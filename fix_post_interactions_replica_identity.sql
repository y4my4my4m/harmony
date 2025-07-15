-- =============================================
-- FIX POST INTERACTIONS REPLICA IDENTITY FOR REALTIME
-- =============================================
-- This migration ensures that DELETE events on post_interactions table
-- include full row data (post_id, user_id, interaction_type) in payload.old

-- 1. Set REPLICA IDENTITY FULL for post_interactions table
-- This tells PostgreSQL to include ALL column values in DELETE events
ALTER TABLE post_interactions REPLICA IDENTITY FULL;

-- 2. Verify replica identity is set correctly
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'post_interactions' 
        AND n.nspname = 'public'
        AND c.relreplident = 'f'  -- 'f' means FULL
    ) THEN
        RAISE NOTICE 'SUCCESS: post_interactions table has REPLICA IDENTITY FULL';
    ELSE
        RAISE WARNING 'ISSUE: post_interactions table does NOT have REPLICA IDENTITY FULL';
    END IF;
END $$;

-- 3. Ensure post_interactions table is in realtime publication
DO $$
BEGIN
    -- Remove and re-add to ensure clean state
    BEGIN
        ALTER PUBLICATION supabase_realtime DROP TABLE post_interactions;
    EXCEPTION
        WHEN OTHERS THEN
            -- Table wasn't in publication, continue
            NULL;
    END;
    
    -- Add post_interactions table to realtime publication
    ALTER PUBLICATION supabase_realtime ADD TABLE post_interactions;
    
    RAISE NOTICE 'Added post_interactions table to supabase_realtime publication';
END $$;

-- 4. Grant necessary permissions for real-time to work
GRANT SELECT ON post_interactions TO authenticated;
GRANT INSERT ON post_interactions TO authenticated;
GRANT UPDATE ON post_interactions TO authenticated;
GRANT DELETE ON post_interactions TO authenticated;

-- Also grant to the supabase real-time role if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
        GRANT SELECT ON post_interactions TO supabase_realtime_admin;
        GRANT INSERT ON post_interactions TO supabase_realtime_admin;
        GRANT UPDATE ON post_interactions TO supabase_realtime_admin;
        GRANT DELETE ON post_interactions TO supabase_realtime_admin;
    END IF;
END $$;

-- 5. Create a test function to verify DELETE events include full data
CREATE OR REPLACE FUNCTION test_post_interaction_delete_event(p_post_id UUID, p_user_id UUID)
RETURNS UUID AS $$
DECLARE
    interaction_id UUID;
BEGIN
    -- First insert a test favorite
    INSERT INTO post_interactions (post_id, user_id, interaction_type, is_local, metadata)
    VALUES (p_post_id, p_user_id, 'favorite', true, '{}')
    RETURNING id INTO interaction_id;
    
    -- Wait a moment
    PERFORM pg_sleep(0.1);
    
    -- Now delete it (this should trigger a realtime DELETE event with full row data)
    DELETE FROM post_interactions WHERE id = interaction_id;
    
    RETURN interaction_id;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION test_post_interaction_delete_event(UUID, UUID) TO authenticated;

-- 6. Verification queries
SELECT 
    'Post Interactions Real-time Setup Verification' as status,
    EXISTS(
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'post_interactions'
    ) as post_interactions_in_publication,
    EXISTS(
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'post_interactions' 
        AND n.nspname = 'public'
        AND c.relreplident = 'f'
    ) as has_full_replica_identity;

-- Success message
SELECT 'Post Interactions real-time DELETE events fixed! 

NEXT STEPS:
1. Test by favoriting/unfavoriting a post in the UI
2. Check browser console - DELETE events should now include post_id, user_id, interaction_type in payload.old
3. The heart should now properly unfill when unfavoriting

If DELETE events still don''t include full data in payload.old, check:
- Supabase project realtime settings
- Database connection and replication setup
- Restart the Supabase realtime service if needed' as instructions;
