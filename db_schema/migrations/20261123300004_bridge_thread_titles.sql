-- Bridged thread titles and the opt-outs of the authors whose words they are.
--
-- Discord titles a thread started on a message with the message's text. bot_create_thread and
-- bridge_import_thread consulted the opt-out of the member who started the thread only: a thread
-- someone started on an opted-out member's message arrived under that member's words. And
-- bot_create_thread did not receive the thread's creation time, so a live post in a thread started
-- before its starter opted back in kept the old title, where history import renames it Thread.
--
--   bridge_privacy_hides            (server, platform, remote user, written at) -> whether the remote
--                                   user's words of that time stay off Harmony: opted out now, or
--                                   opted back in (bridge_remote_optins) after them. A NULL time
--                                   checks the opt-out only. No API role executes it.
--   bot_create_thread               as 20261115500001_review_round2.sql, with p_created_at (the
--                                   Discord thread's creation time) and p_starter_discord_user_id
--                                   (the author of the Discord message the thread starts on, when
--                                   that message is not on Harmony). The title is 'Thread' when
--                                   bridge_privacy_hides holds for the thread's starter at
--                                   p_created_at, or for the starter message's author at its time:
--                                   the bridged message's discord_user and created_at, else
--                                   p_starter_discord_user_id at the time of p_discord_thread_id (a
--                                   thread on a message shares the message's id). The notice is left
--                                   unattributed for the thread's starter alone, as before. The
--                                   signature changes: the six-argument form is dropped.
--   bridge_import_thread            as 20261123200001_bridge_import_review.sql; the same for the
--                                   starter message: the imported message's discord_user and
--                                   created_at, else p_thread.starter_discord_user_id at the time of
--                                   starter_discord_message_id. The starter message is looked up
--                                   before the title is chosen.
-- Snowflake time: (id >> 22) + 1420070400000 Unix ms.
-- Bodies otherwise, volatility, owners and grants as the migrations named.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.bridge_privacy_hides(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_written_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT p_remote_user_id IS NOT NULL AND (
           EXISTS (SELECT 1 FROM public.bridge_remote_optouts o
                    WHERE o.server_id = p_server_id AND o.platform = p_platform
                      AND o.remote_user_id = p_remote_user_id)
        OR EXISTS (SELECT 1 FROM public.bridge_remote_optins i
                    WHERE i.server_id = p_server_id AND i.platform = p_platform
                      AND i.remote_user_id = p_remote_user_id AND i.opted_in_at > p_written_at));
$$;
REVOKE ALL ON FUNCTION public.bridge_privacy_hides(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.bot_create_thread(uuid, uuid, text, uuid, text, jsonb);

CREATE OR REPLACE FUNCTION public.bot_create_thread(
    p_bot_id uuid,
    p_channel_id uuid,
    p_name text,
    p_parent_message_id uuid DEFAULT NULL,
    p_discord_thread_id text DEFAULT NULL,
    p_discord_user jsonb DEFAULT NULL,
    p_created_at timestamptz DEFAULT NULL,
    p_starter_discord_user_id text DEFAULT NULL)
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
    v_starter_author text;
    v_starter_at timestamptz;
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
    -- the author's text and is not copied. Nor is a title from before the author's last opt-in.
    v_opted := jsonb_typeof(p_discord_user) = 'object'
               AND public.bridge_privacy_hides(v_server_id, 'discord', p_discord_user->>'id', LEAST(p_created_at, now()));
    -- Discord titles a thread on a message from the message: its author's opt-out holds too. The
    -- bridged message names its author; one the bridge left out is named by the bridge, and was
    -- written when the thread's id (the message's) says.
    IF p_parent_message_id IS NOT NULL THEN
        SELECT m.metadata #>> '{discord_user,id}', m.created_at INTO v_starter_author, v_starter_at
          FROM public.messages m
         WHERE m.id = p_parent_message_id;
    ELSIF p_discord_thread_id IS NOT NULL AND p_starter_discord_user_id ~ '^[0-9]{1,20}$' THEN
        v_starter_author := p_starter_discord_user_id;
        v_starter_at := to_timestamp(((floor(p_discord_thread_id::numeric / 4194304) + 1420070400000) / 1000)::double precision);
    END IF;
    IF v_opted OR public.bridge_privacy_hides(v_server_id, 'discord', v_starter_author, v_starter_at) THEN
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

COMMENT ON FUNCTION public.bot_create_thread(uuid, uuid, text, uuid, text, jsonb, timestamptz, text) IS
    'Create a thread as a bot (bot gateway, service role); permissions are checked by the gateway.';

REVOKE ALL ON FUNCTION public.bot_create_thread(uuid, uuid, text, uuid, text, jsonb, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_create_thread(uuid, uuid, text, uuid, text, jsonb, timestamptz, text) TO service_role;

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
    v_server uuid;
    v_starter_author text;
    v_starter_at timestamptz;
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

    -- A person deleted the Harmony thread: it stays deleted.
    IF EXISTS (SELECT 1 FROM public.discord_bridge_deleted_threads d
                WHERE d.bridge_id = v_job.bridge_id AND d.discord_thread_id = v_did) THEN
        RAISE EXCEPTION 'thread_deleted' USING ERRCODE = '55000', DETAIL = v_did;
    END IF;

    IF v_starter IS NOT NULL THEN
        SELECT m.id, m.metadata #>> '{discord_user,id}', m.created_at INTO v_parent, v_starter_author, v_starter_at
          FROM public.messages m
         WHERE m.channel_id = v_job.harmony_channel_id
           AND m.metadata ? 'discord_message_id'
           AND m.metadata ->> 'discord_message_id' = v_starter
           AND m.is_deleted IS NOT TRUE
           AND m.thread_id IS NULL;
        -- A starter the import left out is named by the bridge; the message id says when it was written.
        IF v_parent IS NULL AND v_starter ~ '^[0-9]{1,20}$'
           AND (p_thread ->> 'starter_discord_user_id') ~ '^[0-9]{1,20}$' THEN
            v_starter_author := p_thread ->> 'starter_discord_user_id';
            v_starter_at := to_timestamp(((floor(v_starter::numeric / 4194304) + 1420070400000) / 1000)::double precision);
        END IF;
    END IF;

    -- The title is the author's text: the thread of an opted-out author, or one started before its
    -- author's last opt-in, is imported under a plain name. Discord titles a thread on a message
    -- from the message, so the same holds for the message's author.
    SELECT b.server_id INTO v_server FROM public.discord_bridges b WHERE b.id = v_job.bridge_id;
    v_opted := jsonb_typeof(v_user) = 'object'
               AND public.bridge_privacy_hides(v_server, 'discord', v_user ->> 'id', v_created);
    IF v_opted OR public.bridge_privacy_hides(v_server, 'discord', v_starter_author, v_starter_at) THEN
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

COMMIT;

NOTIFY pgrst, 'reload schema';
