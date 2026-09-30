-- Role mentions follow MENTION_EVERYONE and server_roles.mentionable.
--
-- handle_role_mention_notifications() notified every accepted member for an @everyone part and
-- every holder of a role for a role part, whoever sent it. The rule, as in Discord:
--
--   @everyone (the is_default role)   sender holds MENTION_EVERYONE in the channel
--   any other role                    the role is mentionable, or the sender holds
--                                     MENTION_EVERYONE in the channel
--
-- A user sender is checked with has_permission(), which applies channel overrides. A bot sender
-- is checked with check_bot_permission(bot, server, 'mention_everyone'). A message with neither
-- author mentions nothing. A refused part still renders; it notifies no one.
--
-- Production runs an older body of this function (sender fields built inline, no is_everyone or
-- is_role_mention flags); this definition replaces either.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.handle_role_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server_id uuid;
    v_channel_id uuid;
    v_channel_name text;
    v_server_name text;
    v_sender_profile profiles%ROWTYPE;
    v_sender_json jsonb;
    v_can_mention_all boolean;
    v_role_id uuid;
    v_role_is_default boolean;
    v_role_mentionable boolean;
    v_member_id uuid;
    content_part jsonb;
    content_preview text;
BEGIN
    IF NEW.channel_id IS NULL OR NEW.is_system THEN
        RETURN NEW;
    END IF;

    SELECT c.server_id, c.name INTO v_server_id, v_channel_name
    FROM channels c WHERE c.id = NEW.channel_id;
    IF v_server_id IS NULL THEN RETURN NEW; END IF;

    IF jsonb_typeof(NEW.content) != 'array' THEN RETURN NEW; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) elem
        WHERE elem->>'type' = 'role_mention'
    ) THEN
        RETURN NEW;
    END IF;

    IF NEW.bot_id IS NOT NULL THEN
        v_can_mention_all := check_bot_permission(NEW.bot_id, v_server_id, 'mention_everyone');
    ELSIF NEW.user_id IS NOT NULL THEN
        v_can_mention_all := has_permission(NEW.user_id, v_server_id, 'MENTION_EVERYONE', NEW.channel_id);
    ELSE
        RETURN NEW;
    END IF;

    SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;

    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;

    v_sender_json := message_notification_sender_json(
        NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile
    );

    content_preview := LEFT(
        (SELECT string_agg(elem->>'text', ' ')
         FROM jsonb_array_elements(NEW.content) elem
         WHERE elem->>'type' = 'text'), 100);

    v_channel_id := NEW.channel_id;

    FOR content_part IN SELECT jsonb_array_elements(NEW.content)
    LOOP
        IF content_part->>'type' = 'role_mention' THEN
            v_role_id := (content_part->>'roleId')::uuid;
            IF v_role_id IS NULL THEN CONTINUE; END IF;

            SELECT is_default, COALESCE(mentionable, true)
              INTO v_role_is_default, v_role_mentionable
            FROM server_roles WHERE id = v_role_id AND server_id = v_server_id;

            IF NOT FOUND THEN CONTINUE; END IF;

            IF v_role_is_default THEN
                IF NOT v_can_mention_all THEN CONTINUE; END IF;

                FOR v_member_id IN
                    SELECT us.user_id FROM user_servers us
                    WHERE us.server_id = v_server_id
                      AND us.status = 'accepted'
                      AND (NEW.user_id IS NULL OR us.user_id <> NEW.user_id)
                LOOP
                    PERFORM send_notification_to_user(
                        'mention', v_member_id,
                        jsonb_build_object(
                            'sender', v_sender_json,
                            'message', jsonb_build_object('id', NEW.id, 'content_preview', content_preview),
                            'location', jsonb_build_object(
                                'server_id', v_server_id::text,
                                'server_name', v_server_name,
                                'channel_id', v_channel_id::text,
                                'channel_name', v_channel_name
                            ),
                            'message_id', NEW.id,
                            'mentioned_by', NEW.user_id,
                            'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                            'sender_display_name', COALESCE(
                                v_sender_json->>'display_name',
                                v_sender_profile.display_name
                            ),
                            'server_id', v_server_id::text,
                            'server_name', v_server_name,
                            'channel_id', v_channel_id::text,
                            'channel_name', v_channel_name,
                            'preview', content_preview,
                            'is_role_mention', true,
                            'is_everyone', true
                        ),
                        v_server_id, v_channel_id, NULL, NEW.user_id, 'normal'
                    );
                END LOOP;
            ELSE
                IF NOT (v_role_mentionable OR v_can_mention_all) THEN CONTINUE; END IF;

                FOR v_member_id IN
                    SELECT ur.user_id FROM user_roles ur
                    WHERE ur.role_id = v_role_id
                      AND ur.server_id = v_server_id
                      AND (NEW.user_id IS NULL OR ur.user_id <> NEW.user_id)
                LOOP
                    PERFORM send_notification_to_user(
                        'mention', v_member_id,
                        jsonb_build_object(
                            'sender', v_sender_json,
                            'message', jsonb_build_object('id', NEW.id, 'content_preview', content_preview),
                            'location', jsonb_build_object(
                                'server_id', v_server_id::text,
                                'server_name', v_server_name,
                                'channel_id', v_channel_id::text,
                                'channel_name', v_channel_name
                            ),
                            'message_id', NEW.id,
                            'mentioned_by', NEW.user_id,
                            'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                            'sender_display_name', COALESCE(
                                v_sender_json->>'display_name',
                                v_sender_profile.display_name
                            ),
                            'server_id', v_server_id::text,
                            'server_name', v_server_name,
                            'channel_id', v_channel_id::text,
                            'channel_name', v_channel_name,
                            'preview', content_preview,
                            'is_role_mention', true
                        ),
                        v_server_id, v_channel_id, NULL, NEW.user_id, 'normal'
                    );
                END LOOP;
            END IF;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_role_mention_notifications() FROM PUBLIC, anon, authenticated;

COMMIT;
