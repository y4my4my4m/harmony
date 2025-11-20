-- Fix notification filtering to handle blocks/mutes at database level
-- This ensures security and efficiency - filtering happens before data is sent to frontend

-- Update get_user_notifications function to filter blocked/muted users and muted channels
CREATE OR REPLACE FUNCTION public.get_user_notifications(
    p_user_id uuid, 
    p_limit integer DEFAULT 20, 
    p_offset integer DEFAULT 0, 
    p_unread_only boolean DEFAULT false, 
    p_notification_types character varying[] DEFAULT NULL::character varying[]
) RETURNS TABLE(
    id uuid, 
    user_id uuid, 
    type character varying, 
    data jsonb, 
    is_read boolean, 
    is_clicked boolean, 
    created_at timestamp with time zone, 
    updated_at timestamp with time zone, 
    expires_at timestamp with time zone, 
    read_at timestamp with time zone
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        n.id,
        n.user_id,
        n.type,
        n.data,
        n.is_read,
        n.is_clicked,
        n.created_at,
        n.updated_at,
        n.expires_at,
        n.read_at
    FROM notifications n
    WHERE n.user_id = p_user_id
    AND (NOT p_unread_only OR n.is_read = FALSE)
    AND (p_notification_types IS NULL OR n.type = ANY(p_notification_types))
    
    -- Filter out notifications from blocked users
    -- Extract sender ID from various possible JSONB structures
    AND NOT EXISTS (
        SELECT 1 
        FROM user_blocks ub
        WHERE ub.blocker_id = p_user_id
        AND ub.blocked_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
    )
    
    -- Filter out notifications from muted users (notifications_only or all)
    AND NOT EXISTS (
        SELECT 1 
        FROM user_mutes um
        WHERE um.muter_id = p_user_id
        AND um.muted_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND um.mute_type IN ('notifications_only', 'all')
        AND (um.expires_at IS NULL OR um.expires_at > NOW())
    )
    
    -- Filter out notifications from muted channels/conversations
    AND NOT EXISTS (
        SELECT 1 
        FROM notification_channels nc
        WHERE nc.user_id = p_user_id
        AND nc.muted = true
        AND (
            (nc.channel_id IS NOT NULL AND nc.channel_id = COALESCE(
                NULLIF((n.data->>'channel_id'), '')::uuid,
                NULLIF((n.data->'location'->>'channel_id'), '')::uuid
            ))
            OR
            (nc.conversation_id IS NOT NULL AND nc.conversation_id = COALESCE(
                NULLIF((n.data->>'conversation_id'), '')::uuid,
                NULLIF((n.data->'conversation'->>'id'), '')::uuid
            ))
        )
        AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
    )
    
    ORDER BY n.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION public.get_user_notifications IS 'Get user notifications with filtering. Filters out notifications from blocked users, muted users, and muted channels at database level for security and efficiency.';

-- Also update send_notification to check blocks/mutes before creating notifications
-- This prevents creating notifications that will be filtered anyway
CREATE OR REPLACE FUNCTION public.send_notification(
    notification_type character varying, 
    to_user_ids uuid[], 
    notification_data jsonb DEFAULT '{}'::jsonb, 
    server_id uuid DEFAULT NULL::uuid, 
    channel_id uuid DEFAULT NULL::uuid, 
    conversation_id uuid DEFAULT NULL::uuid, 
    from_user_id uuid DEFAULT NULL::uuid, 
    priority character varying DEFAULT 'normal'::character varying
) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    created_notification_ids uuid[] := '{}';
    recipient_id uuid;
    user_prefs record;
    should_send boolean;
    notification_id uuid;
    current_timestamp timestamp with time zone := now();
    enhanced_data jsonb;
    is_blocked boolean;
    is_muted boolean;
    is_channel_muted boolean;
    p_channel_id uuid;
    p_conversation_id uuid;
BEGIN
    -- Validate inputs
    IF notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    -- Process each recipient
    FOREACH recipient_id IN ARRAY to_user_ids LOOP
        -- Skip if sending to self (optional check)
        IF from_user_id IS NOT NULL AND recipient_id = from_user_id THEN
            CONTINUE;
        END IF;

        -- Check if sender is blocked by recipient
        IF from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 
                FROM user_blocks ub
                WHERE ub.blocker_id = recipient_id
                AND ub.blocked_user_id = from_user_id
                AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
            ) INTO is_blocked;
            
            IF is_blocked THEN
                CONTINUE; -- Skip this recipient
            END IF;
        END IF;

        -- Check if sender is muted by recipient (for notifications)
        IF from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 
                FROM user_mutes um
                WHERE um.muter_id = recipient_id
                AND um.muted_user_id = from_user_id
                AND um.mute_type IN ('notifications_only', 'all')
                AND (um.expires_at IS NULL OR um.expires_at > NOW())
            ) INTO is_muted;
            
            IF is_muted THEN
                CONTINUE; -- Skip this recipient
            END IF;
        END IF;

        -- Check if channel/conversation is muted
        -- Use local variables to avoid ambiguity with parameter names
        p_channel_id := channel_id;
        p_conversation_id := conversation_id;
        
        IF p_channel_id IS NOT NULL OR p_conversation_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 
                FROM notification_channels nc
                WHERE nc.user_id = recipient_id
                AND nc.muted = true
                AND (
                    (p_channel_id IS NOT NULL AND nc.channel_id = p_channel_id)
                    OR
                    (p_conversation_id IS NOT NULL AND nc.conversation_id = p_conversation_id)
                )
                AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
            ) INTO is_channel_muted;
            
            IF is_channel_muted THEN
                CONTINUE; -- Skip this recipient
            END IF;
        END IF;

        -- 🔥 Check if user is currently viewing this channel/DM (Discord-like behavior)
        -- If user is viewing the source channel/DM, suppress notification entirely at database level
        IF (server_id IS NOT NULL AND p_channel_id IS NOT NULL) OR p_conversation_id IS NOT NULL THEN
            IF public.is_user_viewing_context(recipient_id, server_id, p_channel_id, p_conversation_id) THEN
                RAISE NOTICE '🔇 Notification suppressed (user viewing context): type=% to_user=% server_id=% channel_id=% conversation_id=%', 
                    notification_type, recipient_id, server_id, p_channel_id, p_conversation_id;
                CONTINUE; -- Skip creating notification entirely
            END IF;
        END IF;

        -- Get user notification preferences if table exists
        user_prefs := NULL;
        BEGIN
            SELECT * INTO user_prefs FROM notification_preferences WHERE user_id = recipient_id;
        EXCEPTION
            WHEN undefined_table THEN
                -- notification_preferences table doesn't exist, send all notifications
                user_prefs := NULL;
        END;

        -- Default to sending notifications if no preferences found
        should_send := true;

        -- Apply preferences if they exist
        IF user_prefs IS NOT NULL THEN
            -- ✅ FIXED: Use ACTUAL column names from notification_preferences table
            CASE notification_type
                WHEN 'mention' THEN
                    should_send := COALESCE(user_prefs.desktop_mentions, true);
                WHEN 'reply' THEN
                    should_send := COALESCE(user_prefs.desktop_replies, true);
                WHEN 'dm' THEN
                    should_send := COALESCE(user_prefs.desktop_dms, true);
                WHEN 'reaction' THEN
                    should_send := COALESCE(user_prefs.desktop_reactions, true);
                WHEN 'activitypub_follow' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_follows, true);
                WHEN 'activitypub_favorite' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_favorites, true);
                WHEN 'activitypub_reblog' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_reblogs, true);
                WHEN 'activitypub_mention' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_mentions, true);
                WHEN 'activitypub_reply' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_replies, true);
                WHEN 'activitypub_reaction' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_favorites, true); -- Use favorites preference for reactions
                ELSE
                    should_send := true; -- Default to sending for unknown types
            END CASE;

            -- Apply DND restrictions if configured
            IF user_prefs.dnd_enabled IS TRUE THEN
                IF current_timestamp::time BETWEEN 
                   COALESCE(user_prefs.dnd_start_time, '22:00'::time) AND 
                   COALESCE(user_prefs.dnd_end_time, '08:00'::time) THEN
                    should_send := false;
                END IF;
            END IF;
        END IF;

        -- Create enhanced notification data with context
        enhanced_data := notification_data;
        
        -- Add context information to the data field since we can't use separate columns
        IF server_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('server_id', server_id);
        END IF;
        
        IF channel_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('channel_id', channel_id);
        END IF;
        
        IF conversation_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('conversation_id', conversation_id);
        END IF;
        
        IF from_user_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('from_user_id', from_user_id);
        END IF;
        
        IF priority IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('priority', priority);
        END IF;

        -- Create notification if should send - using ONLY existing columns
        IF should_send THEN
            INSERT INTO notifications (
                type,
                user_id,
                data,
                created_at
            ) VALUES (
                notification_type,
                recipient_id,
                enhanced_data,
                current_timestamp
            ) RETURNING id INTO notification_id;

            created_notification_ids := array_append(created_notification_ids, notification_id);
            
            RAISE NOTICE '✅ Notification sent: type=% to_user=% id=%', notification_type, recipient_id, notification_id;
        ELSE
            RAISE NOTICE '🔇 Notification skipped (user preferences): type=% to_user=%', notification_type, recipient_id;
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$$;

