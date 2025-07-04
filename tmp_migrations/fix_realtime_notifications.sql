-- =============================================
-- FIX REAL-TIME NOTIFICATIONS MIGRATION
-- =============================================
-- This migration fixes the real-time subscription issues for notifications

-- 1. Ensure notifications table is properly configured for real-time
-- First, make sure notifications table has replica identity for real-time
ALTER TABLE notifications REPLICA IDENTITY FULL;

-- 2. Ensure the notifications table is in the realtime publication
DO $$
BEGIN
    -- Remove and re-add to ensure clean state
    BEGIN
        ALTER PUBLICATION supabase_realtime DROP TABLE notifications;
    EXCEPTION
        WHEN OTHERS THEN
            -- Table wasn't in publication, continue
            NULL;
    END;
    
    -- Add notifications table to realtime publication
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
    
    RAISE NOTICE 'Added notifications table to supabase_realtime publication';
END $$;

-- 3. Create a special RLS policy that allows real-time events
-- The issue is that RLS can block real-time events, so we need a policy that works with real-time

-- Drop existing policies that might interfere
DROP POLICY IF EXISTS "Users can view their own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update their own notifications" ON notifications;
DROP POLICY IF EXISTS "System can insert notifications" ON notifications;
DROP POLICY IF EXISTS "Users can delete their own notifications" ON notifications;

-- Create new RLS policies that work properly with real-time
CREATE POLICY "notifications_select_policy" ON notifications
    FOR SELECT 
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "notifications_insert_policy" ON notifications
    FOR INSERT 
    TO authenticated
    WITH CHECK (true); -- Allow system to insert

CREATE POLICY "notifications_update_policy" ON notifications
    FOR UPDATE 
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "notifications_delete_policy" ON notifications
    FOR DELETE 
    TO authenticated
    USING (auth.uid() = user_id);

-- 4. Grant necessary permissions for real-time to work
GRANT SELECT ON notifications TO authenticated;
GRANT INSERT ON notifications TO authenticated;
GRANT UPDATE ON notifications TO authenticated;
GRANT DELETE ON notifications TO authenticated;

-- Also grant to the supabase real-time role if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
        GRANT SELECT ON notifications TO supabase_realtime_admin;
    END IF;
END $$;

-- 5. Create a test function to verify real-time is working
CREATE OR REPLACE FUNCTION test_realtime_notification(p_user_id UUID)
RETURNS UUID AS $$
DECLARE
    notification_id UUID;
BEGIN
    INSERT INTO notifications (user_id, type, data)
    VALUES (
        p_user_id,
        'server_update',
        jsonb_build_object(
            'title', 'Real-time Test',
            'message', 'This is a test notification to verify real-time is working',
            'timestamp', NOW()
        )
    )
    RETURNING id INTO notification_id;
    
    RETURN notification_id;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION test_realtime_notification(UUID) TO authenticated;

-- 6. Add logging to check if real-time publication is working
DO $$
BEGIN
    -- Check if notifications table is in publication
    IF EXISTS (
        SELECT 1 
        FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' 
        AND tablename = 'notifications'
    ) THEN
        RAISE NOTICE 'SUCCESS: notifications table is in supabase_realtime publication';
    ELSE
        RAISE WARNING 'ISSUE: notifications table is NOT in supabase_realtime publication';
    END IF;
    
    -- Check replica identity
    IF EXISTS (
        SELECT 1 
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'notifications' 
        AND n.nspname = 'public'
        AND c.relreplident = 'f'  -- 'f' means FULL
    ) THEN
        RAISE NOTICE 'SUCCESS: notifications table has REPLICA IDENTITY FULL';
    ELSE
        RAISE WARNING 'ISSUE: notifications table does NOT have REPLICA IDENTITY FULL';
    END IF;
END $$;

-- 7. Test real-time publication with a simple query
SELECT 
    'Real-time Setup Verification' as status,
    EXISTS(
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
    ) as notifications_in_publication,
    EXISTS(
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'notifications' 
        AND n.nspname = 'public'
        AND c.relreplident = 'f'
    ) as has_full_replica_identity;

-- Success message
SELECT 'Real-time notifications migration completed! Test with test_realtime_notification() function.' as result;