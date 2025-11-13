-- ============================================
-- DROP UNNECESSARY FUNCTIONS
-- Cleaning up 124 functions down to ~15
-- ============================================

-- RUN THIS AFTER BACKING UP YOUR DATABASE!
-- pg_dump your_db > backup_before_cleanup.sql

-- ============================================
-- FEDERATION FUNCTIONS (Move to TypeScript backend)
-- ============================================

-- Drop all overloads properly
DO $$ 
DECLARE
    func_record RECORD;
BEGIN
    -- Drop all federation-related functions (including all overloads)
    FOR func_record IN 
        SELECT p.oid::regprocedure as func_signature
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname IN (
            'create_http_signature',
            'convert_content_to_activitypub_html',
            'convert_unified_content_to_activitypub_html',
            'extract_activitypub_attachments',
            'extract_activitypub_mention_tags',
            'extract_all_activitypub_tags',
            'extract_misskey_emoji_tags',
            'generate_activitypub_metadata',
            'generate_rsa_keypair',
            'get_activitypub_conversation_context',
            'get_activitypub_conversation_root',
            'get_activitypub_conversation_thread',
            'setup_activitypub_federation',
            'process_federation_activity',
            'process_federation_delivery_queue',
            'process_federation_delivery_queue_unified',
            'process_pending_federation',
            'queue_activity_for_federation',
            'trigger_follow_federation',
            'handle_post_federation',
            'create_outgoing_dm_activity',
            'create_outgoing_dm_activity_unified',
            'create_federated_dm',
            'create_federated_profile',
            'cleanup_federation_delivery_queue',
            'collect_federation_stats',
            'get_federation_stats',
            'mark_instance_reachable',
            'mark_instance_unreachable',
            'moderate_instance',
            'add_activitypub_keys_to_user',
            'add_activitypub_to_new_local_user',
            'regenerate_all_activitypub_keys'
        )
    LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', func_record.func_signature);
    END LOOP;
END $$;


-- ============================================
-- TIMELINE/FEED FUNCTIONS (Use direct queries)
-- ============================================

-- Timeline functions (all overloads)
DO $$
DECLARE func_record RECORD;
BEGIN
    FOR func_record IN 
        SELECT p.oid::regprocedure as func_signature
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname IN (
            'get_cached_timeline',
            'get_user_timeline',
            'get_timeline_posts_with_interactions',
            'update_timeline_cache',
            'update_follower_timelines',
            'create_simple_timeline_entries'
        )
    LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', func_record.func_signature);
    END LOOP;
END $$;


-- ============================================
-- NOTIFICATION HANDLERS (Use triggers instead)
-- ============================================

-- Notification functions (all overloads)
DO $$
DECLARE func_record RECORD;
BEGIN
    FOR func_record IN 
        SELECT p.oid::regprocedure as func_signature
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname IN (
            'handle_mention_notifications',
            'handle_reaction_notifications',
            'handle_simple_follow_notifications',
            'handle_simple_interaction_notifications',
            'handle_simple_post_notifications',
            'create_simple_activitypub_notification',
            'log_notification_insert',
            'notify_new_activity'
        )
    LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', func_record.func_signature);
    END LOOP;
END $$;


-- ============================================
-- HASHTAG FUNCTIONS (Simplify to 2, rest to backend/cron)
-- ============================================

