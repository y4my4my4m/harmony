-- Clean up legacy ActivityPub processing functions and triggers
-- Run this AFTER deploying the unified ActivityPub processing trigger system
-- This removes old, duplicate, or superseded functions that are no longer needed

-- =====================================================
-- REMOVE LEGACY ACTIVITYPUB PROCESSING FUNCTIONS
-- =====================================================

-- NOTE: The following functions are now handled by the unified trigger system:
-- - Old inbox processing functions (now minimal validation only)
-- - Duplicate ActivityPub content processing functions
-- - Legacy trigger functions that may conflict

-- Drop any old ActivityPub activity processing functions that might exist
-- (These would be from previous iterations or development attempts)

DROP FUNCTION IF EXISTS process_activitypub_activity(UUID, JSONB);
DROP FUNCTION IF EXISTS handle_activitypub_inbox_processing();
DROP FUNCTION IF EXISTS process_incoming_activitypub_activity(JSONB);
DROP FUNCTION IF EXISTS handle_federated_activity_processing();

-- =====================================================
-- REMOVE LEGACY NOTIFICATION FUNCTIONS AND TRIGGERS
-- =====================================================

-- NOTE: We KEEP the following functions as they handle LOCAL-to-LOCAL notifications:
-- ✅ KEEP: handle_simple_follow_notifications() - for local follow notifications
-- ✅ KEEP: handle_simple_interaction_notifications() - for local interaction notifications  
-- ✅ KEEP: handle_simple_post_notifications() - for local reply notifications
-- ✅ KEEP: create_simple_activitypub_notification() - used by all notification functions
-- ✅ KEEP: Local notification triggers - still needed for local interactions

-- The unified ActivityPub trigger only handles FEDERATED activities (remote-to-local)
-- Local activities (local-to-local) still need the existing notification system

-- Drop only truly legacy/duplicate functions that are no longer used
DROP FUNCTION IF EXISTS handle_activitypub_follow_notification();
DROP FUNCTION IF EXISTS handle_activitypub_favorite_notification();
DROP FUNCTION IF EXISTS handle_activitypub_reblog_notification();
DROP FUNCTION IF EXISTS handle_activitypub_mention_notification();
DROP FUNCTION IF EXISTS handle_activitypub_reply_notification();
DROP FUNCTION IF EXISTS create_activitypub_notification(UUID, VARCHAR(50), JSONB, INTEGER);

-- Drop any old/conflicting trigger names (if they exist)
DROP TRIGGER IF EXISTS old_activitypub_follow_notifications ON follows;
DROP TRIGGER IF EXISTS old_activitypub_interaction_notifications ON post_interactions;
DROP TRIGGER IF EXISTS old_activitypub_post_notifications ON posts;

-- =====================================================
-- REMOVE LEGACY TRIGGERS ON AP_ACTIVITIES
-- =====================================================

-- Drop any old triggers on ap_activities table that might conflict
-- (Our new unified trigger will be the only one)

DROP TRIGGER IF EXISTS process_activitypub_activity_trigger ON ap_activities;
DROP TRIGGER IF EXISTS handle_inbox_processing_trigger ON ap_activities;
DROP TRIGGER IF EXISTS activitypub_processing_trigger ON ap_activities;
DROP TRIGGER IF EXISTS federated_activity_trigger ON ap_activities;

-- =====================================================
-- CHECK FOR CONFLICTING FUNCTIONS
-- =====================================================

-- Note: We're NOT removing these because they serve different purposes:
-- 
-- KEEP (Outbound federation - different purpose):
-- - handle_unified_interaction_processing() - Sends our interactions to remote servers
-- - handle_unified_reply_processing() - Sends our replies to remote servers
-- - convert_unified_content_to_activitypub_html() - Converts our content for outbound
-- - extract_activitypub_attachments() - For outbound federation
-- - extract_activitypub_mention_tags() - For outbound federation
--
-- KEEP (User management):
-- - setup_activitypub_federation() - Sets up new local users
-- - add_activitypub_keys_to_user() - Adds keys to users
-- - generate_activitypub_metadata() - Generates user metadata
--
-- KEEP (Conversation management):
-- - set_activitypub_conversation_root_id() - Sets conversation threading
-- - get_activitypub_conversation_root() - Gets conversation roots
-- - get_activitypub_conversation_thread() - Gets conversation threads
-- - get_activitypub_conversation_context() - Gets conversation context
--
-- KEEP (Utilities):
-- - create_simple_activitypub_notification() - Used by our new trigger
-- - regenerate_all_activitypub_keys() - Utility function

