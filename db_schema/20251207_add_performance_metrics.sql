-- =============================================
-- Performance Monitoring System
-- Track request latency, query times, federation health
-- Time-series data with automatic aggregation and cleanup
-- =============================================

-- =============================================
-- 1. Raw performance metrics table
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."performance_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "timestamp" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metric_type" "text" NOT NULL,
    "metric_name" "text" NOT NULL,
    "value" double precision NOT NULL,
    "unit" "text" DEFAULT 'ms'::text,
    "labels" "jsonb" DEFAULT '{}'::jsonb,
    "source" "text" DEFAULT 'unknown'::text,
    CONSTRAINT "performance_metrics_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "performance_metrics_type_check" CHECK ("metric_type" IN (
        'request_latency',
        'query_time',
        'federation_delivery',
        'queue_processing',
        'websocket_latency',
        'cache_hit_rate',
        'memory_usage',
        'cpu_usage',
        'error_rate',
        'custom'
    ))
);

ALTER TABLE "public"."performance_metrics" OWNER TO "postgres";

COMMENT ON TABLE "public"."performance_metrics" IS 'Raw performance metrics for monitoring';
COMMENT ON COLUMN "public"."performance_metrics"."metric_type" IS 'Type of metric for categorization';
COMMENT ON COLUMN "public"."performance_metrics"."metric_name" IS 'Specific metric name (e.g., GET_/api/messages)';
COMMENT ON COLUMN "public"."performance_metrics"."labels" IS 'Additional metadata/tags for filtering';
COMMENT ON COLUMN "public"."performance_metrics"."source" IS 'Source of metric: frontend, backend, federation-backend';

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS "idx_perf_metrics_timestamp" ON "public"."performance_metrics"("timestamp" DESC);
CREATE INDEX IF NOT EXISTS "idx_perf_metrics_type" ON "public"."performance_metrics"("metric_type", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "idx_perf_metrics_name" ON "public"."performance_metrics"("metric_name", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "idx_perf_metrics_labels" ON "public"."performance_metrics" USING GIN ("labels");

-- Partition by time for efficient data management (optional, for high-volume)
-- CREATE INDEX IF NOT EXISTS "idx_perf_metrics_time_range" ON "public"."performance_metrics"("timestamp") 
--   WHERE "timestamp" > NOW() - INTERVAL '7 days';

-- =============================================
-- 2. Aggregated metrics (hourly summaries)
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."performance_metrics_hourly" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hour" timestamp with time zone NOT NULL,
    "metric_type" "text" NOT NULL,
    "metric_name" "text" NOT NULL,
    "count" bigint DEFAULT 0,
    "sum" double precision DEFAULT 0,
    "min" double precision,
    "max" double precision,
    "avg" double precision,
    "p50" double precision,
    "p95" double precision,
    "p99" double precision,
    "labels" "jsonb" DEFAULT '{}'::jsonb,
    "source" "text" DEFAULT 'aggregation'::text,
    CONSTRAINT "performance_metrics_hourly_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "performance_metrics_hourly_unique" UNIQUE ("hour", "metric_type", "metric_name", "labels")
);

ALTER TABLE "public"."performance_metrics_hourly" OWNER TO "postgres";

COMMENT ON TABLE "public"."performance_metrics_hourly" IS 'Hourly aggregated performance metrics';

CREATE INDEX IF NOT EXISTS "idx_perf_hourly_hour" ON "public"."performance_metrics_hourly"("hour" DESC);
CREATE INDEX IF NOT EXISTS "idx_perf_hourly_type" ON "public"."performance_metrics_hourly"("metric_type", "hour" DESC);

-- =============================================
-- 3. Slow queries log
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."slow_queries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "timestamp" timestamp with time zone DEFAULT "now"() NOT NULL,
    "duration_ms" double precision NOT NULL,
    "query_text" "text",
    "query_hash" "text",
    "operation_type" "text",
    "table_name" "text",
    "parameters" "jsonb",
    "source" "text" DEFAULT 'backend'::text,
    "user_id" "uuid",
    "request_id" "text",
    CONSTRAINT "slow_queries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."slow_queries" OWNER TO "postgres";

COMMENT ON TABLE "public"."slow_queries" IS 'Log of slow database queries for optimization';
COMMENT ON COLUMN "public"."slow_queries"."query_hash" IS 'Hash of normalized query for grouping';
COMMENT ON COLUMN "public"."slow_queries"."duration_ms" IS 'Query execution time in milliseconds';

CREATE INDEX IF NOT EXISTS "idx_slow_queries_timestamp" ON "public"."slow_queries"("timestamp" DESC);
CREATE INDEX IF NOT EXISTS "idx_slow_queries_duration" ON "public"."slow_queries"("duration_ms" DESC);
CREATE INDEX IF NOT EXISTS "idx_slow_queries_hash" ON "public"."slow_queries"("query_hash");

-- =============================================
-- 4. Federation health metrics
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."federation_health" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "timestamp" timestamp with time zone DEFAULT "now"() NOT NULL,
    "instance_domain" "text" NOT NULL,
    "status" "text" DEFAULT 'unknown'::text,
    "last_success_at" timestamp with time zone,
    "last_failure_at" timestamp with time zone,
    "failure_count" integer DEFAULT 0,
    "success_count" integer DEFAULT 0,
    "avg_latency_ms" double precision,
    "last_error" "text",
    "metadata" "jsonb" DEFAULT '{}'::jsonb,
    CONSTRAINT "federation_health_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "federation_health_status_check" CHECK ("status" IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
    CONSTRAINT "federation_health_domain_unique" UNIQUE ("instance_domain")
);

