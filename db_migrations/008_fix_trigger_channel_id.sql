-- Migration 008: Fix notification trigger channel_id reference error
-- 
-- Issue: The handle_unified_notification_processing trigger tries to access
-- NEW.channel_id when processing reactions, but NEW refers to the reactions
-- table which doesn't have a channel_id field. We need to JOIN to get the
-- channel_id from the related message.
--
-- Error: record "new" has no field "channel_id"

-- =====================================================
-- Fix the notification trigger
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing()
RETURNS trigger
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
    -- Add variables for message context when processing reactions
    message_channel_id uuid;
    message_server_id uuid;
BEGIN
    -- Process based on table and determine notification recipients
    IF TG_TABLE_NAME = 'posts' AND TG_OP = 'INSERT' THEN
        -- Handle post mention notifications
        mentioned_users := extract_mentions(NEW.content);
        
        IF array_length(mentioned_users, 1) > 0 THEN
            notification_data := jsonb_build_object(
                'type', 'mention',
                'post_id', NEW.id,
                'author_id', NEW.author_id,
                'content_preview', substring(convert_unified_content_to_plain_text(NEW.content) for 100)
            );
            
            PERFORM send_notification(
                'mention',
                mentioned_users,
                notification_data,
                NULL,
                NULL, 
                NULL,
                NEW.author_id,
                'normal'
            );
        END IF;

        -- Handle reply notifications
        IF NEW.in_reply_to IS NOT NULL THEN
            SELECT author_id INTO single_target_id 
            FROM posts WHERE id = NEW.in_reply_to;
            
            IF single_target_id IS NOT NULL AND single_target_id != NEW.author_id THEN
                notification_data := jsonb_build_object(
                    'type', 'reply',
                    'post_id', NEW.id,
                    'reply_to_id', NEW.in_reply_to,
                    'author_id', NEW.author_id,
                    'content_preview', substring(convert_unified_content_to_plain_text(NEW.content) for 100)
                );
                
                PERFORM send_notification_to_user(
                    'reply',
                    single_target_id,
                    notification_data,
                    NULL,
                    NULL,
                    NULL,
                    NEW.author_id,
                    'normal'
                );
            END IF;
        END IF;

    ELSIF TG_TABLE_NAME = 'messages' AND TG_OP = 'INSERT' THEN
        -- Handle message mention notifications  
        IF NEW.channel_id IS NOT NULL THEN
            -- Channel message mentions
            mentioned_users := extract_mentions(NEW.content);
            
            IF array_length(mentioned_users, 1) > 0 THEN
                notification_data := jsonb_build_object(
                    'type', 'mention',
                    'message_id', NEW.id,
                    'channel_id', NEW.channel_id,
                    'author_id', NEW.user_id,
                    'content_preview', substring(convert_unified_content_to_plain_text(NEW.content) for 100)
                );
                
                PERFORM send_notification(
                    'mention',
                    mentioned_users,
                    notification_data,
                    (SELECT server_id FROM channels WHERE id = NEW.channel_id),
                    NEW.channel_id,
                    NULL,
                    NEW.user_id,
                    'normal'
                );
            END IF;
        ELSIF NEW.conversation_id IS NOT NULL THEN
            -- DM notifications
            SELECT array_agg(DISTINCT unnest) INTO target_user_ids
            FROM (
                SELECT unnest(ARRAY[c.user1, c.user2])
                FROM conversations c 
                WHERE c.id = NEW.conversation_id
            ) t
            WHERE unnest != NEW.user_id;
            
            IF array_length(target_user_ids, 1) > 0 THEN
                notification_data := jsonb_build_object(
                    'type', 'direct_message',
                    'message_id', NEW.id,
                    'conversation_id', NEW.conversation_id,
                    'author_id', NEW.user_id,
                    'content_preview', substring(convert_unified_content_to_plain_text(NEW.content) for 100)
                );
                
                PERFORM send_notification(
                    'dm',
                    target_user_ids,
                    notification_data,
                    NULL,
                    NULL,
                    NEW.conversation_id,
                    NEW.user_id,
                    'high'
                );
            END IF;
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' AND TG_OP = 'INSERT' THEN
        -- Handle like/reblog notifications
        SELECT author_id INTO single_target_id FROM posts WHERE id = NEW.post_id;
        
        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            notification_data := jsonb_build_object(
                'type', NEW.interaction_type,
                'post_id', NEW.post_id,
                'user_id', NEW.user_id
            );
            
            PERFORM send_notification_to_user(
                NEW.interaction_type,
                single_target_id,
                notification_data,
                NULL,
                NULL,
                NULL,
                NEW.user_id,
                'normal'
            );
        END IF;

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
        -- Handle reaction notifications
        SELECT user_id INTO single_target_id FROM messages WHERE id = NEW.message_id;
        
        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            -- FIXED: Get channel_id and server_id from the related message
            -- This is the key fix - we can't access NEW.channel_id because
            -- NEW refers to the reactions table, not the messages table
            SELECT m.channel_id, c.server_id 
            INTO message_channel_id, message_server_id
            FROM messages m 
            LEFT JOIN channels c ON m.channel_id = c.id 
            WHERE m.id = NEW.message_id;
            
            notification_data := jsonb_build_object(
                'type', 'reaction',
                'message_id', NEW.message_id,
                'emoji_id', NEW.emoji_id,
                'user_id', NEW.user_id
            );
            
            -- FIXED: Use the fetched channel_id and server_id
            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                message_server_id,  -- FIXED: Use fetched server_id
                message_channel_id, -- FIXED: Use fetched channel_id
                NULL,
                NEW.user_id,
                'normal'
            );
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 'Fixed trigger function that properly handles reactions by fetching channel_id from related message instead of trying to access non-existent NEW.channel_id';

-- =====================================================
-- Migration complete
-- =====================================================