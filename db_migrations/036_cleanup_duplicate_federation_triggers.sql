-- Migration 036: Cleanup Duplicate Federation Triggers
-- Fix: Multiple triggers causing double federation queuing

BEGIN;

-- =====================================================
-- STEP 1: REMOVE ALL CONFLICTING FEDERATION TRIGGERS
-- =====================================================

-- Remove unified content triggers (problematic)
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;

-- Remove old individual triggers  
DROP TRIGGER IF EXISTS handle_post_federation_trigger ON posts;

-- Remove any other federation-related triggers
DROP TRIGGER IF EXISTS trg_unified_post_federation ON posts;
DROP TRIGGER IF EXISTS trigger_post_federation ON posts;

-- =====================================================
-- STEP 2: KEEP ONLY THE WORKING TRIGGER
-- =====================================================

-- Ensure we have the correct working trigger
-- (Based on migration 034, this should be the working one)
DROP TRIGGER IF EXISTS trg_handle_post_federation ON posts;

CREATE TRIGGER trg_handle_post_federation
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_post_federation();

-- =====================================================  
-- STEP 3: VERIFY TRIGGER SETUP
-- =====================================================

-- Ensure the function exists and is correct
SELECT COUNT(*) as function_exists 
FROM pg_proc 
WHERE proname = 'handle_post_federation';

-- Ensure trigger is properly created
SELECT COUNT(*) as trigger_exists
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
WHERE c.relname = 'posts' 
AND t.tgname = 'trg_handle_post_federation';

COMMIT;