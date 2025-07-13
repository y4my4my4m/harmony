-- Supabase Cron Jobs Setup for Hashtag Trending System
-- Description: Sets up pg_cron jobs for automated trending calculations
-- Run this in your Supabase SQL editor

-- ============================================================================
-- ENABLE PG_CRON EXTENSION
-- ============================================================================

-- Enable the pg_cron extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================================
-- SETUP CRON JOBS FOR TRENDING SYSTEM
-- ============================================================================

-- 1. Process trending queue every 15 minutes
-- This handles the async trending calculations
SELECT cron.schedule(
    'process-trending-queue',
    '*/15 * * * *', -- Every 15 minutes
    $$SELECT process_trending_queue();$$
);

-- 2. Reset daily hashtag counts at midnight UTC
-- This resets the daily_uses counter and updates peaks
SELECT cron.schedule(
    'reset-daily-hashtag-counts',
    '0 0 * * *', -- Daily at midnight UTC
    $$SELECT reset_daily_hashtag_counts();$$
);

-- 3. Reset weekly hashtag counts every Sunday at 1 AM UTC
-- This resets the weekly_uses counter
SELECT cron.schedule(
    'reset-weekly-hashtag-counts',
    '0 1 * * 0', -- Weekly on Sunday at 1 AM UTC
    $$SELECT reset_weekly_hashtag_counts();$$
);

-- 4. Clean up trending queue daily at 2 AM UTC
-- This removes stuck processing items and optimizes the queue
SELECT cron.schedule(
    'cleanup-trending-queue',
    '0 2 * * *', -- Daily at 2 AM UTC
    $$SELECT cleanup_trending_queue();$$
);

-- 5. Clean up old trending data weekly at 3 AM UTC on Sunday
-- This removes old trending posts/users data to keep database lean
SELECT cron.schedule(
    'cleanup-old-trending-data',
    '0 3 * * 0', -- Weekly on Sunday at 3 AM UTC
    $$SELECT cleanup_old_trending_data();$$
);

-- 6. Clean up inactive hashtags monthly on the 1st at 4 AM UTC
-- This removes hashtags that haven't been used in a long time
SELECT cron.schedule(
    'cleanup-inactive-hashtags',
    '0 4 1 * *', -- Monthly on the 1st at 4 AM UTC
    $$SELECT cleanup_inactive_hashtags();$$
);

-- ============================================================================
-- VIEW SCHEDULED JOBS
-- ============================================================================

-- Check all scheduled cron jobs
SELECT * FROM cron.job ORDER BY schedule;

-- ============================================================================
-- MONITOR JOB EXECUTION
-- ============================================================================

-- View job execution history (last 10 executions)
-- Note: Using actual column names from cron.job_run_details
SELECT 
    jobid,
    command,
    status,
    return_message,
    start_time,
    end_time,
    (end_time - start_time) as duration
FROM cron.job_run_details 
WHERE command LIKE '%trending%' OR command LIKE '%hashtag%'
ORDER BY start_time DESC 
LIMIT 10;

-- ============================================================================
-- OPTIONAL: HIGH-FREQUENCY TRENDING UPDATES (FOR HIGH-TRAFFIC INSTANCES)
-- ============================================================================

-- If you have very high traffic and want more frequent trending updates:
-- Uncomment the lines below to process trending every 5 minutes instead of 15

-- SELECT cron.unschedule('process-trending-queue');
-- SELECT cron.schedule(
--     'process-trending-queue-frequent',
--     '*/5 * * * *', -- Every 5 minutes
--     $$SELECT process_trending_queue();$$
-- );

-- ============================================================================
-- OPTIONAL: TIMEZONE-SPECIFIC SCHEDULES
-- ============================================================================

-- If you want to reset counts based on your local timezone instead of UTC,
-- adjust the schedules accordingly. For example, for EST (UTC-5):

-- Reset daily counts at midnight EST (5 AM UTC)
-- SELECT cron.unschedule('reset-daily-hashtag-counts');
-- SELECT cron.schedule(
--     'reset-daily-hashtag-counts-est',
--     '0 5 * * *', -- Daily at 5 AM UTC (midnight EST)
--     $$SELECT reset_daily_hashtag_counts();$$
-- );

-- ============================================================================
-- MANAGEMENT FUNCTIONS
-- ============================================================================

-- Function to pause all trending cron jobs
CREATE OR REPLACE FUNCTION pause_trending_cron_jobs()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    job_names TEXT[] := ARRAY[
        'process-trending-queue',
        'reset-daily-hashtag-counts',
        'reset-weekly-hashtag-counts',
        'cleanup-trending-queue',
        'cleanup-old-trending-data',
        'cleanup-inactive-hashtags'
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

-- Function to resume all trending cron jobs
CREATE OR REPLACE FUNCTION resume_trending_cron_jobs()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    result TEXT := '';
    schedule_result TEXT;
BEGIN
    -- Re-create all the cron jobs using SELECT instead of PERFORM
    SELECT cron.schedule('process-trending-queue', '*/15 * * * *', 'SELECT process_trending_queue();') INTO schedule_result;
    SELECT cron.schedule('reset-daily-hashtag-counts', '0 0 * * *', 'SELECT reset_daily_hashtag_counts();') INTO schedule_result;
    SELECT cron.schedule('reset-weekly-hashtag-counts', '0 1 * * 0', 'SELECT reset_weekly_hashtag_counts();') INTO schedule_result;
    SELECT cron.schedule('cleanup-trending-queue', '0 2 * * *', 'SELECT cleanup_trending_queue();') INTO schedule_result;
    SELECT cron.schedule('cleanup-old-trending-data', '0 3 * * 0', 'SELECT cleanup_old_trending_data();') INTO schedule_result;
    SELECT cron.schedule('cleanup-inactive-hashtags', '0 4 1 * *', 'SELECT cleanup_inactive_hashtags();') INTO schedule_result;
    
    result := 'All trending cron jobs have been resumed';
    RETURN result;
END;
$$;

-- ============================================================================
-- TESTING AND VALIDATION
-- ============================================================================

-- Test the trending queue processing manually
-- SELECT process_trending_queue();

-- Check the queue status
-- SELECT * FROM trending_refresh_queue;

-- View current trending hashtags
-- SELECT * FROM get_trending_hashtags(10);

-- ============================================================================
-- NOTES FOR PRODUCTION
-- ============================================================================

/*
IMPORTANT PRODUCTION CONSIDERATIONS:

1. TIMEZONE: All cron schedules above use UTC. Adjust if you need local timezone.

2. FREQUENCY: The 15-minute frequency for trending updates is a good balance.
   - For high-traffic sites: Consider 5-10 minutes
   - For low-traffic sites: Consider 30-60 minutes

3. MONITORING: Set up alerts for failed cron jobs:
   - Monitor cron.job_run_details for failures
   - Set up notifications for stuck processing

4. RESOURCE USAGE: These operations are optimized but still use database resources:
   - Monitor database performance during peak hours
   - Consider running heavy cleanup operations during low-traffic periods

5. BACKUP CONSIDERATIONS: 
   - Daily/weekly resets modify many rows
   - Ensure your backup strategy accounts for this

6. SCALING: For very large instances (millions of hashtags):
   - Consider partitioning hashtags table by date
   - Implement gradual cleanup instead of bulk operations
   - Monitor and adjust batch sizes in the functions

7. SUPABASE SPECIFIC:
   - pg_cron runs in the same database as your application
   - Ensure your database plan supports the required compute for these operations
   - Consider upgrading to Pro plan for better performance monitoring
*/
