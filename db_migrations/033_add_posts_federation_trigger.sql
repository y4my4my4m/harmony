-- Migration 033: Add Posts Federation Trigger
-- 
-- ISSUE: Posts table has no federation trigger (was disabled in previous migrations)
-- RESULT: Posts never trigger federation logic
-- 
-- SOLUTION: Add the missing trigger for posts

BEGIN;

-- First verify the federation function exists and is updated
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_unified_content_federation') THEN
        RAISE EXCEPTION 'Federation function handle_unified_content_federation() does not exist - run migration 032 first';
    END IF;
    
    RAISE NOTICE 'Federation function exists ✅';
END $$;

-- Clean up any existing posts federation triggers
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
'OUTGOING ONLY: Federation trigger for posts. Creates ap_activities AND federation_delivery_queue entries for webhook processing.';

-- Log completion
INSERT INTO migration_log (version, description, applied_at) 
VALUES (33, 'Added posts federation trigger - posts will now federate via webhook', NOW())
ON CONFLICT (version) DO UPDATE SET 
    description = EXCLUDED.description,
    applied_at = EXCLUDED.applied_at;

COMMIT;

-- Summary
DO $$
BEGIN
    RAISE NOTICE '🎯 Posts federation trigger added!';
    RAISE NOTICE '';
    RAISE NOTICE 'Federation flow now complete:';
    RAISE NOTICE '  1. User creates post → INSERT into posts table';
    RAISE NOTICE '  2. trigger_unified_content_federation fires';
    RAISE NOTICE '  3. handle_unified_content_federation creates ap_activities';
    RAISE NOTICE '  4. handle_unified_content_federation calls queue_activity_for_federation';
    RAISE NOTICE '  5. federation_delivery_queue entries created';
    RAISE NOTICE '  6. "Federated Outbox" webhook fires on queue INSERT';
    RAISE NOTICE '  7. Edge function called: http://kong:8000/functions/v1/outbox/delivery';
    RAISE NOTICE '  8. ActivityPub HTTP requests sent to remote instances';
    RAISE NOTICE '';
    RAISE NOTICE 'Test by creating a post and checking federation_delivery_queue!';
END $$;