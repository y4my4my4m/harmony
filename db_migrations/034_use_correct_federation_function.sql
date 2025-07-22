-- Migration 034: Use Correct Federation Function
-- 
-- ISSUE: We've been trying to fix handle_unified_content_federation 
-- SOLUTION: Use the existing handle_post_federation (which works perfectly)
-- 
-- From all_db_functions.sql analysis:
-- - handle_post_federation: ✅ Complete with queue_activity_for_federation calls
-- - handle_unified_content_federation: ❌ Broken, missing queue calls

BEGIN;

-- Step 1: Drop the broken unified function (CASCADE removes its triggers)
DROP FUNCTION IF EXISTS handle_unified_content_federation() CASCADE;

-- Step 2: Verify the working function exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_post_federation') THEN
        RAISE EXCEPTION 'handle_post_federation function does not exist! Check all_db_functions.sql';
    END IF;
    
    -- Check it has queue calls
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'handle_post_federation' 
        AND prosrc LIKE '%queue_activity_for_federation%'
    ) THEN
        RAISE EXCEPTION 'handle_post_federation exists but missing queue calls!';
    END IF;
    
    RAISE NOTICE '✅ handle_post_federation verified with queue calls';
END $$;

-- Step 3: Create posts trigger using the working function
CREATE TRIGGER handle_post_federation_trigger
    AFTER INSERT OR UPDATE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_post_federation();

-- Step 4: Add trigger comment
COMMENT ON TRIGGER handle_post_federation_trigger ON posts IS 
'Uses the working handle_post_federation function with proper queue_activity_for_federation calls';

-- Step 5: Verify the fix
DO $$
BEGIN
    -- Check posts trigger exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t 
        JOIN pg_class c ON t.tgrelid = c.oid 
        WHERE c.relname = 'posts' AND t.tgname = 'handle_post_federation_trigger'
    ) THEN
        RAISE EXCEPTION 'Posts federation trigger was not created';
    END IF;
    
    -- Check it calls the right function
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_proc p ON t.tgfoid = p.oid
        JOIN pg_class c ON t.tgrelid = c.oid
        WHERE c.relname = 'posts' 
        AND t.tgname = 'handle_post_federation_trigger'
        AND p.proname = 'handle_post_federation'
    ) THEN
        RAISE EXCEPTION 'Posts trigger not calling handle_post_federation function';
    END IF;
    
    RAISE NOTICE '🔥 FEDERATION FIX COMPLETE!';
    RAISE NOTICE '✅ Deleted broken handle_unified_content_federation';
    RAISE NOTICE '✅ Now using working handle_post_federation'; 
    RAISE NOTICE '✅ Posts trigger created and verified';
    RAISE NOTICE '🎯 Federation should work now!';
END $$;

COMMIT;