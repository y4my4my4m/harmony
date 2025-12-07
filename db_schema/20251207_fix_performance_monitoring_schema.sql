-- =============================================
-- Fix Performance Monitoring Schema Mismatches
-- This migration adds views and columns to match what the frontend expects
-- =============================================

-- =============================================
-- 1. Add rows_affected column to slow_queries
-- =============================================
ALTER TABLE "public"."slow_queries" 
ADD COLUMN IF NOT EXISTS "rows_affected" integer;

COMMENT ON COLUMN "public"."slow_queries"."rows_affected" IS 'Number of rows affected by the query (if applicable)';

-- =============================================
-- 2. Create view for performance_metrics_hourly with avg_latency
-- The frontend queries performance_metrics_hourly directly, so we need to either:
-- a) Rename the table and create a view with the old name, OR
-- b) Update the frontend to use a view
-- We'll create a view that can be queried, but the frontend will need to query the view
-- Actually, let's add the column directly to the table for simplicity
-- =============================================

-- Drop the view if it exists (in case of re-running)
DROP VIEW IF EXISTS "public"."performance_metrics_hourly_compat";

-- Add avg_latency as a regular column (will be NULL for existing rows, populated by aggregation function)
ALTER TABLE "public"."performance_metrics_hourly" 
ADD COLUMN IF NOT EXISTS "avg_latency" double precision;

-- Update existing rows to populate avg_latency from avg
UPDATE "public"."performance_metrics_hourly" 
SET "avg_latency" = "avg" 
WHERE "avg_latency" IS NULL;

-- Create a trigger function to keep avg_latency in sync with avg
CREATE OR REPLACE FUNCTION "public"."sync_avg_latency"()
RETURNS TRIGGER AS $$
BEGIN
    NEW.avg_latency := NEW.avg;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS "trigger_sync_avg_latency" ON "public"."performance_metrics_hourly";
CREATE TRIGGER "trigger_sync_avg_latency"
    BEFORE INSERT OR UPDATE ON "public"."performance_metrics_hourly"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."sync_avg_latency"();

COMMENT ON COLUMN "public"."performance_metrics_hourly"."avg_latency" IS 'Alias for avg column for frontend compatibility';

-- =============================================
-- 3. Add recorded_at column to slow_queries
-- =============================================
ALTER TABLE "public"."slow_queries" 
ADD COLUMN IF NOT EXISTS "recorded_at" timestamp with time zone;

-- Update existing rows to populate recorded_at from timestamp
UPDATE "public"."slow_queries" 
SET "recorded_at" = "timestamp" 
WHERE "recorded_at" IS NULL;

-- Create a trigger function to keep recorded_at in sync with timestamp
CREATE OR REPLACE FUNCTION "public"."sync_recorded_at"()
RETURNS TRIGGER AS $$
BEGIN
    NEW.recorded_at := NEW.timestamp;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS "trigger_sync_recorded_at" ON "public"."slow_queries";
CREATE TRIGGER "trigger_sync_recorded_at"
    BEFORE INSERT OR UPDATE ON "public"."slow_queries"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."sync_recorded_at"();

COMMENT ON COLUMN "public"."slow_queries"."recorded_at" IS 'Alias for timestamp column for frontend compatibility';

-- =============================================
-- 4. Create view for federation_health_metrics
-- The component expects individual request records, but we have aggregated health status
-- This view transforms the federation_health table to match expected structure
-- =============================================
CREATE OR REPLACE VIEW "public"."federation_health_metrics" AS
SELECT 
    id,
    timestamp as recorded_at,
    instance_domain as remote_domain,
    status,
    CASE 
        WHEN status = 'healthy' THEN true
        WHEN status = 'degraded' THEN true  -- Still consider degraded as success
        ELSE false
    END as success,
    avg_latency_ms as latency_ms,
    last_error,
    metadata->>'software_name' as software_name,
    metadata->>'software_version' as software_version,
    success_count,
    failure_count,
    last_success_at,
    last_failure_at
FROM "public"."federation_health";

GRANT SELECT ON "public"."federation_health_metrics" TO "authenticated";
GRANT SELECT ON "public"."federation_health_metrics" TO "service_role";

COMMENT ON VIEW "public"."federation_health_metrics" IS 'View of federation health transformed to match frontend expectations (individual request records)';

-- =============================================
-- 5. Add index on recorded_at for slow_queries
-- =============================================
CREATE INDEX IF NOT EXISTS "idx_slow_queries_recorded_at" 
ON "public"."slow_queries"("recorded_at" DESC);
