-- =============================================================================
-- Harmony Database Schema - Performance & Admin Views
-- =============================================================================
-- Views for performance monitoring and admin dashboards
-- =============================================================================

-- ---------------------------------------------------------------------------
-- SLOW QUERIES TABLE - Track slow database queries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.slow_queries (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    
    -- Query details
    duration_ms double precision NOT NULL,
    query_text text,
    query_hash text,
    operation_type text,
    table_name text,
    parameters jsonb,
    
    -- Context
    source text DEFAULT 'backend'::text,
    user_id uuid,
    request_id text,
    rows_affected integer,
    recorded_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_slow_queries_timestamp ON public.slow_queries("timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_slow_queries_duration ON public.slow_queries(duration_ms DESC);
CREATE INDEX IF NOT EXISTS idx_slow_queries_table ON public.slow_queries(table_name);

COMMENT ON TABLE public.slow_queries IS 'Tracked slow database queries for performance analysis';

-- ---------------------------------------------------------------------------
-- FEDERATION HEALTH TABLE - Instance health status
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.federation_health (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    timestamp timestamp with time zone DEFAULT now() NOT NULL,
    
    -- UNIQUE constraint on domain for upsert operations
    instance_domain text NOT NULL UNIQUE,
    
    -- Status
    status text DEFAULT 'unknown'::text,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    
    -- Counts
    failure_count integer DEFAULT 0,
    success_count integer DEFAULT 0,
    
    -- Performance
    avg_latency_ms double precision,
    
    -- Error tracking
    last_error text,
    
    -- Metadata
    metadata jsonb DEFAULT '{}'::jsonb,
    
    CONSTRAINT federation_health_status_check CHECK (status IN ('healthy', 'degraded', 'unhealthy', 'unknown'))
);

ALTER TABLE public.federation_health REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_federation_health_timestamp ON public.federation_health(timestamp DESC);

COMMENT ON TABLE public.federation_health IS 'Health status of federated instances (one row per domain)';

-- ---------------------------------------------------------------------------
-- PERFORMANCE METRICS HOURLY - Aggregated hourly metrics
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.performance_metrics_hourly (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    hour timestamp with time zone NOT NULL,
    
    metric_type text NOT NULL,
    metric_name text NOT NULL,
    
    -- Aggregated values
    count bigint DEFAULT 0,
    sum double precision DEFAULT 0,
    min double precision,
    max double precision,
    avg double precision,
    p50 double precision,
    p95 double precision,
    p99 double precision,
    
    -- Labels aggregation
    labels jsonb DEFAULT '{}'::jsonb,
    source text DEFAULT 'aggregation'::text,
    avg_latency double precision,
    
    UNIQUE(hour, metric_type, metric_name, source)
);

CREATE INDEX IF NOT EXISTS idx_perf_metrics_hourly_hour ON public.performance_metrics_hourly(hour DESC);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_hourly_type ON public.performance_metrics_hourly(metric_type, metric_name);

COMMENT ON TABLE public.performance_metrics_hourly IS 'Hourly aggregated performance metrics';

-- ---------------------------------------------------------------------------
-- SLOW QUERIES SUMMARY VIEW
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.slow_queries_summary WITH (security_invoker = true) AS
SELECT 
    table_name,
    operation_type,
    count(*) AS query_count,
    avg(duration_ms) AS avg_duration_ms,
    max(duration_ms) AS max_duration_ms,
    min(duration_ms) AS min_duration_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_duration_ms,
    max("timestamp") AS last_seen
FROM public.slow_queries
WHERE "timestamp" > now() - interval '24 hours'
GROUP BY table_name, operation_type
ORDER BY avg(duration_ms) DESC;

COMMENT ON VIEW public.slow_queries_summary IS 'Summary of slow queries in the last 24 hours';

-- ---------------------------------------------------------------------------
-- METRICS SUMMARY VIEW
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.metrics_summary_view WITH (security_invoker = true) AS
SELECT 
    metric_type,
    metric_name,
    count(*) AS sample_count,
    avg(value) AS avg_value,
    max(value) AS max_value,
    min(value) AS min_value,
    source,
    max(timestamp) AS last_recorded
FROM public.performance_metrics
WHERE timestamp > now() - interval '1 hour'
GROUP BY metric_type, metric_name, source
ORDER BY count(*) DESC;

COMMENT ON VIEW public.metrics_summary_view IS 'Summary of performance metrics in the last hour';

-- ---------------------------------------------------------------------------
-- RPC FUNCTIONS FOR PERFORMANCE MONITORING
-- ---------------------------------------------------------------------------

-- Record slow query function
CREATE OR REPLACE FUNCTION public.record_slow_query(
    p_duration_ms numeric,
    p_query_text text DEFAULT NULL,
    p_operation_type text DEFAULT NULL,
    p_table_name text DEFAULT NULL,
    p_parameters jsonb DEFAULT NULL,
    p_source text DEFAULT 'unknown',
    p_user_id uuid DEFAULT NULL,
    p_request_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.slow_queries (
        duration_ms,
        query_text,
        operation_type,
        table_name,
        parameters,
        source,
        user_id,
        request_id
    ) VALUES (
        p_duration_ms,
        p_query_text,
        p_operation_type,
        p_table_name,
        p_parameters,
        p_source,
        p_user_id,
        p_request_id
    );
END;
$$;

-- Update federation health function
CREATE OR REPLACE FUNCTION public.touch_federated_instance(p_domain text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_domain text;
BEGIN
  v_domain := lower(btrim(p_domain));
  IF v_domain IS NULL OR v_domain = '' THEN
    RETURN;
  END IF;

  INSERT INTO public.federated_instances (
    domain,
    last_seen_at,
    updated_at
  )
  VALUES (
    v_domain,
    now(),
    now()
  )
  ON CONFLICT (domain) DO UPDATE
  SET last_seen_at = now(),
      updated_at = now();
END;
$$;

COMMENT ON FUNCTION public.touch_federated_instance(text)
IS 'Bump federated_instances.last_seen_at when federation traffic is observed. Auto-registers unknown domains.';

GRANT EXECUTE ON FUNCTION public.touch_federated_instance(text) TO service_role;

CREATE OR REPLACE FUNCTION public.update_federation_health(
    p_instance_domain text,
    p_success boolean,
    p_latency_ms numeric DEFAULT NULL,
    p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_domain text;
BEGIN
    v_domain := lower(btrim(p_instance_domain));
    IF v_domain IS NULL OR v_domain = '' THEN
        RETURN;
    END IF;

    -- Upsert federation health by instance_domain (UNIQUE constraint)
    INSERT INTO public.federation_health (
        instance_domain,
        status,
        last_success_at,
        last_failure_at,
        success_count,
        failure_count,
        avg_latency_ms,
        last_error
    ) VALUES (
        v_domain,
        CASE WHEN p_success THEN 'healthy' ELSE 'unhealthy' END,
        CASE WHEN p_success THEN now() ELSE NULL END,
        CASE WHEN NOT p_success THEN now() ELSE NULL END,
        CASE WHEN p_success THEN 1 ELSE 0 END,
        CASE WHEN NOT p_success THEN 1 ELSE 0 END,
        p_latency_ms,
        p_error
    )
    ON CONFLICT (instance_domain) DO UPDATE SET
        timestamp = now(),
        status = CASE
            WHEN p_success THEN 'healthy'
            ELSE 'unhealthy'
        END,
        last_success_at = CASE WHEN p_success THEN now() ELSE federation_health.last_success_at END,
        last_failure_at = CASE WHEN NOT p_success THEN now() ELSE federation_health.last_failure_at END,
        success_count = federation_health.success_count + CASE WHEN p_success THEN 1 ELSE 0 END,
        failure_count = CASE
            WHEN p_success THEN 0
            ELSE federation_health.failure_count + 1
        END,
        avg_latency_ms = CASE
            WHEN p_latency_ms IS NOT NULL AND federation_health.avg_latency_ms IS NOT NULL
            THEN (federation_health.avg_latency_ms + p_latency_ms) / 2
            ELSE COALESCE(p_latency_ms, federation_health.avg_latency_ms)
        END,
        last_error = CASE
            WHEN p_success THEN NULL
            ELSE COALESCE(p_error, federation_health.last_error)
        END;

    IF p_success THEN
        PERFORM public.touch_federated_instance(v_domain);
    END IF;
END;
$$;

-- Aggregate hourly metrics function
CREATE OR REPLACE FUNCTION public.aggregate_hourly_metrics()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count integer := 0;
BEGIN
    -- Aggregate metrics from the last hour
    INSERT INTO public.performance_metrics_hourly (
        hour,
        metric_type,
        metric_name,
        count,
        sum_value,
        min_value,
        max_value,
        avg_value,
        source
    )
    SELECT 
        date_trunc('hour', timestamp) AS hour,
        metric_type,
        metric_name,
        count(*),
        sum(value),
        min(value),
        max(value),
        avg(value),
        source
    FROM public.performance_metrics
    WHERE timestamp >= date_trunc('hour', now() - interval '1 hour')
      AND timestamp < date_trunc('hour', now())
    GROUP BY date_trunc('hour', timestamp), metric_type, metric_name, source
    ON CONFLICT (hour, metric_type, metric_name, source) DO UPDATE SET
        count = EXCLUDED.count,
        sum_value = EXCLUDED.sum_value,
        min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value,
        avg_value = EXCLUDED.avg_value;
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Cleanup old metrics function
CREATE OR REPLACE FUNCTION public.cleanup_old_metrics(
    p_raw_retention_days integer DEFAULT 7,
    p_hourly_retention_days integer DEFAULT 90,
    p_slow_query_retention_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_raw_deleted integer;
    v_hourly_deleted integer;
    v_slow_deleted integer;
BEGIN
    -- Delete old raw metrics
    DELETE FROM public.performance_metrics
    WHERE timestamp < now() - (p_raw_retention_days || ' days')::interval;
    GET DIAGNOSTICS v_raw_deleted = ROW_COUNT;
    
    -- Delete old hourly metrics
    DELETE FROM public.performance_metrics_hourly
    WHERE hour < now() - (p_hourly_retention_days || ' days')::interval;
    GET DIAGNOSTICS v_hourly_deleted = ROW_COUNT;
    
    -- Delete old slow queries
    DELETE FROM public.slow_queries
    WHERE created_at < now() - (p_slow_query_retention_days || ' days')::interval;
    GET DIAGNOSTICS v_slow_deleted = ROW_COUNT;
    
    RETURN jsonb_build_object(
        'raw_metrics_deleted', v_raw_deleted,
        'hourly_metrics_deleted', v_hourly_deleted,
        'slow_queries_deleted', v_slow_deleted
    );
END;
$$;

DO $$
BEGIN
    RAISE NOTICE 'Performance views and functions created successfully';
END $$;

