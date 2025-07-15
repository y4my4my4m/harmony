-- Federation Delivery Queue Cron Job
-- This creates a periodic job to process pending deliveries automatically

-- Enable the pg_cron extension if not already enabled
SELECT cron.schedule(
    'federation-delivery-worker',
    '*/2 * * * *', -- Every 2 minutes
    $$
    SELECT process_federation_delivery_queue();
    $$
);

-- Also create a cleanup job to run daily
SELECT cron.schedule(
    'federation-cleanup',
    '0 2 * * *', -- Daily at 2 AM
    $$
    SELECT cleanup_federation_delivery_queue();
    $$
);

-- Monitor federation health with a stats job
SELECT cron.schedule(
    'federation-stats',
    '0 */6 * * *', -- Every 6 hours
    $$
    SELECT collect_federation_stats();
    $$
);

-- Create federation_delivery_stats table if it doesn't exist
CREATE TABLE IF NOT EXISTS federation_delivery_stats (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    total_deliveries INTEGER DEFAULT 0,
    successful_deliveries INTEGER DEFAULT 0,
    failed_deliveries INTEGER DEFAULT 0,
    avg_delivery_time_ms NUMERIC,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_federation_delivery_stats_period 
ON federation_delivery_stats(period_start, period_end);
