-- 1.8.12's channel refresh (CoreMessageService.refreshRemoteChannel through the history proxy in
-- federation-backend ServerDiscoveryService) cached a host's channel page, which named this
-- instance's members' messages by the host's own rows: each became a second message here, the
-- same author in the same channel, its created_at cut to milliseconds. From 1.9.0 the proxy
-- links such a message to the member's row (ownMessageRow) and a 1.9.0 host names it by the id
-- it was sent under.
--
-- merge_own_message_echoes() folds each cached copy into the member's row and deletes it. A copy
-- is a row of a remote server's channel by a local profile, cached from a page (metadata ap_id
-- and is_remote), matched to that profile's nearest row in the channel with no ap_id or
-- host_ap_id, in the same thread, created within 2 s. A host that stored one message several
-- times gave it several copies; all fold into the one row. Reactions (one per person and emoji),
-- replies, threads, read markers, message heads, reports, AutoMod events, key requests and a pin
-- move to the member's row, which keeps the nearest copy's id as metadata.host_ap_id. A row whose
-- copies and itself start more than one thread is left as it is. Returns the copies merged; a
-- second run merges none.
BEGIN;

CREATE OR REPLACE FUNCTION public.merge_own_message_echoes()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    -- The pairs, by position: copy, member's row, the copy's id, seconds apart.
    v_echo uuid[];
    v_local uuid[];
    v_host_ap_id text[];
    v_dt numeric[];
    v_merged integer;
