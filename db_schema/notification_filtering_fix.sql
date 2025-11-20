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
        IF channel_id IS NOT NULL OR conversation_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 
                FROM notification_channels nc
                WHERE nc.user_id = recipient_id
                AND nc.muted = true
                AND (
                    (channel_id IS NOT NULL AND nc.channel_id = channel_id)
                    OR
                    (conversation_id IS NOT NULL AND nc.conversation_id = conversation_id)
                )
                AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
            ) INTO is_channel_muted;
            
            IF is_channel_muted THEN
                CONTINUE; -- Skip this recipient
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

COMMENT ON FUNCTION public.handle_unified_notification_processing IS 'Handles notifications for mentions, follows, reactions, and ActivityPub emoji reactions. Now includes support for post_interactions emoji_reaction type.';

