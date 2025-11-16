-- ============================================================================
-- Database Optimization Queries
-- ============================================================================
-- Diagnostic queries to identify optimization opportunities
-- Safe to run in production (read-only)
-- ============================================================================

-- ============================================================================
-- 1. FUNCTION PERFORMANCE ANALYSIS
-- ============================================================================

-- Top 20 slowest functions by total execution time
SELECT 
    schemaname,
    funcname,
    calls,
    total_time::numeric(10,2) as total_time_ms,
    mean_time::numeric(10,2) as avg_time_ms,
    (total_time / NULLIF(calls, 0))::numeric(10,2) as time_per_call_ms
FROM pg_stat_user_functions
WHERE schemaname = 'public'
ORDER BY total_time DESC
LIMIT 20;

-- Functions with highest average execution time
SELECT 
    schemaname,
    funcname,
    calls,
    mean_time::numeric(10,2) as avg_time_ms,
    max_time::numeric(10,2) as max_time_ms
FROM pg_stat_user_functions
WHERE schemaname = 'public'
    AND calls > 10  -- Only functions called more than 10 times
ORDER BY mean_time DESC
LIMIT 20;

-- ============================================================================
-- 2. INDEX USAGE ANALYSIS
-- ============================================================================

-- Unused indexes (candidates for removal)
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan,
    pg_size_pretty(pg_relation_size(indexrelid)) as index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
    AND idx_scan = 0
    AND indexrelid IS NOT NULL
ORDER BY pg_relation_size(indexrelid) DESC;

-- Most used indexes
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch,
    pg_size_pretty(pg_relation_size(indexrelid)) as index_size
FROM pg_stat_user_indexes  
WHERE schemaname = 'public'
ORDER BY idx_scan DESC
LIMIT 20;

-- Tables missing indexes (sequential scans)
SELECT 
    schemaname,
    tablename,
    seq_scan,
    seq_tup_read,
    idx_scan,
    seq_tup_read / NULLIF(seq_scan, 0) as avg_seq_tup_read,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size
FROM pg_stat_user_tables
WHERE schemaname = 'public'
    AND seq_scan > 0
    AND (idx_scan IS NULL OR seq_scan > idx_scan)
ORDER BY seq_scan DESC
LIMIT 20;

-- ============================================================================
-- 3. TABLE BLOAT ANALYSIS
-- ============================================================================

-- Tables with potential bloat
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) as index_size,
    n_dead_tup,
    n_live_tup,
    CASE 
        WHEN n_live_tup > 0 
        THEN (n_dead_tup::float / n_live_tup::float * 100)::numeric(10,2)
        ELSE 0 
    END as dead_tup_percent
FROM pg_stat_user_tables
WHERE schemaname = 'public'
    AND n_dead_tup > 1000
ORDER BY dead_tup_percent DESC, n_dead_tup DESC
LIMIT 20;

-- ============================================================================
-- 4. QUERY PERFORMANCE (requires pg_stat_statements extension)
-- ============================================================================

-- Top 20 slowest queries
-- SELECT 
--     query,
--     calls,
--     total_time::numeric(10,2) as total_time_ms,
--     mean_time::numeric(10,2) as avg_time_ms,
--     max_time::numeric(10,2) as max_time_ms,
--     stddev_time::numeric(10,2) as stddev_ms
-- FROM pg_stat_statements
-- WHERE query NOT LIKE '%pg_stat_statements%'
-- ORDER BY mean_time DESC
-- LIMIT 20;

-- ============================================================================
-- 5. CACHE HIT RATIOS
-- ============================================================================

-- Buffer cache hit ratio (should be > 95%)
SELECT 
    sum(heap_blks_read) as heap_read,
    sum(heap_blks_hit) as heap_hit,
    sum(heap_blks_hit) / NULLIF((sum(heap_blks_hit) + sum(heap_blks_read)), 0) * 100 as cache_hit_ratio
FROM pg_statio_user_tables;

-- Index cache hit ratio (should be > 95%)
SELECT 
    sum(idx_blks_read) as idx_read,
    sum(idx_blks_hit) as idx_hit,
    sum(idx_blks_hit) / NULLIF((sum(idx_blks_hit) + sum(idx_blks_read)), 0) * 100 as index_hit_ratio
FROM pg_statio_user_tables;

-- ============================================================================
-- 6. TABLE STATISTICS
-- ============================================================================

-- Largest tables
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,
    pg_total_relation_size(schemaname||'.'||tablename) as bytes
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY bytes DESC
LIMIT 20;

-- Tables with most writes
SELECT 
    schemaname,
    tablename,
    n_tup_ins + n_tup_upd + n_tup_del as total_writes,
    n_tup_ins as inserts,
    n_tup_upd as updates,
    n_tup_del as deletes,
    n_live_tup,
    last_autovacuum,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY total_writes DESC