BEGIN
    SELECT array_agg(p.echo_id ORDER BY p.echo_id), array_agg(p.local_id ORDER BY p.echo_id),
           array_agg(p.host_ap_id ORDER BY p.echo_id), array_agg(p.dt ORDER BY p.echo_id)
    INTO v_echo, v_local, v_host_ap_id, v_dt
    FROM (
        SELECT DISTINCT ON (e.id)
               e.id AS echo_id,
               l.id AS local_id,
               e.metadata ->> 'ap_id' AS host_ap_id,
               abs(extract(epoch FROM l.created_at - e.created_at)) AS dt
        FROM public.messages e
        JOIN public.channels c ON c.id = e.channel_id
        JOIN public.servers s ON s.id = c.server_id AND s.is_local_server IS FALSE
        JOIN public.profiles pr ON pr.id = e.user_id AND pr.is_local IS TRUE
        JOIN public.messages l
          ON l.channel_id = e.channel_id
         AND l.user_id = e.user_id
         AND l.id <> e.id
         AND NULLIF(l.metadata ->> 'ap_id', '') IS NULL
         AND NULLIF(l.metadata ->> 'host_ap_id', '') IS NULL
         AND l.thread_id IS NOT DISTINCT FROM e.thread_id
         AND l.created_at BETWEEN e.created_at - interval '2 seconds' AND e.created_at + interval '2 seconds'
        WHERE NULLIF(e.metadata ->> 'ap_id', '') IS NOT NULL
          AND e.metadata ->> 'is_remote' = 'true'
        ORDER BY e.id, abs(extract(epoch FROM l.created_at - e.created_at)), l.id
    ) p;
    IF v_echo IS NULL THEN
        RETURN 0;
    END IF;

    -- More than one thread among a row and its copies: a deleted copy takes its thread (CASCADE).
    SELECT array_agg(x.echo_id ORDER BY x.echo_id), array_agg(x.local_id ORDER BY x.echo_id),
           array_agg(x.host_ap_id ORDER BY x.echo_id), array_agg(x.dt ORDER BY x.echo_id)
    INTO v_echo, v_local, v_host_ap_id, v_dt
    FROM unnest(v_echo, v_local, v_host_ap_id, v_dt) AS x(echo_id, local_id, host_ap_id, dt)
    WHERE (SELECT count(*) FROM public.threads t
           WHERE t.parent_message_id = x.local_id
              OR t.parent_message_id IN (SELECT y.echo_id FROM unnest(v_echo, v_local) AS y(echo_id, local_id)
                                         WHERE y.local_id = x.local_id)) <= 1;
    IF v_echo IS NULL THEN
        RETURN 0;
    END IF;

    -- reactions_message_user_emoji_unique: one reaction per person and emoji on the row.
    UPDATE public.reactions r
    SET message_id = moved.local_id
    FROM (
        SELECT DISTINCT ON (x.local_id, r1.user_id, COALESCE(r1.emoji_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(r1.custom_emoji_content, ''))
               r1.id, x.local_id
        FROM public.reactions r1
        JOIN unnest(v_echo, v_local) AS x(echo_id, local_id) ON r1.message_id = x.echo_id
        WHERE NOT EXISTS (
            SELECT 1 FROM public.reactions r2
            WHERE r2.message_id = x.local_id
              AND r2.user_id IS NOT DISTINCT FROM r1.user_id
              AND r2.emoji_id IS NOT DISTINCT FROM r1.emoji_id
              AND COALESCE(r2.custom_emoji_content, '') = COALESCE(r1.custom_emoji_content, ''))
        ORDER BY x.local_id, r1.user_id, COALESCE(r1.emoji_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(r1.custom_emoji_content, ''), r1.created_at
    ) moved
    WHERE r.id = moved.id;

    UPDATE public.messages m SET reply_to = x.local_id FROM unnest(v_echo, v_local) AS x(echo_id, local_id) WHERE m.reply_to = x.echo_id;
    UPDATE public.threads t SET parent_message_id = x.local_id FROM unnest(v_echo, v_local) AS x(echo_id, local_id) WHERE t.parent_message_id = x.echo_id;
    UPDATE public.threads t SET last_message_id = x.local_id FROM unnest(v_echo, v_local) AS x(echo_id, local_id) WHERE t.last_message_id = x.echo_id;
    UPDATE public.thread_members tm SET last_read_message_id = x.local_id FROM unnest(v_echo, v_local) AS x(echo_id, local_id) WHERE tm.last_read_message_id = x.echo_id;
    UPDATE public.unread_counts u SET last_read_message_id = x.local_id FROM unnest(v_echo, v_local) AS x(echo_id, local_id) WHERE u.last_read_message_id = x.echo_id;
    UPDATE public.message_heads h SET last_message_id = x.local_id FROM unnest(v_echo, v_local) AS x(echo_id, local_id) WHERE h.last_message_id = x.echo_id;
    UPDATE public.reports r SET reported_message_id = x.local_id FROM unnest(v_echo, v_local) AS x(echo_id, local_id) WHERE r.reported_message_id = x.echo_id;
    UPDATE public.automod_events a SET message_id = x.local_id FROM unnest(v_echo, v_local) AS x(echo_id, local_id) WHERE a.message_id = x.echo_id;
    UPDATE public.megolm_key_requests k SET message_id = x.local_id FROM unnest(v_echo, v_local) AS x(echo_id, local_id) WHERE k.message_id = x.echo_id;

    UPDATE public.messages l
    SET is_pinned = true, pinned_at = e.pinned_at, pinned_by = e.pinned_by
    FROM unnest(v_echo, v_local) AS x(echo_id, local_id)
    JOIN public.messages e ON e.id = x.echo_id
    WHERE l.id = x.local_id
      AND e.is_pinned IS TRUE
      AND l.is_pinned IS NOT TRUE;

    UPDATE public.messages l
    SET metadata = COALESCE(l.metadata, '{}'::jsonb) || jsonb_build_object('host_ap_id', nearest.host_ap_id)
    FROM (SELECT DISTINCT ON (x.local_id) x.local_id, x.host_ap_id
          FROM unnest(v_echo, v_local, v_host_ap_id, v_dt) AS x(echo_id, local_id, host_ap_id, dt)
          ORDER BY x.local_id, x.dt, x.echo_id) nearest
    WHERE l.id = nearest.local_id;

    DELETE FROM public.messages e WHERE e.id = ANY (v_echo);
    GET DIAGNOSTICS v_merged = ROW_COUNT;
    RETURN v_merged;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_own_message_echoes() FROM PUBLIC, anon, authenticated;

SELECT public.merge_own_message_echoes();

COMMIT;
