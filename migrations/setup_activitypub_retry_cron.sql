-- ActivityPub Retry System Cron Job Setup
-- Description: Sets up the essential cron job for ActivityPub failed activity retry processing
-- Run this in your Supabase SQL editor AFTER deploying the unified ActivityPub trigger system

-- ============================================================================
-- ACTIVITYPUB RETRY PROCESSOR CRON JOB
-- ============================================================================

SELECT cron.schedule(
    'activitypub-retry-processor',
    '*/5 * * * *',
    'SELECT process_failed_activities_retry();'
);

-- ============================================================================
-- OPTIONAL: ACTIVITYPUB MONITORING AND CLEANUP
-- ============================================================================

SELECT cron.schedule(
    'activitypub-cleanup-old-activities',
    '0 3 * * *',
    'DELETE FROM ap_activities WHERE status = ''processed'' AND created_at < NOW() - INTERVAL ''30 days'' AND attempts < 3;'
);

SELECT cron.schedule(
    'activitypub-daily-stats',
    '0 1 * * *',
    'INSERT INTO activitypub_processing_stats (date, total_activities, processed_activities, failed_activities, permanently_failed_activities, avg_processing_time_ms) SELECT CURRENT_DATE - INTERVAL ''1 day'', COUNT(*), COUNT(*) FILTER (WHERE status = ''processed''), COUNT(*) FILTER (WHERE status = ''failed''), COUNT(*) FILTER (WHERE status = ''permanently_failed''), AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) FROM ap_activities WHERE created_at >= CURRENT_DATE - INTERVAL ''1 day'' AND created_at < CURRENT_DATE;'
);

-- ============================================================================
-- CREATE STATS TABLE (IF NEEDED)
-- ============================================================================

