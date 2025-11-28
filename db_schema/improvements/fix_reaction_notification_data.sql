-- Fix reaction notifications to include reactor profile data
-- The current trigger only includes user_id, but frontend expects full reactor profile

CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    single_target_id uuid;
    notification_data jsonb;
    msg_channel_id uuid;
    msg_server_id uuid;
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
        -- Get complete follower profile for the notification
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO follower_profile
        FROM profiles
        WHERE id = NEW.follower_id;

        IF follower_profile.id IS NOT NULL THEN
            -- Build notification data with complete follower profile
            notification_data := jsonb_build_object(
                'type', 'activitypub_follow',
                'follower_id', NEW.follower_id,
                'follower', jsonb_build_object(
                    'id', follower_profile.id,
                    'username', follower_profile.username,
                    'display_name', follower_profile.display_name,
                    'avatar_url', follower_profile.avatar_url,
                    'domain', follower_profile.domain,
                    'is_local', follower_profile.is_local
                )
            );

            -- Create the notification
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
            
            -- Get reactor profile for the notification
            SELECT id, username, display_name, avatar_url, domain, is_local
            INTO reactor_profile
            FROM profiles
            WHERE id = NEW.user_id;
            
            -- Get emoji data if available
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
                'emoji_id', NEW.emoji_id,
                'user_id', NEW.user_id,
                'emoji_name', emoji_name,
                'emoji_url', emoji_url,
                'reactor', CASE WHEN reactor_profile.id IS NOT NULL THEN
                    jsonb_build_object(
                        'id', reactor_profile.id,
                        'username', reactor_profile.username,
                        'display_name', reactor_profile.display_name,
                        'avatar_url', reactor_profile.avatar_url,
                        'domain', reactor_profile.domain,
                        'is_local', reactor_profile.is_local
                    )
                ELSE NULL END
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
                
                -- Get reactor profile
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
                    'type', 'activitypub_reaction',
                    'post_id', NEW.post_id,
                    'post', jsonb_build_object(
                        'id', post_record.id,
                        'content_preview', post_record.content
                    ),
                    'reaction', jsonb_build_object(
                        'emoji_id', NEW.emoji_id,
                        'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content),
                        'emoji_url', emoji_url,
                        'custom_emoji_content', NEW.custom_emoji_content
                    ),
                    'sender', CASE WHEN reactor_profile.id IS NOT NULL THEN
                        jsonb_build_object(
                            'id', reactor_profile.id,
                            'username', reactor_profile.username,
                            'display_name', reactor_profile.display_name,
                            'avatar_url', reactor_profile.avatar_url,
                            'domain', reactor_profile.domain,
                            'is_local', reactor_profile.is_local
                        )
                    ELSE NULL END
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

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 
'Handles notifications for follows (with full profile data), reactions, and ActivityPub emoji reactions. 
Now includes full reactor/sender profile in notification data for proper display.';

