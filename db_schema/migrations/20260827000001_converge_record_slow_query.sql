-- record_slow_query exists in two shapes across live instances:
--
--   numeric,          RETURNS void, p_source DEFAULT 'unknown'   -- staging, and local
--   double precision, RETURNS uuid, p_source DEFAULT 'backend'   -- production, and local
--
-- CREATE OR REPLACE does not replace across a change of argument type, so an instance that
-- received both ends up carrying both. The two overloads take identical argument names, which
-- PostgREST cannot disambiguate: the RPC answers PGRST203 until one is dropped.
--
-- The baseline already carries the drop, but the migration ledger keys on the version prefix
-- with no checksum, so an instance that has already recorded 20260101000000 never replays it.
-- Converging an existing instance takes its own migration.
--
-- No-op on an instance that already holds only the double precision form.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.record_slow_query(numeric, text, text, text, jsonb, text, uuid, text);

CREATE OR REPLACE FUNCTION public.record_slow_query(
    p_duration_ms double precision,
    p_query_text text DEFAULT NULL,
    p_operation_type text DEFAULT NULL,
    p_table_name text DEFAULT NULL,
    p_parameters jsonb DEFAULT NULL,
    p_source text DEFAULT 'backend',
    p_user_id uuid DEFAULT NULL,
    p_request_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_id uuid;
    v_query_hash text;
BEGIN
    -- Digits collapse to '?' so parameterised variants of one statement share a hash.
    IF p_query_text IS NOT NULL THEN
        v_query_hash := md5(regexp_replace(p_query_text, '\d+', '?', 'g'));
    END IF;

    INSERT INTO public.slow_queries (
        duration_ms,
        query_text,
        query_hash,
        operation_type,
        table_name,
        parameters,
        source,
        user_id,
        request_id
    ) VALUES (
        p_duration_ms,
        p_query_text,
        v_query_hash,
        p_operation_type,
        p_table_name,
        p_parameters,
        p_source,
        p_user_id,
        p_request_id
    ) RETURNING id INTO v_id;

    PERFORM public.record_metric(
        'query_time',
        COALESCE(p_operation_type || '_' || p_table_name, 'unknown'),
        p_duration_ms,
        'ms',
        jsonb_build_object('slow', true, 'table', p_table_name),
        p_source
    );

    RETURN v_id;
END;
$$;

-- DROP takes the grants with it; restated so a converged instance matches production.
GRANT EXECUTE ON FUNCTION public.record_slow_query(double precision, text, text, text, jsonb, text, uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