COMMENT ON FUNCTION public.send_notification IS 'Send notifications to users. Now filters blocked/muted users and muted channels before creating notifications for efficiency and security.';

-- Ensure extract_message_text function exists and handles all MessagePart types correctly
CREATE OR REPLACE FUNCTION public.extract_message_text(content_parts jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  part jsonb;
  text_result text := '';
  v_username TEXT;
  v_domain TEXT;
  v_emoji_name TEXT;
  v_hashtag_name TEXT;
BEGIN
  IF content_parts IS NULL OR jsonb_typeof(content_parts) != 'array' THEN
    RETURN '';
  END IF;

  FOR part IN SELECT * FROM jsonb_array_elements(content_parts)
  LOOP
    CASE (part->>'type')
      WHEN 'text' THEN
        text_result := text_result || COALESCE(part->>'text', '') || ' ';
      WHEN 'emoji' THEN
        v_emoji_name := part->'emoji'->>'name';
        IF v_emoji_name IS NOT NULL THEN
            text_result := text_result || ':' || v_emoji_name || ': ';
        END IF;
      WHEN 'mention' THEN
        v_username := part->>'username';
        v_domain := part->>'domain';
        IF v_username IS NOT NULL THEN
            IF v_domain IS NOT NULL THEN
                text_result := text_result || '@' || v_username || '@' || v_domain || ' ';
            ELSE
                text_result := text_result || '@' || v_username || ' ';
            END IF;
        END IF;
      WHEN 'url' THEN
        text_result := text_result || COALESCE(part->>'url', '') || ' ';
      WHEN 'hashtag' THEN
        v_hashtag_name := part->>'name';
        IF v_hashtag_name IS NOT NULL THEN
            text_result := text_result || '#' || v_hashtag_name || ' ';
        END IF;
      WHEN 'file' THEN
        text_result := text_result || '[file] ';
      ELSE
        -- Skip system messages and unknown types
        NULL;
    END CASE;
  END LOOP;

  RETURN trim(text_result);
END;
$$;

COMMENT ON FUNCTION public.extract_message_text IS 'Extracts readable text from MessagePart[] JSONB array, handling text, emoji, mentions, URLs, hashtags, and files.';

-- Add support for ActivityPub reaction notifications in handle_unified_notification_processing
CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    notification_data jsonb;
    target_user_id uuid;
    mentioned_users uuid[];
    server_members uuid[];
    followers uuid[];
    single_target_id uuid;
    target_user_ids uuid[];
    -- CRITICAL: Use explicit variable names to avoid ANY ambiguity
    msg_channel_id uuid;
    msg_server_id uuid;
    -- For post_interactions
    post_author_id uuid;
    post_record RECORD;
    emoji_record RECORD;
    emoji_name TEXT;
    emoji_url TEXT;
BEGIN
    -- Early exit for non-notification operations
    IF TG_OP = 'UPDATE' THEN
        RETURN NEW;
    END IF;

    -- Handle different table operations
    IF TG_TABLE_NAME = 'mentions' AND TG_OP = 'INSERT' THEN
        -- Handle mention notifications
        notification_data := jsonb_build_object(
            'type', 'mention',
            'message_id', NEW.message_id,
            'mentioned_by', NEW.mentioned_by
        );
        
        PERFORM send_notification_to_user(
            'mention',
            NEW.mentioned_user,
            notification_data,
            (SELECT s.id FROM messages m JOIN channels c ON m.channel_id = c.id JOIN servers s ON c.server_id = s.id WHERE m.id = NEW.message_id),
            (SELECT m.channel_id FROM messages m WHERE m.id = NEW.message_id),
            NULL,
            NEW.mentioned_by,
            'normal'
        );

    ELSIF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        -- Handle follow notifications
        notification_data := jsonb_build_object(
            'type', 'follow',
            'follower_id', NEW.follower_id
        );
        
        PERFORM send_notification_to_user(
            'follow',
            NEW.following_id,
            notification_data,
            NULL,
            NULL,
            NULL,
            NEW.follower_id,
            'normal'
        );

    ELSIF TG_TABLE_NAME = 'reactions' AND TG_OP = 'INSERT' THEN
        -- Handle reaction notifications (for messages)
        SELECT user_id INTO single_target_id FROM messages WHERE id = NEW.message_id;
        
        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            -- CRITICAL FIX: Use explicit variables to eliminate ANY channel_id ambiguity
            SELECT m.channel_id, c.server_id 
            INTO msg_channel_id, msg_server_id
            FROM messages m 
            LEFT JOIN channels c ON m.channel_id = c.id 
            WHERE m.id = NEW.message_id;
            
            notification_data := jsonb_build_object(
                'type', 'reaction',
                'message_id', NEW.message_id,
                'emoji_id', NEW.emoji_id,
                'user_id', NEW.user_id
            );
            
            -- CRITICAL FIX: Use explicit variable names instead of ambiguous references
            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                msg_server_id,  -- EXPLICIT: No ambiguity
                msg_channel_id, -- EXPLICIT: No ambiguity
                NULL,
                NEW.user_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' AND TG_OP = 'INSERT' THEN
        -- Handle ActivityPub reaction notifications (emoji_reaction type)
        -- Only notify for emoji_reaction type, not favorite/reblog (those have their own notification types)
        IF NEW.interaction_type = 'emoji_reaction' THEN
            -- Get post author
            SELECT author_id INTO post_author_id 
            FROM posts 
            WHERE id = NEW.post_id;
            
            -- Only send notification if reacting to someone else's post
            IF post_author_id IS NOT NULL AND post_author_id != NEW.user_id THEN
                -- Get post info for context
                SELECT * INTO post_record FROM posts WHERE id = NEW.post_id;
                
                -- Get emoji info if it's a custom emoji
                emoji_name := NULL;
                emoji_url := NULL;
                IF NEW.emoji_id IS NOT NULL THEN
                    SELECT name, url INTO emoji_record FROM emojis WHERE id = NEW.emoji_id;
                    IF FOUND THEN
                        emoji_name := emoji_record.name;
                        emoji_url := emoji_record.url;
                    END IF;
                END IF;
                
                -- Build notification data with structured format
                notification_data := jsonb_build_object(
                    'type', 'activitypub_reaction',
                    'post_id', NEW.post_id,
                    'post_content', COALESCE(post_record.content->0->>'text', ''),
                    'interaction_id', NEW.id,
                    'sender', jsonb_build_object(
                        'user_id', NEW.user_id,
                        'username', (SELECT username FROM profiles WHERE id = NEW.user_id),
                        'display_name', (SELECT display_name FROM profiles WHERE id = NEW.user_id),
                        'avatar_url', (SELECT avatar_url FROM profiles WHERE id = NEW.user_id),
                        'is_local', (SELECT is_local FROM profiles WHERE id = NEW.user_id),
                        'domain', (SELECT domain FROM profiles WHERE id = NEW.user_id)
                    ),
                    'reaction', jsonb_build_object(
                        'emoji_id', NEW.emoji_id,
                        'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content, '👍'),
                        'emoji_url', emoji_url,
                        'custom_emoji_content', NEW.custom_emoji_content
                    )
                );
                
                -- Send notification to post author
                PERFORM send_notification_to_user(
                    'activitypub_reaction',
                    post_author_id,
                    notification_data,
                    NULL,
                    NULL,
                    NULL,
                    NEW.user_id,
                    'normal'
                );
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_unified_notification_processing IS 'Handles notifications for follows, reactions, and ActivityPub emoji reactions. Now includes support for post_interactions emoji_reaction type.';

-- Update handle_message_federation to create mention notifications directly for channel messages
-- Ensure the trigger exists
DROP TRIGGER IF EXISTS trg_handle_message_federation ON public.messages;

CREATE OR REPLACE FUNCTION public.handle_message_federation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_federation_type TEXT;
    v_is_federated_incoming BOOLEAN;
    v_sender_profile profiles%ROWTYPE;
    -- Variables for mention detection
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
    -- Determine federation type
    v_federation_type := determine_message_federation_type(NEW.id);
    
    -- Check if this is an incoming federated message
    v_is_federated_incoming := (NEW.metadata->>'federated' = 'true');
    
    -- Get sender profile for notifications
    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- Extract content preview from MessagePart[] array using existing function
    content_preview := extract_message_text(NEW.content);
    content_preview := TRIM(content_preview);
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New message';
    END IF;
    
    -- Handle mentions in channel messages (channel_id is not null)
    -- Note: Channel messages have channel_id set, DMs have conversation_id set
    IF NEW.channel_id IS NOT NULL AND NOT NEW.is_system AND NOT COALESCE((NEW.metadata->>'federated')::boolean, false) THEN
        RAISE NOTICE '🔍 Processing channel message for mentions: message_id=%, channel_id=%', NEW.id, NEW.channel_id;
        
        -- Get channel and server info (use explicit table aliases and variables to avoid ambiguity)
        v_channel_id := NEW.channel_id;
        
        SELECT c.name, c.server_id INTO v_channel_name, v_server_id
        FROM channels c 
        WHERE c.id = v_channel_id;
        
        IF NOT FOUND THEN
            RAISE WARNING 'Channel not found: %', NEW.channel_id;
            -- Set to NULL to avoid issues
            v_channel_id := NULL;
            v_channel_name := NULL;
            v_server_id := NULL;
            v_server_name := NULL;
        ELSE
            -- Get server info (use explicit table alias)
            SELECT s.id, s.name INTO v_server_id, v_server_name
            FROM servers s
            WHERE s.id = v_server_id;
            
            IF NOT FOUND THEN
                RAISE WARNING 'Server not found for channel: %', v_server_id;
                v_server_id := NULL;
                v_server_name := NULL;
            END IF;
        END IF;
        
        -- Get current instance domain
        SELECT trim(both '"' from config_value::text) INTO current_domain 
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;
        
        IF current_domain IS NULL THEN
            RAISE WARNING 'Instance domain not configured';
        END IF;
        
        -- Process message content to find mentions
        IF jsonb_typeof(NEW.content) = 'array' THEN
            RAISE NOTICE '📝 Processing content array, length: %', jsonb_array_length(NEW.content);
            
            FOR content_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                -- Check if this is a mention part
                IF content_part->>'type' = 'mention' THEN
                    mentioned_username := content_part->>'username';
                    mentioned_domain := content_part->>'domain';
                    
                    RAISE NOTICE '👤 Found mention: @% @%', mentioned_username, COALESCE(mentioned_domain, 'local');
                    
                    -- Find the mentioned user
                    IF mentioned_domain IS NULL OR mentioned_domain = current_domain THEN
                        -- Local user mention
                        SELECT id INTO mentioned_user_id
                        FROM profiles
                        WHERE username = mentioned_username
                          AND (domain IS NULL OR domain = current_domain)
                          AND is_local = true
                          AND id != NEW.user_id; -- Don't notify self
                    ELSE
                        -- Remote user mention
                        SELECT id INTO mentioned_user_id
                        FROM profiles
                        WHERE username = mentioned_username
                          AND domain = mentioned_domain
                          AND id != NEW.user_id; -- Don't notify self
                    END IF;
                    
                    -- Create mention notification if user found
                    IF mentioned_user_id IS NOT NULL THEN
                        RAISE NOTICE '✅ Creating mention notification: mentioned_user_id=%, message_id=%', mentioned_user_id, NEW.id;
                        
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
                                -- Legacy fields for compatibility
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
                        
                        RAISE NOTICE '✅ Mention notification sent successfully';
                    ELSE
                        RAISE NOTICE '⚠️ Mentioned user not found: @% @%', mentioned_username, COALESCE(mentioned_domain, 'local');
                    END IF;
                END IF;
            END LOOP;
        ELSE
            RAISE NOTICE '⚠️ Content is not an array: %', jsonb_typeof(NEW.content);
        END IF;
    END IF;
    
    -- Handle existing notification cases
    CASE v_federation_type
        WHEN 'chat_local_only' THEN
            -- Send local notifications for chat messages (ONLY to LOCAL users)
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
            -- Send DM notifications for local-only DMs (ONLY to LOCAL users)
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
            -- Send DM notifications for federated DMs (ONLY to LOCAL users)
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

COMMENT ON FUNCTION public.handle_message_federation IS 'Handles notifications for DMs, chat messages, and channel mentions. Creates mention notifications directly when mentions are detected in channel messages.';

-- Recreate the trigger to ensure it's active
CREATE TRIGGER trg_handle_message_federation 
    AFTER INSERT ON public.messages 
    FOR EACH ROW 
    EXECUTE FUNCTION public.handle_message_federation();

COMMENT ON TRIGGER trg_handle_message_federation ON public.messages IS 'Handles local notifications for all messages (both local and federated) and creates mention notifications for channel messages.';

-- Remove mentions handling from handle_unified_notification_processing since we don't use mentions table
CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    notification_data jsonb;
    target_user_id uuid;
    mentioned_users uuid[];
    server_members uuid[];
    followers uuid[];
    single_target_id uuid;
    target_user_ids uuid[];
    msg_channel_id uuid;
    msg_server_id uuid;
    post_author_id uuid;
    post_record RECORD;
    emoji_record RECORD;
    emoji_name TEXT;
    emoji_url TEXT;
BEGIN
    -- Early exit for non-notification operations
    IF TG_OP = 'UPDATE' THEN
        RETURN NEW;
    END IF;

    -- Handle different table operations (removed mentions handling - now done directly in handle_message_federation)
    IF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        -- Handle follow notifications
        notification_data := jsonb_build_object(
            'type', 'follow',
            'follower_id', NEW.follower_id
        );
        
        PERFORM send_notification_to_user(
            'follow',
            NEW.following_id,
            notification_data,
            NULL,
            NULL,
            NULL,
            NEW.follower_id,
            'normal'
        );

    ELSIF TG_TABLE_NAME = 'reactions' AND TG_OP = 'INSERT' THEN
        -- Handle reaction notifications (for messages)
        SELECT user_id INTO single_target_id FROM messages WHERE id = NEW.message_id;
        
        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            SELECT m.channel_id, c.server_id 
            INTO msg_channel_id, msg_server_id
            FROM messages m 
            LEFT JOIN channels c ON m.channel_id = c.id 
            WHERE m.id = NEW.message_id;
            
            notification_data := jsonb_build_object(
                'type', 'reaction',
                'message_id', NEW.message_id,
                'emoji_id', NEW.emoji_id,
                'user_id', NEW.user_id
            );
            
            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                msg_server_id,
                msg_channel_id,
                NULL,
                NEW.user_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' AND TG_OP = 'INSERT' THEN
        -- Handle ActivityPub reaction notifications (emoji_reaction type)
        IF NEW.interaction_type = 'emoji_reaction' THEN
            SELECT author_id INTO post_author_id 
            FROM posts 
            WHERE id = NEW.post_id;
            
            IF post_author_id IS NOT NULL AND post_author_id != NEW.user_id THEN
                SELECT * INTO post_record FROM posts WHERE id = NEW.post_id;
                
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
                    'type', 'activitypub_reaction',
                    'post_id', NEW.post_id,
                    'post_content', COALESCE(post_record.content->0->>'text', ''),
                    'interaction_id', NEW.id,
                    'sender', jsonb_build_object(
                        'user_id', NEW.user_id,
                        'username', (SELECT username FROM profiles WHERE id = NEW.user_id),
                        'display_name', (SELECT display_name FROM profiles WHERE id = NEW.user_id),
                        'avatar_url', (SELECT avatar_url FROM profiles WHERE id = NEW.user_id),
                        'is_local', (SELECT is_local FROM profiles WHERE id = NEW.user_id),
                        'domain', (SELECT domain FROM profiles WHERE id = NEW.user_id)
                    ),
                    'reaction', jsonb_build_object(
                        'emoji_id', NEW.emoji_id,
                        'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content, '👍'),
                        'emoji_url', emoji_url,
                        'custom_emoji_content', NEW.custom_emoji_content
                    )
                );
                
                PERFORM send_notification_to_user(
                    'activitypub_reaction',
                    post_author_id,
                    notification_data,
                    NULL,
                    NULL,
                    NULL,
                    NEW.user_id,
                    'normal'
                );
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_unified_notification_processing IS 'Handles notifications for follows, reactions, and ActivityPub emoji reactions. Mentions are now handled directly in handle_message_federation.';

