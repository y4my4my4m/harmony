-- ============================================================================
-- Supabase-Friendly Database Optimization Queries
-- ============================================================================
-- Diagnostic queries to identify optimization opportunities
-- Safe to run in production (read-only)
-- ============================================================================

-- ============================================================================
-- 1. QUERY PERFORMANCE (via pg_stat_statements)
--    (Replacement for FUNCTION PERFORMANCE ANALYSIS)
-- ============================================================================

-- NOTE:
-- - Requires pg_stat_statements (enabled by default on Supabase).
-- - We filter out a bunch of obvious internal/system queries so you mainly see
--   app-related stuff.

WITH filtered_statements AS (
  SELECT
    query,
    calls,
    total_exec_time,
    mean_exec_time,
    max_exec_time,
    rows
  FROM pg_stat_statements
  WHERE
    -- Ignore pg_stat_statements queries themselves
    query NOT LIKE '%pg_stat_statements%'
    -- Hide obvious system/catalog noise
    AND query NOT LIKE '%pg_catalog.%'
    AND query NOT LIKE '%information_schema.%'
    -- Hide Supabase analytics logging chatter
    AND query NOT LIKE 'INSERT INTO "_analytics".log_events_%'
    -- Hide realtime/list_changes polling
    AND query NOT LIKE 'select * from realtime.list_changes%'
    -- Hide HTTP extension queue cleanup
    AND query NOT LIKE 'WITH    rows AS (      SELECT ctid      FROM net._http_response%'
    AND query NOT LIKE 'WITH    rows AS (      SELECT id      FROM net.http_request_queue%'
)

-- 1.1 Top 20 queries by total execution time (heaviest overall)
SELECT
  query,
  calls,
  total_exec_time::numeric(12,2) AS total_time_ms,
  mean_exec_time::numeric(12,2)  AS avg_time_ms,
  max_exec_time::numeric(12,2)   AS max_time_ms
FROM filtered_statements
ORDER BY total_exec_time DESC
LIMIT 20;

-- 1.2 Slowest queries by average execution time (with min call count)
--     (good for finding very slow endpoints / RPC calls)
SELECT
  query,
  calls,
  mean_exec_time::numeric(12,2) AS avg_time_ms,
  max_exec_time::numeric(12,2)  AS max_time_ms,
  total_exec_time::numeric(12,2) AS total_time_ms
FROM filtered_statements
WHERE calls > 50  -- tweak as needed
ORDER BY mean_exec_time DESC
LIMIT 20;

-- 1.3 Likely RPC / function-backed queries (PostgREST style)
--     This surfaces calls that go through your `public.*` functions.
SELECT
  query,
  calls,
  mean_exec_time::numeric(12,2) AS avg_time_ms,
  total_exec_time::numeric(12,2) AS total_time_ms
FROM filtered_statements
WHERE query ILIKE '%pgrst_source%'
  AND query ILIKE '%public.%'
ORDER BY total_exec_time DESC
LIMIT 20;


-- ============================================================================
-- 2. INDEX USAGE ANALYSIS
-- ============================================================================

-- Unused indexes (candidates for removal)
SELECT 
    schemaname,
    relname AS tablename,
    indexrelname AS indexname,
    idx_scan,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND idx_scan = 0
  AND indexrelid IS NOT NULL
ORDER BY pg_relation_size(indexrelid) DESC;


-- Most used indexes
SELECT 
    schemaname,
    relname AS tablename,
    indexrelname AS indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes  
WHERE schemaname = 'public'
ORDER BY idx_scan DESC
LIMIT 20;


-- Tables missing indexes (sequential scans dominating)
SELECT 
    schemaname,
    relname AS tablename,
    seq_scan,
    seq_tup_read,
    idx_scan,
    seq_tup_read / NULLIF(seq_scan, 0) AS avg_seq_tup_read,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND seq_scan > 0
  AND seq_scan > idx_scan
ORDER BY seq_scan DESC
LIMIT 20;



-- ============================================================================
-- 3. TABLE BLOAT ANALYSIS (approx, based on dead tuples)
-- ============================================================================

SELECT
    schemaname,
    relname AS tablename,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    pg_size_pretty(pg_relation_size(relid))       AS table_size,
    pg_size_pretty(
        pg_total_relation_size(relid) - pg_relation_size(relid)
    ) AS index_size,
    n_dead_tup,
    n_live_tup,
    CASE 
        WHEN n_live_tup > 0 THEN ROUND(n_dead_tup::numeric / n_live_tup * 100, 2)
        ELSE 0
    END AS dead_tup_percent
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND n_dead_tup > 1000
ORDER BY dead_tup_percent DESC, n_dead_tup DESC
LIMIT 20;


SELECT
    schemaname,
    relname AS tablename,
    indexrelname AS indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 30;


-- ============================================================================
-- 4. CACHE HIT RATIOS
-- ============================================================================

-- Buffer cache hit ratio (should ideally be > 95%)
SELECT 
    sum(heap_blks_read) AS heap_read,
    sum(heap_blks_hit)  AS heap_hit,
    (sum(heap_blks_hit) / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0)::numeric) * 100
      AS cache_hit_ratio_percent
FROM pg_statio_user_tables;

-- Index cache hit ratio (should ideally be > 95%)
SELECT 
    sum(idx_blks_read) AS idx_read,
    sum(idx_blks_hit)  AS idx_hit,
    (sum(idx_blks_hit) / NULLIF(sum(idx_blks_hit) + sum(idx_blks_read), 0)::numeric) * 100
      AS index_hit_ratio_percent
