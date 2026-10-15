-- Threads across the Discord bridge.
--
-- discord_bridge_threads pairs a Harmony thread with a Discord thread of the same bridge. Only
-- the service role (bot gateway) reads or writes it; a client pointing a Harmony thread at an
-- arbitrary Discord thread would steer the bridge.
--
-- bot_create_thread creates a thread as a bot, which has no profile for create_thread or
-- create_channel_thread to resolve: on a message (a Discord thread started from a bridged
-- message) or standalone, with the "started a thread" notice. Passing a Discord thread id
-- makes it idempotent per bridge: the paired thread comes back instead of a second one.
--
-- Bot-authored thread messages: thread_message_handler inserted a thread_members row for
-- NEW.user_id, NULL for a bot, which thread_members.user_id rejects; such inserts failed.
-- handle_thread_reply_notification compared tm.user_id != NEW.user_id, NULL for a bot, so a
-- bridged reply notified nobody; the sender now comes from message_notification_sender_json.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.discord_bridge_threads (
    thread_id uuid PRIMARY KEY REFERENCES public.threads(id) ON DELETE CASCADE,
    bridge_id uuid NOT NULL REFERENCES public.discord_bridges(id) ON DELETE CASCADE,
    discord_thread_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT discord_bridge_threads_snowflake_check CHECK (discord_thread_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_bridge_threads_bridge_discord_key UNIQUE (bridge_id, discord_thread_id)
);

ALTER TABLE public.discord_bridge_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS discord_bridge_threads_service_role ON public.discord_bridge_threads;
CREATE POLICY discord_bridge_threads_service_role ON public.discord_bridge_threads
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.discord_bridge_threads FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.discord_bridge_threads TO service_role;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.thread_message_handler()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.thread_id IS NOT NULL THEN
        -- A bot author has no profile to enrol.
        IF NEW.user_id IS NOT NULL THEN
            INSERT INTO public.thread_members (thread_id, user_id)
            VALUES (NEW.thread_id, NEW.user_id)
            ON CONFLICT (thread_id, user_id) DO NOTHING;
        END IF;

        UPDATE public.threads
        SET
            message_count = message_count + 1,
            last_message_id = NEW.id,
            last_message_at = NEW.created_at,
            updated_at = NOW(),
            archived = CASE WHEN locked THEN archived ELSE false END,
            archived_at = CASE WHEN locked THEN archived_at ELSE NULL END
        WHERE id = NEW.thread_id;

        UPDATE public.threads t
        SET member_count = (
            SELECT COUNT(*) FROM public.thread_members tm WHERE tm.thread_id = t.id
        )
        WHERE t.id = NEW.thread_id;
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_thread_reply_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_thread record;
    v_sender_profile profiles%ROWTYPE;
    v_sender jsonb;
    v_channel_id uuid;
    v_server_id uuid;
    v_channel_name text;
    v_server_name text;
    content_preview text;
    v_recipient uuid;
BEGIN
    IF NEW.thread_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT t.id, t.parent_message_id, t.channel_id, t.created_by
    INTO v_thread
    FROM threads t WHERE t.id = NEW.thread_id;

    IF NOT FOUND THEN RETURN NEW; END IF;

    v_channel_id := v_thread.channel_id;

    SELECT c.server_id, c.name INTO v_server_id, v_channel_name
    FROM channels c WHERE c.id = v_channel_id;

    IF v_server_id IS NOT NULL THEN
        SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;
    END IF;

    IF NEW.user_id IS NOT NULL THEN
        SELECT * INTO v_sender_profile FROM profiles p WHERE p.id = NEW.user_id;
    END IF;
    -- A bridged Discord author or a bot reads as itself, not as an empty profile.
    v_sender := message_notification_sender_json(NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile);
    IF NEW.user_id IS NOT NULL THEN
        v_sender := v_sender || jsonb_build_object('user_id', NEW.user_id);
    END IF;

    content_preview := TRIM(extract_message_text(NEW.content));
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New thread reply';
    END IF;

    -- Thread members, and the creator when not a member.
    FOR v_recipient IN
        SELECT tm.user_id
          FROM thread_members tm
         WHERE tm.thread_id = NEW.thread_id
           AND tm.user_id IS DISTINCT FROM NEW.user_id
           AND COALESCE(tm.muted, false) = false
        UNION
        SELECT v_thread.created_by
         WHERE v_thread.created_by IS NOT NULL
           AND v_thread.created_by IS DISTINCT FROM NEW.user_id
           AND NOT EXISTS (
               SELECT 1 FROM thread_members
                WHERE thread_id = NEW.thread_id AND user_id = v_thread.created_by
           )
    LOOP
        PERFORM send_notification_to_user(
            'thread_reply',
            v_recipient,
            jsonb_build_object(
                'sender', v_sender,
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', content_preview
                ),
                'thread', jsonb_build_object(
                    'id', NEW.thread_id,
                    'parent_message_id', v_thread.parent_message_id
                ),
                'location', jsonb_build_object(
                    'server_id', v_server_id::text,
                    'server_name', v_server_name,
                    'channel_id', v_channel_id::text,
                    'channel_name', v_channel_name
                ),
                'message_id', NEW.id,
                'thread_id', NEW.thread_id,
                'server_id', v_server_id::text,
                'channel_id', v_channel_id::text,
                'preview', content_preview
            ),
            v_server_id,
            v_channel_id,
            NULL,
            NEW.user_id,
            'normal'
        );
    END LOOP;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bot_create_thread(
    p_bot_id uuid,
    p_channel_id uuid,
    p_name text,
    p_parent_message_id uuid DEFAULT NULL,
    p_discord_thread_id text DEFAULT NULL)
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
                    jsonb_build_object('type', 'thread_created', 'thread_id', v_thread_id,
                                       'thread_name', v_name, 'bridge_source', 'discord'));
        END IF;
    ELSE
        v_thread_id := gen_random_uuid();
        INSERT INTO public.messages (channel_id, bot_id, content, is_system, metadata)
        VALUES (p_channel_id, p_bot_id,
                '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                jsonb_build_object('type', 'thread_created', 'thread_id', v_thread_id,
                                   'thread_name', v_name, 'standalone', true, 'bridge_source', 'discord'))
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

COMMENT ON FUNCTION public.bot_create_thread(uuid, uuid, text, uuid, text) IS
    'Create a thread as a bot (bot gateway, service role); permissions are checked by the gateway.';

REVOKE ALL ON FUNCTION public.bot_create_thread(uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_create_thread(uuid, uuid, text, uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
