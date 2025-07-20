-- Migration 031: Restore Posts Federation Trigger
-- 
-- ISSUE: Posts are not federating because the federation trigger was disabled in previous migrations
-- CAUSE: Multiple migrations dropped the posts federation trigger to fix other issues
-- RESULT: Posts created but never added to federation_delivery_queue
-- 
-- SOLUTION: Re-enable the posts federation trigger using the existing unified function

BEGIN;

-- First verify the unified federation function exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_unified_content_federation') THEN
        RAISE EXCEPTION 'Federation function handle_unified_content_federation() does not exist';
    END IF;
    
    RAISE NOTICE 'Federation function exists ✅';
END $$;

-- Drop any existing posts federation triggers (cleanup)
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;
DROP TRIGGER IF EXISTS handle_post_federation_trigger ON posts;
DROP TRIGGER IF EXISTS trg_handle_post_federation ON posts;

-- Create the posts federation trigger
CREATE TRIGGER trigger_unified_content_federation
    AFTER INSERT OR UPDATE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_unified_content_federation();

-- Verify the trigger was created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t 
        JOIN pg_class c ON t.tgrelid = c.oid 
        WHERE c.relname = 'posts' AND t.tgname = 'trigger_unified_content_federation'
    ) THEN
        RAISE EXCEPTION 'Posts federation trigger was not created successfully';
    END IF;
    
    RAISE NOTICE 'Posts federation trigger created successfully ✅';
END $$;

-- Add comment
COMMENT ON TRIGGER trigger_unified_content_federation ON posts IS 
'OUTGOING ONLY: Federation trigger for posts. Creates activities in federation_delivery_queue for webhook processing.';

-- Log completion
INSERT INTO migration_log (version, description, applied_at) 
VALUES (31, 'Restored posts federation trigger for outgoing ActivityPub delivery', NOW())
ON CONFLICT (version) DO UPDATE SET 
    description = EXCLUDED.description,
    applied_at = EXCLUDED.applied_at;

COMMIT;

-- Test the trigger works
DO $$
DECLARE
    test_post_id UUID;
    queue_count INTEGER;
BEGIN
    RAISE NOTICE 'Testing posts federation trigger...';
    
    -- Check if we can test (need a local user)
    IF EXISTS (SELECT 1 FROM profiles WHERE is_local = true LIMIT 1) THEN
        -- Count existing queue entries
        SELECT COUNT(*) INTO queue_count FROM federation_delivery_queue;
        
        RAISE NOTICE 'Posts federation trigger restored and ready for testing';
        RAISE NOTICE 'Current federation queue entries: %', queue_count;
        RAISE NOTICE 'Next post creation should add entries to federation_delivery_queue';
    ELSE
        RAISE NOTICE 'No local users found - cannot test trigger, but trigger is installed';
    END IF;
END $$;