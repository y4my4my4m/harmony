BEGIN;

-- ============================================================
-- Migration: DM / Group Chat Notifications
-- Replaces the placeholder handle_message_federation() with the
-- full implementation that sends notifications for DM and group
-- chat messages.  Also adds a trigger on conversation_participants
-- to notify users when they are added to a conversation.
-- ============================================================

-- 1. Helper: classify a message as chat_local_only, dm_local_only,
--    or dm_federated so the trigger can decide what notifications to send.
CREATE OR REPLACE FUNCTION public.determine_message_federation_type(p_message_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_channel_id UUID;
  v_conversation_id UUID;
  v_remote_participant_count INTEGER := 0;
BEGIN
  SELECT channel_id, conversation_id
  INTO v_channel_id, v_conversation_id
  FROM messages
  WHERE id = p_message_id;

  IF v_channel_id IS NOT NULL THEN
    RETURN 'chat_local_only';
  ELSIF v_conversation_id IS NOT NULL THEN
    SELECT COUNT(DISTINCT cp.user_id)
    INTO v_remote_participant_count
    FROM conversation_participants cp
    JOIN profiles p ON cp.user_id = p.id
    WHERE cp.conversation_id = v_conversation_id
      AND NOT p.is_local
      AND cp.left_at IS NULL;

    IF v_remote_participant_count > 0 THEN
      RETURN 'dm_federated';
    ELSE
      RETURN 'dm_local_only';
    END IF;
  END IF;

  RETURN 'unknown';
END;
$$;


-- 2. Full implementation of handle_message_federation()
--    Sends notifications for channel mentions, DMs and group chat messages.
CREATE OR REPLACE FUNCTION public.handle_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_federation_type TEXT;
    v_sender_profile profiles%ROWTYPE;
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    mentioned_domain TEXT;
    current_domain TEXT;
    v_channel_id uuid;
    v_server_id uuid;
    v_channel_name TEXT;
    v_server_name TEXT;
    content_preview TEXT;
BEGIN
    v_federation_type := determine_message_federation_type(NEW.id);

    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;

    content_preview := extract_message_text(NEW.content);
    content_preview := TRIM(content_preview);
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New message';
    END IF;

    -- Channel mention notifications
    IF NEW.channel_id IS NOT NULL AND NOT NEW.is_system AND NOT COALESCE((NEW.metadata->>'federated')::boolean, false) THEN
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
                    mentioned_username := content_part->>'username';
                    mentioned_domain  := content_part->>'domain';

                    IF mentioned_domain IS NULL OR mentioned_domain = current_domain THEN
                        SELECT id INTO mentioned_user_id
                        FROM profiles
                        WHERE username = mentioned_username
                          AND (domain IS NULL OR domain = current_domain)
                          AND is_local = true
                          AND id != NEW.user_id;
                    ELSE
                        SELECT id INTO mentioned_user_id
                        FROM profiles
                        WHERE username = mentioned_username
                          AND domain = mentioned_domain
                          AND id != NEW.user_id;
                    END IF;

                    IF mentioned_user_id IS NOT NULL THEN
                        PERFORM send_notification_to_user(
                            'mention',
                            mentioned_user_id,
                            jsonb_build_object(
                                'sender', jsonb_build_object(
                                    'user_id', v_sender_profile.id,
                                    'username', v_sender_profile.username,
                                    'display_name', v_sender_profile.display_name,
                                    'avatar_url', v_sender_profile.avatar_url
                                ),
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
                                'message_id', NEW.id,
                                'mentioned_by', NEW.user_id,
                                'sender_username', v_sender_profile.username,
                                'sender_display_name', v_sender_profile.display_name,
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
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );

        WHEN 'dm_local_only' THEN
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );

        WHEN 'dm_federated' THEN
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview,
                    'federated', true
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
    END CASE;

    RETURN NEW;

EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Message federation processing failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$;


-- 3. Trigger function: notify a user when they are added to a conversation
CREATE OR REPLACE FUNCTION public.handle_conversation_participant_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_conversation conversations%ROWTYPE;
    v_inviter profiles%ROWTYPE;
    v_added_profile profiles%ROWTYPE;
    v_conversation_name TEXT;
BEGIN
    -- Only fire on fresh inserts (not on re-joins via ON CONFLICT left_at = NULL)
    IF NEW.left_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_added_profile FROM profiles WHERE id = NEW.user_id;
    IF NOT v_added_profile.is_local THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_conversation FROM conversations WHERE id = NEW.conversation_id;

    -- Determine a human-readable name for the conversation
    v_conversation_name := v_conversation.name;
    IF v_conversation_name IS NULL OR v_conversation_name = '' THEN
        v_conversation_name := 'a group conversation';
    END IF;

    -- Try to find the creator / inviter (the most recent other participant
    -- who was added in the same second - a heuristic for batch inserts from
    -- create_group_conversation).  Falls back to the conversation creator
    -- if available, otherwise NULL.
    SELECT p.* INTO v_inviter
    FROM conversation_participants cp
    JOIN profiles p ON p.id = cp.user_id
    WHERE cp.conversation_id = NEW.conversation_id
      AND cp.user_id != NEW.user_id
      AND cp.role = 'admin'
    ORDER BY cp.joined_at ASC
    LIMIT 1;

    -- Send a DM-style notification so the frontend already knows how to handle it
    PERFORM send_notification_to_user(
        'dm',
        NEW.user_id,
        jsonb_build_object(
            'sender', jsonb_build_object(
                'user_id', COALESCE(v_inviter.id, '00000000-0000-0000-0000-000000000000'),
                'username', COALESCE(v_inviter.username, 'system'),
                'display_name', COALESCE(v_inviter.display_name, v_inviter.username, 'System'),
                'avatar_url', v_inviter.avatar_url
            ),
            'conversation', jsonb_build_object(
                'id', NEW.conversation_id,
                'name', v_conversation_name
            ),
            'conversation_id', NEW.conversation_id,
            'preview', 'You were added to ' || v_conversation_name,
            'is_invite', true
        ),
        NULL, NULL, NEW.conversation_id,
        v_inviter.id,
        'normal'
    );

    RETURN NEW;

EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Conversation participant notification failed for %: %', NEW.user_id, SQLERRM;
        RETURN NEW;
END;
$$;

-- 4. Create the trigger (idempotent)
DROP TRIGGER IF EXISTS trg_conversation_participant_added ON conversation_participants;
CREATE TRIGGER trg_conversation_participant_added
    AFTER INSERT ON public.conversation_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_conversation_participant_added();

COMMIT;
