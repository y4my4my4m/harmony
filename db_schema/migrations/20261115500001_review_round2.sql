-- Second review of 1.9.7.
--
--   signup_captcha_verdict        as 20261111100001, the rule turned round: a refused token is
--                                 'fail' unless the provider names the instance's keys or its own
--                                 failure (missing-input-secret, invalid-input-secret,
--                                 internal-error). hCaptcha answers a token minted on another site
--                                 key with sitekey-secret-mismatch, which passed as 'error'.
--   bridge_remote_optouts.self_opted_out
--                                 the user's own opt-out beside a manager's or admin's removal
--                                 (source). One row held one decision: an opt-out and opt-in by the
--                                 user lifted a manager's removal, and a manager's restore lifted the
--                                 user's opt-out. Each side now lifts only its own: opt-in clears the
--                                 flag (a self row goes), restore turns a flagged row into a self row.
--                                 bridge_privacy_status adds self.
--   bridge_privacy_erase_core     as 20261115100001; also deletes the notifications quoting an erased
--                                 message (idx_notifications_message_id, 20261115400001), renames the
--                                 threads the author started to 'Thread', and clears the author from
--                                 requested_by_remote of imports.
--   guard_bridge_reaction_optout  a relayed reaction of an opted-out author is refused (23514
--                                 BRIDGE_AUTHOR_OPTED_OUT), as messages are.
--   bot_create_thread,            as 20261115100001 and 20261112700001: an opted-out author's thread
--   bridge_import_thread          is created under the name 'Thread'.
--   restore_emoji                 as 20261107100001; a copy's mirrored emoji is outside the cap.
--   bridge_mirror_unreferenced    the mirrored files among p_paths no live message or report
--                                 snapshot names, by idx_messages_media_refs. message_media_deletable
--                                 read every message of each channel named.
--   server_member_presence,       as 20261113100001 without blocks: as on Discord, a member who
--   get_server_member_list        blocks the caller is listed with their status, and every list
--                                 longer than member_order_min() reads the stored order.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.signup_captcha_verdict(p_status integer, p_content text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_temp
AS $$
DECLARE
    -- Codes about the instance's keys or the provider itself: no verdict on the token.
    KEY_ERRORS CONSTANT text[] := ARRAY['missing-input-secret', 'invalid-input-secret', 'internal-error'];
    v_answer jsonb;
    v_codes text[];
BEGIN
    IF p_status IS DISTINCT FROM 200 THEN
        RETURN 'error';
    END IF;
    BEGIN
        v_answer := p_content::jsonb;
    EXCEPTION WHEN OTHERS THEN
        RETURN 'error';
    END;
    IF jsonb_typeof(v_answer) <> 'object' OR jsonb_typeof(v_answer -> 'success') IS DISTINCT FROM 'boolean' THEN
        RETURN 'error';
    END IF;
    IF (v_answer ->> 'success')::boolean THEN
        RETURN 'pass';
    END IF;
    SELECT coalesce(array_agg(e.c), '{}') INTO v_codes
      FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(v_answer -> 'error-codes') = 'array' THEN v_answer -> 'error-codes' ELSE '[]'::jsonb END) AS e(c);
    IF v_codes && KEY_ERRORS THEN
        RETURN 'error';
    END IF;
    RETURN 'fail';
END;
$$;

REVOKE ALL ON FUNCTION public.signup_captcha_verdict(integer, text) FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.bridge_remote_optouts ADD COLUMN IF NOT EXISTS self_opted_out boolean NOT NULL DEFAULT false;
UPDATE public.bridge_remote_optouts SET self_opted_out = true WHERE source = 'self' AND NOT self_opted_out;

