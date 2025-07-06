-- =============================================
-- SERVER MEMBERSHIP EVENTS MIGRATION
-- Professional real-time user join/leave system like Discord
-- =============================================

-- 1. Create server_membership_events table for tracking all membership changes
CREATE TABLE IF NOT EXISTS server_membership_events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('join', 'leave', 'kick', 'ban')),
    initiated_by UUID REFERENCES profiles(id), -- null for self-initiated events
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_server_membership_events_server_id ON server_membership_events(server_id);
CREATE INDEX IF NOT EXISTS idx_server_membership_events_user_id ON server_membership_events(user_id);
CREATE INDEX IF NOT EXISTS idx_server_membership_events_created_at ON server_membership_events(created_at);
CREATE INDEX IF NOT EXISTS idx_server_membership_events_server_event ON server_membership_events(server_id, event_type, created_at);

-- Enable RLS
ALTER TABLE server_membership_events ENABLE ROW LEVEL SECURITY;

-- RLS policies for real-time compatibility
CREATE POLICY "Members can view server membership events" ON server_membership_events
    FOR SELECT 
    TO authenticated
    USING (
        server_id IN (
            SELECT us.server_id 
            FROM user_servers us 
            WHERE us.user_id = auth.uid()
        )
    );

CREATE POLICY "System can insert membership events" ON server_membership_events
    FOR INSERT 
    TO authenticated
    WITH CHECK (true); -- Triggers need to insert events

-- Set replica identity for real-time
ALTER TABLE server_membership_events REPLICA IDENTITY FULL;

-- 2. Function to get the default general channel for a server
CREATE OR REPLACE FUNCTION get_default_channel(p_server_id UUID)
RETURNS UUID AS $$
DECLARE
    channel_id UUID;
BEGIN
    -- Get the first text channel (type 0) named 'general' or the first text channel
    SELECT id INTO channel_id
    FROM channels 
    WHERE server_id = p_server_id 
      AND type = 0 
    ORDER BY 
        CASE WHEN name = 'general' THEN 0 ELSE 1 END,
        "order" ASC,
        created_at ASC
    LIMIT 1;
    
    RETURN channel_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Function to create system message
CREATE OR REPLACE FUNCTION create_system_message(
    p_channel_id UUID,
    p_user_id UUID,
    p_event_type TEXT,
    p_initiated_by UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    message_id UUID;
    user_profile RECORD;
    initiator_profile RECORD;
    message_content JSONB;
BEGIN
    -- Get user profile
    SELECT username, display_name, avatar_url 
    INTO user_profile 
    FROM profiles 
    WHERE id = p_user_id;
    
    -- Get initiator profile if exists
    IF p_initiated_by IS NOT NULL THEN
        SELECT username, display_name, avatar_url 
        INTO initiator_profile 
        FROM profiles 
        WHERE id = p_initiated_by;
    END IF;
    
    -- Build system message content
    message_content := jsonb_build_array(
        jsonb_build_object(
            'type', 'system',
            'event_type', p_event_type,
            'user', jsonb_build_object(
                'id', p_user_id,
                'username', user_profile.username,
                'display_name', user_profile.display_name,
                'avatar_url', user_profile.avatar_url
            ),
            'initiated_by', CASE 
                WHEN p_initiated_by IS NOT NULL THEN
                    jsonb_build_object(
                        'id', p_initiated_by,
                        'username', initiator_profile.username,
                        'display_name', initiator_profile.display_name,
                        'avatar_url', initiator_profile.avatar_url
                    )
                ELSE NULL
            END,
            'timestamp', NOW()
        )
    );
    
    -- Insert system message
    INSERT INTO messages (channel_id, user_id, content, is_system)
    VALUES (p_channel_id, p_user_id, message_content, true)
    RETURNING id INTO message_id;
    
    RETURN message_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Function to handle user join events
CREATE OR REPLACE FUNCTION handle_user_join()
RETURNS TRIGGER AS $$
DECLARE
    default_channel_id UUID;
    event_id UUID;
    user_profile RECORD;
BEGIN
    -- Get user profile for system message
    SELECT username, display_name, avatar_url 
    INTO user_profile 
    FROM profiles 
    WHERE id = NEW.user_id;

    -- Log the membership event
    INSERT INTO server_membership_events (server_id, user_id, event_type, metadata)
    VALUES (NEW.server_id, NEW.user_id, 'join', jsonb_build_object(
        'joined_at', NEW.created_at,
        'username', user_profile.username,
        'display_name', user_profile.display_name
    ))
    RETURNING id INTO event_id;
    
    -- Get default channel for system message
    SELECT get_default_channel(NEW.server_id) INTO default_channel_id;
    
    -- Create system message if default channel exists
    IF default_channel_id IS NOT NULL THEN
        PERFORM create_system_message(default_channel_id, NEW.user_id, 'join');
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Function to handle user leave events
CREATE OR REPLACE FUNCTION handle_user_leave()
RETURNS TRIGGER AS $$
DECLARE
    default_channel_id UUID;
    event_id UUID;
    user_profile RECORD;
BEGIN
    -- Get user profile for system message
    SELECT username, display_name, avatar_url 
    INTO user_profile 
    FROM profiles 
    WHERE id = OLD.user_id;

    -- Log the membership event
    INSERT INTO server_membership_events (server_id, user_id, event_type, metadata)
    VALUES (OLD.server_id, OLD.user_id, 'leave', jsonb_build_object(
        'left_at', NOW(),
        'username', user_profile.username,
        'display_name', user_profile.display_name
    ))
    RETURNING id INTO event_id;
    
    -- Get default channel for system message
    SELECT get_default_channel(OLD.server_id) INTO default_channel_id;
    
    -- Create system message if default channel exists
    IF default_channel_id IS NOT NULL THEN
        PERFORM create_system_message(default_channel_id, OLD.user_id, 'leave');
    END IF;
    
    RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Create triggers on user_servers table
DROP TRIGGER IF EXISTS trigger_user_join ON user_servers;
CREATE TRIGGER trigger_user_join
    AFTER INSERT ON user_servers
    FOR EACH ROW
    EXECUTE FUNCTION handle_user_join();

DROP TRIGGER IF EXISTS trigger_user_leave ON user_servers;
CREATE TRIGGER trigger_user_leave
    AFTER DELETE ON user_servers
    FOR EACH ROW
    EXECUTE FUNCTION handle_user_leave();

-- 7. Add is_system column to messages table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'messages' AND column_name = 'is_system'
    ) THEN
        ALTER TABLE messages ADD COLUMN is_system BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- 8. Enable real-time for the new table and ensure proper publication
DO $$
BEGIN
    -- Add table to realtime publication
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE server_membership_events;
    EXCEPTION
        WHEN duplicate_object THEN
            -- Table already in publication
            NULL;
    END;
    
    -- Also ensure messages table supports system messages in real-time
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE messages;
    EXCEPTION
        WHEN duplicate_object THEN
            -- Table already in publication
            NULL;
    END;
END $$;

-- Grant permissions for real-time functionality
GRANT SELECT ON server_membership_events TO authenticated;
GRANT INSERT ON server_membership_events TO authenticated;
GRANT ALL ON server_membership_events TO anon;

-- Ensure proper permissions for system message creation
GRANT EXECUTE ON FUNCTION get_default_channel(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION create_system_message(UUID, UUID, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION handle_user_join() TO authenticated;
GRANT EXECUTE ON FUNCTION handle_user_leave() TO authenticated;

SELECT 'Server membership events system created successfully!' as result;
