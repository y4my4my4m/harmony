BEGIN;

-- =============================================================================
-- Fix federation_health_metrics view (references non-existent columns)
-- =============================================================================
-- The view in 70_views.sql referenced federated_instances columns (is_silenced,
-- last_successful_sync, etc.) that don't exist. The production schema uses the
-- federation_health table from 71_views_performance.sql instead.
-- =============================================================================

-- Ensure federation_health table exists (from 71_views_performance.sql)
CREATE TABLE IF NOT EXISTS public.federation_health (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    timestamp timestamp with time zone DEFAULT now() NOT NULL,
    instance_domain text NOT NULL UNIQUE,
    status text DEFAULT 'unknown'::text,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    failure_count integer DEFAULT 0,
    success_count integer DEFAULT 0,
    avg_latency_ms double precision,
    last_error text,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT federation_health_status_check CHECK (status IN ('healthy', 'degraded', 'unhealthy', 'unknown'))
);

ALTER TABLE public.federation_health REPLICA IDENTITY FULL;
CREATE INDEX IF NOT EXISTS idx_federation_health_timestamp ON public.federation_health(timestamp DESC);

-- DROP first because CREATE OR REPLACE cannot change column list of an existing view
DROP VIEW IF EXISTS public.federation_health_metrics;
CREATE OR REPLACE VIEW public.federation_health_metrics AS
SELECT 
    fh.id,
    fh.timestamp AS recorded_at,
    fh.instance_domain AS remote_domain,
    fh.status,
    CASE
        WHEN fh.status = 'healthy' THEN true
        WHEN fh.status = 'degraded' THEN true
        ELSE false
    END AS success,
    fh.avg_latency_ms AS latency_ms,
    fh.last_error,
    (fh.metadata ->> 'software_name') AS software_name,
    (fh.metadata ->> 'software_version') AS software_version,
    fh.success_count,
    fh.failure_count,
    fh.last_success_at,
    fh.last_failure_at
FROM public.federation_health fh;

COMMENT ON VIEW public.federation_health_metrics
    IS 'View of federation health transformed to match frontend expectations';

-- Ensure update_federation_health function exists
CREATE OR REPLACE FUNCTION public.update_federation_health(
    p_instance_domain text,
    p_success boolean,
    p_latency_ms numeric DEFAULT NULL,
    p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO public.federation_health (
        instance_domain, status, last_success_at, last_failure_at,
        success_count, failure_count, avg_latency_ms, last_error
    ) VALUES (
        p_instance_domain,
        CASE WHEN p_success THEN 'healthy' ELSE 'unhealthy' END,
        CASE WHEN p_success THEN now() ELSE NULL END,
        CASE WHEN NOT p_success THEN now() ELSE NULL END,
        CASE WHEN p_success THEN 1 ELSE 0 END,
        CASE WHEN NOT p_success THEN 1 ELSE 0 END,
        p_latency_ms, p_error
    )
    ON CONFLICT (instance_domain) DO UPDATE SET
        timestamp = now(),
        status = CASE 
            WHEN p_success AND federation_health.failure_count = 0 THEN 'healthy'
            WHEN p_success THEN 'degraded'
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
        last_error = COALESCE(p_error, federation_health.last_error);
END;
$$;

-- =============================================================================
-- Fix federated_instances RLS: add INSERT/UPDATE/DELETE for authenticated users
-- =============================================================================

DROP POLICY IF EXISTS "federated_instances_manage" ON public.federated_instances;
CREATE POLICY "federated_instances_manage" ON public.federated_instances
    FOR ALL USING (auth.uid() IS NOT NULL);

-- Also ensure federation_health has RLS
ALTER TABLE public.federation_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "federation_health_select_all" ON public.federation_health;
CREATE POLICY "federation_health_select_all" ON public.federation_health
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "federation_health_manage" ON public.federation_health;
CREATE POLICY "federation_health_manage" ON public.federation_health
    FOR ALL USING (auth.uid() IS NOT NULL);

COMMIT;