-- Update handle_local_post_mention_notifications to use send_notification_to_user for proper notifications
CREATE OR REPLACE FUNCTION public.handle_local_post_mention_notifications() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
    post_content_preview TEXT;
BEGIN
    -- Only handle new posts
    IF TG_OP = 'INSERT' THEN
        -- Get author profile for notification data
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO author_profile
        FROM profiles 
        WHERE id = NEW.author_id;
        
        -- Only process if author found and content exists
        IF FOUND AND NEW.content IS NOT NULL THEN
            -- Extract content preview from MessagePart[] array
            post_content_preview := extract_message_text(NEW.content);
            IF LENGTH(post_content_preview) > 100 THEN
                post_content_preview := LEFT(post_content_preview, 100) || '...';
            END IF;
            IF post_content_preview = '' OR post_content_preview IS NULL THEN
                post_content_preview := 'New post';
            END IF;
            
            -- Extract mentions from unified content format
            FOR content_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                -- Check if this is a mention
                IF content_part->>'type' = 'mention' THEN
                    -- Extract username from mention
                    mentioned_username := content_part->>'username';
                    
                    -- Get the mentioned user ID (only local users)
                    -- For local posts, mentions should always be local users
                    SELECT id INTO mentioned_user_id
                    FROM profiles
                    WHERE username = mentioned_username
                      AND is_local = true
                      AND id != NEW.author_id; -- Don't notify self
                    
                    -- Debug logging
                    IF mentioned_user_id IS NULL THEN
                        RAISE NOTICE '⚠️ Local mention: username=% not found or not local. Available local users: %', 
                            mentioned_username,
                            (SELECT string_agg(username, ', ') FROM profiles WHERE is_local = true LIMIT 10);
                    ELSE
                        RAISE NOTICE '✅ Local mention: found user % (ID: %)', mentioned_username, mentioned_user_id;
                    END IF;
                    
                    -- Create notification if mentioned user found
                    IF mentioned_user_id IS NOT NULL THEN
                        -- Use send_notification_to_user for proper notification creation
                        PERFORM send_notification_to_user(
                            'activitypub_mention',
                            mentioned_user_id,
                            jsonb_build_object(
                                'actor', jsonb_build_object(
                                    'id', author_profile.id,
                                    'username', author_profile.username,
                                    'display_name', author_profile.display_name,
                                    'avatar_url', author_profile.avatar_url,
                                    'domain', author_profile.domain,
                                    'is_local', author_profile.is_local
                                ),
                                'post', jsonb_build_object(
                                    'id', NEW.id,
                                    'ap_id', NEW.ap_id,
                                    'content_preview', post_content_preview,
                                    'content', NEW.content
                                ),
                                'post_id', NEW.id,
                                'post_content', NEW.content,
                                'timestamp', NEW.created_at
                            ),
                            NULL, -- server_id
                            NULL, -- channel_id
                            NULL, -- conversation_id
                            author_profile.id, -- from_user_id
                            'normal' -- priority
                        );
                        
                        RAISE NOTICE '✅ Created ActivityPub mention notification: % mentioned %', 
                            author_profile.username, mentioned_username;
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_local_post_mention_notifications IS 'Creates proper notifications for local users mentioned in ActivityPub posts using send_notification_to_user.';

