-- Notifications System Schema
-- Professional notification system with real-time updates and RLS

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL, -- 'mention', 'dm', 'reaction', 'reply', 'server_invite', 'friend_request'
    title VARCHAR(255) NOT NULL,
    message TEXT,
    data JSONB DEFAULT '{}', -- Additional data (message_id, server_id, channel_id, etc.)
    is_read BOOLEAN DEFAULT FALSE,
    is_clicked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '30 days')
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_expires_at ON notifications(expires_at);

-- Create notification preferences table
CREATE TABLE IF NOT EXISTS notification_preferences (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
    
    -- Desktop notifications
    desktop_notifications BOOLEAN DEFAULT TRUE,
    desktop_mentions BOOLEAN DEFAULT TRUE,
    desktop_dms BOOLEAN DEFAULT TRUE,
    desktop_reactions BOOLEAN DEFAULT FALSE,
    desktop_replies BOOLEAN DEFAULT TRUE,
    
    -- Sound notifications
    sound_notifications BOOLEAN DEFAULT TRUE,
    sound_mentions BOOLEAN DEFAULT TRUE,
    sound_dms BOOLEAN DEFAULT TRUE,
    sound_reactions BOOLEAN DEFAULT FALSE,
    sound_voice_activity BOOLEAN DEFAULT TRUE,
    
    -- Push notifications (for PWA)
    push_notifications BOOLEAN DEFAULT TRUE,
    push_mentions BOOLEAN DEFAULT TRUE,
    push_dms BOOLEAN DEFAULT TRUE,
    push_offline_only BOOLEAN DEFAULT TRUE,
    
    -- Email notifications
    email_notifications BOOLEAN DEFAULT FALSE,
    email_digest BOOLEAN DEFAULT FALSE,
    email_digest_frequency VARCHAR(20) DEFAULT 'weekly', -- 'daily', 'weekly', 'never'
    
    -- Do not disturb
    dnd_enabled BOOLEAN DEFAULT FALSE,
    dnd_start_time TIME DEFAULT '22:00:00',
    dnd_end_time TIME DEFAULT '08:00:00',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create notification channels table (for grouping notifications)
CREATE TABLE IF NOT EXISTS notification_channels (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    
    -- Notification settings per channel/server
    muted BOOLEAN DEFAULT FALSE,
    muted_until TIMESTAMP WITH TIME ZONE,
    notification_level VARCHAR(20) DEFAULT 'all', -- 'all', 'mentions', 'none'
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create unique index for notification channels (handles the complex constraint properly)
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_unique 
ON notification_channels(user_id, server_id, channel_id, conversation_id);

-- Create unread counts table (for efficient badge counting)
CREATE TABLE IF NOT EXISTS unread_counts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    
    unread_messages INTEGER DEFAULT 0,
    unread_mentions INTEGER DEFAULT 0,
    last_read_message_id UUID,
    last_read_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create unique index for unread counts (handles NULLs properly)
CREATE UNIQUE INDEX IF NOT EXISTS idx_unread_counts_unique 
ON unread_counts(user_id, server_id, channel_id, conversation_id);

-- Enable Row Level Security
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE unread_counts ENABLE ROW LEVEL SECURITY;

-- RLS Policies for notifications
CREATE POLICY "Users can view their own notifications" ON notifications
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own notifications" ON notifications
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "System can insert notifications" ON notifications
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Users can delete their own notifications" ON notifications
    FOR DELETE USING (auth.uid() = user_id);

-- RLS Policies for notification preferences
CREATE POLICY "Users can manage their own notification preferences" ON notification_preferences
    FOR ALL USING (auth.uid() = user_id);

-- RLS Policies for notification channels
CREATE POLICY "Users can manage their own notification channels" ON notification_channels
    FOR ALL USING (auth.uid() = user_id);

-- RLS Policies for unread counts
CREATE POLICY "Users can view their own unread counts" ON unread_counts
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own unread counts" ON unread_counts
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "System can manage unread counts" ON unread_counts
    FOR ALL WITH CHECK (true);

-- Enable real-time for notifications
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE notification_preferences;
ALTER PUBLICATION supabase_realtime ADD TABLE notification_channels;
ALTER PUBLICATION supabase_realtime ADD TABLE unread_counts;

-- Function to automatically create notification preferences for new users
CREATE OR REPLACE FUNCTION create_notification_preferences()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO notification_preferences (user_id)
    VALUES (NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to create notification preferences when a user is created
CREATE TRIGGER create_notification_preferences_trigger
    AFTER INSERT ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION create_notification_preferences();

-- Function to clean up old notifications
CREATE OR REPLACE FUNCTION cleanup_old_notifications()
RETURNS void AS $$
BEGIN
    DELETE FROM notifications 
    WHERE expires_at < NOW() 
    OR (is_read = true AND created_at < NOW() - INTERVAL '7 days');
END;
$$ LANGUAGE plpgsql;

-- Function to create notification
CREATE OR REPLACE FUNCTION create_notification(
    p_user_id UUID,
    p_type VARCHAR(50),
    p_title VARCHAR(255),
    p_message TEXT DEFAULT NULL,
    p_data JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
    notification_id UUID;
    user_prefs notification_preferences%ROWTYPE;
    is_dnd BOOLEAN := FALSE;
BEGIN
    -- Get user preferences
    SELECT * INTO user_prefs 
    FROM notification_preferences 
    WHERE user_id = p_user_id;
    
    -- Check if user is in DND mode
    IF user_prefs.dnd_enabled THEN
        SELECT INTO is_dnd
            CASE 
                WHEN user_prefs.dnd_start_time <= user_prefs.dnd_end_time THEN
                    CURRENT_TIME BETWEEN user_prefs.dnd_start_time AND user_prefs.dnd_end_time
                ELSE
                    CURRENT_TIME >= user_prefs.dnd_start_time OR CURRENT_TIME <= user_prefs.dnd_end_time
            END;
    END IF;
    
    -- Only create notification if not in DND or if it's a critical notification
    IF NOT is_dnd OR p_type IN ('server_invite', 'friend_request') THEN
        INSERT INTO notifications (user_id, type, title, message, data)
        VALUES (p_user_id, p_type, p_title, p_message, p_data)
        RETURNING id INTO notification_id;
        
        RETURN notification_id;
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to mark notification as read
CREATE OR REPLACE FUNCTION mark_notification_read(notification_id UUID)
RETURNS void AS $$
BEGIN
    UPDATE notifications 
    SET is_read = true, updated_at = NOW()
    WHERE id = notification_id;
END;
$$ LANGUAGE plpgsql;

-- Function to mark all notifications as read for a user
CREATE OR REPLACE FUNCTION mark_all_notifications_read(p_user_id UUID)
RETURNS void AS $$
BEGIN
    UPDATE notifications 
    SET is_read = true, updated_at = NOW()
    WHERE user_id = p_user_id AND is_read = false;
END;
$$ LANGUAGE plpgsql;

-- Function to get unread notification count
CREATE OR REPLACE FUNCTION get_unread_notification_count(p_user_id UUID)
RETURNS INTEGER AS $$
BEGIN
    RETURN (SELECT COUNT(*) FROM notifications WHERE user_id = p_user_id AND is_read = false);
END;
$$ LANGUAGE plpgsql;

-- Function to update unread counts
CREATE OR REPLACE FUNCTION update_unread_count(
    p_user_id UUID,
    p_server_id UUID DEFAULT NULL,
    p_channel_id UUID DEFAULT NULL,
    p_conversation_id UUID DEFAULT NULL,
    p_increment_messages INTEGER DEFAULT 0,
    p_increment_mentions INTEGER DEFAULT 0,
    p_last_read_message_id UUID DEFAULT NULL
)
RETURNS void AS $$
BEGIN
    INSERT INTO unread_counts (
        user_id, server_id, channel_id, conversation_id,
        unread_messages, unread_mentions, last_read_message_id
    )
    VALUES (
        p_user_id, p_server_id, p_channel_id, p_conversation_id,
        p_increment_messages, p_increment_mentions, p_last_read_message_id
    )
    ON CONFLICT (user_id, server_id, channel_id, conversation_id)
    DO UPDATE SET
        unread_messages = unread_counts.unread_messages + p_increment_messages,
        unread_mentions = unread_counts.unread_mentions + p_increment_mentions,
        last_read_message_id = COALESCE(p_last_read_message_id, unread_counts.last_read_message_id),
        last_read_at = CASE WHEN p_last_read_message_id IS NOT NULL THEN NOW() ELSE unread_counts.last_read_at END,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;