FROM pg_statio_user_tables;


-- ============================================================================
-- 5. TABLE STATISTICS
-- ============================================================================

-- Largest tables
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename))       AS table_size,
    pg_total_relation_size(schemaname||'.'||tablename)                 AS bytes
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY bytes DESC
LIMIT 20;

-- Tables with most writes
SELECT 
    schemaname,
    tablename,
    n_tup_ins + n_tup_upd + n_tup_del AS total_writes,
    n_tup_ins  AS inserts,
    n_tup_upd  AS updates,
    n_tup_del  AS deletes,
    n_live_tup,
    last_autovacuum,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY total_writes DESC
LIMIT 20;


-- ============================================================================
-- 6. MISSING FOREIGN KEY INDEXES
-- ============================================================================

-- Foreign keys without supporting indexes
SELECT 
    c.conrelid::regclass AS table,
    string_agg(a.attname, ', ') AS columns,
    pg_size_pretty(pg_total_relation_size(c.conrelid)) AS table_size
FROM pg_constraint c
JOIN pg_attribute a
  ON a.attrelid = c.conrelid
 AND a.attnum   = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND i.indkey   = c.conkey
  )
GROUP BY c.conrelid, c.conname
ORDER BY pg_total_relation_size(c.conrelid) DESC;


-- ============================================================================
-- 7. TIMELINE SPECIFIC ANALYSIS
-- ============================================================================

-- Timeline entries distribution
SELECT 
    COUNT(*)                                      AS total_entries,
    COUNT(DISTINCT user_id)                       AS unique_users,
    COUNT(DISTINCT post_id)                       AS unique_posts,
    AVG(extract(epoch FROM (now() - created_at))) / 3600 AS avg_age_hours,
    pg_size_pretty(pg_total_relation_size('timeline_entries')) AS table_size
FROM timeline_entries
WHERE deleted_at IS NULL;

-- Users with most timeline entries
SELECT 
    user_id,
    COUNT(*)          AS entry_count,
    MAX(created_at)   AS latest_entry,
    MIN(created_at)   AS oldest_entry
FROM timeline_entries
WHERE deleted_at IS NULL
GROUP BY user_id
ORDER BY entry_count DESC
LIMIT 20;


-- ============================================================================
-- 8. REACTION ANALYSIS
-- ============================================================================

-- Emoji reaction statistics
SELECT 
    COUNT(*)                                          AS total_reactions,
    COUNT(DISTINCT post_id)                           AS posts_with_reactions,
    COUNT(DISTINCT user_id)                           AS users_who_reacted,
    COUNT(DISTINCT emoji_id)                          AS unique_emojis_used,
    pg_size_pretty(pg_total_relation_size('post_emoji_reactions')) AS table_size
FROM post_emoji_reactions;

-- Most used emojis
SELECT 
    e.name,
    COUNT(*) AS usage_count
FROM post_emoji_reactions per
JOIN emojis e ON e.id = per.emoji_id
GROUP BY e.id, e.name
ORDER BY usage_count DESC
LIMIT 20;


-- ============================================================================
-- 9. FEDERATION ANALYSIS
-- ============================================================================

-- Federation delivery queue health
SELECT 
    status,
    COUNT(*) AS count,
    AVG(extract(epoch FROM (now() - created_at))) / 60 AS avg_age_minutes
FROM federation_deliveries
GROUP BY status;

-- Failed deliveries by instance
SELECT 
    target_instance,
    COUNT(*)        AS failed_count,
    MAX(updated_at) AS last_failure
FROM federation_deliveries
WHERE status = 'failed'
GROUP BY target_instance
ORDER BY failed_count DESC
LIMIT 20;


-- ============================================================================
-- 10. NOTIFICATION ANALYSIS
-- ============================================================================

-- Notification distribution (last 30 days)
SELECT 
    type,
    COUNT(*)                                            AS count,
    COUNT(CASE WHEN read_at IS NOT NULL THEN 1 END)     AS read_count,
    COUNT(CASE WHEN read_at IS NULL THEN 1 END)         AS unread_count
FROM notifications
WHERE created_at > now() - interval '30 days'
GROUP BY type
ORDER BY count DESC;

-- Users with most unread notifications
SELECT 
    user_id,
    COUNT(*)        AS unread_count,
    MAX(created_at) AS latest_notification
FROM notifications
WHERE read_at IS NULL
GROUP BY user_id
ORDER BY unread_count DESC
LIMIT 20;


-- ============================================================================
-- 11. MESSAGE ANALYSIS
-- ============================================================================

-- Message distribution by type
SELECT 
    CASE 
      WHEN conversation_id IS NOT NULL THEN 'DM'
      WHEN channel_id      IS NOT NULL THEN 'Channel'
      ELSE 'Unknown'
    END AS message_type,
    COUNT(*) AS count,
    pg_size_pretty(SUM(LENGTH(content::text))::bigint) AS total_content_size
FROM messages
GROUP BY message_type;

-- Channels with most messages
SELECT 
    c.name         AS channel_name,
    s.name         AS server_name,
    COUNT(m.id)    AS message_count,
    MAX(m.created_at) AS last_message
FROM messages m
JOIN channels c ON c.id = m.channel_id
JOIN servers  s ON s.id = c.server_id
WHERE m.channel_id IS NOT NULL
GROUP BY c.id, c.name, s.name
ORDER BY message_count DESC
LIMIT 20;

-- ============================================================================
-- END OF OPTIMIZATION QUERIES
-- ============================================================================
