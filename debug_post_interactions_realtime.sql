-- =============================================
-- DEBUG POST INTERACTIONS REALTIME ISSUES
-- =============================================

-- 1. Check current replica identity setting
SELECT 
    'Current Replica Identity Check' as check_type,
    c.relname as table_name,
    CASE c.relreplident
        WHEN 'd' THEN 'DEFAULT (primary key only)'
        WHEN 'n' THEN 'NOTHING'
        WHEN 'f' THEN 'FULL (all columns)'
        WHEN 'i' THEN 'INDEX'
        ELSE 'UNKNOWN'
    END as replica_identity,
    c.relreplident as raw_value
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = 'post_interactions' 
AND n.nspname = 'public';

-- 2. Check if table is in realtime publication
SELECT 
    'Realtime Publication Check' as check_type,
    pt.pubname,
    pt.tablename,
    pt.schemaname
FROM pg_publication_tables pt
WHERE pt.tablename = 'post_interactions'
AND pt.schemaname = 'public';

-- 3. Check table permissions for realtime
SELECT 
    'Permissions Check' as check_type,
    grantee,
    privilege_type,
    is_grantable
FROM information_schema.table_privileges 
WHERE table_name = 'post_interactions'
AND table_schema = 'public'
AND grantee IN ('authenticated', 'supabase_realtime_admin', 'postgres');

-- 4. Force REPLICA IDENTITY FULL again (in case it didn't stick)
ALTER TABLE post_interactions REPLICA IDENTITY FULL;

-- 5. Check if there are any triggers that might interfere
SELECT 
    'Triggers Check' as check_type,
    trigger_name,
    event_manipulation,
    action_timing,
    action_statement
FROM information_schema.triggers
WHERE event_object_table = 'post_interactions'
AND event_object_schema = 'public';

-- 6. Alternative: Try setting REPLICA IDENTITY on specific columns
-- This is a fallback if FULL doesn't work
DO $$
BEGIN
    -- Create a unique index on the columns we need for realtime
    BEGIN
        CREATE UNIQUE INDEX IF NOT EXISTS idx_post_interactions_realtime_replica 
        ON post_interactions (id, user_id, post_id, interaction_type);
    EXCEPTION
        WHEN OTHERS THEN
            -- Index might already exist or have conflicts
            RAISE NOTICE 'Could not create replica index: %', SQLERRM;
    END;
    
    -- Try setting REPLICA IDENTITY to use this index
    BEGIN
        ALTER TABLE post_interactions REPLICA IDENTITY USING INDEX idx_post_interactions_realtime_replica;
        RAISE NOTICE 'Set REPLICA IDENTITY to use specific index';
    EXCEPTION
        WHEN OTHERS THEN
            RAISE NOTICE 'Could not set REPLICA IDENTITY to index: %', SQLERRM;
    END;
END $$;

-- 7. Final verification
SELECT 
    'Final Verification' as check_type,
    c.relname as table_name,
    CASE c.relreplident
        WHEN 'd' THEN 'DEFAULT (primary key only) - THIS IS THE PROBLEM!'
        WHEN 'n' THEN 'NOTHING - THIS IS THE PROBLEM!'
        WHEN 'f' THEN 'FULL (all columns) - THIS IS CORRECT!'
        WHEN 'i' THEN 'INDEX - THIS MIGHT WORK!'
        ELSE 'UNKNOWN - THIS IS A PROBLEM!'
    END as replica_identity_status,
    c.relreplident as raw_value
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = 'post_interactions' 
AND n.nspname = 'public';

-- 8. Create a test to see what realtime actually sends
-- This function will help us see the exact payload structure
CREATE OR REPLACE FUNCTION debug_post_interaction_realtime()
RETURNS TEXT AS $$
DECLARE
    test_post_id UUID := '968f8b30-8de1-4e0f-b9bb-87d8085330a7'::UUID;
    test_user_id UUID := '2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e'::UUID;
    interaction_id UUID;
    result TEXT;
BEGIN
    -- Clean up any existing test data
    DELETE FROM post_interactions 
    WHERE post_id = test_post_id 
    AND user_id = test_user_id 
    AND interaction_type = 'favorite';
    
    -- Insert a test favorite
    INSERT INTO post_interactions (post_id, user_id, interaction_type, is_local, metadata)
    VALUES (test_post_id, test_user_id, 'favorite', true, '{}')
    RETURNING id INTO interaction_id;
    
    result := 'Inserted test favorite with ID: ' || interaction_id::TEXT;
    
    -- Wait a moment
    PERFORM pg_sleep(0.5);
    
    -- Delete it (this should trigger realtime event)
    DELETE FROM post_interactions WHERE id = interaction_id;
    
    result := result || '. Deleted favorite. Check browser console for realtime event.';
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT EXECUTE ON FUNCTION debug_post_interaction_realtime() TO authenticated;

-- Instructions
SELECT 'DEBUG COMPLETE! 

TO TEST:
1. Check the output above - replica_identity_status should be "FULL (all columns) - THIS IS CORRECT!"
2. If not, there may be a Supabase-specific issue
3. Run: SELECT debug_post_interaction_realtime(); 
4. Immediately check browser console for the DELETE event
5. The payload.old should now include post_id, user_id, interaction_type

If REPLICA IDENTITY FULL still doesn''t work, this might be a Supabase limitation.
Alternative solutions:
- Handle DELETE events differently in the code
- Use UPDATE instead of DELETE (set deleted_at timestamp)
- Store interaction data temporarily during the operation' as instructions;
