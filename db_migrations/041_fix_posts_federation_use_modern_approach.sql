-- Migration 041: Ensure Modern Posts Federation Trigger
-- 
-- ISSUE: Posts federation may be missing the modern trigger
-- CURRENT APPROACH: handle_post_federation() function with trg_handle_post_federation trigger
-- DEPRECATED: handle_unified_content_federation() - old "unified" approach
-- 
-- SIMPLE FIX: Ensure modern trigger exists

BEGIN;

-- Verify the modern function exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_post_federation') THEN
        RAISE EXCEPTION 'handle_post_federation function does not exist! This is the current approach.';
    END IF;
    
    -- Verify it has proper queue calls
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'handle_post_federation' 
        AND prosrc LIKE '%queue_activity_for_federation%'
    ) THEN
        RAISE EXCEPTION 'handle_post_federation missing queue calls!';
    END IF;
    
    RAISE NOTICE '✅ Modern handle_post_federation function verified';
END $$;

-- Drop any old unified triggers (deprecated approach)
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;
DROP TRIGGER IF EXISTS trigger_unified_message_federation ON posts;

-- Ensure the modern trigger exists
DROP TRIGGER IF EXISTS trg_handle_post_federation ON posts;

CREATE TRIGGER trg_handle_post_federation
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_post_federation();

COMMENT ON TRIGGER trg_handle_post_federation ON posts IS 
'Modern posts federation trigger using handle_post_federation() (not deprecated unified approach)';

-- Verify trigger was created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        WHERE c.relname = 'posts' 
        AND t.tgname = 'trg_handle_post_federation'
    ) THEN
        RAISE EXCEPTION 'Failed to create posts federation trigger!';
    END IF;
    
    RAISE NOTICE '✅ Modern posts federation trigger verified';
END $$;

COMMIT;