-- =============================================================================
-- Harmony Database Schema - Scheduled Jobs (pg_cron)
-- =============================================================================
-- Sets up recurring cron jobs for trending updates, hashtag maintenance, etc.
-- Requires pg_cron extension (enabled in 00_extensions.sql).
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Unschedule first for idempotency
    BEGIN PERFORM cron.unschedule('update-trending-posts'); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN PERFORM cron.unschedule('update-hashtag-scores'); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN PERFORM cron.unschedule('reset-daily-hashtag-counters'); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN PERFORM cron.unschedule('cleanup-cron-job-run-details'); EXCEPTION WHEN OTHERS THEN NULL; END;

    -- Recompute trending_posts every 15 minutes
    PERFORM cron.schedule(
      'update-trending-posts',
      '*/15 * * * *',
      'SELECT public.update_trending_posts()'
    );

    -- Recompute hashtag trending_score every hour
    PERFORM cron.schedule(
      'update-hashtag-scores',
      '0 * * * *',
      'SELECT public.update_hashtag_trending_scores()'
    );

    -- Reset daily hashtag counters at midnight
    PERFORM cron.schedule(
      'reset-daily-hashtag-counters',
      '0 0 * * *',
      'SELECT public.reset_daily_hashtag_counters()'
    );

    -- Purge cron run logs older than 7 days (prevents unbounded growth)
    PERFORM cron.schedule(
      'cleanup-cron-job-run-details',
      '0 4 * * *',
      $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$$
    );

    RAISE NOTICE 'pg_cron jobs scheduled for trending updates';
  ELSE
    RAISE NOTICE 'pg_cron not available - trending updates must be triggered manually or via external scheduler';
  END IF;
END $$;