CREATE TABLE IF NOT EXISTS activitypub_processing_stats (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    total_activities INTEGER DEFAULT 0,
    processed_activities INTEGER DEFAULT 0,
    failed_activities INTEGER DEFAULT 0,
    permanently_failed_activities INTEGER DEFAULT 0,
    avg_processing_time_ms NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activitypub_processing_stats_date 
ON activitypub_processing_stats(date DESC);

-- ============================================================================
-- VIEW SCHEDULED JOBS
-- ============================================================================

SELECT 
    jobname,
    schedule,
    command,
    active
FROM cron.job 
WHERE jobname LIKE '%activitypub%'
ORDER BY jobname;

-- ============================================================================
-- MONITOR JOB EXECUTION
-- ============================================================================

SELECT 
    j.jobname,
    jrd.status,
    jrd.return_message,
    jrd.start_time,
    jrd.end_time,
    (jrd.end_time - jrd.start_time) as duration
FROM cron.job j
JOIN cron.job_run_details jrd ON j.jobid = jrd.jobid
WHERE j.jobname LIKE '%activitypub%'
ORDER BY jrd.start_time DESC 
LIMIT 10;

-- ============================================================================
-- MANUAL TESTING
-- ============================================================================

-- SELECT process_failed_activities_retry();

-- ============================================================================
-- MANAGEMENT FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION pause_activitypub_cron_jobs()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    job_names TEXT[] := ARRAY[
        'activitypub-retry-processor',
        'activitypub-cleanup-old-activities',
        'activitypub-daily-stats'
    ];
    job_name TEXT;
    result TEXT := '';
BEGIN
    FOREACH job_name IN ARRAY job_names LOOP
        BEGIN
            PERFORM cron.unschedule(job_name);
            result := result || 'Paused: ' || job_name || E'\n';
        EXCEPTION WHEN OTHERS THEN
            result := result || 'Failed to pause: ' || job_name || ' (' || SQLERRM || ')' || E'\n';
        END;
    END LOOP;
    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION resume_activitypub_cron_jobs()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    result TEXT := '';
    schedule_result TEXT;
BEGIN
    SELECT cron.schedule(
        'activitypub-retry-processor', 
        '*/5 * * * *', 
        'SELECT process_failed_activities_retry();'
    ) INTO schedule_result;
    SELECT cron.schedule(
        'activitypub-cleanup-old-activities',
        '0 3 * * *',
        'DELETE FROM ap_activities WHERE status = ''processed'' AND created_at < NOW() - INTERVAL ''30 days'' AND attempts < 3;'
    ) INTO schedule_result;
    SELECT cron.schedule(
        'activitypub-daily-stats',
        '0 1 * * *',
        'INSERT INTO activitypub_processing_stats (date, total_activities, processed_activities, failed_activities, permanently_failed_activities, avg_processing_time_ms) SELECT CURRENT_DATE - INTERVAL ''1 day'', COUNT(*), COUNT(*) FILTER (WHERE status = ''processed''), COUNT(*) FILTER (WHERE status = ''failed''), COUNT(*) FILTER (WHERE status = ''permanently_failed''), AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) FROM ap_activities WHERE created_at >= CURRENT_DATE - INTERVAL ''1 day'' AND created_at < CURRENT_DATE;'
    ) INTO schedule_result;
    result := 'ActivityPub cron jobs have been resumed';
    RETURN result;
END;
$$;

-- ============================================================================
-- VERIFICATION AND SUCCESS MESSAGE
-- ============================================================================

DO $$
BEGIN
    -- Verify the retry processor function exists
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'process_failed_activities_retry') THEN
        RAISE EXCEPTION 'ERROR: process_failed_activities_retry function not found! Deploy the unified ActivityPub trigger system first.';
    ELSE
        RAISE NOTICE '✅ process_failed_activities_retry function exists';
    END IF;

    -- Verify the ap_activities table exists
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'ap_activities') THEN
        RAISE EXCEPTION 'ERROR: ap_activities table not found! Deploy the ActivityPub schema first.';
    ELSE
        RAISE NOTICE '✅ ap_activities table exists';
    END IF;

    RAISE NOTICE '🚀 ACTIVITYPUB RETRY SYSTEM CRON JOB SETUP COMPLETE';
    RAISE NOTICE '✅ Retry processor will run every 5 minutes';
    RAISE NOTICE '✅ Optional cleanup and stats jobs configured';
    RAISE NOTICE 'NEXT STEPS:';
    RAISE NOTICE '1. Monitor: SELECT status, count(*) FROM ap_activities GROUP BY status;';
    RAISE NOTICE '2. Check job execution: SELECT * FROM cron.job WHERE jobname LIKE ''%%activitypub%%'';';
    RAISE NOTICE '3. Test federation flow end-to-end';
    RAISE NOTICE '4. Monitor cron.job_run_details for any failures';
END $$;

-- ============================================================================
-- IMPORTANT NOTES
-- ============================================================================

/*
CRITICAL INFORMATION:

1. ESSENTIAL JOB: The 'activitypub-retry-processor' job is CRITICAL for federation.
   - It runs every 5 minutes and retries failed ActivityPub activities
   - Without this, failed activities will never be retried
   - This enables the exponential backoff retry system (5min, 20min, 60min)

2. RETRY LOGIC: The process_failed_activities_retry() function:
   - Finds activities with status 'failed' that are ready for retry
   - Retries them up to 3 times with exponential backoff
   - Marks as 'permanently_failed' after 3 attempts
   - Updates next_attempt_at with exponential delays

3. MONITORING: Monitor these key metrics:
   - SELECT status, count(*) FROM ap_activities GROUP BY status;
   - Watch for growing numbers of 'failed' or 'permanently_failed' activities
   - Check cron.job_run_details for retry processor failures

4. PERFORMANCE: The retry processor is optimized:
   - Only processes activities ready for retry (next_attempt_at <= NOW())
   - Uses efficient indexing
   - Limits batch size to avoid overloading the database

5. OPTIONAL JOBS:
   - Cleanup job removes old processed activities (keeps database lean)
   - Stats job tracks processing metrics over time
   - Both can be disabled if not needed

6. TROUBLESHOOTING:
   - If activities get stuck in 'failed' status, check the retry processor logs
   - Ensure the unified ActivityPub trigger system is properly deployed
   - Verify network connectivity for outbound federation
*/
