-- Notifications System Schema
-- Professional notification system with automatic triggers and real-time updates
-- INTERNATIONALIZATION-READY: Stores structured data, client formats messages

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL, -- 'mention', 'dm', 'reaction', 'reply', 'server_invite', 'friend_request'
    data JSONB DEFAULT '{}', -- Structured data for client-side message formatting
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
    
    -- ActivityPub notifications
    activitypub_notifications BOOLEAN DEFAULT TRUE,
    activitypub_follows BOOLEAN DEFAULT TRUE,
    activitypub_favorites BOOLEAN DEFAULT TRUE,
    activitypub_reblogs BOOLEAN DEFAULT TRUE,
    activitypub_mentions BOOLEAN DEFAULT TRUE,
    activitypub_replies BOOLEAN DEFAULT TRUE,
    activitypub_follow_requests BOOLEAN DEFAULT TRUE,
    
    -- ActivityPub desktop notifications
    activitypub_desktop_notifications BOOLEAN DEFAULT TRUE,
    activitypub_desktop_follows BOOLEAN DEFAULT TRUE,
    activitypub_desktop_favorites BOOLEAN DEFAULT FALSE,
    activitypub_desktop_reblogs BOOLEAN DEFAULT FALSE,
    activitypub_desktop_mentions BOOLEAN DEFAULT TRUE,
    activitypub_desktop_replies BOOLEAN DEFAULT TRUE,
    
    -- ActivityPub sound notifications
    activitypub_sound_notifications BOOLEAN DEFAULT TRUE,
    activitypub_sound_follows BOOLEAN DEFAULT TRUE,
    activitypub_sound_favorites BOOLEAN DEFAULT FALSE,
    activitypub_sound_reblogs BOOLEAN DEFAULT FALSE,
    activitypub_sound_mentions BOOLEAN DEFAULT TRUE,
    activitypub_sound_replies BOOLEAN DEFAULT TRUE,
    
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

-- =============================================
-- STRUCTURED DATA NOTIFICATION SYSTEM
-- =============================================

-- Function to create notification with structured data only
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
    
    -- Create the notification with structured data only
    INSERT INTO notifications (user_id, type, data)
    VALUES (p_user_id, p_type, p_data)
    RETURNING id INTO notification_id;
    
    -- TODO: Trigger push notification to service worker here
    -- This would integrate with your push notification service
    
    RETURN notification_id;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- UPDATED MESSAGE NOTIFICATION TRIGGERS
-- =============================================

-- Function to handle message notifications with structured data
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
                WHEN item->>'type' = 'mention' THEN item->>'mention'
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
        
        -- Notify the other participant in the conversation
        IF conversation_info.user1_id != NEW.user_id THEN
            PERFORM create_notification_structured(
                conversation_info.user1_id,
                'dm',
                notification_data,
                NULL,
                NULL,
                NEW.conversation_id
            );
        END IF;
        
        IF conversation_info.user2_id != NEW.user_id THEN
            PERFORM create_notification_structured(
                conversation_info.user2_id,
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

-- =============================================
-- UPDATED REACTION NOTIFICATION TRIGGERS  
-- =============================================

-- Function to handle reaction notifications with structured data
CREATE OR REPLACE FUNCTION handle_reaction_notifications()
RETURNS TRIGGER AS $$
DECLARE
    message_info messages%ROWTYPE;
    reactor_profile profiles%ROWTYPE;
    emoji_info emojis%ROWTYPE;
    channel_info channels%ROWTYPE;
    server_info servers%ROWTYPE;
    conversation_info conversations%ROWTYPE;
    notification_data JSONB;
BEGIN
    -- Only handle INSERT events (new reactions)
    IF TG_OP != 'INSERT' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Get message and reactor info
    SELECT * INTO message_info FROM messages WHERE id = NEW.message_id;
    SELECT * INTO reactor_profile FROM profiles WHERE id = NEW.user_id;
    SELECT * INTO emoji_info FROM emojis WHERE id = NEW.emoji_id;
    
    -- Don't notify if user reacted to their own message
    IF message_info.user_id = NEW.user_id THEN
        RETURN NEW;
    END IF;
    
    -- Build base structured data for reaction notification
    notification_data := jsonb_build_object(
        'reactor', jsonb_build_object(
            'user_id', reactor_profile.id,
            'username', reactor_profile.username,
            'avatar_url', reactor_profile.avatar_url
        ),
        'reaction', jsonb_build_object(
            'emoji_id', NEW.emoji_id,
            'emoji_name', COALESCE(emoji_info.name, '👍'),
            'emoji_url', emoji_info.url
        ),
        'message', jsonb_build_object(
            'id', message_info.id,
            'created_at', message_info.created_at
        )
    );
    
    -- Handle DM reaction notifications
    IF message_info.conversation_id IS NOT NULL THEN
        SELECT * INTO conversation_info FROM conversations WHERE id = message_info.conversation_id;
        
        notification_data := notification_data || jsonb_build_object(
            'conversation', jsonb_build_object(
                'id', message_info.conversation_id
            )
        );
        
        PERFORM create_notification_structured(
            message_info.user_id,
            'reaction',
            notification_data,
            NULL,
            NULL,
            message_info.conversation_id
        );
    
    -- Handle server channel reaction notifications
    ELSIF message_info.channel_id IS NOT NULL THEN
        SELECT * INTO channel_info FROM channels WHERE id = message_info.channel_id;
        SELECT * INTO server_info FROM servers WHERE id = channel_info.server_id;
        
        notification_data := notification_data || jsonb_build_object(
            'location', jsonb_build_object(
                'server_id', channel_info.server_id,
                'server_name', server_info.name,
                'channel_id', message_info.channel_id,
                'channel_name', channel_info.name
            )
        );
        
        PERFORM create_notification_structured(
            message_info.user_id,
            'reaction',
            notification_data,
            channel_info.server_id,
            message_info.channel_id,
            NULL
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- UTILITY FUNCTIONS (keeping existing ones)
-- =============================================

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

-- Function to clean up old notifications
CREATE OR REPLACE FUNCTION cleanup_old_notifications()
RETURNS void AS $$
BEGIN
    DELETE FROM notifications 
    WHERE expires_at < NOW() 
    OR (is_read = true AND created_at < NOW() - INTERVAL '7 days');
END;
$$ LANGUAGE plpgsql;

-- Enable real-time for notifications
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE notification_preferences;
ALTER PUBLICATION supabase_realtime ADD TABLE notification_channels;
ALTER PUBLICATION supabase_realtime ADD TABLE unread_counts;