BEGIN;

-- Canonical web handle (@user vs @user@domain). Used in notification payloads and profiles.web_handle.

CREATE OR REPLACE FUNCTION public.profile_web_handle(
  p_username text,
  p_domain text,
  p_is_local boolean
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Mirrors the profiles.web_handle generated column. Falls back to the bare
  -- '@username' when a remote profile has no resolvable domain so we never emit
  -- a NULL handle (string || NULL = NULL in SQL).
  SELECT CASE
    WHEN COALESCE(p_is_local, true) THEN '@' || p_username
    ELSE '@' || p_username || COALESCE(
      '@' || NULLIF(p_domain, ''),
      '@' || NULLIF(current_setting('app.domain', true), ''),
      ''
    )
  END;
$$;

CREATE OR REPLACE FUNCTION public.notification_actor_json(
  p_id uuid,
  p_username text,
  p_display_name text,
  p_avatar_url text,
  p_domain text,
  p_is_local boolean
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', p_id,
    'user_id', p_id,
    'username', p_username,
    'display_name', COALESCE(p_display_name, p_username),
    'avatar_url', p_avatar_url,
    'domain', p_domain,
    'is_local', COALESCE(p_is_local, true),
    'handle', public.profile_web_handle(p_username, p_domain, p_is_local)
  );
$$;

CREATE OR REPLACE FUNCTION public.notification_actor_json(p public.profiles)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.notification_actor_json(
    p.id, p.username, p.display_name, p.avatar_url, p.domain, p.is_local
  );
$$;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS web_handle text
  GENERATED ALWAYS AS (
    CASE
      WHEN COALESCE(is_local, true) THEN '@' || username
      WHEN domain IS NOT NULL AND domain <> '' THEN '@' || username || '@' || domain
      ELSE '@' || username
    END
  ) STORED;

COMMENT ON COLUMN public.profiles.web_handle IS 'Precomputed @handle for UI (local @user, remote @user@domain)';

-- Refresh notification triggers so new notifications include actor.handle (mirrors db_schema/init).

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
                                'sender', notification_actor_json(v_sender_profile),
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
                    'sender', notification_actor_json(v_sender_profile),
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
                    'sender', notification_actor_json(v_sender_profile),
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
                    'sender', notification_actor_json(v_sender_profile),
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
CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    single_target_id uuid;
    notification_data jsonb;
    msg_channel_id uuid;
    msg_server_id uuid;
    msg_conversation_id uuid;
    msg_channel_name text;
    msg_server_name text;
    post_author_id uuid;
    post_record RECORD;
    emoji_record RECORD;
    emoji_name text;
    emoji_url text;
    reactor_profile RECORD;
    follower_profile RECORD;
BEGIN
    -- Handle follows
    IF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO follower_profile
        FROM profiles
        WHERE id = NEW.follower_id;

        IF follower_profile.id IS NOT NULL THEN
            notification_data := jsonb_build_object(
                'type', 'activitypub_follow',
                'follower_id', NEW.follower_id,
                'follower', notification_actor_json(
                    follower_profile.id,
                    follower_profile.username,
                    follower_profile.display_name,
                    follower_profile.avatar_url,
                    follower_profile.domain,
                    follower_profile.is_local
                )
            );

            PERFORM send_notification_to_user(
                'activitypub_follow',
                NEW.following_id,
                notification_data,
                NULL, NULL, NULL,
                NEW.follower_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'reactions' AND TG_OP = 'INSERT' THEN
        SELECT user_id INTO single_target_id FROM messages WHERE id = NEW.message_id;
        
        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            SELECT m.channel_id, c.server_id, m.conversation_id, c.name, s.name
            INTO msg_channel_id, msg_server_id, msg_conversation_id, msg_channel_name, msg_server_name
            FROM messages m 
            LEFT JOIN channels c ON m.channel_id = c.id
            LEFT JOIN servers s ON c.server_id = s.id
            WHERE m.id = NEW.message_id;
            
            SELECT id, username, display_name, avatar_url, domain, is_local
            INTO reactor_profile
            FROM profiles
            WHERE id = NEW.user_id;
            
            emoji_name := NULL;
            emoji_url := NULL;
            IF NEW.emoji_id IS NOT NULL THEN
                SELECT name, url INTO emoji_record FROM emojis WHERE id = NEW.emoji_id;
                IF FOUND THEN
                    emoji_name := emoji_record.name;
                    emoji_url := emoji_record.url;
                END IF;
            END IF;
            
            notification_data := jsonb_build_object(
                'type', 'reaction',
                'message_id', NEW.message_id,
                'channel_id', msg_channel_id,
                'server_id', msg_server_id,
                'channel_name', msg_channel_name,
                'server_name', msg_server_name,
                'message_preview', extract_message_text((SELECT content FROM messages WHERE id = NEW.message_id)),
                'reaction', jsonb_build_object(
                    'emoji_id', NEW.emoji_id,
                    'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content),
                    'emoji_url', emoji_url,
                    'custom_emoji_content', NEW.custom_emoji_content
                ),
                'sender', CASE WHEN reactor_profile.id IS NOT NULL THEN
                    notification_actor_json(
                        reactor_profile.id,
                        reactor_profile.username,
                        reactor_profile.display_name,
                        reactor_profile.avatar_url,
                        reactor_profile.domain,
                        reactor_profile.is_local
                    )
                ELSE NULL END
            );

            IF msg_conversation_id IS NOT NULL THEN
                notification_data := notification_data || jsonb_build_object(
                    'conversation_id', msg_conversation_id
                );
            END IF;
            
            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                msg_server_id, msg_channel_id, msg_conversation_id,
                NEW.user_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' AND TG_OP = 'INSERT' THEN
        IF NEW.interaction_type IN ('emoji_reaction', 'favorite', 'reblog') THEN
            SELECT author_id INTO post_author_id 
            FROM posts 
            WHERE id = NEW.post_id;
            
            IF post_author_id IS NOT NULL AND post_author_id != NEW.user_id THEN
                SELECT * INTO post_record FROM posts WHERE id = NEW.post_id;
                
                SELECT id, username, display_name, avatar_url, domain, is_local
                INTO reactor_profile
                FROM profiles
                WHERE id = NEW.user_id;
                
                emoji_name := NULL;
                emoji_url := NULL;
                IF NEW.emoji_id IS NOT NULL THEN
                    SELECT name, url INTO emoji_record FROM emojis WHERE id = NEW.emoji_id;
                    IF FOUND THEN
                        emoji_name := emoji_record.name;
                        emoji_url := emoji_record.url;
                    END IF;
                END IF;
                
                notification_data := jsonb_build_object(
                    'type', CASE
                        WHEN NEW.interaction_type = 'favorite' THEN 'activitypub_favorite'
                        WHEN NEW.interaction_type = 'reblog' THEN 'activitypub_reblog'
                        ELSE 'activitypub_reaction'
                    END,
                    'post_id', NEW.post_id,
                    'post', jsonb_build_object(
                        'id', post_record.id,
                        'content_preview', extract_message_text(post_record.content)
                    ),
                    'reaction', jsonb_build_object(
                        'emoji_id', NEW.emoji_id,
                        'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content),
                        'emoji_url', emoji_url,
                        'custom_emoji_content', NEW.custom_emoji_content
                    ),
                    'sender', CASE WHEN reactor_profile.id IS NOT NULL THEN
                        notification_actor_json(
                            reactor_profile.id,
                            reactor_profile.username,
                            reactor_profile.display_name,
                            reactor_profile.avatar_url,
                            reactor_profile.domain,
                            reactor_profile.is_local
                        )
                    ELSE NULL END
                );
                
                PERFORM send_notification_to_user(
                    CASE
                        WHEN NEW.interaction_type = 'favorite' THEN 'activitypub_favorite'
                        WHEN NEW.interaction_type = 'reblog' THEN 'activitypub_reblog'
                        ELSE 'activitypub_reaction'
                    END,
                    post_author_id,
                    notification_data,
                    NULL, NULL, NULL,
                    NEW.user_id,
                    'normal'
                );
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
