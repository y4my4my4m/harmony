-- =============================================
-- COMPLETE NOTIFICATION SYSTEM FIX MIGRATION
-- =============================================
-- This migration adds missing helper functions and fixes the notification system

-- 1. Create the missing should_create_notification function with user preferences checking
CREATE OR REPLACE FUNCTION should_create_notification(
    p_user_id UUID,
    p_type VARCHAR(50),
    p_server_id UUID DEFAULT NULL,
    p_channel_id UUID DEFAULT NULL,
    p_conversation_id UUID DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    user_prefs RECORD;
    channel_settings RECORD;
    is_dnd_active BOOLEAN;
    current_time_val TIME;
BEGIN
    -- Get user notification preferences
    SELECT * INTO user_prefs 
    FROM notification_preferences 
    WHERE user_id = p_user_id;
    
    -- If no preferences found, use defaults (allow notifications)
    IF user_prefs IS NULL THEN
        RETURN TRUE;
    END IF;
    
    -- Check if Do Not Disturb is active
    current_time_val := CURRENT_TIME;
    is_dnd_active := FALSE;
    
    IF user_prefs.dnd_enabled THEN
        IF user_prefs.dnd_start_time::TIME > user_prefs.dnd_end_time::TIME THEN
            -- DND spans midnight (e.g., 22:00 to 08:00)
            is_dnd_active := current_time_val >= user_prefs.dnd_start_time::TIME 
                           OR current_time_val <= user_prefs.dnd_end_time::TIME;
        ELSE
            -- DND within same day
            is_dnd_active := current_time_val >= user_prefs.dnd_start_time::TIME 
                           AND current_time_val <= user_prefs.dnd_end_time::TIME;
        END IF;
    END IF;
    
    -- If DND is active, only allow critical notifications
    IF is_dnd_active AND p_type NOT IN ('dm', 'mention') THEN
        RETURN FALSE;
    END IF;
    
    -- Check channel-specific settings if applicable
    IF p_server_id IS NOT NULL OR p_channel_id IS NOT NULL OR p_conversation_id IS NOT NULL THEN
        SELECT * INTO channel_settings
        FROM notification_channels
        WHERE user_id = p_user_id
        AND (
            (server_id = p_server_id AND channel_id IS NULL AND conversation_id IS NULL) OR
            (channel_id = p_channel_id) OR
            (conversation_id = p_conversation_id)
        );
        
        -- Check if channel/conversation is muted
        IF channel_settings.muted THEN
            -- Check if mute has expired
            IF channel_settings.muted_until IS NULL OR channel_settings.muted_until > NOW() THEN
                RETURN FALSE;
            END IF;
        END IF;
        
        -- Check notification level
        IF channel_settings.notification_level = 'none' THEN
            RETURN FALSE;
        ELSIF channel_settings.notification_level = 'mentions' AND p_type NOT IN ('mention', 'dm') THEN
            RETURN FALSE;
        END IF;
    END IF;
    
    -- Check type-specific preferences
    CASE p_type
        WHEN 'mention' THEN
            RETURN user_prefs.desktop_mentions;
        WHEN 'dm' THEN
            RETURN user_prefs.desktop_dms;
        WHEN 'reaction' THEN
            RETURN user_prefs.desktop_reactions;
        WHEN 'reply' THEN
            RETURN user_prefs.desktop_replies;
        ELSE
            RETURN TRUE; -- Default to allowing notification
    END CASE;
    
END;
$$ LANGUAGE plpgsql;

-- 2. Create the missing extract_mentions function
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

-- 3. Create the missing get_user_id_from_username function
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

-- 4. Now create/recreate the triggers (using the correct function names)
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

-- 5. Ensure realtime is enabled for notifications
DO $$
BEGIN
    -- Try to add notifications table to realtime publication
    ALTER publication supabase_realtime ADD TABLE notifications;
EXCEPTION
    WHEN duplicate_object THEN
        -- Table already added to publication
        NULL;
END $$;

-- 6. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_notification_preferences_user_id ON notification_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_channels_user_id ON notification_channels(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_channels_composite ON notification_channels(user_id, server_id, channel_id, conversation_id);

-- 7. Test the system by checking if all components exist
SELECT 
    'Functions' as component,
    COUNT(*) as count
FROM pg_proc 
WHERE proname IN (
    'should_create_notification', 
    'extract_mentions', 
    'get_user_id_from_username',
    'handle_message_notifications',
    'handle_reaction_notifications'
)

UNION ALL

SELECT 
    'Triggers' as component,
    COUNT(*) as count
FROM pg_trigger 
WHERE tgname IN ('trigger_message_notifications', 'trigger_reaction_notifications')

UNION ALL

SELECT 
    'Tables' as component,
    COUNT(*) as count
FROM information_schema.tables 
WHERE table_name IN ('notifications', 'notification_preferences', 'notification_channels');

-- 8. Grant necessary permissions
GRANT EXECUTE ON FUNCTION should_create_notification TO authenticated;
GRANT EXECUTE ON FUNCTION extract_mentions TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_id_from_username TO authenticated;

-- 9. Add comments for documentation
COMMENT ON FUNCTION should_create_notification IS 'Checks user preferences and channel settings to determine if a notification should be created';
COMMENT ON FUNCTION extract_mentions IS 'Extracts mention usernames from JSONB message content';
COMMENT ON FUNCTION get_user_id_from_username IS 'Gets user ID from username for mention processing';
COMMENT ON TRIGGER trigger_message_notifications ON messages IS 'Automatically creates notifications for mentions, DMs, and replies when messages are inserted';
COMMENT ON TRIGGER trigger_reaction_notifications ON reactions IS 'Automatically creates notifications when reactions are added to messages';

-- Success message
SELECT 'Notification system migration completed successfully!' as status;