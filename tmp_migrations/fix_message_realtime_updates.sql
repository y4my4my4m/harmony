-- =============================================
-- FIX MESSAGE REAL-TIME UPDATES MIGRATION
-- =============================================
-- This migration ensures messages table is properly configured for real-time updates
-- and that UPDATE events are properly handled

-- 1. Ensure messages table is properly configured for real-time
-- First, make sure messages table has replica identity for real-time
ALTER TABLE messages REPLICA IDENTITY FULL;

-- 2. Ensure the messages table is in the realtime publication
DO $$
BEGIN
    -- Remove and re-add to ensure clean state
    BEGIN
        ALTER PUBLICATION supabase_realtime DROP TABLE messages;
    EXCEPTION
        WHEN OTHERS THEN
            -- Table wasn't in publication, continue
            NULL;
    END;
    
    -- Add messages table to realtime publication
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
    
    RAISE NOTICE 'Added messages table to supabase_realtime publication';
END $$;

-- 3. Verify current RLS policies for messages allow UPDATE events
-- Check if update policies exist and are not too restrictive for real-time

-- 4. Grant necessary permissions for real-time to work
GRANT SELECT ON messages TO authenticated;
GRANT INSERT ON messages TO authenticated;
GRANT UPDATE ON messages TO authenticated;
GRANT DELETE ON messages TO authenticated;

-- Also grant to the supabase real-time role if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
        GRANT SELECT ON messages TO supabase_realtime_admin;
        GRANT UPDATE ON messages TO supabase_realtime_admin;
    END IF;
END $$;

-- 5. Create a test function to verify real-time updates are working
CREATE OR REPLACE FUNCTION test_realtime_message_update(p_message_id UUID, p_new_content TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE messages 
    SET content = p_new_content,
        updated_at = NOW()
    WHERE id = p_message_id;
    
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION test_realtime_message_update(UUID, TEXT) TO authenticated;

-- 6. Add logging to check if real-time publication is working
DO $$
BEGIN
    -- Check if messages table is in publication
    IF EXISTS (
        SELECT 1 
        FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' 
        AND tablename = 'messages'
    ) THEN
        RAISE NOTICE 'SUCCESS: messages table is in supabase_realtime publication';
    ELSE
        RAISE WARNING 'ISSUE: messages table is NOT in supabase_realtime publication';
    END IF;
    
    -- Check replica identity
    IF EXISTS (
        SELECT 1 
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'messages' 
        AND n.nspname = 'public'
        AND c.relreplident = 'f'  -- 'f' means FULL
    ) THEN
        RAISE NOTICE 'SUCCESS: messages table has REPLICA IDENTITY FULL';
    ELSE
        RAISE WARNING 'ISSUE: messages table does NOT have REPLICA IDENTITY FULL';
    END IF;
END $$;

-- 7. Test real-time publication with a simple query
SELECT 
    'Message Real-time Setup Verification' as status,
    EXISTS(
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
    ) as messages_in_publication,
    EXISTS(
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'messages' 
        AND n.nspname = 'public'
        AND c.relreplident = 'f'
    ) as has_full_replica_identity;

-- Success message
SELECT 'Message real-time updates migration completed! Test with test_realtime_message_update() function.' as result;
