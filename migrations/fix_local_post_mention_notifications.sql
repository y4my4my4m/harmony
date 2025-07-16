-- Fix Local Post Mention Notifications
-- Ensures that posts with mentions to local users create proper notifications
-- This handles LOCAL-to-LOCAL mentions (different from federated mentions)

-- =====================================================
-- CREATE MENTION NOTIFICATION FUNCTION
-- =====================================================

-- Function to extract mentions from post content and create notifications
CREATE OR REPLACE FUNCTION handle_local_post_mention_notifications()
RETURNS TRIGGER 
LANGUAGE plpgsql
AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
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
            -- Extract mentions from unified content format
            FOR content_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                -- Check if this is a mention
                IF content_part->>'type' = 'mention' THEN
                    -- Extract username from mention
                    mentioned_username := content_part->>'username';
                    
                    -- Get the mentioned user ID (only local users)
                    SELECT id INTO mentioned_user_id
                    FROM profiles
                    WHERE username = mentioned_username
                      AND is_local = true
                      AND id != NEW.author_id; -- Don't notify self
                    
                    -- Create notification if mentioned user found
                    IF mentioned_user_id IS NOT NULL THEN
                        PERFORM create_simple_activitypub_notification(
                            mentioned_user_id,
                            'activitypub_mention',
                            jsonb_build_object(
                                'author', jsonb_build_object(
                                    'id', author_profile.id,
                                    'username', author_profile.username,
                                    'display_name', author_profile.display_name,
                                    'avatar_url', author_profile.avatar_url,
                                    'domain', author_profile.domain,
                                    'is_local', author_profile.is_local
                                ),
                                'post_id', NEW.id,
                                'post_content', NEW.content,
                                'timestamp', NEW.created_at
                            )
                        );
                        
                        RAISE NOTICE '✅ Created mention notification: % mentioned %', 
                            author_profile.username, mentioned_username;
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- =====================================================
-- CREATE TRIGGER FOR POST MENTIONS
-- =====================================================

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS handle_local_post_mention_notifications_trigger ON posts;

-- Create new trigger for local post mentions
CREATE TRIGGER handle_local_post_mention_notifications_trigger
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_local_post_mention_notifications();

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Check that the trigger was created
SELECT 
    tgname as trigger_name,
    tgrelid::regclass as table_name,
    proname as function_name,
    tgenabled as enabled
FROM pg_trigger 
JOIN pg_proc ON pg_trigger.tgfoid = pg_proc.oid
WHERE tgname = 'handle_local_post_mention_notifications_trigger';

-- Add documentation
COMMENT ON FUNCTION handle_local_post_mention_notifications() IS 'Creates notifications for local users mentioned in posts by other local users';
COMMENT ON TRIGGER handle_local_post_mention_notifications_trigger ON posts IS 'Automatically creates mention notifications when posts contain mentions to local users';

-- =====================================================
-- TESTING
-- =====================================================

-- Test query to check recent mention notifications
/*
SELECT 
    n.id,
    n.type,
    n.data->'author'->>'username' as author,
    n.data->>'post_id' as post_id,
    n.created_at
FROM notifications n
WHERE n.type = 'activitypub_mention'
ORDER BY n.created_at DESC
LIMIT 5;
*/

-- =====================================================
-- FIX MESSAGE MENTION NOTIFICATIONS (CHAT/DM)
-- =====================================================

-- Function to handle chat mention notifications (channel messages only)
CREATE OR REPLACE FUNCTION handle_chat_mention_notifications()
RETURNS TRIGGER 
LANGUAGE plpgsql
AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    sender_profile RECORD;
    channel_info RECORD;
    notification_data JSONB;
