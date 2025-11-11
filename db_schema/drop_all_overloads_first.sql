-- ============================================
-- DROP ALL OVERLOADS OF FUNCTIONS WE'RE RECREATING
-- Run this BEFORE essential_functions.sql
-- ============================================

DO $$ 
DECLARE
    func_record RECORD;
BEGIN
    -- Drop ALL overloads of functions we're about to recreate
    FOR func_record IN 
        SELECT p.oid::regprocedure as func_signature
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname IN (
            'get_or_create_conversation',
            'get_user_handle',
            'is_local_user',
            'search_users',
            'get_timeline',
            'extract_hashtags_from_content',
            'get_trending_hashtags',
            'create_system_message',
            'create_default_server_structure',
            'create_notification_structured',
            'get_unread_notification_count',
            'cleanup_old_notifications',
            'get_system_stats',
            'update_updated_at_column',
            'notify_federation_event',
            'update_post_counters'
        )
    LOOP
        RAISE NOTICE 'Dropping: %', func_record.func_signature;
        EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', func_record.func_signature);
    END LOOP;
    
    RAISE NOTICE '✅ Dropped all overloads of essential functions';
END $$;

