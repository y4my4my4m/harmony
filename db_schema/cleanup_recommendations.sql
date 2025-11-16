-- ============================================================================
-- Database Cleanup & Optimization Script
-- Generated: 2025-11-16
-- ============================================================================
-- 
-- This script contains RECOMMENDATIONS for cleaning up redundant functions.
-- DO NOT RUN THIS DIRECTLY without reviewing usage patterns first.
--
-- See docs/DATABASE_ANALYSIS.md for full analysis
-- ============================================================================

-- ============================================================================
-- STEP 1: VERIFY CURRENT USAGE (Run these queries first)
-- ============================================================================

-- Check if any of these deprecated functions are still being called
-- Review application logs and monitor for 24-48 hours before proceeding

COMMENT ON FUNCTION public.create_or_get_direct_conversation IS 'DEPRECATED: Use get_or_create_dm_conversation instead. Will be removed in future version.';
COMMENT ON FUNCTION public.get_or_create_conversation IS 'DEPRECATED: Use get_or_create_dm_conversation for DMs or create_or_get_multi_conversation for groups.';
COMMENT ON FUNCTION public.get_timeline IS 'DEPRECATED: Use get_enhanced_timeline_posts instead for better performance and features.';
COMMENT ON FUNCTION public.get_batch_post_reactions IS 'DEPRECATED: Use get_batch_post_emoji_reactions instead.';

-- ============================================================================
-- STEP 2: ADD DEPRECATION WARNINGS (Safe to run immediately)
-- ============================================================================

-- Add warnings to deprecated functions so we can track usage
CREATE OR REPLACE FUNCTION public.create_or_get_direct_conversation(user1_uuid uuid, user2_uuid uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RAISE WARNING 'DEPRECATED: create_or_get_direct_conversation is deprecated. Use get_or_create_dm_conversation instead.';
    -- Forward to new function
    RETURN public.get_or_create_dm_conversation(user1_uuid, user2_uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_or_create_conversation(user1_uuid uuid, user2_uuid uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RAISE WARNING 'DEPRECATED: get_or_create_conversation is deprecated. Use get_or_create_dm_conversation instead.';
    -- Forward to new function
    RETURN public.get_or_create_dm_conversation(user1_uuid, user2_uuid);
END;
$$;

-- ============================================================================
-- STEP 3: FRONTEND CODE UPDATES REQUIRED
-- ============================================================================

-- Before running cleanup, update these files:
-- 
-- 1. src/stores/useDM.ts
--    Change: .rpc('create_or_get_direct_conversation'...)
--    To:     .rpc('get_or_create_dm_conversation'...)
--
-- 2. Search all .rpc() calls for deprecated function names
--    Run: grep -r "get_timeline\|get_batch_post_reactions\|get_or_create_conversation" src/
--

-- ============================================================================
-- STEP 4: ACTUAL CLEANUP (Run AFTER frontend updates deployed)
-- ============================================================================

-- WARNING: Only run this after:
-- 1. Frontend code has been updated
-- 2. New code has been deployed
-- 3. No warnings appear in logs for 48 hours

/*
-- Conversation Functions Cleanup
DROP FUNCTION IF EXISTS public.create_or_get_direct_conversation(uuid, uuid);
DROP FUNCTION IF EXISTS public.get_or_create_conversation(uuid, uuid);

-- Timeline Functions Cleanup  
DROP FUNCTION IF EXISTS public.get_timeline(uuid, integer, timestamp without time zone);

-- Reaction Functions Cleanup
DROP FUNCTION IF EXISTS public.get_batch_post_reactions(uuid[]);
*/

-- ============================================================================
-- STEP 5: OPTIMIZATION - ADD MISSING INDEXES
-- ============================================================================

-- Analyze which indexes are actually used
-- Run this to see index usage:
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan as index_scans,
    idx_tup_read as tuples_read,
    idx_tup_fetch as tuples_fetched
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan ASC
LIMIT 20;

-- Add indexes for commonly filtered columns (review query patterns first)
-- Examples (verify these are needed before creating):

/*
-- Timeline query optimization
CREATE INDEX IF NOT EXISTS idx_timeline_entries_user_created 
ON public.timeline_entries(user_id, created_at DESC) 
WHERE deleted_at IS NULL;

-- Message reactions optimization  
CREATE INDEX IF NOT EXISTS idx_message_emoji_reactions_batch
ON public.message_emoji_reactions(message_id, emoji_id)
INCLUDE (user_id);

-- Post interactions optimization
CREATE INDEX IF NOT EXISTS idx_posts_author_created
ON public.posts(author_id, created_at DESC)
WHERE deleted_at IS NULL;

-- Conversation participants lookup
CREATE INDEX IF NOT EXISTS idx_conversation_participants_lookup
ON public.conversation_participants(conversation_id, user_id)
WHERE left_at IS NULL;
*/

-- ============================================================================
-- STEP 6: FUNCTION PERFORMANCE OPTIMIZATION
-- ============================================================================

-- Monitor slow functions
SELECT 
    funcname,
    calls,
    total_time,
    mean_time,
    max_time
FROM pg_stat_user_functions
WHERE schemaname = 'public'
ORDER BY total_time DESC
LIMIT 20;

-- ============================================================================
-- STEP 7: MATERIALIZED VIEW FOR EXPENSIVE QUERIES
-- ============================================================================

-- Consider materialized views for expensive aggregations
-- Example: Timeline statistics

/*
CREATE MATERIALIZED VIEW IF NOT EXISTS public.timeline_stats AS
SELECT 
    user_id,
    COUNT(*) as entry_count,
    MAX(created_at) as latest_entry,
    COUNT(DISTINCT post_id) as unique_posts
FROM public.timeline_entries
WHERE deleted_at IS NULL
GROUP BY user_id;

CREATE UNIQUE INDEX ON public.timeline_stats(user_id);

-- Refresh strategy (choose one):
-- Option 1: Manual refresh when needed
-- REFRESH MATERIALIZED VIEW CONCURRENTLY public.timeline_stats;

-- Option 2: Auto-refresh via trigger
-- CREATE OR REPLACE FUNCTION refresh_timeline_stats()
-- RETURNS trigger AS $$
-- BEGIN
--     REFRESH MATERIALIZED VIEW CONCURRENTLY public.timeline_stats;
--     RETURN NULL;
-- END;
-- $$ LANGUAGE plpgsql;
*/

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- After cleanup, verify functions were removed:
SELECT 
    routine_schema,
    routine_name,
    routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
    AND routine_name IN (
        'create_or_get_direct_conversation',
        'get_or_create_conversation',
        'get_timeline',
        'get_batch_post_reactions'
    )
ORDER BY routine_name;

-- Should return 0 rows after cleanup

-- ============================================================================
-- ROLLBACK PLAN
-- ============================================================================

-- If issues arise, restore from backup or recreate functions
-- Ensure you have a backup before running cleanup:
-- pg_dump -h localhost -U postgres -d harmony --schema-only > backup_schema.sql

-- ============================================================================
-- MONITORING RECOMMENDATIONS
-- ============================================================================

-- 1. Enable function call logging temporarily:
-- ALTER DATABASE harmony SET log_statement = 'all';
-- Monitor logs for deprecated function calls

-- 2. Set up alerts for:
--    - Functions with mean_time > 100ms
--    - Functions with total_time in top 10
--    - Missing index warnings in logs

-- 3. Regular maintenance:
--    - VACUUM ANALYZE after major cleanups
--    - REINDEX if needed
--    - Update statistics: ANALYZE;

-- ============================================================================
-- END OF CLEANUP SCRIPT
-- ============================================================================