ALTER TABLE "public"."federation_health" OWNER TO "postgres";

COMMENT ON TABLE "public"."federation_health" IS 'Health status of federated instances';

CREATE INDEX IF NOT EXISTS "idx_federation_health_domain" ON "public"."federation_health"("instance_domain");
CREATE INDEX IF NOT EXISTS "idx_federation_health_status" ON "public"."federation_health"("status");

-- =============================================
-- 5. Function to record a metric
-- =============================================
CREATE OR REPLACE FUNCTION "public"."record_metric"(
    p_metric_type text,
    p_metric_name text,
    p_value double precision,
    p_unit text DEFAULT 'ms',
    p_labels jsonb DEFAULT '{}'::jsonb,
    p_source text DEFAULT 'backend'
)
RETURNS uuid AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO "public"."performance_metrics" (
        metric_type, metric_name, value, unit, labels, source
    ) VALUES (
        p_metric_type, p_metric_name, p_value, p_unit, p_labels, p_source
    ) RETURNING id INTO v_id;
    
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- 6. Function to record a slow query
-- =============================================
CREATE OR REPLACE FUNCTION "public"."record_slow_query"(
    p_duration_ms double precision,
    p_query_text text DEFAULT NULL,
    p_operation_type text DEFAULT NULL,
    p_table_name text DEFAULT NULL,
    p_parameters jsonb DEFAULT NULL,
    p_source text DEFAULT 'backend',
    p_user_id uuid DEFAULT NULL,
    p_request_id text DEFAULT NULL
)
RETURNS uuid AS $$
DECLARE
    v_id uuid;
    v_query_hash text;
BEGIN
    -- Generate query hash (for grouping similar queries)
    IF p_query_text IS NOT NULL THEN
        v_query_hash := md5(regexp_replace(p_query_text, '\d+', '?', 'g'));
    END IF;
    
    INSERT INTO "public"."slow_queries" (
        duration_ms, query_text, query_hash, operation_type, 
        table_name, parameters, source, user_id, request_id
    ) VALUES (
        p_duration_ms, p_query_text, v_query_hash, p_operation_type,
        p_table_name, p_parameters, p_source, p_user_id, p_request_id
    ) RETURNING id INTO v_id;
    
    -- Also record as a metric
    PERFORM "public"."record_metric"(
        'query_time',
        COALESCE(p_operation_type || '_' || p_table_name, 'unknown'),
        p_duration_ms,
        'ms',
        jsonb_build_object('slow', true, 'table', p_table_name),
        p_source
    );
    
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- 7. Function to update federation health
-- =============================================
CREATE OR REPLACE FUNCTION "public"."update_federation_health"(
    p_instance_domain text,
    p_success boolean,
    p_latency_ms double precision DEFAULT NULL,
    p_error text DEFAULT NULL
)
RETURNS void AS $$
DECLARE
    v_current record;
