-- bot_create_thread takes the Discord member who started a bridged thread and records them
-- as the notice's discord_user, so the notice reads "<member> started a thread" rather than
-- under the bridge bot. The five-argument form is replaced.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.bot_create_thread(uuid, uuid, text, uuid, text);

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

    v_notice := jsonb_build_object('type', 'thread_created', 'thread_name', v_name, 'bridge_source', 'discord');
    -- The Discord member who started the thread names the notice (messageAuthor.ts discord_user).
    IF jsonb_typeof(p_discord_user) = 'object' AND p_discord_user->>'id' ~ '^[0-9]{1,20}$' THEN
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

            INSERT INTO public.messages (channel_id, bot_id, content, is_system, metadata)
            VALUES (p_channel_id, p_bot_id,
                    '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                    v_notice || jsonb_build_object('thread_id', v_thread_id));
        END IF;
    ELSE
        v_thread_id := gen_random_uuid();
        INSERT INTO public.messages (channel_id, bot_id, content, is_system, metadata)
        VALUES (p_channel_id, p_bot_id,
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

COMMENT ON FUNCTION public.bot_create_thread(uuid, uuid, text, uuid, text, jsonb) IS
    'Create a thread as a bot (bot gateway, service role); permissions are checked by the gateway.';

REVOKE ALL ON FUNCTION public.bot_create_thread(uuid, uuid, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_create_thread(uuid, uuid, text, uuid, text, jsonb) TO service_role;

COMMIT;
