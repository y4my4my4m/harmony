-- Which threads the channel sidebar lists: every active thread ('all') or only the threads the
-- viewer has joined ('joined'). A server picks a mode; a server with none follows the instance
-- default.
--
--   server_settings.thread_sidebar       'all' | 'joined' | NULL. NULL follows instance_config
--                                        'thread_sidebar_default'; an absent or unrecognised
--                                        default reads as 'all'.
--   server_thread_sidebar_state(uuid)    {mode, server_value, instance_default}. mode is the
--                                        effective mode. Invoker, service_role only.
--   get_server_thread_sidebar(uuid)      the state, for a local server's MANAGE_SERVER holders.
--   set_server_thread_sidebar(uuid,text) stores 'all', 'joined' or NULL (back to the instance
--                                        default); any other value raises 22023. Returns the
--                                        state. Same guard as get.
--   server_thread_sidebar_mode(uuid)     the effective mode, for any member of the server
--                                        (42501 otherwise). Definer.
--   thread_message_handler()             redefined: a specific @mention in a thread reply adds the
--                                        mentioned account to the thread (thread_members, which also
--                                        ends a departure and recounts member_count), when the account
--                                        can view the channel, has not blocked the author, and is not
--                                        the author. Roles, @everyone and @here add no one. Nothing
--                                        under the history-import flag, nor for a system or deleted
--                                        reply.
--   handle_message_federation()          redefined: a mention notification's data carries thread
--                                        {id} when the message is a thread reply, else null.
--
-- Converges on rerun: every statement is idempotent.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.server_settings
    ADD COLUMN IF NOT EXISTS thread_sidebar text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.server_settings'::regclass
                      AND conname = 'server_settings_thread_sidebar_check') THEN
        ALTER TABLE public.server_settings
            ADD CONSTRAINT server_settings_thread_sidebar_check
            CHECK (thread_sidebar IN ('all', 'joined'));
    END IF;
END;
$$;

COMMENT ON COLUMN public.server_settings.thread_sidebar IS
    'Threads the channel sidebar lists: all or joined. NULL follows instance_config thread_sidebar_default.';

-- mode is the effective mode; server_value is NULL when the server follows the instance.
CREATE OR REPLACE FUNCTION public.server_thread_sidebar_state(p_server_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'mode', COALESCE(ss.thread_sidebar, d.instance_default),
        'server_value', ss.thread_sidebar,
        'instance_default', d.instance_default)
      FROM (SELECT COALESCE((SELECT CASE WHEN ic.config_value #>> '{}' = 'joined' THEN 'joined' ELSE 'all' END
                               FROM public.instance_config ic
                              WHERE ic.config_key = 'thread_sidebar_default'), 'all')
                   AS instance_default) d
      LEFT JOIN public.server_settings ss ON ss.server_id = p_server_id;
$$;

