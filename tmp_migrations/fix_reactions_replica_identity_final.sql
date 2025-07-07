-- =============================================
-- FIX REACTIONS REPLICA IDENTITY FOR REALTIME
-- =============================================
-- This migration ensures that DELETE events on reactions table
-- include full row data (message_id, user_id, emoji_id) in payload.old

-- 1. Set REPLICA IDENTITY FULL for reactions table
-- This tells PostgreSQL to include ALL column values in DELETE events
ALTER TABLE reactions REPLICA IDENTITY FULL;

-- 2. Verify replica identity is set correctly
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'reactions' 
        AND n.nspname = 'public'
        AND c.relreplident = 'f'  -- 'f' means FULL
    ) THEN
        RAISE NOTICE 'SUCCESS: reactions table has REPLICA IDENTITY FULL';
    ELSE
        RAISE WARNING 'ISSUE: reactions table does NOT have REPLICA IDENTITY FULL';
    END IF;
END $$;

-- 3. Ensure reactions table is in realtime publication
DO $$
BEGIN
    -- Remove and re-add to ensure clean state
    BEGIN
        ALTER PUBLICATION supabase_realtime DROP TABLE reactions;
    EXCEPTION
        WHEN OTHERS THEN
            -- Table wasn't in publication, continue
            NULL;
    END;
    
    -- Add reactions table to realtime publication
    ALTER PUBLICATION supabase_realtime ADD TABLE reactions;
    
    RAISE NOTICE 'Added reactions table to supabase_realtime publication';
END $$;

-- 4. Grant necessary permissions for real-time to work
GRANT SELECT ON reactions TO authenticated;
GRANT INSERT ON reactions TO authenticated;
GRANT UPDATE ON reactions TO authenticated;
GRANT DELETE ON reactions TO authenticated;

-- Also grant to the supabase real-time role if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
        GRANT SELECT ON reactions TO supabase_realtime_admin;
        GRANT DELETE ON reactions TO supabase_realtime_admin;
    END IF;
END $$;

-- 5. Create a test function to verify DELETE events include full data
CREATE OR REPLACE FUNCTION test_reaction_delete_event(p_message_id UUID, p_emoji_id UUID, p_user_id UUID)
RETURNS UUID AS $$
DECLARE
    reaction_id UUID;
BEGIN
    -- First insert a test reaction
    INSERT INTO reactions (message_id, emoji_id, user_id)
    VALUES (p_message_id, p_emoji_id, p_user_id)
    RETURNING id INTO reaction_id;
    
    -- Wait a moment
    PERFORM pg_sleep(0.1);
    
    -- Now delete it (this should trigger a realtime DELETE event with full row data)
    DELETE FROM reactions WHERE id = reaction_id;
    
    RETURN reaction_id;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION test_reaction_delete_event(UUID, UUID, UUID) TO authenticated;

-- 6. Verification queries
SELECT 
    'Reactions Real-time Setup Verification' as status,
    EXISTS(
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'reactions'
    ) as reactions_in_publication,
    EXISTS(
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'reactions' 
        AND n.nspname = 'public'
        AND c.relreplident = 'f'
    ) as has_full_replica_identity;

-- Success message
SELECT 'Reactions real-time DELETE events fixed! 

NEXT STEPS:
1. Run: SELECT test_reaction_delete_event(''message-id'', ''emoji-id'', ''user-id'');
2. Check browser console - DELETE events should now include message_id in payload.old
3. Test removing reactions in the UI - other users should see updates immediately

If DELETE events still don''t include message_id in payload.old, check:
- Supabase project realtime settings
- Database connection and replication setup' as instructions;
