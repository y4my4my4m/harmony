-- Fix follow notifications to include complete follower profile data
-- and use the correct 'activitypub_follow' notification type
--
-- Issue: Follow notifications were being created with incomplete data:
--   - Using 'follow' type instead of 'activitypub_follow'
--   - Only including follower_id, missing profile data (username, display_name, avatar, etc.)
--
-- This causes the notification display to show "Unknown" for the follower

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
    follower_record RECORD;
BEGIN
    -- Early exit for non-notification operations
    IF TG_OP = 'UPDATE' THEN
        RETURN NEW;
    END IF;

    -- Handle different table operations (removed mentions handling - now done directly in handle_message_federation)
    IF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        -- Handle follow notifications with complete follower profile data
        -- Get follower profile information
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO follower_record
        FROM profiles
        WHERE id = NEW.follower_id;
        
        IF follower_record IS NOT NULL THEN
            -- Build comprehensive notification data matching frontend expectations
            notification_data := jsonb_build_object(
                'type', 'activitypub_follow',
                'follower_id', NEW.follower_id,
                'follow_id', NEW.id,
                'timestamp', NOW(),
                'follower', jsonb_build_object(
                    'id', follower_record.id,
                    'username', follower_record.username,
                    'display_name', COALESCE(follower_record.display_name, follower_record.username),
                    'avatar_url', follower_record.avatar_url,
                    'domain', follower_record.domain,
                    'is_local', COALESCE(follower_record.is_local, true),
                    'handle', CASE 
                        WHEN follower_record.is_local = true OR follower_record.domain IS NULL 
                        THEN '@' || follower_record.username
                        ELSE '@' || follower_record.username || '@' || follower_record.domain
                    END
                )
            );
            
            PERFORM send_notification_to_user(
                'activitypub_follow',
                NEW.following_id,
                notification_data,
                NULL,
                NULL,
                NULL,
                NEW.follower_id,
                'normal'
            );
        END IF;

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

-- Update the comment to reflect the changes
COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 'Handles notifications for follows (with full profile data), reactions, and ActivityPub emoji reactions. Uses activitypub_follow type for follow notifications with complete follower profile data.';

