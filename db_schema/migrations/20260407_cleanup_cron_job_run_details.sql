-- =============================================================================
-- Housekeeping: purge cron run logs + drop unused pgboss schema
-- =============================================================================
-- 1. cron.job_run_details logs every pg_cron execution and grew to 189 MB.
--    Purge old rows and schedule daily cleanup so it never bloats again.
-- 2. The pgboss schema is leftover from before the BullMQ migration
--    (20260319). queue_federation_job() now uses pg_notify exclusively.
--    Nothing reads or writes pgboss tables anymore -- safe to drop.
-- =============================================================================

BEGIN;

-- 1a. Purge old cron run details (keep last 7 days for debugging)
DELETE FROM cron.job_run_details
WHERE end_time < now() - interval '7 days';

-- 1b. Schedule daily cleanup at 4 AM (idempotent)
-- NOTE: outer block uses the $do$ tag so the inner $$...$$ cron command string
-- does not prematurely terminate it.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('cleanup-cron-job-run-details'); EXCEPTION WHEN OTHERS THEN NULL; END;

    PERFORM cron.schedule(
      'cleanup-cron-job-run-details',
      '0 4 * * *',
      $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$$
    );

    RAISE NOTICE 'Scheduled daily cleanup of cron.job_run_details';
  END IF;
END $do$;

-- 2. Drop the unused pgboss schema (CASCADE drops all its tables/types)
DROP SCHEMA IF EXISTS pgboss CASCADE;

COMMIT;
