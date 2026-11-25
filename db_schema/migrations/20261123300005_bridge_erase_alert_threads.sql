-- Bridge privacy: a thread on an erased AutoMod alert loses its title.
--
-- An erase keeps an alert a thread starts on as an empty deleted row; the thread and its
-- "started a thread" notice kept their title, which a bot or an API client may have taken from
-- the alert, and the alert quotes the erased author. They are renamed 'Thread' with the alert,
-- as the threads on the author's own messages are.
--
--   bridge_privacy_erase_core   as 20261123200003_bridge_erase_import_lock.sql; the threads on the alerts it
--                               empties are renamed and their notices' thread_name follows, under
--                               harmony.silent_content_update as the other notice updates.
-- Body otherwise, volatility, owner and grants as 20261123200003_bridge_erase_import_lock.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.bridge_privacy_erase_core(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
-- A custom plan folds v_key into each statement, which proves the predicate of the platform's
-- partial indexes; a generic plan uses none of them.
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
    v_key text := public.bridge_platform_author_key(p_platform);
    v_path text[] := ARRAY[public.bridge_platform_author_key(p_platform), 'id'];
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
    v_channels uuid[];
    v_ids uuid[];
    v_notices uuid[];
    v_parents uuid[];
    v_renamed uuid[];
    v_renamed_more uuid[];
    v_federated uuid[];
    v_found integer;
    v_more boolean;
    v_reactions integer := 0;
    v_events integer := 0;
    v_event_ids uuid[];
    v_alerts integer := 0;
    v_alerts_deleted integer := 0;
    v_alert_parents uuid[];
    v_alert_threads uuid[];
    v_touched uuid[];
    v_touched_parents uuid[];
    v_gone uuid[];
    v_prev text := current_setting('harmony.silent_content_update', true);
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);

    IF p_server_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[]) INTO v_channels
          FROM public.channels c WHERE c.server_id = p_server_id;
    END IF;

    -- One statement per scope, each stating its index's predicate: messages_discord_author_idx
    -- (20261112600002) or messages_matrix_author_idx (20261117900003) for one author,
    -- messages_discord_relayed_channel (20261115800001) or messages_matrix_relayed_channel
    -- (20261117900003) for a server's relayed rows.
    IF p_remote_user_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
          FROM (SELECT m.id
                  FROM public.messages m
                 WHERE m.metadata ? v_key
                   AND m.metadata #>> v_path = p_remote_user_id
                   AND (p_server_id IS NULL OR m.channel_id = ANY (v_channels))
                 LIMIT v_limit
                   FOR UPDATE SKIP LOCKED) s;
    ELSIF p_server_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
          FROM (SELECT m.id
                  FROM public.messages m
                 WHERE m.metadata ? v_key
                   AND m.channel_id = ANY (v_channels)
                 LIMIT v_limit
                   FOR UPDATE SKIP LOCKED) s;
    ELSE
        SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
          FROM (SELECT m.id
                  FROM public.messages m
                 WHERE m.metadata ? v_key
                 LIMIT v_limit
                   FOR UPDATE SKIP LOCKED) s;
    END IF;
    v_found := cardinality(v_ids);

    IF v_found > 0 THEN
        SELECT COALESCE(array_agg(m.id) FILTER (WHERE m.is_system IS TRUE), ARRAY[]::uuid[]),
               COALESCE(array_agg(m.id) FILTER (WHERE m.is_system IS NOT TRUE AND EXISTS (
                            SELECT 1 FROM public.threads t WHERE t.parent_message_id = m.id)), ARRAY[]::uuid[]),
               COALESCE(array_agg(m.id) FILTER (WHERE m.is_system IS NOT TRUE
                            AND m.is_deleted IS NOT TRUE
                            AND m.federation_status IS DISTINCT FROM 'skipped'
                            AND COALESCE(m.metadata ->> 'history_import', '') <> 'true'), ARRAY[]::uuid[])
          INTO v_notices, v_parents, v_federated
          FROM public.messages m
         WHERE m.id = ANY (v_ids);

        -- The threads the batch may empty, with their starters: the threads its rows are in or
        -- start (threads_pkey, idx_threads_parent_message).
        SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]), COALESCE(array_agg(s.parent_message_id), ARRAY[]::uuid[])
          INTO v_touched, v_touched_parents
          FROM (SELECT t.id, t.parent_message_id
                  FROM public.threads t
                 WHERE t.id IN (SELECT m.thread_id FROM public.messages m
                                 WHERE m.id = ANY (v_ids) AND m.thread_id IS NOT NULL)
                UNION
                SELECT t.id, t.parent_message_id
                  FROM public.threads t
                 WHERE t.parent_message_id = ANY (v_ids)) s;

        -- A thread's title may be the author's text: the threads they started, and the threads on
        -- their messages, whose title the platform fills from the message, are renamed. Two statements,
        -- each on an index (threads.parent_message_id, the primary key); under one OR the planner
        -- read every thread.
        WITH r AS (
            UPDATE public.threads t
               SET name = 'Thread'
             WHERE t.parent_message_id = ANY (v_parents)
            RETURNING t.id)
        SELECT COALESCE(array_agg(r.id), ARRAY[]::uuid[]) INTO v_renamed FROM r;
        WITH r AS (
            UPDATE public.threads t
               SET name = 'Thread'
             WHERE t.id IN (SELECT CASE WHEN m.metadata ->> 'thread_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                        THEN (m.metadata ->> 'thread_id')::uuid END
                              FROM public.messages m
                             WHERE m.id = ANY (v_notices) AND m.metadata ->> 'type' = 'thread_created')
            RETURNING t.id)
        SELECT COALESCE(array_agg(r.id), ARRAY[]::uuid[]) INTO v_renamed_more FROM r;
        v_renamed := v_renamed || v_renamed_more;

        PERFORM set_config('harmony.silent_content_update', 'true', true);
        UPDATE public.messages m
           SET metadata = (m.metadata - v_key)
                          || CASE WHEN m.metadata ->> 'type' = 'thread_created'
                                  THEN jsonb_build_object('thread_name', 'Thread') ELSE '{}'::jsonb END
         WHERE m.id = ANY (v_notices);
        -- The notices of the renamed threads others started repeat the title
        -- (messages_thread_created_notice).
        IF cardinality(v_renamed) > 0 THEN
            UPDATE public.messages m
               SET metadata = m.metadata || jsonb_build_object('thread_name', 'Thread')
             WHERE m.metadata ->> 'type' = 'thread_created'
               AND m.metadata ->> 'thread_id' = ANY (SELECT x::text FROM unnest(v_renamed) x)
               AND m.metadata ->> 'thread_name' IS DISTINCT FROM 'Thread';
        END IF;
        PERFORM set_config('harmony.silent_content_update', COALESCE(v_prev, ''), true);

        -- Notifications quoting an erased message carry its text and its author's name and picture
        -- (idx_notifications_message_id).
        DELETE FROM public.notifications n
         WHERE n.data ? 'message_id'
           AND n.data ->> 'message_id' = ANY (
                   SELECT x::text FROM unnest(v_ids) x WHERE NOT (x = ANY (v_notices)));

        -- Queues the federated Delete of each row that federated.
        UPDATE public.messages m
           SET is_deleted = true
         WHERE m.id = ANY (v_federated);

        UPDATE public.messages m
           SET is_deleted = true,
               content = '[{"type": "text", "text": ""}]'::jsonb,
               metadata = jsonb_build_object('bridge_erased', true)
                          || jsonb_strip_nulls(jsonb_build_object(
                                 'bot', m.metadata -> 'bot',
                                 'created_via', m.metadata -> 'created_via',
                                 'history_import', m.metadata -> 'history_import'))
         WHERE m.id = ANY (v_parents);

        DELETE FROM public.messages m
         WHERE m.id = ANY (v_ids)
           AND NOT (m.id = ANY (v_notices))
           AND NOT (m.id = ANY (v_parents));

        -- A thread the batch emptied went with its last message (delete_emptied_thread). Its
        -- notices (messages_thread_created_notice) and the erased starter kept for it go too, or a
        -- re-import posts a second notice beside the first.
        SELECT COALESCE(array_agg(g.id), ARRAY[]::uuid[]) INTO v_gone
          FROM unnest(v_touched) g(id)
         WHERE NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = g.id);
        IF cardinality(v_gone) > 0 THEN
            DELETE FROM public.messages m
             WHERE m.metadata ->> 'type' = 'thread_created'
               AND m.metadata ->> 'thread_id' = ANY (SELECT x::text FROM unnest(v_gone) x);
            DELETE FROM public.messages m
             WHERE m.id IN (SELECT p.parent FROM unnest(v_touched, v_touched_parents) p(id, parent)
                             WHERE p.id = ANY (v_gone))
               AND m.is_deleted IS TRUE
               AND m.metadata ->> 'bridge_erased' = 'true';
        END IF;
    END IF;

    -- SKIP LOCKED passes over a row another transaction holds: a short batch is the last only
    -- when no row of the author is left.
    v_more := v_found >= v_limit;
    IF NOT v_more THEN
        IF p_remote_user_id IS NOT NULL THEN
            v_more := EXISTS (SELECT 1 FROM public.messages m
                               WHERE m.metadata ? v_key
                                 AND m.metadata #>> v_path = p_remote_user_id
                                 AND (p_server_id IS NULL OR m.channel_id = ANY (v_channels)));
        ELSIF p_server_id IS NOT NULL THEN
            v_more := EXISTS (SELECT 1 FROM public.messages m
                               WHERE m.metadata ? v_key AND m.channel_id = ANY (v_channels));
        ELSE
            v_more := EXISTS (SELECT 1 FROM public.messages m WHERE m.metadata ? v_key);
        END IF;
    END IF;

    -- Reactions and AutoMod events once the messages are gone, `limit` of each per call. Each
    -- statement states the predicate of idx_reactions_discord_author (20261115600001) or
    -- idx_reactions_matrix_author (20261117900003), or of idx_automod_events_author_key
    -- (20261115600001), so a batch reads the author's rows only.
    IF NOT v_more THEN
        IF p_remote_user_id IS NOT NULL AND p_server_id IS NOT NULL THEN
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? v_key
                               AND r2.channel_id = ANY (v_channels)
                               AND r2.metadata #>> v_path = p_remote_user_id
                             LIMIT v_limit);
        ELSIF p_remote_user_id IS NOT NULL THEN
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? v_key
                               AND r2.metadata #>> v_path = p_remote_user_id
                             LIMIT v_limit);
        ELSIF p_server_id IS NOT NULL THEN
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? v_key
                               AND r2.channel_id = ANY (v_channels)
                             LIMIT v_limit);
        ELSE
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? v_key
                             LIMIT v_limit);
        END IF;
        GET DIAGNOSTICS v_reactions = ROW_COUNT;

        IF p_remote_user_id IS NOT NULL THEN
            WITH gone AS (
                DELETE FROM public.automod_events e
                 WHERE e.id IN (SELECT e2.id FROM public.automod_events e2
                                 WHERE e2.details ? 'author_key'
                                   AND (p_server_id IS NULL OR e2.server_id = p_server_id)
                                   AND e2.details ->> 'author_key' = p_platform || ':' || p_remote_user_id
                                 LIMIT v_limit)
                RETURNING e.id)
            SELECT COALESCE(array_agg(gone.id), ARRAY[]::uuid[]) INTO v_event_ids FROM gone;
        ELSE
            WITH gone AS (
                DELETE FROM public.automod_events e
                 WHERE e.id IN (SELECT e2.id FROM public.automod_events e2
                                 WHERE e2.details ? 'author_key'
                                   AND (p_server_id IS NULL OR e2.server_id = p_server_id)
                                   AND e2.details ->> 'author_key' LIKE p_platform || ':%'
                                 LIMIT v_limit)
                RETURNING e.id)
            SELECT COALESCE(array_agg(gone.id), ARRAY[]::uuid[]) INTO v_event_ids FROM gone;
        END IF;
        v_events := cardinality(v_event_ids);
        -- The alerts AutoMod posted for these events quote the author's name and text
        -- (automod_post_alert; messages_automod_alert_event). An alert a thread starts on stays as
        -- an empty deleted row, so the thread and its replies stay; the others go.
        IF v_events > 0 THEN
            WITH kept AS (
                UPDATE public.messages m
                   SET is_deleted = true,
                       content = '[{"type": "text", "text": ""}]'::jsonb,
                       metadata = jsonb_build_object('bridge_erased', true)
                 WHERE m.metadata ->> 'type' = 'automod_alert'
                   AND m.metadata #>> '{automod,event_id}' = ANY (SELECT x::text FROM unnest(v_event_ids) x)
                   AND EXISTS (SELECT 1 FROM public.threads t WHERE t.parent_message_id = m.id)
                RETURNING m.id)
            SELECT COALESCE(array_agg(kept.id), ARRAY[]::uuid[]) INTO v_alert_parents FROM kept;
            v_alerts := cardinality(v_alert_parents);
            -- The title of a thread on an alert may be the alert's text, and its notice repeats it.
            IF v_alerts > 0 THEN
                WITH r AS (
                    UPDATE public.threads t
                       SET name = 'Thread'
                     WHERE t.parent_message_id = ANY (v_alert_parents)
                    RETURNING t.id)
                SELECT COALESCE(array_agg(r.id), ARRAY[]::uuid[]) INTO v_alert_threads FROM r;
                PERFORM set_config('harmony.silent_content_update', 'true', true);
                UPDATE public.messages m
                   SET metadata = m.metadata || jsonb_build_object('thread_name', 'Thread')
                 WHERE m.metadata ->> 'type' = 'thread_created'
                   AND m.metadata ->> 'thread_id' = ANY (SELECT x::text FROM unnest(v_alert_threads) x)
                   AND m.metadata ->> 'thread_name' IS DISTINCT FROM 'Thread';
                PERFORM set_config('harmony.silent_content_update', COALESCE(v_prev, ''), true);
            END IF;
            DELETE FROM public.messages m
             WHERE m.metadata ->> 'type' = 'automod_alert'
               AND m.metadata #>> '{automod,event_id}' = ANY (SELECT x::text FROM unnest(v_event_ids) x);
            GET DIAGNOSTICS v_alerts_deleted = ROW_COUNT;
            v_alerts := v_alerts + v_alerts_deleted;
        END IF;
        v_more := v_reactions >= v_limit OR v_events >= v_limit;

        -- SKIP LOCKED: an import call holds its job row while it waits for this author's lock (a
        -- thread notice of theirs, a batch into a thread this erase renamed); a wait for the row
        -- here closes the cycle. A job passed over keeps the erase pending.
        IF NOT v_more AND p_platform = 'discord' THEN
            UPDATE public.discord_bridge_imports i
               SET requested_by_remote = NULL
             WHERE i.id IN (SELECT i2.id
                              FROM public.discord_bridge_imports i2
                             WHERE i2.requested_by_remote IS NOT NULL
                               AND (p_remote_user_id IS NULL OR i2.requested_by_remote ->> 'id' = p_remote_user_id)
                               AND (p_server_id IS NULL OR i2.bridge_id IN (
                                        SELECT b.id FROM public.discord_bridges b WHERE b.server_id = p_server_id))
                               FOR UPDATE SKIP LOCKED);
            v_more := EXISTS (SELECT 1
                                FROM public.discord_bridge_imports i
                               WHERE i.requested_by_remote IS NOT NULL
                                 AND (p_remote_user_id IS NULL OR i.requested_by_remote ->> 'id' = p_remote_user_id)
                                 AND (p_server_id IS NULL OR i.bridge_id IN (
                                          SELECT b.id FROM public.discord_bridges b WHERE b.server_id = p_server_id)));
        END IF;
    END IF;

    -- erased: messages; removed: every row deleted or emptied, reactions, events and alerts too.
    RETURN jsonb_build_object('erased', v_found, 'more', v_more,
                              'removed', v_found + v_reactions + v_events + v_alerts);
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_erase_core(uuid, text, text, integer)
    FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
