-- =============================================
-- DEBUG REAL-TIME NOTIFICATIONS MIGRATION
-- =============================================
-- This migration adds comprehensive debugging for real-time notifications

-- 1. First, let's check the current state of everything
SELECT 'DIAGNOSIS: Current State' as section;

-- Check if notifications table is in realtime publication
SELECT 
    'notifications_in_realtime_publication' as check_name,
    EXISTS(
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
    ) as result;

-- Check replica identity
SELECT 
    'notifications_replica_identity' as check_name,
    CASE 
        WHEN EXISTS(
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = 'notifications' 
            AND n.nspname = 'public'
            AND c.relreplident = 'f'
        ) THEN 'FULL'
        ELSE 'NOT_FULL'
    END as result;

-- Check RLS policies
SELECT 
    'notification_policies' as check_name,
    COUNT(*) as policy_count
FROM pg_policies 
WHERE tablename = 'notifications';

-- List all policies
SELECT 
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies 
WHERE tablename = 'notifications';

-- 2. Recreate everything from scratch to ensure clean state
ALTER TABLE notifications REPLICA IDENTITY FULL;

-- Remove and re-add to realtime publication (fixed syntax)
DO $$
BEGIN
    -- Try to remove table from publication
    BEGIN
        ALTER PUBLICATION supabase_realtime DROP TABLE notifications;
    EXCEPTION
        WHEN OTHERS THEN
            -- Table wasn't in publication, continue
            NULL;
    END;
    
    -- Add table to publication
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
    
    RAISE NOTICE 'Successfully added notifications table to realtime publication';
END $$;

-- Drop all existing RLS policies and recreate them properly
DROP POLICY IF EXISTS "notifications_select_policy" ON notifications;
DROP POLICY IF EXISTS "notifications_insert_policy" ON notifications;
DROP POLICY IF EXISTS "notifications_update_policy" ON notifications;
DROP POLICY IF EXISTS "notifications_delete_policy" ON notifications;
DROP POLICY IF EXISTS "notifications_realtime_select" ON notifications;
DROP POLICY IF EXISTS "notifications_realtime_insert" ON notifications;
DROP POLICY IF EXISTS "notifications_realtime_update" ON notifications;
DROP POLICY IF EXISTS "notifications_realtime_delete" ON notifications;

-- Create RLS policies that definitely work with real-time
CREATE POLICY "notifications_realtime_select" ON notifications
    FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "notifications_realtime_insert" ON notifications
    FOR INSERT 
    WITH CHECK (true);

CREATE POLICY "notifications_realtime_update" ON notifications
    FOR UPDATE 
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "notifications_realtime_delete" ON notifications
    FOR DELETE 
    USING (auth.uid() = user_id);

-- 3. Grant all necessary permissions
GRANT ALL ON notifications TO authenticated;
GRANT ALL ON notifications TO anon;

-- Also try granting to supabase_admin if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
        GRANT ALL ON notifications TO supabase_admin;
    END IF;
END $$;

-- 4. Create a more comprehensive test function
CREATE OR REPLACE FUNCTION test_realtime_comprehensive(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
    notification_id UUID;
    result JSON;
BEGIN
    -- Insert test notification
    INSERT INTO notifications (user_id, type, data)
    VALUES (
        p_user_id,
        'server_update',
        jsonb_build_object(
            'test', true,
            'message', 'Comprehensive real-time test',
            'timestamp', NOW(),
            'test_id', gen_random_uuid()
        )
    )
    RETURNING id INTO notification_id;
    
    -- Return comprehensive result
    SELECT jsonb_build_object(
        'notification_id', notification_id,
        'user_id', p_user_id,
        'timestamp', NOW(),
        'table_in_publication', EXISTS(
            SELECT 1 FROM pg_publication_tables 
            WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
        ),
        'replica_identity_full', EXISTS(
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = 'notifications' 
            AND n.nspname = 'public'
            AND c.relreplident = 'f'
        ),
        'rls_enabled', (
            SELECT relrowsecurity FROM pg_class 
            WHERE relname = 'notifications' AND relnamespace = 'public'::regnamespace
        ),
        'policy_count', (
            SELECT COUNT(*) FROM pg_policies WHERE tablename = 'notifications'
        )
    ) INTO result;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION test_realtime_comprehensive(UUID) TO authenticated;

-- 5. Also create a simple logging function to see if triggers are working
CREATE OR REPLACE FUNCTION log_notification_insert()
RETURNS TRIGGER AS $$
BEGIN
    RAISE NOTICE 'NOTIFICATION INSERTED: id=%, user_id=%, type=%, data=%', 
        NEW.id, NEW.user_id, NEW.type, NEW.data;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create logging trigger
DROP TRIGGER IF EXISTS notification_insert_logger ON notifications;
CREATE TRIGGER notification_insert_logger
    AFTER INSERT ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION log_notification_insert();

-- 6. Final verification
SELECT 'FINAL VERIFICATION' as section;

SELECT 
    'Real-time Setup Complete' as status,
    jsonb_build_object(
        'notifications_in_publication', EXISTS(
            SELECT 1 FROM pg_publication_tables 
            WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
        ),
        'replica_identity_full', EXISTS(
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = 'notifications' 
            AND n.nspname = 'public'
            AND c.relreplident = 'f'
        ),
        'rls_enabled', (
            SELECT relrowsecurity FROM pg_class 
            WHERE relname = 'notifications' AND relnamespace = 'public'::regnamespace
        ),
        'policy_count', (
            SELECT COUNT(*) FROM pg_policies WHERE tablename = 'notifications'
        )
    ) as verification_data;

-- Success message with instructions
SELECT 'Real-time debugging setup complete! 

NEXT STEPS:
1. Run: SELECT test_realtime_comprehensive(''your-user-id-here'');
2. Check browser console for real-time events
3. Check Supabase logs for any realtime errors
4. Look for NOTICE messages in database logs

If still not working, the issue might be:
- Client-side subscription setup
- Network connectivity 
- Supabase project realtime settings' as instructions;