DROP FUNCTION IF EXISTS calculate_hashtag_trending_score CASCADE;
DROP FUNCTION IF EXISTS update_hashtag_trending_scores CASCADE;
DROP FUNCTION IF EXISTS update_hashtag_trending_scores_efficient CASCADE;
DROP FUNCTION IF EXISTS archive_popular_hashtags CASCADE;
DROP FUNCTION IF EXISTS cleanup_inactive_hashtags CASCADE;
DROP FUNCTION IF EXISTS reset_daily_hashtag_counters CASCADE;
DROP FUNCTION IF EXISTS reset_daily_hashtag_counts CASCADE;
DROP FUNCTION IF EXISTS reset_weekly_hashtag_counters CASCADE;
DROP FUNCTION IF EXISTS reset_weekly_hashtag_counts CASCADE;
DROP FUNCTION IF EXISTS trigger_trending_update_now CASCADE;
DROP FUNCTION IF EXISTS pause_trending_cron_jobs CASCADE;
DROP FUNCTION IF EXISTS resume_trending_cron_jobs CASCADE;
DROP FUNCTION IF EXISTS process_trending_queue CASCADE;
DROP FUNCTION IF EXISTS cleanup_trending_queue CASCADE;
DROP FUNCTION IF EXISTS get_trending_maintenance_stats CASCADE;
DROP FUNCTION IF EXISTS normalize_hashtag CASCADE;
DROP FUNCTION IF EXISTS upsert_hashtag CASCADE;
DROP FUNCTION IF EXISTS update_trending_posts CASCADE;
DROP FUNCTION IF EXISTS trigger_process_post_hashtags CASCADE;


-- ============================================
-- EMOJI FUNCTIONS (Frontend can query directly)
-- ============================================

DROP FUNCTION IF EXISTS increment_emoji_usage CASCADE;
DROP FUNCTION IF EXISTS update_emoji_updated_at CASCADE;
DROP FUNCTION IF EXISTS get_most_used_emojis CASCADE;
DROP FUNCTION IF EXISTS get_user_emoji_stats CASCADE;
DROP FUNCTION IF EXISTS get_server_emoji_analytics CASCADE;
DROP FUNCTION IF EXISTS get_emoji_usage_analytics CASCADE;


-- ============================================
-- COUNTER FUNCTIONS (Triggers handle these)
-- ============================================

DROP FUNCTION IF EXISTS reconcile_social_counters CASCADE;
DROP FUNCTION IF EXISTS calculate_post_engagement_score CASCADE;


-- ============================================
-- DUPLICATE/OLD FUNCTIONS
-- ============================================

DROP FUNCTION IF EXISTS handle_new_message CASCADE;
DROP FUNCTION IF EXISTS handle_user_join CASCADE;
DROP FUNCTION IF EXISTS handle_user_leave CASCADE;
DROP FUNCTION IF EXISTS handle_unified_interaction_processing CASCADE;
DROP FUNCTION IF EXISTS handle_unified_reply_processing CASCADE;
DROP FUNCTION IF EXISTS create_notification CASCADE; -- Use create_notification_structured
DROP FUNCTION IF EXISTS get_post_replies CASCADE; -- Simple query
DROP FUNCTION IF EXISTS convert_unified_content_to_plain_text CASCADE;
DROP FUNCTION IF EXISTS jsonb_agg_text_array CASCADE;
DROP FUNCTION IF EXISTS set_activitypub_conversation_root_id CASCADE;
DROP FUNCTION IF EXISTS update_unread_count CASCADE; -- Can be computed
DROP FUNCTION IF EXISTS mark_notification_read CASCADE; -- Direct UPDATE
DROP FUNCTION IF EXISTS mark_all_notifications_read CASCADE; -- Direct UPDATE


-- ============================================
-- ADMIN/MANAGEMENT (Keep minimal)
-- ============================================

-- Keep these for now, could simplify later:
-- get_system_stats()
-- get_recent_admin_activity()
-- log_admin_action()
-- moderate_user()
-- get_instance_config()
-- set_instance_config()

-- ============================================
-- SUMMARY
-- ============================================

DO $$
DECLARE
  remaining_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.prokind = 'f';
    
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Cleanup complete!';
  RAISE NOTICE 'Remaining functions: %', remaining_count;
  RAISE NOTICE 'Target was ~15-20 functions';
  RAISE NOTICE '================================================';
END $$;

-- ============================================
-- NEXT STEPS
-- ============================================
--
-- 1. Apply essential_functions.sql (create the new simplified set)
-- 2. Test your app - verify everything works
-- 3. Update frontend to use direct queries where possible
-- 4. Start federation backend for ActivityPub
-- 5. Celebrate! 🎉

