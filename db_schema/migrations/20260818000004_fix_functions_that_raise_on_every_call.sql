-- Three functions that install cleanly and raise on every call.
--
-- plpgsql resolves column references at first execution, not at CREATE, so a body naming a
-- column its table does not have is accepted by the server and fails only when something
-- calls it. Nothing in this repo's gates could see these: the drift gate compares init/
-- against init/ plus migrations and both carry the same broken text, and
-- check-rpc-coverage.sh asks whether the name exists. Found by building a fresh database
-- from init/ and invoking every function in it.
--
-- 1. create_federated_emoji - broken on every instance including production.
--
--    RETURNS TABLE(id uuid, ...) declares an OUT parameter named id. Inside the body,
--    `SELECT owner_id FROM bots WHERE id = p_created_by` therefore cannot resolve id:
--
--      ERROR:  column reference "id" is ambiguous
--      DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
--    bot-gateway/src/api/BotRestAPI.ts:1602 is the bot emoji-creation endpoint; it returns
--    HTTP 500 with the raw Postgres message. Production's definition is character-identical
--    to init/, so this has never worked anywhere. Fixed by qualifying bots.id and
--    profiles.id; the RETURNING list was already qualified.
--
-- 2. cleanup_old_metrics - broken on fresh installs and staging, correct on production.
--
--    init/ deleted from public.slow_queries by created_at. The table has "timestamp" and
--    recorded_at, and no created_at, in every environment. The statement is the third of
--    three deletes, so raw and hourly metrics were pruned and slow queries silently never
--    were. Production's copy already says "timestamp"; this brings the rest into line.
--    Called from federation-backend/src/services/PerformanceMonitor.ts:388, which logs and
--    returns 0.
--
-- 3. aggregate_hourly_metrics - broken on fresh installs and staging, correct on production.
--
--    init/ inserted into sum_value/min_value/max_value/avg_value. The columns are named for
--    the aggregates - sum, min, max, avg - in production and in init/ alike. Hourly rollup
--    of performance metrics never produced a row on any instance built from init/. Called
--    from federation-backend/src/services/PerformanceMonitor.ts:367.
--
--    This one is guarded, because the two environments genuinely differ below the function.
--    init/ declares UNIQUE (hour, metric_type, metric_name, source); production declares
--    UNIQUE (hour, metric_type, metric_name, labels) and its function conflicts on labels
--    and groups by labels to match. Pushing init/'s version to production would raise
--    "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--    and turn a working rollup into a broken one. The guard tests for the source-based
--    constraint and skips where it is absent, so production keeps the version that fits its
--    table. Converging the constraint itself is a table change and is not attempted here.

BEGIN;

-- 1 ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_federated_emoji(
    p_name text,
    p_url text,
    p_created_by uuid,
    p_domain text DEFAULT NULL
)
RETURNS TABLE(id uuid, created_at timestamptz, name text, url text, server_id uuid, uploader uuid, domain text, scope text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    INSERT INTO emojis (name, url, uploader, domain, scope, server_id)
    VALUES (
        p_name,
        p_url,
        -- Qualified. RETURNS TABLE declares an OUT parameter named id, which otherwise
        -- shadows the table column: 42702, on every call.
        COALESCE(
            (SELECT owner_id FROM bots WHERE bots.id = p_created_by),
            CASE
                WHEN EXISTS (SELECT 1 FROM profiles WHERE profiles.id = p_created_by) THEN p_created_by
                ELSE NULL
            END
        ),
        p_domain,
        'instance',
        NULL
    )
    RETURNING emojis.id, emojis.created_at, emojis.name::text, emojis.url::text, emojis.server_id,
              emojis.uploader, emojis.domain, emojis.scope;
END;
$$;

-- 2 ---------------------------------------------------------------------------------------
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

    -- Delete old slow queries. The column is "timestamp"; slow_queries has no created_at.
    DELETE FROM public.slow_queries
    WHERE "timestamp" < now() - (p_slow_query_retention_days || ' days')::interval;
    GET DIAGNOSTICS v_slow_deleted = ROW_COUNT;

    RETURN jsonb_build_object(
        'raw_metrics_deleted', v_raw_deleted,
        'hourly_metrics_deleted', v_hourly_deleted,
        'slow_queries_deleted', v_slow_deleted
    );
END;
$$;

-- 3 ---------------------------------------------------------------------------------------
DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.performance_metrics_hourly'::regclass
           AND contype = 'u'
           AND (SELECT array_agg(attname::text ORDER BY attname::text)
                  FROM pg_attribute
                 WHERE attrelid = conrelid AND attnum = ANY(conkey))
               = ARRAY['hour','metric_name','metric_type','source']
    ) THEN
        RAISE NOTICE 'performance_metrics_hourly has no (hour, metric_type, metric_name, source) unique constraint; leaving aggregate_hourly_metrics as it stands';
        RETURN;
    END IF;

    EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.aggregate_hourly_metrics()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $body$
DECLARE
    v_count integer := 0;
BEGIN
    -- Aggregate metrics from the last hour
    INSERT INTO public.performance_metrics_hourly (
        hour,
        metric_type,
        metric_name,
        count,
        sum,
        min,
        max,
        avg,
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
        sum = EXCLUDED.sum,
        min = EXCLUDED.min,
        max = EXCLUDED.max,
        avg = EXCLUDED.avg;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$body$;
    $fn$;

    RAISE NOTICE 'aggregate_hourly_metrics rewritten against the aggregate-named columns';
END
$do$;

COMMIT;

NOTIFY pgrst, 'reload schema';
