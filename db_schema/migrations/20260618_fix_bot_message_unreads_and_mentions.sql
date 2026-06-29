-- Bot/bridge messages have user_id = NULL. Fixes:
-- 1) handle_new_message_unread skipped all members (NULL != user_id is unknown in SQL)
-- 2) handle_message_federation used id != NEW.user_id for mentions (same NULL trap)
-- 3) Mention parts from /m include userId; resolve via structured lookup

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_mention_profile_id(
  p_part jsonb,
  p_sender_user_id uuid,
  p_current_domain text
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_username text;
  v_domain text;
BEGIN
  IF p_part->>'type' IS DISTINCT FROM 'mention' THEN
    RETURN NULL;
  END IF;

  IF (p_part->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT id INTO v_user_id
    FROM profiles
    WHERE id = (p_part->>'userId')::uuid
      AND (p_sender_user_id IS NULL OR id <> p_sender_user_id);
    IF v_user_id IS NOT NULL THEN
      RETURN v_user_id;
    END IF;
  END IF;

  v_username := p_part->>'username';
  v_domain := p_part->>'domain';
  IF v_username IS NULL OR v_username = '' THEN
    RETURN NULL;
  END IF;

  IF v_domain IS NULL OR v_domain = p_current_domain THEN
    SELECT id INTO v_user_id
    FROM profiles
    WHERE username = v_username
      AND (domain IS NULL OR domain = p_current_domain)
      AND is_local = true
      AND (p_sender_user_id IS NULL OR id <> p_sender_user_id);
  ELSE
    SELECT id INTO v_user_id
    FROM profiles
    WHERE username = v_username
      AND domain = v_domain
      AND (p_sender_user_id IS NULL OR id <> p_sender_user_id);
  END IF;

  RETURN v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.message_notification_sender_json(
  p_user_id uuid,
  p_bot_id uuid,
  p_metadata jsonb,
  p_sender_profile profiles
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_bot bots%ROWTYPE;
BEGIN
  IF p_user_id IS NOT NULL THEN
    RETURN notification_actor_json(p_sender_profile);
  END IF;

  IF p_metadata IS NOT NULL AND p_metadata ? 'discord_user' THEN
    RETURN jsonb_build_object(
      'username', p_metadata->'discord_user'->>'username',
      'display_name', COALESCE(
        p_metadata->'discord_user'->>'display_name',
        p_metadata->'discord_user'->>'username'
      ),
      'avatar_url', p_metadata->'discord_user'->>'avatar_url',
      'is_local', false,
      'handle', '@' || COALESCE(p_metadata->'discord_user'->>'username', 'discord')
    );
  END IF;

  IF p_bot_id IS NOT NULL THEN
    SELECT * INTO v_bot FROM bots WHERE id = p_bot_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'username', v_bot.username,
        'display_name', COALESCE(v_bot.display_name, v_bot.username),
        'avatar_url', v_bot.avatar_url,
        'is_local', false,
        'handle', '@' || v_bot.username
      );
    END IF;
  END IF;

  RETURN '{}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    v_sender_json := message_notification_sender_json(
        NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile
    );

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

    CASE v_federation_type
        WHEN 'chat_local_only' THEN
            PERFORM send_notification(
                'chat_message',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND (NEW.user_id IS NULL OR cp.user_id <> NEW.user_id)
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
                    AND (NEW.user_id IS NULL OR cp.user_id <> NEW.user_id)
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
                    AND (NEW.user_id IS NULL OR cp.user_id <> NEW.user_id)
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

CREATE OR REPLACE FUNCTION public.handle_new_message_unread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_id uuid;
BEGIN
    IF NEW.channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT server_id INTO v_server_id
    FROM public.channels WHERE id = NEW.channel_id;

    IF v_server_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.unread_counts (user_id, server_id, channel_id, unread_messages)
    SELECT us.user_id, v_server_id, NEW.channel_id, 1
    FROM public.user_servers us
    WHERE us.server_id = v_server_id
      AND us.status = 'accepted'
      AND (NEW.user_id IS NULL OR us.user_id <> NEW.user_id)
      AND NOT EXISTS (
          SELECT 1 FROM public.notification_channels nc
          WHERE nc.user_id = us.user_id
            AND nc.channel_id = NEW.channel_id
            AND nc.muted = true
            AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
      )
    ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
    DO UPDATE SET
        unread_messages = unread_counts.unread_messages + 1,
        updated_at = now();

    RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
