-- =============================================
-- FINAL NOTIFICATION SYSTEM FIX MIGRATION
-- =============================================
-- This migration fixes the notification system to work with structured data only
-- and fixes the DM conversation schema mismatch

-- 1. Update create_notification_structured function to NOT use title/message
CREATE OR REPLACE FUNCTION create_notification_structured(
    p_user_id UUID,
    p_type VARCHAR(50),
    p_data JSONB DEFAULT '{}',
    p_server_id UUID DEFAULT NULL,
    p_channel_id UUID DEFAULT NULL,
    p_conversation_id UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    notification_id UUID;
BEGIN
    -- Check if notification should be created
    IF NOT should_create_notification(p_user_id, p_type, p_server_id, p_channel_id, p_conversation_id) THEN
        RETURN NULL;
    END IF;
    
    -- Create the notification with structured data only (NO title/message)
    INSERT INTO notifications (user_id, type, data)
    VALUES (p_user_id, p_type, p_data)
    RETURNING id INTO notification_id;
    
    RETURN notification_id;
END;
$$ LANGUAGE plpgsql;

-- 2. Fix the DM conversation schema mismatch
-- Update handle_message_notifications to use correct conversation field names
CREATE OR REPLACE FUNCTION handle_message_notifications()
RETURNS TRIGGER AS $$
DECLARE
    mentioned_usernames TEXT[];
    mentioned_user_id UUID;
    username_item TEXT;
    sender_profile profiles%ROWTYPE;
    channel_info channels%ROWTYPE;
    server_info servers%ROWTYPE;
    conversation_info conversations%ROWTYPE;
    reply_author_id UUID;
    content_preview TEXT;
    notification_data JSONB;
BEGIN
    -- Get sender profile
    SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- Extract content preview for notifications (first 100 chars)
    IF jsonb_typeof(NEW.content) = 'array' THEN
        SELECT LEFT(string_agg(
            CASE 
                WHEN item->>'type' = 'mention' THEN '@' || (item->>'mention')
                ELSE COALESCE(item->>'text', item::text)
            END, ''
        ), 100) INTO content_preview
        FROM jsonb_array_elements(NEW.content) AS item;
    ELSE
        content_preview := LEFT(NEW.content::text, 100);
    END IF;
    
    -- Handle DM notifications
    IF NEW.conversation_id IS NOT NULL THEN
        SELECT * INTO conversation_info FROM conversations WHERE id = NEW.conversation_id;
        
        -- Build structured data for DM notification
        notification_data := jsonb_build_object(
            'sender', jsonb_build_object(
                'user_id', sender_profile.id,
                'username', sender_profile.username,
                'avatar_url', sender_profile.avatar_url
            ),
            'conversation', jsonb_build_object(
                'id', NEW.conversation_id
            ),
            'message', jsonb_build_object(
                'id', NEW.id,
                'content_preview', content_preview,
                'created_at', NEW.created_at
            )
        );
        
        -- Fixed: Use correct field names (user1, user2 not user1_id, user2_id)
        IF conversation_info.user1 != NEW.user_id THEN
            PERFORM create_notification_structured(
                conversation_info.user1,
                'dm',
                notification_data,
                NULL,
                NULL,
                NEW.conversation_id
            );
        END IF;
        
        IF conversation_info.user2 != NEW.user_id THEN
            PERFORM create_notification_structured(
                conversation_info.user2,
                'dm',
                notification_data,
                NULL,
                NULL,
                NEW.conversation_id
            );
        END IF;
    
    -- Handle server channel notifications
    ELSIF NEW.channel_id IS NOT NULL THEN
        SELECT * INTO channel_info FROM channels WHERE id = NEW.channel_id;
        SELECT * INTO server_info FROM servers WHERE id = channel_info.server_id;
        
        -- Build base structured data for server notifications
        notification_data := jsonb_build_object(
            'sender', jsonb_build_object(
                'user_id', sender_profile.id,
                'username', sender_profile.username,
                'avatar_url', sender_profile.avatar_url
            ),
            'location', jsonb_build_object(
                'server_id', channel_info.server_id,
                'server_name', server_info.name,
                'channel_id', NEW.channel_id,
                'channel_name', channel_info.name
            ),
            'message', jsonb_build_object(
                'id', NEW.id,
                'content_preview', content_preview,
                'created_at', NEW.created_at
            )
        );
        
        -- Handle reply notifications
        IF NEW.reply_to IS NOT NULL THEN
            SELECT user_id INTO reply_author_id FROM messages WHERE id = NEW.reply_to;
            
            IF reply_author_id IS NOT NULL AND reply_author_id != NEW.user_id THEN
                PERFORM create_notification_structured(
                    reply_author_id,
                    'reply',
                    notification_data || jsonb_build_object(
                        'original_message', jsonb_build_object(
                            'id', NEW.reply_to
                        )
                    ),
                    channel_info.server_id,
                    NEW.channel_id,
                    NULL
                );
            END IF;
        END IF;
        
        -- Handle mention notifications
        mentioned_usernames := extract_mentions(NEW.content);
        
        FOREACH username_item IN ARRAY mentioned_usernames
        LOOP
            mentioned_user_id := get_user_id_from_username(username_item);
            
            IF mentioned_user_id IS NOT NULL AND mentioned_user_id != NEW.user_id THEN
                PERFORM create_notification_structured(
                    mentioned_user_id,
                    'mention',
                    notification_data,
                    channel_info.server_id,
                    NEW.channel_id,
                    NULL
                );
            END IF;
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Add the missing helper functions if they don't exist
CREATE OR REPLACE FUNCTION should_create_notification(
    p_user_id UUID,
    p_type VARCHAR(50),
    p_server_id UUID DEFAULT NULL,
    p_channel_id UUID DEFAULT NULL,
    p_conversation_id UUID DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
    -- For now, always allow notifications
    -- This can be enhanced later with user preferences
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION extract_mentions(content JSONB)
RETURNS TEXT[] AS $$
DECLARE
    mentions TEXT[] := '{}';
    item JSONB;
BEGIN
    -- Handle array content (rich text)
    IF jsonb_typeof(content) = 'array' THEN
        FOR item IN SELECT jsonb_array_elements(content)
        LOOP
            IF item->>'type' = 'mention' AND item->>'mention' IS NOT NULL THEN
                mentions := array_append(mentions, item->>'mention');
            END IF;
        END LOOP;
    END IF;
    
    RETURN mentions;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_user_id_from_username(username_param TEXT)
RETURNS UUID AS $$
DECLARE
    user_id UUID;
BEGIN
    SELECT id INTO user_id
    FROM profiles
    WHERE username = username_param
    LIMIT 1;
    
    RETURN user_id;
END;
$$ LANGUAGE plpgsql;

-- 4. Create the triggers
DROP TRIGGER IF EXISTS trigger_message_notifications ON messages;
CREATE TRIGGER trigger_message_notifications
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION handle_message_notifications();

DROP TRIGGER IF EXISTS trigger_reaction_notifications ON reactions;
CREATE TRIGGER trigger_reaction_notifications
    AFTER INSERT ON reactions
    FOR EACH ROW
    EXECUTE FUNCTION handle_reaction_notifications();

-- 5. Ensure realtime is enabled
DO $$
BEGIN
    ALTER publication supabase_realtime ADD TABLE notifications;
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END $$;

-- 6. Test query to verify everything works
SELECT 
    'Setup Complete - Structured Data Only Notifications' as status,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_message_notifications') as message_trigger_exists,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_reaction_notifications') as reaction_trigger_exists;