-- =====================================================
-- REMOVE DUPLICATE CONTENT PROCESSING FUNCTIONS
-- =====================================================

-- If there are any old versions of content processing functions that
-- duplicate our new unified ones, remove them

-- Check for old content processing functions that might conflict
-- (These would be from migrations/professional_message_processing.sql or similar)

-- Only drop if they exist and are NOT the current unified versions
DO $$
BEGIN
    -- Drop old content conversion functions that might conflict
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'convert_content_to_activitypub_html'
        AND p.proargnames IS NULL -- Old version might not have proper arg names
    ) THEN
        -- This is likely an old version, but let's be safe and not drop it
        -- since other parts of the system might still use it
        RAISE NOTICE 'Found old convert_content_to_activitypub_html function - keeping for compatibility';
    END IF;
END $$;

-- =====================================================
-- VERIFY TRIGGER DEPLOYMENT
-- =====================================================

-- Verify our new unified trigger is properly installed
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger 
        WHERE tgname = 'unified_activitypub_processing_trigger'
        AND tgrelid = 'ap_activities'::regclass
    ) THEN
        RAISE EXCEPTION 'ERROR: unified_activitypub_processing_trigger not found! Deploy the unified trigger migrations first.';
    ELSE
        RAISE NOTICE '✅ unified_activitypub_processing_trigger is properly installed';
    END IF;
    
    -- Verify key functions exist
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_activitypub_activity_processing') THEN
        RAISE EXCEPTION 'ERROR: handle_activitypub_activity_processing function not found!';
    ELSE
        RAISE NOTICE '✅ handle_activitypub_activity_processing function exists';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'process_activitypub_public_post') THEN
        RAISE EXCEPTION 'ERROR: process_activitypub_public_post function not found!';
    ELSE
        RAISE NOTICE '✅ process_activitypub_public_post function exists';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'process_activitypub_direct_message') THEN
        RAISE EXCEPTION 'ERROR: process_activitypub_direct_message function not found!';
    ELSE
        RAISE NOTICE '✅ process_activitypub_direct_message function exists';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'process_failed_activities_retry') THEN
        RAISE EXCEPTION 'ERROR: process_failed_activities_retry function not found!';
    ELSE
        RAISE NOTICE '✅ process_failed_activities_retry function exists';
    END IF;
END $$;

-- =====================================================
-- FINAL VERIFICATION
-- =====================================================

-- Show all remaining ActivityPub-related triggers for verification
SELECT 
    n.nspname as schemaname,
    c.relname as tablename,
    t.tgname as triggername,
    'Trigger'::text as object_type
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public'
  AND (t.tgname LIKE '%activitypub%' OR t.tgname LIKE '%unified%')
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

-- Show all ActivityPub-related functions for verification
SELECT 
    n.nspname as schema,
    p.proname as function_name,
    'Function'::text as object_type
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND (p.proname LIKE '%activitypub%' OR p.proname LIKE '%unified%')
ORDER BY p.proname;

-- =====================================================
-- COMPLETION MESSAGE
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '🧹 LEGACY ACTIVITYPUB CLEANUP COMPLETE';
    RAISE NOTICE '✅ Removed any conflicting legacy functions and triggers';
    RAISE NOTICE '✅ PRESERVED local notification functions (handle_simple_*_notifications)';
    RAISE NOTICE '✅ PRESERVED local notification triggers - still needed for local-to-local interactions';
    RAISE NOTICE '✅ Kept outbound federation triggers (handle_unified_interaction_processing, etc.)';
    RAISE NOTICE '✅ Kept user management functions (setup_activitypub_federation, etc.)';
    RAISE NOTICE '✅ Kept conversation management functions';
    RAISE NOTICE '✅ Verified unified trigger system is properly deployed';
    RAISE NOTICE '🚀 ActivityPub system is ready for production';
    RAISE NOTICE '';
    RAISE NOTICE 'IMPORTANT: The unified trigger handles FEDERATED activities only';
    RAISE NOTICE 'LOCAL notifications still use the existing notification system';
    RAISE NOTICE '';
    RAISE NOTICE 'NEXT STEPS:';
    RAISE NOTICE '1. Apply fix_local_post_mention_notifications.sql to ensure mentions work';
    RAISE NOTICE '2. Set up cron job: SELECT process_failed_activities_retry(); (every 5 minutes)';
    RAISE NOTICE '3. Monitor: SELECT status, count(*) FROM ap_activities GROUP BY status;';
    RAISE NOTICE '4. Test federation flow end-to-end';
END $$;