BEGIN
    -- Only handle new channel messages (not DMs)
    IF TG_OP = 'INSERT' AND NEW.channel_id IS NOT NULL THEN
        -- Get channel and server info
        SELECT c.*, s.name as server_name INTO channel_info
        FROM channels c
        JOIN servers s ON c.server_id = s.id 
        WHERE c.id = NEW.channel_id;
        
        -- Only process if channel found
        IF FOUND THEN
            -- Get sender profile for notification data
            SELECT id, username, display_name, avatar_url, domain, is_local
            INTO sender_profile
            FROM profiles 
            WHERE id = NEW.user_id;
            
            -- Only process if sender found and content exists
            IF FOUND AND NEW.content IS NOT NULL THEN
                -- Extract mentions from unified content format
                FOR content_part IN SELECT jsonb_array_elements(NEW.content)
                LOOP
                    -- Check if this is a mention
                    IF content_part->>'type' = 'mention' THEN
                        -- Extract username from mention
                        mentioned_username := content_part->>'username';
                        
                        -- Get the mentioned user ID (only local users in the same server)
                        SELECT p.id INTO mentioned_user_id
                        FROM profiles p
                        JOIN user_servers us ON p.id = us.user_id
                        WHERE p.username = mentioned_username
                          AND p.is_local = true
                          AND p.id != NEW.user_id -- Don't notify self
                          AND us.server_id = channel_info.server_id; -- Must be in the same server
                        
                        -- Create notification if mentioned user found and is in server
                        IF mentioned_user_id IS NOT NULL THEN
                            -- Build notification data with parsed content preview
                            notification_data := jsonb_build_object(
                                'sender', jsonb_build_object(
                                    'user_id', sender_profile.id,
                                    'username', sender_profile.username,
                                    'display_name', sender_profile.display_name,
                                    'avatar_url', sender_profile.avatar_url,
                                    'domain', sender_profile.domain
                                ),
                                'message', jsonb_build_object(
                                    'id', NEW.id,
                                    'content_preview', LEFT(convert_unified_content_to_plain_text(NEW.content), 100),
                                    'created_at', NEW.created_at
                                ),
                                'location', jsonb_build_object(
                                    'server_id', channel_info.server_id,
                                    'server_name', channel_info.server_name,
                                    'channel_id', NEW.channel_id,
                                    'channel_name', channel_info.name
                                ),
                                'mentioned_username', mentioned_username
                            );
                            
                            PERFORM create_notification_structured(
                                mentioned_user_id,
                                'mention',
                                notification_data,
                                channel_info.server_id,
                                NEW.channel_id,
                                NULL
                            );
                            
                            RAISE NOTICE '✅ Created chat mention notification: % mentioned % in #% (server: %)', 
                                sender_profile.username, mentioned_username, channel_info.name, channel_info.server_name;
                        ELSE
                            RAISE NOTICE '❌ User % not found or not in server % - mention ignored', 
                                mentioned_username, channel_info.server_name;
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- =====================================================
-- CREATE TRIGGER FOR CHAT MENTIONS
-- =====================================================

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS handle_chat_mention_notifications_trigger ON messages;

-- Create new trigger for chat mentions (channel messages only, DMs already work)
CREATE TRIGGER handle_chat_mention_notifications_trigger
    AFTER INSERT ON messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL) -- Only for channel messages, not DMs
    EXECUTE FUNCTION handle_chat_mention_notifications();

-- Add documentation
COMMENT ON FUNCTION handle_chat_mention_notifications() IS 'Creates notifications for local users mentioned in channel messages (not DMs - those already work)';
COMMENT ON TRIGGER handle_chat_mention_notifications_trigger ON messages IS 'Automatically creates mention notifications when channel messages contain mentions to local users in the same server';

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Check that both triggers were created
SELECT 
    tgname as trigger_name,
    tgrelid::regclass as table_name,
    proname as function_name,
    tgenabled as enabled
FROM pg_trigger 
JOIN pg_proc ON pg_trigger.tgfoid = pg_proc.oid
WHERE tgname IN (
    'handle_local_post_mention_notifications_trigger',
    'handle_chat_mention_notifications_trigger'
);


-- Test query to check recent chat mention notifications
/*
SELECT 
    n.id,
    n.type,
    n.data->'sender'->>'username' as sender,
    n.data->>'mentioned_username' as mentioned_user,
    n.data->'location'->>'channel_name' as channel,
    n.data->'location'->>'server_name' as server,
    n.created_at
FROM notifications n
WHERE n.type = 'mention'
  AND n.data->'location'->>'channel_id' IS NOT NULL
ORDER BY n.created_at DESC
LIMIT 5;
*/
