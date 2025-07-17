-- Fix federation cron jobs to properly handle retries and clean up dead code
-- 1. Webhooks handle new deliveries (INSERT events) - already set up
-- 2. Cron handles retries (failed items ready for retry)
-- 3. Clean up all the ghost/dead functions and jobs

-- Remove all old federation cron jobs
SELECT cron.unschedule('federation-delivery-worker');
SELECT cron.unschedule('federation-cleanup'); 
SELECT cron.unschedule('federation-stats');

-- Create a proper retry cron job that only triggers when there are items ready for retry
SELECT cron.schedule(
    'federation-retry-worker',
    '*/2 * * * *',  -- Every 2 minutes to handle retries
    $$
    SELECT
        CASE 
            WHEN EXISTS(
                SELECT 1 FROM federation_delivery_queue 
                WHERE status = 'pending' 
                AND next_attempt_at <= NOW()
                AND attempts > 0  -- Only retry items that have failed before
            ) THEN
                net.http_post(
                    url := 'http://kong:8000/functions/v1/outbox/delivery',
                    body := '{}',
                    headers := jsonb_build_object(
                        'Content-Type', 'application/json',
                        'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key')
                    ),
                    timeout_milliseconds := 10000
                )
            ELSE
                NULL  -- No retries needed, don't call edge function
        END;
    $$
);

-- Clean up old/dead federation functions that just return stats or don't work
DROP FUNCTION IF EXISTS process_federation_delivery_queue();
DROP FUNCTION IF EXISTS process_federation_delivery_queue_unified();
DROP FUNCTION IF EXISTS cleanup_federation_delivery_queue();
DROP FUNCTION IF EXISTS collect_federation_stats();

-- Create a simple cleanup function for old delivered items (this actually does cleanup)
CREATE OR REPLACE FUNCTION cleanup_old_federation_deliveries()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    cleanup_count INTEGER := 0;
    delivered_count INTEGER;
    failed_count INTEGER;
BEGIN
    -- Delete delivered items older than 7 days
    DELETE FROM federation_delivery_queue 
    WHERE status = 'delivered' 
    AND delivered_at < NOW() - INTERVAL '7 days';
    
    GET DIAGNOSTICS delivered_count = ROW_COUNT;
    cleanup_count := delivered_count;
    
    -- Delete permanently failed items older than 30 days
    DELETE FROM federation_delivery_queue 
    WHERE status = 'failed' 
    AND updated_at < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS failed_count = ROW_COUNT;
    cleanup_count := cleanup_count + failed_count;
    
    RAISE NOTICE 'Cleaned up % delivered and % failed federation delivery records', delivered_count, failed_count;
    
    RETURN cleanup_count;
END;
$$;

-- Create a proper cleanup cron job (daily)
SELECT cron.schedule(
    'federation-cleanup-delivered',
    '0 2 * * *',  -- Daily at 2 AM
    'SELECT cleanup_old_federation_deliveries();'
);

-- 3. Keep only the cleanup and stats cron jobs (these are still useful)
-- federation-cleanup and federation-stats are fine as they do actual database cleanup

-- 4. Update activitypub-retry-processor to also call Edge Function if needed
-- (This one might be processing different activities, let's keep it for now)

-- Log the changes
INSERT INTO instance_config (config_key, config_value, description) 
VALUES (
    'federation_cron_migration_completed', 
    'true',
    'Cron jobs updated to call Edge Function webhooks instead of obsolete PostgreSQL functions'
) ON CONFLICT (config_key) DO UPDATE SET 
    config_value = EXCLUDED.config_value,
    description = EXCLUDED.description,
    updated_at = NOW();

-- Verify the cron jobs
SELECT jobname, schedule, command 
FROM cron.job 
WHERE jobname LIKE '%federation%' 
ORDER BY jobname;