LIMIT 20;

-- ============================================================================
-- 7. MISSING FOREIGN KEY INDEXES
-- ============================================================================

-- Find foreign keys without supporting indexes
SELECT 
    c.conrelid::regclass AS table,
    string_agg(a.attname, ', ') AS columns,
    pg_size_pretty(pg_total_relation_size(c.conrelid)) AS table_size
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
    AND NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = c.conrelid
            AND c.conkey::text = i.indkey::text
    )
GROUP BY c.conrelid, c.conname
ORDER BY pg_total_relation_size(c.conrelid) DESC;

-- ============================================================================
-- 8. TIMELINE SPECIFIC ANALYSIS
-- ============================================================================

-- Timeline entries distribution
SELECT 
    COUNT(*) as total_entries,
    COUNT(DISTINCT user_id) as unique_users,
    COUNT(DISTINCT post_id) as unique_posts,
    AVG(extract(epoch from (now() - created_at))) / 3600 as avg_age_hours,
    pg_size_pretty(pg_total_relation_size('timeline_entries')) as table_size
FROM timeline_entries
WHERE deleted_at IS NULL;

-- Users with most timeline entries
SELECT 
    user_id,
    COUNT(*) as entry_count,
    MAX(created_at) as latest_entry,
    MIN(created_at) as oldest_entry
FROM timeline_entries
WHERE deleted_at IS NULL
GROUP BY user_id
ORDER BY entry_count DESC
LIMIT 20;

-- ============================================================================
-- 9. REACTION ANALYSIS
-- ============================================================================

-- Emoji reaction statistics
SELECT 
    COUNT(*) as total_reactions,
    COUNT(DISTINCT post_id) as posts_with_reactions,
    COUNT(DISTINCT user_id) as users_who_reacted,
    COUNT(DISTINCT emoji_id) as unique_emojis_used,
    pg_size_pretty(pg_total_relation_size('post_emoji_reactions')) as table_size
FROM post_emoji_reactions;

-- Most used emojis
SELECT 
    e.name,
    COUNT(*) as usage_count
FROM post_emoji_reactions per
JOIN emojis e ON e.id = per.emoji_id
GROUP BY e.id, e.name
ORDER BY usage_count DESC
LIMIT 20;

-- ============================================================================
-- 10. FEDERATION ANALYSIS
-- ============================================================================

-- Federation delivery queue health
SELECT 
    status,
    COUNT(*) as count,
    AVG(extract(epoch from (now() - created_at))) / 60 as avg_age_minutes
FROM federation_deliveries
GROUP BY status;

-- Failed deliveries by instance
SELECT 
    target_instance,
    COUNT(*) as failed_count,
    MAX(updated_at) as last_failure
FROM federation_deliveries
WHERE status = 'failed'
GROUP BY target_instance
ORDER BY failed_count DESC
LIMIT 20;

-- ============================================================================
-- 11. NOTIFICATION ANALYSIS
-- ============================================================================

-- Notification distribution
SELECT 
    type,
    COUNT(*) as count,
    COUNT(CASE WHEN read_at IS NOT NULL THEN 1 END) as read_count,
    COUNT(CASE WHEN read_at IS NULL THEN 1 END) as unread_count
FROM notifications
WHERE created_at > now() - interval '30 days'
GROUP BY type
ORDER BY count DESC;

-- Users with most unread notifications
SELECT 
    user_id,
    COUNT(*) as unread_count,
    MAX(created_at) as latest_notification
FROM notifications
WHERE read_at IS NULL
GROUP BY user_id
ORDER BY unread_count DESC
LIMIT 20;

-- ============================================================================
-- 12. MESSAGE ANALYSIS
-- ============================================================================

-- Message distribution by type
SELECT 
    CASE 
        WHEN conversation_id IS NOT NULL THEN 'DM'
        WHEN channel_id IS NOT NULL THEN 'Channel'
        ELSE 'Unknown'
    END as message_type,
    COUNT(*) as count,
    pg_size_pretty(SUM(LENGTH(content::text))::bigint) as total_content_size
FROM messages
GROUP BY message_type;

-- Channels with most messages
SELECT 
    c.name as channel_name,
    s.name as server_name,
    COUNT(m.id) as message_count,
    MAX(m.created_at) as last_message
FROM messages m
JOIN channels c ON c.id = m.channel_id
JOIN servers s ON s.id = c.server_id
WHERE m.channel_id IS NOT NULL
GROUP BY c.id, c.name, s.name
ORDER BY message_count DESC
LIMIT 20;

-- ============================================================================
-- END OF OPTIMIZATION QUERIES
-- ============================================================================