REVOKE ALL ON FUNCTION public.server_thread_sidebar_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_thread_sidebar_state(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_server_thread_sidebar(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE)
       OR NOT public.has_permission(v_caller, p_server_id, 'MANAGE_SERVER') THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;
    RETURN public.server_thread_sidebar_state(p_server_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_server_thread_sidebar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_server_thread_sidebar(uuid) TO authenticated, service_role;

-- p_mode NULL returns the server to the instance default.
CREATE OR REPLACE FUNCTION public.set_server_thread_sidebar(p_server_id uuid, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE)
       OR NOT public.has_permission(v_caller, p_server_id, 'MANAGE_SERVER') THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;
    IF p_mode IS NOT NULL AND p_mode NOT IN ('all', 'joined') THEN
        RAISE EXCEPTION 'Thread sidebar mode must be all or joined' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.server_settings (server_id, thread_sidebar)
    VALUES (p_server_id, p_mode)
    ON CONFLICT (server_id) DO UPDATE
    SET thread_sidebar = EXCLUDED.thread_sidebar,
        updated_at = now();

    RETURN public.server_thread_sidebar_state(p_server_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_server_thread_sidebar(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_server_thread_sidebar(uuid, text) TO authenticated, service_role;

-- The effective mode for a member's own client; the setting itself is for managers.
CREATE OR REPLACE FUNCTION public.server_thread_sidebar_mode(p_server_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.current_user_is_member_of_server(p_server_id) THEN
        RAISE EXCEPTION 'Not a member of this server' USING ERRCODE = '42501';
    END IF;
    RETURN public.server_thread_sidebar_state(p_server_id)->>'mode';
END;
$$;

REVOKE ALL ON FUNCTION public.server_thread_sidebar_mode(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.server_thread_sidebar_mode(uuid) TO authenticated, service_role;

-- A mention in a thread reply adds the member; the rest is the body as the history-import
-- migration left it.
CREATE OR REPLACE FUNCTION public.thread_message_handler()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_part jsonb;
    v_uid uuid;
    v_domain text;
    v_domain_read boolean := false;
BEGIN
    IF NEW.thread_id IS NOT NULL THEN
        -- A bot author has no profile to enrol.
        IF NEW.user_id IS NOT NULL THEN
            INSERT INTO public.thread_members (thread_id, user_id)
            VALUES (NEW.thread_id, NEW.user_id)
            ON CONFLICT (thread_id, user_id) DO NOTHING;
        END IF;
        -- A specific @mention in a reply adds the member: a viewer of the channel who has not
        -- blocked the author, back from leaving too. Roles, @everyone and @here add no one.
        IF NEW.is_system IS NOT TRUE AND NEW.is_deleted IS NOT TRUE
           AND NOT public.is_history_import()
           AND jsonb_typeof(NEW.content) = 'array' THEN
            FOR v_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                IF v_part->>'type' = 'mention' THEN
                    -- The instance domain is read on the first mention only.
                    IF NOT v_domain_read THEN
                        SELECT trim(both '"' from config_value::text) INTO v_domain
                          FROM public.instance_config WHERE config_key = 'domain' LIMIT 1;
                        v_domain_read := true;
                    END IF;
                    v_uid := public.resolve_mention_profile_id(v_part, NEW.user_id, v_domain);
                    IF v_uid IS NOT NULL
                       AND v_uid IS DISTINCT FROM NEW.user_id
                       AND public.can_view_channel(v_uid, NEW.channel_id)
                       AND NOT EXISTS (SELECT 1 FROM public.user_blocks b
                                        WHERE b.blocker_id = v_uid AND b.blocked_user_id = NEW.user_id) THEN
                        INSERT INTO public.thread_members (thread_id, user_id)
                        VALUES (NEW.thread_id, v_uid)
                        ON CONFLICT (thread_id, user_id) DO NOTHING;
                    END IF;
                END IF;
            END LOOP;
        END IF;
        IF public.is_history_import() THEN
            UPDATE public.threads
            SET message_count = message_count + 1,
                last_message_at = COALESCE(last_message_at, NEW.created_at)
            WHERE id = NEW.thread_id;
        ELSE
            UPDATE public.threads
            SET
                message_count = message_count + 1,
                last_message_id = NEW.id,
                last_message_at = NEW.created_at,
                updated_at = NOW(),
                archived = CASE WHEN locked THEN archived ELSE false END,
                archived_at = CASE WHEN locked THEN archived_at ELSE NULL END
            WHERE id = NEW.thread_id;
        END IF;
        UPDATE public.threads t
        SET member_count = (
            SELECT COUNT(*) FROM public.thread_members tm WHERE tm.thread_id = t.id
        )
        WHERE t.id = NEW.thread_id;
    END IF;
    RETURN NEW;
END;
$function$;

-- The mention notification names the thread so the client can open it.
CREATE OR REPLACE FUNCTION public.handle_message_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_federation_type TEXT;
    v_sender_profile profiles%ROWTYPE;
    content_part JSONB;
    mentioned_user_id UUID;
    current_domain TEXT;
    v_channel_id uuid;
    v_server_id uuid;
    v_channel_name TEXT;
    v_server_name TEXT;
    content_preview TEXT;
    v_sender_json jsonb;
    -- A system row has no author; its actor sends the notification.
    v_sender_id uuid := NEW.user_id;
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    v_federation_type := determine_message_federation_type(NEW.id);

    IF NEW.is_system IS TRUE AND NEW.metadata ->> 'actor_id'
       ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_sender_id := (NEW.metadata ->> 'actor_id')::uuid;
    END IF;

    SELECT * INTO v_sender_profile FROM profiles WHERE id = v_sender_id;

    content_preview := extract_message_text(NEW.content);
    content_preview := TRIM(content_preview);
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New message';
    END IF;

    v_sender_json := message_notification_sender_json(
        v_sender_id, NEW.bot_id, NEW.metadata, v_sender_profile
    );

    -- Channel mention notifications (includes federated messages)
    IF NEW.channel_id IS NOT NULL AND NOT NEW.is_system THEN
        v_channel_id := NEW.channel_id;

        SELECT c.name, c.server_id INTO v_channel_name, v_server_id
        FROM channels c WHERE c.id = v_channel_id;

        IF FOUND AND v_server_id IS NOT NULL THEN
            SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;
        END IF;

        SELECT trim(both '"' from config_value::text) INTO current_domain
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;

        IF jsonb_typeof(NEW.content) = 'array' THEN
            FOR content_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                IF content_part->>'type' = 'mention' THEN
                    mentioned_user_id := resolve_mention_profile_id(
                        content_part, NEW.user_id, current_domain
                    );

                    IF mentioned_user_id IS NOT NULL THEN
                        PERFORM send_notification_to_user(
                            'mention',
                            mentioned_user_id,
                            jsonb_build_object(
                                'sender', v_sender_json,
                                'message', jsonb_build_object(
                                    'id', NEW.id,
                                    'content_preview', content_preview
                                ),
                                'location', jsonb_build_object(
                                    'server_id', COALESCE(v_server_id::text, NULL),
                                    'server_name', COALESCE(v_server_name, NULL),
                                    'channel_id', COALESCE(v_channel_id::text, NULL),
                                    'channel_name', COALESCE(v_channel_name, NULL)
                                ),
                                'thread', CASE WHEN NEW.thread_id IS NULL THEN NULL
                                               ELSE jsonb_build_object('id', NEW.thread_id) END,
                                'message_id', NEW.id,
                                'mentioned_by', NEW.user_id,
                                'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                                'sender_display_name', COALESCE(
                                    v_sender_json->>'display_name',
                                    v_sender_profile.display_name
                                ),
                                'server_id', COALESCE(v_server_id::text, NULL),
                                'server_name', COALESCE(v_server_name, NULL),
                                'channel_id', COALESCE(v_channel_id::text, NULL),
                                'channel_name', COALESCE(v_channel_name, NULL),
                                'preview', content_preview
                            ),
                            v_server_id,
                            v_channel_id,
                            NULL,
                            NEW.user_id,
                            'normal'
                        );
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END IF;

    -- DM / group chat notifications
    CASE v_federation_type
        WHEN 'chat_local_only' THEN
            PERFORM send_notification(
                'chat_message',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND (v_sender_id IS NULL OR cp.user_id <> v_sender_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview
                ),
                NULL, NULL, NEW.conversation_id, v_sender_id, 'normal'
            );

        WHEN 'dm_local_only' THEN
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND (v_sender_id IS NULL OR cp.user_id <> v_sender_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview
                ),
                NULL, NULL, NEW.conversation_id, v_sender_id, 'normal'
            );

        WHEN 'dm_federated' THEN
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND (v_sender_id IS NULL OR cp.user_id <> v_sender_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview,
                    'federated', true
                ),
                NULL, NULL, NEW.conversation_id, v_sender_id, 'normal'
            );
    END CASE;

    RETURN NEW;

EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Message federation processing failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