CREATE OR REPLACE FUNCTION public.bridge_privacy_status(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.bridge_remote_optouts;
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    SELECT * INTO v_row
      FROM public.bridge_remote_optouts o
     WHERE o.server_id = p_server_id AND o.platform = p_platform AND o.remote_user_id = p_remote_user_id;
    RETURN jsonb_build_object('opted_out', FOUND, 'since', v_row.created_at, 'source', v_row.source,
                              'self', COALESCE(v_row.self_opted_out, false));
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_set_optout(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_opted_out boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_remote_user_id IS NULL OR p_opted_out IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    IF p_opted_out THEN
        INSERT INTO public.bridge_remote_optouts AS o (server_id, platform, remote_user_id, source, self_opted_out)
        VALUES (p_server_id, p_platform, p_remote_user_id, 'self', true)
        ON CONFLICT (server_id, platform, remote_user_id)
            DO UPDATE SET self_opted_out = true WHERE NOT o.self_opted_out;
    ELSE
        -- The user's own choice only: a manager's or admin's removal stays.
        DELETE FROM public.bridge_remote_optouts o
         WHERE o.server_id = p_server_id AND o.platform = p_platform
           AND o.remote_user_id = p_remote_user_id AND o.source = 'self';
        IF NOT FOUND THEN
            UPDATE public.bridge_remote_optouts o
               SET self_opted_out = false
             WHERE o.server_id = p_server_id AND o.platform = p_platform
               AND o.remote_user_id = p_remote_user_id AND o.self_opted_out;
        END IF;
    END IF;
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN public.bridge_privacy_status(p_server_id, p_platform, p_remote_user_id);
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_erase(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_server_id IS NULL OR p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.bridge_remote_optouts AS o (server_id, platform, remote_user_id, source, self_opted_out)
    VALUES (p_server_id, p_platform, p_remote_user_id, 'self', true)
    ON CONFLICT (server_id, platform, remote_user_id)
        DO UPDATE SET self_opted_out = true WHERE NOT o.self_opted_out;
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN jsonb_build_object('opted_out', true)
           || public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, p_limit);
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_remove_remote_user(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_admin boolean := public.is_current_user_admin();
BEGIN
    IF NOT (v_admin OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can remove a bridged user' USING ERRCODE = '42501';
    END IF;
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    -- The row records the manager's removal beside the user's own opt-out (self_opted_out), which
    -- stays: each is lifted by its own side.
    INSERT INTO public.bridge_remote_optouts AS o (server_id, platform, remote_user_id, source, created_by)
    VALUES (p_server_id, p_platform, p_remote_user_id,
            CASE WHEN public.can_manage_discord_bridge(p_server_id) THEN 'manager' ELSE 'admin' END,
            public.get_current_profile_id())
    ON CONFLICT (server_id, platform, remote_user_id)
        DO UPDATE SET source = EXCLUDED.source, created_by = EXCLUDED.created_by WHERE o.source = 'self';
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, 200);
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_restore_remote_user(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
    v_kept integer;
BEGIN
    IF NOT (public.is_current_user_admin() OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can restore a bridged user' USING ERRCODE = '42501';
    END IF;
    -- Lifts the manager's or admin's removal; the user's own opt-out stays as a self row.
    DELETE FROM public.bridge_remote_optouts o
     WHERE o.server_id = p_server_id AND o.platform = p_platform
       AND o.remote_user_id = p_remote_user_id AND o.source <> 'self' AND NOT o.self_opted_out;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    UPDATE public.bridge_remote_optouts o
       SET source = 'self', created_by = NULL
     WHERE o.server_id = p_server_id AND o.platform = p_platform
       AND o.remote_user_id = p_remote_user_id AND o.source <> 'self' AND o.self_opted_out;
    GET DIAGNOSTICS v_kept = ROW_COUNT;
    IF v_count > 0 THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN v_count + v_kept > 0;
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_erase_core(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
    v_channels uuid[];
    v_ids uuid[];
    v_notices uuid[];
    v_parents uuid[];
    v_federated uuid[];
    v_found integer;
    v_more boolean;
    v_reactions integer;
    v_events integer;
    v_prev text := current_setting('harmony.silent_content_update', true);
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);

    IF p_server_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[]) INTO v_channels
          FROM public.channels c WHERE c.server_id = p_server_id;
    END IF;

    -- The expressions repeat messages_discord_author_idx (20261112600002).
    SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
      FROM (SELECT m.id
              FROM public.messages m
             WHERE m.metadata ? 'discord_user'
               AND (p_remote_user_id IS NULL OR m.metadata #>> '{discord_user,id}' = p_remote_user_id)
               AND (p_server_id IS NULL OR m.channel_id = ANY (v_channels))
             LIMIT v_limit
               FOR UPDATE SKIP LOCKED) s;
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

        -- A thread's title is its author's text: a thread the author started is renamed.
        UPDATE public.threads t
           SET name = 'Thread'
         WHERE t.parent_message_id = ANY (v_parents)
            OR t.id IN (SELECT CASE WHEN m.metadata ->> 'thread_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                    THEN (m.metadata ->> 'thread_id')::uuid END
                          FROM public.messages m
                         WHERE m.id = ANY (v_notices) AND m.metadata ->> 'type' = 'thread_created');

        PERFORM set_config('harmony.silent_content_update', 'true', true);
        UPDATE public.messages m
           SET metadata = (m.metadata - 'discord_user')
                          || CASE WHEN m.metadata ->> 'type' = 'thread_created'
                                  THEN jsonb_build_object('thread_name', 'Thread') ELSE '{}'::jsonb END
         WHERE m.id = ANY (v_notices);
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
    END IF;

    -- SKIP LOCKED passes over a row another transaction holds: a short batch is the last only
    -- when no row of the author is left.
    v_more := v_found >= v_limit OR EXISTS (
        SELECT 1
          FROM public.messages m
         WHERE m.metadata ? 'discord_user'
           AND (p_remote_user_id IS NULL OR m.metadata #>> '{discord_user,id}' = p_remote_user_id)
           AND (p_server_id IS NULL OR m.channel_id = ANY (v_channels)));

    -- Reactions and AutoMod events once the messages are gone, `limit` of each per call: neither
    -- has an index on the author.
    IF NOT v_more THEN
        DELETE FROM public.reactions r
         WHERE r.id IN (
               SELECT r2.id
                 FROM public.reactions r2
                WHERE r2.metadata ? 'discord_user'
                  AND (p_remote_user_id IS NULL OR r2.metadata #>> '{discord_user,id}' = p_remote_user_id)
                  AND (p_server_id IS NULL OR r2.channel_id = ANY (v_channels))
                LIMIT v_limit);
        GET DIAGNOSTICS v_reactions = ROW_COUNT;

        DELETE FROM public.automod_events e
         WHERE e.id IN (
               SELECT e2.id
                 FROM public.automod_events e2
                WHERE (p_server_id IS NULL OR e2.server_id = p_server_id)
                  AND CASE WHEN p_remote_user_id IS NULL THEN e2.details ->> 'author_key' LIKE 'discord:%'
                           ELSE e2.details ->> 'author_key' = 'discord:' || p_remote_user_id END
                LIMIT v_limit);
        GET DIAGNOSTICS v_events = ROW_COUNT;
        v_more := v_reactions >= v_limit OR v_events >= v_limit;

        IF NOT v_more THEN
            UPDATE public.discord_bridge_imports i
               SET requested_by_remote = NULL
             WHERE i.requested_by_remote IS NOT NULL
               AND (p_remote_user_id IS NULL OR i.requested_by_remote ->> 'id' = p_remote_user_id)
               AND (p_server_id IS NULL OR i.bridge_id IN (
                        SELECT b.id FROM public.discord_bridges b WHERE b.server_id = p_server_id));
        END IF;
    END IF;

    RETURN jsonb_build_object('erased', v_found, 'more', v_more);
END;
$$;


REVOKE ALL ON FUNCTION public.bridge_privacy_erase_core(uuid, text, text, integer)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_bridge_reaction_optout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM public.channels c
                 JOIN public.bridge_remote_optouts o ON o.server_id = c.server_id
                WHERE c.id = COALESCE(NEW.channel_id,
                                      (SELECT m.channel_id FROM public.messages m WHERE m.id = NEW.message_id))
                  AND o.platform = 'discord'
                  AND o.remote_user_id = NEW.metadata #>> '{discord_user,id}') THEN
        RAISE EXCEPTION 'BRIDGE_AUTHOR_OPTED_OUT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_bridge_reaction_optout() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_reactions_bridge_optout_guard ON public.reactions;
CREATE TRIGGER a_reactions_bridge_optout_guard
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    WHEN (NEW.metadata ? 'discord_user')
    EXECUTE FUNCTION public.guard_bridge_reaction_optout();

CREATE OR REPLACE FUNCTION public.bot_create_thread(
    p_bot_id uuid,
    p_channel_id uuid,
    p_name text,
    p_parent_message_id uuid DEFAULT NULL,
    p_discord_thread_id text DEFAULT NULL,
    p_discord_user jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id uuid;
    v_bridge_id uuid;
    v_name text := left(btrim(coalesce(p_name, '')), 100);
    v_thread_id uuid;
    v_parent record;
    v_notice_id uuid;
    v_notice jsonb;
    v_opted boolean;
BEGIN
    IF p_bot_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.bots WHERE id = p_bot_id) THEN
        RAISE EXCEPTION 'Bot not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT c.server_id INTO v_server_id FROM public.channels c WHERE c.id = p_channel_id;
    IF v_server_id IS NULL THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'Thread name must be 1 to 100 characters' USING ERRCODE = '22023';
    END IF;

    IF p_discord_thread_id IS NOT NULL THEN
        IF p_discord_thread_id !~ '^[0-9]{1,20}$' THEN
            RAISE EXCEPTION 'Invalid Discord thread id' USING ERRCODE = '22023';
        END IF;
        SELECT b.id INTO v_bridge_id
          FROM public.discord_bridges b
         WHERE b.server_id = v_server_id AND b.bot_id = p_bot_id;
        IF v_bridge_id IS NULL THEN
            RAISE EXCEPTION 'The bot runs no bridge on this server' USING ERRCODE = '42501';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtext('bridge_thread:' || v_bridge_id::text || ':' || p_discord_thread_id));
        SELECT bt.thread_id INTO v_thread_id
          FROM public.discord_bridge_threads bt
         WHERE bt.bridge_id = v_bridge_id AND bt.discord_thread_id = p_discord_thread_id;
        IF v_thread_id IS NOT NULL THEN
            RETURN v_thread_id;
        END IF;
    END IF;

    -- An opted-out author's thread is created, so the replies of others arrive; its title is
    -- the author's text and is not copied.
    v_opted := jsonb_typeof(p_discord_user) = 'object' AND EXISTS (
        SELECT 1 FROM public.bridge_remote_optouts o
         WHERE o.server_id = v_server_id AND o.platform = 'discord' AND o.remote_user_id = p_discord_user->>'id');
    IF v_opted THEN
        v_name := 'Thread';
    END IF;

    v_notice := jsonb_build_object('type', 'thread_created', 'actor_bot_id', p_bot_id,
                                   'thread_name', v_name, 'bridge_source', 'discord');
    -- The Discord member who started the thread names the notice (messageAuthor.ts discord_user).
    -- An opted-out author is left off: the notice, the thread and its replies still arrive.
    IF jsonb_typeof(p_discord_user) = 'object' AND p_discord_user->>'id' ~ '^[0-9]{1,20}$' AND NOT v_opted THEN
        v_notice := v_notice || jsonb_build_object('discord_user', jsonb_strip_nulls(jsonb_build_object(
            'id', p_discord_user->>'id',
            'username', left(p_discord_user->>'username', 100),
            'display_name', left(p_discord_user->>'display_name', 100),
            'avatar_url', CASE WHEN p_discord_user->>'avatar_url' ~ '^https://' THEN left(p_discord_user->>'avatar_url', 2048) END)));
    END IF;

    IF p_parent_message_id IS NOT NULL THEN
        SELECT m.id, m.channel_id, m.user_id, m.thread_id, m.is_system
          INTO v_parent
          FROM public.messages m
         WHERE m.id = p_parent_message_id;
        IF NOT FOUND OR v_parent.channel_id IS DISTINCT FROM p_channel_id OR v_parent.thread_id IS NOT NULL THEN
            RAISE EXCEPTION 'Message not found in this channel' USING ERRCODE = 'P0002';
        END IF;

        -- One thread per message, as create_thread; an existing one is paired and returned.
        PERFORM pg_advisory_xact_lock(hashtext('create_thread:' || p_parent_message_id::text));
        SELECT t.id INTO v_thread_id FROM public.threads t WHERE t.parent_message_id = p_parent_message_id;

        IF v_thread_id IS NULL THEN
            INSERT INTO public.threads (channel_id, parent_message_id, name, created_by, auto_archive_duration)
            VALUES (p_channel_id, p_parent_message_id, v_name, NULL, 1440)
            RETURNING id INTO v_thread_id;

            INSERT INTO public.thread_members (thread_id, user_id)
            SELECT v_thread_id, v_parent.user_id
             WHERE v_parent.user_id IS NOT NULL
               AND public.can_view_channel(v_parent.user_id, p_channel_id)
            ON CONFLICT (thread_id, user_id) DO NOTHING;

            UPDATE public.threads
               SET member_count = (SELECT count(*) FROM public.thread_members WHERE thread_id = v_thread_id)
             WHERE id = v_thread_id;

            INSERT INTO public.messages (channel_id, content, is_system, metadata)
            VALUES (p_channel_id,
                    '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                    v_notice || jsonb_build_object('thread_id', v_thread_id));
        END IF;
    ELSE
        v_thread_id := gen_random_uuid();
        INSERT INTO public.messages (channel_id, content, is_system, metadata)
        VALUES (p_channel_id,
                '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                v_notice || jsonb_build_object('thread_id', v_thread_id, 'standalone', true))
        RETURNING id INTO v_notice_id;

        INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, auto_archive_duration)
        VALUES (v_thread_id, p_channel_id, v_notice_id, v_name, NULL, 1440);
    END IF;

    IF v_bridge_id IS NOT NULL THEN
        INSERT INTO public.discord_bridge_threads (thread_id, bridge_id, discord_thread_id)
        VALUES (v_thread_id, v_bridge_id, p_discord_thread_id)
        ON CONFLICT (thread_id) DO NOTHING;
    END IF;

    RETURN v_thread_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_import_thread(p_bot_id uuid, p_import_id uuid, p_thread jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.discord_bridge_imports;
    v_did text := p_thread ->> 'discord_thread_id';
    v_name text := left(btrim(COALESCE(p_thread ->> 'name', '')), 100);
    v_created timestamptz;
    v_starter text := NULLIF(p_thread ->> 'starter_discord_message_id', '');
    v_user jsonb := p_thread -> 'discord_user';
    v_archived boolean := COALESCE((p_thread ->> 'archived')::boolean, false);
    v_locked boolean := COALESCE((p_thread ->> 'locked')::boolean, false);
    v_parent uuid;
    v_thread_id uuid;
    v_notice_id uuid;
    v_notice jsonb;
    v_opted boolean;
BEGIN
    v_job := public.bridge_import_guard(p_bot_id, p_import_id);
    IF v_job.state <> 'running' THEN
        RETURN NULL;
    END IF;
    IF p_thread IS NULL OR jsonb_typeof(p_thread) <> 'object' OR v_did IS NULL OR v_did !~ '^[0-9]{1,20}$'
       OR (p_thread ->> 'created_at') IS NULL THEN
        RAISE EXCEPTION 'invalid_thread' USING ERRCODE = '22023', DETAIL = COALESCE(v_did, '');
    END IF;
    IF v_name = '' THEN
        RAISE EXCEPTION 'Thread name must be 1 to 100 characters' USING ERRCODE = '22023';
    END IF;
    v_created := LEAST((p_thread ->> 'created_at')::timestamptz, now());

    PERFORM set_config('harmony.history_import', 'true', true);

    PERFORM pg_advisory_xact_lock(hashtext('bridge_thread:' || v_job.bridge_id::text || ':' || v_did));
    SELECT bt.thread_id INTO v_thread_id
      FROM public.discord_bridge_threads bt
     WHERE bt.bridge_id = v_job.bridge_id AND bt.discord_thread_id = v_did;
    IF v_thread_id IS NOT NULL THEN
        RETURN v_thread_id;
    END IF;

    -- An opted-out author's title is their text: the thread is imported under a plain name.
    v_opted := jsonb_typeof(v_user) = 'object' AND EXISTS (
        SELECT 1
          FROM public.bridge_remote_optouts o
          JOIN public.discord_bridges b ON b.server_id = o.server_id
         WHERE b.id = v_job.bridge_id AND o.platform = 'discord' AND o.remote_user_id = v_user ->> 'id');
    IF v_opted THEN
        v_name := 'Thread';
    END IF;

    v_notice := jsonb_build_object('type', 'thread_created', 'actor_bot_id', p_bot_id, 'thread_name', v_name,
                                   'bridge_source', 'discord', 'history_import', true, 'created_via', 'history_import');
    IF jsonb_typeof(v_user) = 'object' AND v_user ->> 'id' ~ '^[0-9]{1,20}$' AND NOT v_opted THEN
        v_notice := v_notice || jsonb_build_object('discord_user', jsonb_strip_nulls(jsonb_build_object(
            'id', v_user ->> 'id',
            'username', left(v_user ->> 'username', 100),
            'display_name', left(v_user ->> 'display_name', 100),
            'avatar_url', CASE WHEN v_user ->> 'avatar_url' ~ '^https://' THEN left(v_user ->> 'avatar_url', 2048) END)));
    END IF;

    IF v_starter IS NOT NULL THEN
        SELECT m.id INTO v_parent
          FROM public.messages m
         WHERE m.channel_id = v_job.harmony_channel_id
           AND m.metadata ? 'discord_message_id'
           AND m.metadata ->> 'discord_message_id' = v_starter
           AND m.is_deleted IS NOT TRUE
           AND m.thread_id IS NULL;
    END IF;

    IF v_parent IS NOT NULL THEN
        -- One thread per message; an existing one is paired and returned.
        PERFORM pg_advisory_xact_lock(hashtext('create_thread:' || v_parent::text));
        SELECT t.id INTO v_thread_id FROM public.threads t WHERE t.parent_message_id = v_parent;

        IF v_thread_id IS NULL THEN
            INSERT INTO public.threads (channel_id, parent_message_id, name, created_by, auto_archive_duration,
                                        created_at, updated_at, archived, archived_at, locked)
            VALUES (v_job.harmony_channel_id, v_parent, v_name, NULL, 1440, v_created, v_created,
                    v_archived, CASE WHEN v_archived THEN v_created END, v_locked)
            RETURNING id INTO v_thread_id;

            -- A system row has no author (messages_system_authorless); the bot is in metadata.
            INSERT INTO public.messages (created_at, channel_id, content, is_system, metadata)
            VALUES (v_created, v_job.harmony_channel_id,
                    '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                    v_notice || jsonb_build_object('thread_id', v_thread_id));
        END IF;
    ELSE
        v_thread_id := gen_random_uuid();
        INSERT INTO public.messages (created_at, channel_id, content, is_system, metadata)
        VALUES (v_created, v_job.harmony_channel_id,
                '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                v_notice || jsonb_build_object('thread_id', v_thread_id, 'standalone', true))
        RETURNING id INTO v_notice_id;

        INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, auto_archive_duration,
                                    created_at, updated_at, archived, archived_at, locked)
        VALUES (v_thread_id, v_job.harmony_channel_id, v_notice_id, v_name, NULL, 1440, v_created, v_created,
                v_archived, CASE WHEN v_archived THEN v_created END, v_locked);
    END IF;

    INSERT INTO public.discord_bridge_threads (thread_id, bridge_id, discord_thread_id)
    VALUES (v_thread_id, v_job.bridge_id, v_did)
    ON CONFLICT (thread_id) DO NOTHING;

    RETURN v_thread_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.restore_emoji(p_emoji_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_row public.emojis;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_row FROM public.emojis e WHERE e.id = p_emoji_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Emoji not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_emoji(v_row) THEN
        RAISE EXCEPTION 'Not allowed to restore this emoji' USING ERRCODE = '42501';
    END IF;
    IF v_row.deleted_at IS NULL THEN
        RETURN;
    END IF;
    IF public.emoji_name_taken(v_row, v_row.name) THEN
        RAISE EXCEPTION 'An emoji named % exists', v_row.name USING ERRCODE = '23505';
    END IF;
    -- A copy's mirrored emoji (ap_id) is outside the cap: the sync stores what its server lists.
    IF v_row.server_id IS NOT NULL AND v_row.ap_id IS NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('server_emojis:' || v_row.server_id::text, 0));
        IF public.server_emoji_limit() > 0
           AND (SELECT count(*) FROM public.emojis e
                 WHERE e.server_id = v_row.server_id AND e.deleted_at IS NULL) >= public.server_emoji_limit() THEN
            RAISE EXCEPTION 'SERVER_EMOJI_LIMIT: at most % emojis per server', public.server_emoji_limit()
                USING ERRCODE = '23514';
        END IF;
    ELSIF v_row.scope = 'user' AND v_row.uploader IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('user_emojis:' || v_row.uploader::text, 0));
        IF (SELECT count(*) FROM public.emojis e
             WHERE e.scope = 'user' AND e.uploader = v_row.uploader AND e.deleted_at IS NULL)
           >= public.personal_emoji_limit() THEN
            RAISE EXCEPTION 'PERSONAL_EMOJI_LIMIT: at most % personal emojis per user', public.personal_emoji_limit()
                USING ERRCODE = '23514';
        END IF;
    END IF;

    UPDATE public.emojis
       SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
     WHERE id = p_emoji_id;

    IF v_row.server_id IS NULL AND public.is_current_user_admin() THEN
        PERFORM public.log_admin_action(v_me, 'emoji_restore', 'emoji', v_row.id::text,
                                        jsonb_build_object('name', v_row.name, 'scope', v_row.scope));
    END IF;
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_mirror_unreferenced(p_paths text[])
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH wanted AS (
        SELECT DISTINCT p
          FROM unnest(p_paths) p
         WHERE p ~ '^c/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/bridge/[^/]+/[^/]+$'
    ),
    held AS (
        -- idx_messages_media_refs: the expression and predicate repeat the index's.
        SELECT r
          FROM public.messages m
         CROSS JOIN LATERAL unnest(public.message_media_refs(m.content, m.media_paths)) r
         WHERE m.is_deleted IS NOT TRUE
           AND public.message_media_refs(m.content, m.media_paths) && ARRAY(SELECT p FROM wanted)
        UNION
        SELECT r
          FROM public.reports rp
         CROSS JOIN LATERAL unnest(public.message_media_refs(
                   rp.content_snapshot -> 'message' -> 'content',
                   CASE WHEN jsonb_typeof(rp.content_snapshot -> 'message' -> 'media_paths') = 'array'
                        THEN ARRAY(SELECT jsonb_array_elements_text(rp.content_snapshot -> 'message' -> 'media_paths')) END)) r
         WHERE rp.content_snapshot -> 'message' ->> 'channel_id' IN (SELECT split_part(p, '/', 2) FROM wanted)
    )
    SELECT COALESCE(array_agg(w.p), '{}'::text[])
      FROM wanted w
     WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.r = w.p);
$$;

REVOKE ALL ON FUNCTION public.bridge_mirror_unreferenced(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_mirror_unreferenced(text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.server_member_presence(
    p_server_id uuid,
    p_viewer uuid,
    p_like text,
    p_only uuid DEFAULT NULL)
RETURNS TABLE (id uuid, username text, sort_name text, is_local boolean, present boolean, pstatus smallint, mobile boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT m.id, m.username, m.sort_name, m.is_local, m.present,
           CASE WHEN m.present THEN m.shown_status ELSE 0::smallint END,
           m.present AND m.shown_mobile
      FROM (SELECT p.id,
                   COALESCE(p.username, '') AS username,
                   lower(COALESCE(NULLIF(btrim(p.display_name), ''), p.username, '')) AS sort_name,
                   COALESCE(p.is_local, true) AS is_local,
                   CASE WHEN p.id = p_viewer THEN COALESCE(up.status, 1) <> 4
                        ELSE COALESCE(up.published_status, 0) <> 0
                   END AS present,
                   CASE WHEN p.id = p_viewer THEN COALESCE(up.status, 1::smallint)
                        ELSE COALESCE(up.published_status, 0::smallint) END AS shown_status,
                   CASE WHEN p.id = p_viewer THEN COALESCE(up.is_mobile, false)
                        ELSE COALESCE(up.published_mobile, false) END AS shown_mobile
              FROM public.user_servers us
              JOIN public.profiles p ON p.id = us.user_id
              LEFT JOIN public.user_presence up ON up.profile_id = us.user_id
             WHERE us.server_id = p_server_id
               AND (p_only IS NULL OR us.user_id = p_only)
               AND COALESCE(us.status, 'accepted') = 'accepted'
               AND (p_like IS NULL OR p.username ILIKE p_like OR p.display_name ILIKE p_like)) m;
$$;


CREATE OR REPLACE FUNCTION public.get_server_member_list(
    p_server_id uuid,
    p_offset integer DEFAULT 0,
    p_limit integer DEFAULT 100,
    p_query text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me      uuid := public.server_member_reader(p_server_id);
    v_offset  integer := greatest(COALESCE(p_offset, 0), 0);
    v_limit   integer := least(greatest(COALESCE(p_limit, 100), 1), 200);
    v_like    text := public.member_search_pattern(p_query);
    v_live    boolean := NOT public.server_is_large(p_server_id);
    v_order   public.server_member_order;
    v_result  jsonb;
BEGIN
    -- The stored order is the same for every caller.
    IF v_like IS NULL
       AND COALESCE((SELECT st.member_count FROM public.server_member_stats st
                      WHERE st.server_id = p_server_id), 0) > public.member_order_min()
    THEN
        v_order := public.server_member_order_for(public.server_member_order_fresh(p_server_id), v_me);

        WITH bounds AS (
            SELECT e ->> 'key' AS key, n,
                   sum((e ->> 'count')::integer) OVER (ORDER BY n) AS upto
              FROM jsonb_array_elements(v_order.groups) WITH ORDINALITY AS t(e, n)
        ),
        page AS (
            SELECT u.id, v_offset + u.ord AS pos
              FROM unnest(v_order.member_ids[v_offset + 1 : v_offset + v_limit]) WITH ORDINALITY AS u(id, ord)
        )
        SELECT jsonb_build_object(
                   'total', v_order.total,
                   'offset', v_offset,
                   'live', v_live,
                   'max_age_ms', (extract(epoch FROM greatest(interval '5 seconds', v_order.build_ms * interval '20 milliseconds')) * 1000)::integer,
                   'groups', v_order.groups,
                   'members', COALESCE((
                       SELECT jsonb_agg(public.server_member_json(
                                  pr, p_server_id,
                                  (SELECT b.key FROM bounds b WHERE b.upto >= pg.pos ORDER BY b.n LIMIT 1),
                                  CASE WHEN pg.id = v_me THEN COALESCE(up.status, 1) <> 4
                                       ELSE COALESCE(up.published_status, 0) <> 0 END,
                                  CASE WHEN pg.id <> v_me THEN COALESCE(up.published_status, 0::smallint)
                                       WHEN COALESCE(up.status, 1) <> 4 THEN COALESCE(up.status, 1::smallint)
                                       ELSE 0::smallint END,
                                  CASE WHEN pg.id = v_me THEN COALESCE(up.status, 1) <> 4 AND COALESCE(up.is_mobile, false)
                                       ELSE COALESCE(up.published_status, 0) <> 0 AND COALESCE(up.published_mobile, false) END)
                              ORDER BY pg.pos)
                         FROM page pg
                         JOIN public.profiles pr ON pr.id = pg.id
                         LEFT JOIN public.user_presence up ON up.profile_id = pg.id), '[]'::jsonb))
          INTO v_result;
        RETURN v_result;
    END IF;

    WITH keyed AS MATERIALIZED (
        SELECT k.* FROM public.server_member_keyed(p_server_id, v_me, v_like) k
    ),
    page AS (
        SELECT k.*, row_number() OVER (ORDER BY k.grp_rank, k.role_pos DESC, k.grp,
                                                k.sort_name COLLATE public.member_name, k.username, k.id) AS ord
          FROM keyed k
         ORDER BY k.grp_rank, k.role_pos DESC, k.grp, k.sort_name COLLATE public.member_name, k.username, k.id
        OFFSET v_offset
         LIMIT v_limit
    ),
    tally AS (
        SELECT k.grp, min(k.grp_rank) AS grp_rank, max(k.role_pos) AS role_pos, count(*) AS n
          FROM keyed k
         GROUP BY k.grp
    )
    SELECT jsonb_build_object(
               'total', (SELECT count(*) FROM keyed),
               'offset', v_offset,
               'live', v_live,
               'max_age_ms', 0,
               'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', t.grp, 'count', t.n)
                                                    ORDER BY t.grp_rank, t.role_pos DESC, t.grp)
                                     FROM tally t), '[]'::jsonb),
               'members', COALESCE((SELECT jsonb_agg(public.server_member_json(pr, p_server_id, pg.grp, pg.present, pg.pstatus, pg.mobile)
                                                     ORDER BY pg.ord)
                                      FROM page pg
                                      JOIN public.profiles pr ON pr.id = pg.id), '[]'::jsonb))
      INTO v_result;
    RETURN v_result;
END;
$$;


COMMIT;

NOTIFY pgrst, 'reload schema';