-- Create a unified function to handle mentions for both local and federated posts
CREATE OR REPLACE FUNCTION public.handle_post_mention_notifications() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
    post_content_preview TEXT;
BEGIN
    -- Only handle new posts
    IF TG_OP = 'INSERT' THEN
        -- Get author profile for notification data
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO author_profile
        FROM profiles 
        WHERE id = NEW.author_id;
        
        -- Only process if author found and content exists
        IF FOUND AND NEW.content IS NOT NULL THEN
            -- Extract content preview from MessagePart[] array
            post_content_preview := extract_message_text(NEW.content);
            IF LENGTH(post_content_preview) > 100 THEN
                post_content_preview := LEFT(post_content_preview, 100) || '...';
            END IF;
            IF post_content_preview = '' OR post_content_preview IS NULL THEN
                post_content_preview := 'New post';
            END IF;
            
            -- Extract mentions from unified content format
            IF jsonb_typeof(NEW.content) = 'array' THEN
                FOR content_part IN SELECT jsonb_array_elements(NEW.content)
                LOOP
                    -- Check if this is a mention
                    IF content_part->>'type' = 'mention' THEN
                        mentioned_username := content_part->>'username';
                        
                        -- Check if this is a local mention using isLocal field
                        IF (content_part->>'isLocal')::boolean = true THEN
                            RAISE NOTICE '🔍 Processing local mention: username=%, is_local=%, is_federated=%', 
                                mentioned_username, NEW.is_local, NEW.is_federated;
                            
                            -- Get the mentioned user ID (only local users)
                            SELECT id INTO mentioned_user_id
                            FROM profiles 
                            WHERE username = mentioned_username 
                              AND is_local = true
                              AND id != NEW.author_id; -- Don't notify self
                            
                            IF mentioned_user_id IS NOT NULL THEN
                                RAISE NOTICE '✅ Found local user mentioned: % (ID: %)', mentioned_username, mentioned_user_id;
                                
                                -- Use send_notification_to_user for proper notification creation
                                PERFORM send_notification_to_user(
                                    'activitypub_mention',
                                    mentioned_user_id,
                                    jsonb_build_object(
                                        'actor', jsonb_build_object(
                                            'id', author_profile.id,
                                            'username', author_profile.username,
                                            'display_name', author_profile.display_name,
                                            'avatar_url', author_profile.avatar_url,
                                            'domain', author_profile.domain,
                                            'is_local', author_profile.is_local
                                        ),
                                        'post', jsonb_build_object(
                                            'id', NEW.id,
                                            'ap_id', NEW.ap_id,
                                            'content_preview', post_content_preview,
                                            'content', NEW.content
                                        ),
                                        'post_id', NEW.id,
                                        'post_content', NEW.content,
                                        'timestamp', NEW.created_at,
                                        'federated', NEW.is_federated
                                    ),
                                    NULL, -- server_id
                                    NULL, -- channel_id
                                    NULL, -- conversation_id
                                    author_profile.id, -- from_user_id
                                    'normal' -- priority
                                );
                                
                                RAISE NOTICE '✅ Created ActivityPub mention notification: % mentioned %', 
                                    author_profile.username, mentioned_username;
                            ELSE
                                RAISE NOTICE '⚠️ Mentioned user not found: username=%', mentioned_username;
                            END IF;
                        ELSE
                            RAISE NOTICE '⚠️ Skipping remote user mention: username=%', mentioned_username;
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_post_mention_notifications IS 'Creates notifications when local users are mentioned in ActivityPub posts (both local and federated).';