BEGIN
    -- Get current record
    SELECT * INTO v_current FROM "public"."federation_health"
    WHERE instance_domain = p_instance_domain;
    
    IF v_current IS NULL THEN
        -- Create new record
        INSERT INTO "public"."federation_health" (
            instance_domain,
            status,
            last_success_at,
            last_failure_at,
            failure_count,
            success_count,
            avg_latency_ms,
            last_error
        ) VALUES (
            p_instance_domain,
            CASE WHEN p_success THEN 'healthy' ELSE 'unknown' END,
            CASE WHEN p_success THEN NOW() ELSE NULL END,
            CASE WHEN NOT p_success THEN NOW() ELSE NULL END,
            CASE WHEN NOT p_success THEN 1 ELSE 0 END,
            CASE WHEN p_success THEN 1 ELSE 0 END,
            p_latency_ms,
            p_error
        );
    ELSE
        -- Update existing record
        UPDATE "public"."federation_health"
        SET
            timestamp = NOW(),
            last_success_at = CASE WHEN p_success THEN NOW() ELSE last_success_at END,
            last_failure_at = CASE WHEN NOT p_success THEN NOW() ELSE last_failure_at END,
            failure_count = CASE WHEN NOT p_success THEN failure_count + 1 ELSE 0 END,
            success_count = CASE WHEN p_success THEN success_count + 1 ELSE success_count END,
            avg_latency_ms = CASE 
                WHEN p_latency_ms IS NOT NULL AND avg_latency_ms IS NOT NULL 
                    THEN (avg_latency_ms * success_count + p_latency_ms) / (success_count + 1)
                WHEN p_latency_ms IS NOT NULL 
                    THEN p_latency_ms
                ELSE avg_latency_ms
            END,
            last_error = CASE WHEN NOT p_success THEN p_error ELSE last_error END,
            status = CASE
                WHEN p_success AND failure_count = 0 THEN 'healthy'
                WHEN p_success AND failure_count < 3 THEN 'degraded'
                WHEN NOT p_success AND failure_count >= 5 THEN 'unhealthy'
                WHEN NOT p_success THEN 'degraded'
                ELSE status
            END
        WHERE instance_domain = p_instance_domain;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- 8. Function to aggregate hourly metrics
-- =============================================
CREATE OR REPLACE FUNCTION "public"."aggregate_hourly_metrics"()
RETURNS integer AS $$
DECLARE
    v_count integer := 0;
    v_hour timestamptz;
BEGIN
    -- Process the previous hour
    v_hour := date_trunc('hour', NOW() - INTERVAL '1 hour');
    
    -- Aggregate metrics
    INSERT INTO "public"."performance_metrics_hourly" (
        hour, metric_type, metric_name, count, sum, min, max, avg, labels, source
    )
    SELECT 
        v_hour,
        metric_type,
        metric_name,
        COUNT(*),
        SUM(value),
        MIN(value),
        MAX(value),
        AVG(value),
        labels,
        source
    FROM "public"."performance_metrics"
    WHERE timestamp >= v_hour AND timestamp < v_hour + INTERVAL '1 hour'
    GROUP BY metric_type, metric_name, labels, source
    ON CONFLICT (hour, metric_type, metric_name, labels) DO UPDATE SET
        count = EXCLUDED.count,
        sum = EXCLUDED.sum,
        min = EXCLUDED.min,
        max = EXCLUDED.max,
        avg = EXCLUDED.avg;
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- 9. Function to cleanup old metrics (retention)
-- =============================================
CREATE OR REPLACE FUNCTION "public"."cleanup_old_metrics"(
    p_raw_retention_days integer DEFAULT 7,
    p_hourly_retention_days integer DEFAULT 90,
    p_slow_query_retention_days integer DEFAULT 30
)
RETURNS jsonb AS $$
DECLARE
    v_raw_deleted integer;
    v_hourly_deleted integer;
    v_slow_deleted integer;
BEGIN
    -- Delete old raw metrics
    DELETE FROM "public"."performance_metrics"
    WHERE timestamp < NOW() - (p_raw_retention_days || ' days')::interval;
    GET DIAGNOSTICS v_raw_deleted = ROW_COUNT;
    
    -- Delete old hourly aggregates
    DELETE FROM "public"."performance_metrics_hourly"
    WHERE hour < NOW() - (p_hourly_retention_days || ' days')::interval;
    GET DIAGNOSTICS v_hourly_deleted = ROW_COUNT;
    
    -- Delete old slow queries
    DELETE FROM "public"."slow_queries"
    WHERE timestamp < NOW() - (p_slow_query_retention_days || ' days')::interval;
    GET DIAGNOSTICS v_slow_deleted = ROW_COUNT;
    
    RETURN jsonb_build_object(
        'raw_metrics_deleted', v_raw_deleted,
        'hourly_metrics_deleted', v_hourly_deleted,
        'slow_queries_deleted', v_slow_deleted
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- 10. View for latest metrics summary
-- =============================================
CREATE OR REPLACE VIEW "public"."metrics_summary_view" AS
SELECT 
    metric_type,
    metric_name,
    COUNT(*) as count_last_hour,
    AVG(value) as avg_value,
    MIN(value) as min_value,
    MAX(value) as max_value,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY value) as p95,
    source
