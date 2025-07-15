-- Federation System Status Check
-- Run this to verify the federation delivery system is working properly

-- Check current federation tables
SELECT 'federation_delivery_queue' as table_name, COUNT(*) as total_records,
       COUNT(*) FILTER (WHERE status = 'pending') as pending,
       COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
       COUNT(*) FILTER (WHERE status = 'failed') as failed
FROM federation_delivery_queue

UNION ALL

SELECT 'federation_delivery_stats' as table_name, COUNT(*) as total_records,
       NULL as pending, NULL as delivered, NULL as failed
FROM federation_delivery_stats;

-- Check if cron jobs are running (requires pg_cron)
SELECT jobname, schedule, active, database, username
FROM cron.job 
WHERE jobname LIKE 'federation%'
ORDER BY jobname;

-- Check recent delivery activity (last 24 hours)
SELECT 
    DATE_TRUNC('hour', created_at) as hour,
    COUNT(*) as deliveries,
    COUNT(*) FILTER (WHERE status = 'delivered') as successful,
    COUNT(*) FILTER (WHERE status = 'failed') as failed,
    COUNT(*) FILTER (WHERE status = 'pending') as pending,
    AVG(delivery_duration_ms)::INT as avg_delivery_ms
FROM federation_delivery_queue
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('hour', created_at)
ORDER BY hour DESC
LIMIT 24;

-- Show any recent errors
SELECT 
    target_domain,
    target_inbox_url,
    status,
    attempts,
    max_attempts,
    error_message,
    http_status_code,
    next_attempt_at,
    created_at
FROM federation_delivery_queue
WHERE status IN ('failed', 'pending')
   OR attempts > 0
ORDER BY created_at DESC
LIMIT 10;