-- Create trigger for ALL posts (local and federated)
DROP TRIGGER IF EXISTS trigger_handle_post_mention_notifications ON public.posts;
CREATE TRIGGER trigger_handle_post_mention_notifications
    AFTER INSERT ON public.posts
    FOR EACH ROW
    WHEN (NEW.content IS NOT NULL)
    EXECUTE FUNCTION public.handle_post_mention_notifications();

COMMENT ON TRIGGER trigger_handle_post_mention_notifications ON public.posts IS 'Creates notifications when local users are mentioned in ActivityPub posts (both local and federated).';

-- Update process_activitypub_public_post to use send_notification_to_user for federated mentions
CREATE OR REPLACE FUNCTION public.process_activitypub_public_post(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_content JSONB;
    v_post_id UUID;
    v_visibility TEXT := 'public';
    v_in_reply_to TEXT;
    v_parent_post_id UUID;
    v_mentioned_users TEXT[];
    v_local_user_id UUID;
    v_username TEXT;
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_domain TEXT;
    post_content_preview TEXT;
BEGIN
    v_object := activity_data->'object';
    
    -- Convert ActivityPub HTML content to our JSONB format
    v_content := parse_activitypub_content_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- Determine visibility
    IF v_object ? 'to' THEN
        IF jsonb_array_length(COALESCE(v_object->'to', '[]'::jsonb)) = 0 
           OR (v_object->'to' @> '"https://www.w3.org/ns/activitystreams#Public"'::jsonb) THEN
            v_visibility := 'public';
        ELSE
            v_visibility := 'unlisted';
        END IF;
    END IF;
    
    -- Handle replies
    v_in_reply_to := v_object->>'inReplyTo';
    IF v_in_reply_to IS NOT NULL THEN
        SELECT id INTO v_parent_post_id
        FROM posts 
        WHERE ap_id = v_in_reply_to;
    END IF;
    
    -- Create the post
    INSERT INTO posts (
        author_id,
        content,
        visibility,
        in_reply_to,
        is_local,
        is_federated,
        ap_id,
        ap_type,
        content_warning,
        is_sensitive,
        url,
        created_at,
        metadata
    ) VALUES (
        actor_profile.id,
        v_content,
        v_visibility,
        v_parent_post_id,
        false,
        true,
        v_object->>'id',
        'Note',
        v_object->>'summary',
        COALESCE((v_object->>'sensitive')::boolean, false),
        COALESCE(v_object->>'url', v_object->>'id'),
        COALESCE((v_object->>'published')::timestamptz, NOW()),
        jsonb_build_object(
            'federated', true,
            'from_domain', actor_profile.domain,
            'original_activity', activity_data->>'id'
        )
    ) RETURNING id INTO v_post_id;
    
    RAISE NOTICE '📢 Stored federated post from %@%: %', 
        actor_profile.username, actor_profile.domain, v_object->>'id';
    
    -- Extract content preview
    post_content_preview := extract_message_text(v_content);
    IF LENGTH(post_content_preview) > 100 THEN
        post_content_preview := LEFT(post_content_preview, 100) || '...';
    END IF;
    IF post_content_preview = '' OR post_content_preview IS NULL THEN
        post_content_preview := 'New post';
    END IF;
    
    -- Handle mentions from unified content format (MessagePart[] array)
    -- When a federated post mentions a local user, the mention will have domain matching instance_domain
    IF jsonb_typeof(v_content) = 'array' THEN
        FOR content_part IN SELECT jsonb_array_elements(v_content)
        LOOP
            IF content_part->>'type' = 'mention' THEN
                mentioned_username := content_part->>'username';
                
                -- Check if this is a local mention using isLocal field
                IF (content_part->>'isLocal')::boolean = true THEN
                    RAISE NOTICE '🔍 Processing local mention: username=%, instance_domain=%', 
                        mentioned_username, instance_domain;
                    
                    -- Get the mentioned user ID (only local users)
                    SELECT id INTO v_local_user_id
                    FROM profiles 
                    WHERE username = mentioned_username 
                      AND is_local = true
                      AND id != actor_profile.id; -- Don't notify self
                    
                    IF v_local_user_id IS NULL THEN
                        RAISE NOTICE '⚠️ Mentioned user not found or not local: username=%', 
                            mentioned_username;
                    END IF;
                ELSE
                    RAISE NOTICE '⚠️ Skipping remote user mention: username=%', mentioned_username;
                    v_local_user_id := NULL;
                END IF;
                
                IF v_local_user_id IS NOT NULL THEN
                    RAISE NOTICE '✅ Found local user mentioned in federated post: % (ID: %)', mentioned_username, v_local_user_id;
                    
                    -- Use send_notification_to_user for proper notification creation
                    PERFORM send_notification_to_user(
                        'activitypub_mention',
                        v_local_user_id,
                        jsonb_build_object(
                            'actor', jsonb_build_object(
                                'id', actor_profile.id,
                                'username', actor_profile.username,
                                'display_name', actor_profile.display_name,
                                'avatar_url', actor_profile.avatar_url,
                                'domain', actor_profile.domain,
                                'is_local', actor_profile.is_local
                            ),
                            'post', jsonb_build_object(
                                'id', v_post_id,
                                'ap_id', v_object->>'id',
                                'content_preview', post_content_preview,
                                'content', v_content
                            ),
                            'post_id', v_post_id,
                            'post_content', v_content,
                            'timestamp', COALESCE((v_object->>'published')::timestamptz, NOW()),
                            'federated', true
                        ),
                        NULL, -- server_id
                        NULL, -- channel_id
                        NULL, -- conversation_id
                        actor_profile.id, -- from_user_id
                        'normal' -- priority
                    );
                    
                    RAISE NOTICE '🔔 Created federated mention notification for local user: %', mentioned_username;
                ELSE
                    RAISE NOTICE '⚠️ Mentioned user is not local or not found: username=%, domain=%', 
                        mentioned_username, mentioned_domain;
                END IF;
            END IF;
        END LOOP;
    ELSE
        RAISE NOTICE '⚠️ Content is not an array, cannot process mentions. Type: %', jsonb_typeof(v_content);
    END IF;
    
    -- Note: Other notifications (replies, etc.) are handled by existing post triggers
END;
$$;

COMMENT ON FUNCTION public.process_activitypub_public_post IS 'Processes federated ActivityPub posts and creates proper mention notifications using send_notification_to_user.';

-- Update mention notifications to also increment unread_mentions in unread_counts table
CREATE OR REPLACE FUNCTION public.increment_unread_mentions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_user_id uuid;
    v_channel_id uuid;
    v_server_id uuid;
    v_conversation_id uuid;
    existing_count_id uuid;
BEGIN
    -- Only process mention notifications
    IF NEW.type != 'mention' AND NEW.type != 'activitypub_mention' THEN
        RETURN NEW;
    END IF;
    
    v_user_id := NEW.user_id;
    
    -- Extract channel/server/conversation IDs from notification data
    v_channel_id := NULLIF((NEW.data->>'channel_id'), '')::uuid;
    v_server_id := NULLIF((NEW.data->>'server_id'), '')::uuid;
    v_conversation_id := NULLIF((NEW.data->>'conversation_id'), '')::uuid;
    
    -- If no channel/server/conversation ID in data, try location object
    IF v_channel_id IS NULL THEN
        v_channel_id := NULLIF((NEW.data->'location'->>'channel_id'), '')::uuid;
    END IF;
    IF v_server_id IS NULL THEN
        v_server_id := NULLIF((NEW.data->'location'->>'server_id'), '')::uuid;
    END IF;
    
    -- Increment unread_mentions in unread_counts table
    -- For channel mentions
    IF v_channel_id IS NOT NULL THEN
        -- Check if unread_count record exists
        SELECT id INTO existing_count_id
        FROM unread_counts
        WHERE user_id = v_user_id
          AND channel_id = v_channel_id
          AND (server_id = v_server_id OR (server_id IS NULL AND v_server_id IS NULL))
          AND conversation_id IS NULL;
        
        IF existing_count_id IS NOT NULL THEN
            -- Update existing record
            UPDATE unread_counts
            SET unread_mentions = unread_mentions + 1,
                updated_at = NOW()
            WHERE id = existing_count_id;
        ELSE
            -- Insert new record
            INSERT INTO unread_counts (user_id, channel_id, server_id, unread_mentions, updated_at)
            VALUES (v_user_id, v_channel_id, v_server_id, 1, NOW());
        END IF;
    END IF;
    
    -- For DM/conversation mentions
    IF v_conversation_id IS NOT NULL THEN
        -- Check if unread_count record exists
        SELECT id INTO existing_count_id
        FROM unread_counts
        WHERE user_id = v_user_id
          AND conversation_id = v_conversation_id
          AND channel_id IS NULL
          AND server_id IS NULL;
        
        IF existing_count_id IS NOT NULL THEN
            -- Update existing record
            UPDATE unread_counts
            SET unread_mentions = unread_mentions + 1,
                updated_at = NOW()
            WHERE id = existing_count_id;
        ELSE
            -- Insert new record
            INSERT INTO unread_counts (user_id, conversation_id, unread_mentions, updated_at)
            VALUES (v_user_id, v_conversation_id, 1, NOW());
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.increment_unread_mentions IS 'Increments unread_mentions count in unread_counts table when mention notifications are created.';

-- Create trigger to increment unread mentions
DROP TRIGGER IF EXISTS trigger_increment_unread_mentions ON public.notifications;
CREATE TRIGGER trigger_increment_unread_mentions
    AFTER INSERT ON public.notifications
    FOR EACH ROW
    WHEN (NEW.type IN ('mention', 'activitypub_mention'))
    EXECUTE FUNCTION public.increment_unread_mentions();

COMMENT ON TRIGGER trigger_increment_unread_mentions ON public.notifications IS 'Automatically increments unread_mentions count when mention notifications are created.';