FROM "public"."performance_metrics"
WHERE timestamp > NOW() - INTERVAL '1 hour'
GROUP BY metric_type, metric_name, source
ORDER BY avg_value DESC;

GRANT SELECT ON "public"."metrics_summary_view" TO "authenticated";
GRANT SELECT ON "public"."metrics_summary_view" TO "service_role";

-- =============================================
-- 11. View for slow queries summary
-- =============================================
CREATE OR REPLACE VIEW "public"."slow_queries_summary" AS
SELECT 
    query_hash,
    operation_type,
    table_name,
    COUNT(*) as occurrence_count,
    AVG(duration_ms) as avg_duration,
    MAX(duration_ms) as max_duration,
    MIN(timestamp) as first_seen,
    MAX(timestamp) as last_seen
FROM "public"."slow_queries"
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY query_hash, operation_type, table_name
ORDER BY AVG(duration_ms) DESC;

GRANT SELECT ON "public"."slow_queries_summary" TO "authenticated";
GRANT SELECT ON "public"."slow_queries_summary" TO "service_role";

-- =============================================
-- 12. Grant permissions
-- =============================================
GRANT ALL ON "public"."performance_metrics" TO "service_role";
GRANT SELECT ON "public"."performance_metrics" TO "authenticated";
GRANT ALL ON "public"."performance_metrics_hourly" TO "service_role";
GRANT SELECT ON "public"."performance_metrics_hourly" TO "authenticated";
GRANT ALL ON "public"."slow_queries" TO "service_role";
GRANT SELECT ON "public"."slow_queries" TO "authenticated";
GRANT ALL ON "public"."federation_health" TO "service_role";
GRANT SELECT ON "public"."federation_health" TO "authenticated";

GRANT EXECUTE ON FUNCTION "public"."record_metric"(text, text, double precision, text, jsonb, text) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."record_slow_query"(double precision, text, text, text, jsonb, text, uuid, text) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."update_federation_health"(text, boolean, double precision, text) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."aggregate_hourly_metrics"() TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."cleanup_old_metrics"(integer, integer, integer) TO "service_role";

-- =============================================
-- 13. RLS Policies (admin only for reads/writes)
-- =============================================
ALTER TABLE "public"."performance_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."performance_metrics_hourly" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."slow_queries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."federation_health" ENABLE ROW LEVEL SECURITY;

-- Drop existing policies first (makes script idempotent)
DROP POLICY IF EXISTS "Admins can read metrics" ON "public"."performance_metrics";
DROP POLICY IF EXISTS "Admins can read hourly metrics" ON "public"."performance_metrics_hourly";
DROP POLICY IF EXISTS "Admins can read slow queries" ON "public"."slow_queries";
DROP POLICY IF EXISTS "Admins can read federation health" ON "public"."federation_health";

-- Only admins can read performance metrics (contains sensitive system data)
CREATE POLICY "Admins can read metrics" ON "public"."performance_metrics"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."profiles"
            WHERE "profiles"."auth_user_id" = auth.uid()
            AND "profiles"."is_admin" = true
        )
    );

CREATE POLICY "Admins can read hourly metrics" ON "public"."performance_metrics_hourly"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."profiles"
            WHERE "profiles"."auth_user_id" = auth.uid()
            AND "profiles"."is_admin" = true
        )
    );

CREATE POLICY "Admins can read slow queries" ON "public"."slow_queries"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."profiles"
            WHERE "profiles"."auth_user_id" = auth.uid()
            AND "profiles"."is_admin" = true
        )
    );

CREATE POLICY "Admins can read federation health" ON "public"."federation_health"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."profiles"
            WHERE "profiles"."auth_user_id" = auth.uid()
            AND "profiles"."is_admin" = true
        )
    );

