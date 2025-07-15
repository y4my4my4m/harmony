-- Cleanup Migration: Remove deprecated delivery_queue tables and consolidate federation system
-- This migration removes the old delivery_queue table and delivery_queue_stats view
-- in favor of the newer federation_delivery_queue system

-- Drop the old delivery_queue_stats view if it exists
DROP VIEW IF EXISTS delivery_queue_stats CASCADE;

-- Drop the old delivery_queue table if it exists
-- This will also cascade to any dependent objects
DROP TABLE IF EXISTS delivery_queue CASCADE;

-- Verify that our current federation system is properly set up
-- This is a safety check to ensure we have the right tables and functions

-- Ensure federation_delivery_queue table exists with proper structure
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'federation_delivery_queue') THEN
        RAISE EXCEPTION 'federation_delivery_queue table does not exist! Migration cannot proceed.';
    END IF;
END $$;

-- Ensure federation_delivery_stats table exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'federation_delivery_stats') THEN
        RAISE EXCEPTION 'federation_delivery_stats table does not exist! Migration cannot proceed.';
    END IF;
END $$;

-- Ensure the delivery worker function exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'process_federation_delivery_queue'
        AND routine_type = 'FUNCTION'
    ) THEN
        RAISE EXCEPTION 'process_federation_delivery_queue function does not exist! Migration cannot proceed.';
    END IF;
END $$;

-- Ensure the cleanup function exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'cleanup_federation_delivery_queue'
        AND routine_type = 'FUNCTION'
    ) THEN
        RAISE EXCEPTION 'cleanup_federation_delivery_queue function does not exist! Migration cannot proceed.';
    END IF;
END $$;

-- Log the successful cleanup
DO $$
BEGIN
    RAISE NOTICE 'Successfully removed deprecated delivery_queue and delivery_queue_stats';
    RAISE NOTICE 'Federation system is now consolidated on federation_delivery_queue and federation_delivery_stats';
END $$;

-- Optional: Show current cron jobs status (requires pg_cron extension)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE NOTICE 'pg_cron extension is available. Current federation jobs should be visible in cron.job table';
        -- Note: Can't easily show results in migration, but jobs should be there
    ELSE
        RAISE NOTICE 'pg_cron extension not found. Make sure to run setup_federation_cron.sql after enabling pg_cron.';
    END IF;
END $$;
