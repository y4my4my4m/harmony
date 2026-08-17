-- ---------------------------------------------------------------------------
-- Atomic bot rate-limit RPC (BUGS.md B1 + M37).
--
-- This file replaces the racy read-modify-write pattern in
-- `bot-gateway/src/auth/BotAuthMiddleware.checkRateLimit()` with a single
-- atomic UPSERT-and-return RPC. Two concurrent calls for the same
-- (bot, bucket) can no longer both observe `request_count = N` and both
-- write `N + 1`; the ON CONFLICT DO UPDATE clause holds an exclusive row
-- lock for the duration of the CASE evaluation.
--
-- Schema decision: the existing `bot_rate_limits` columns
-- (`request_count`, `window_start`, `window_duration_seconds`,
-- `max_requests`, `resets_at`, `metadata`) are kept. The init shape's
-- alternative (`limit_max`, `remaining`, `violations`, `last_violation_at`)
-- was considered and rejected - see BUGS.md "B1 reconciliation choice".
-- Reasons: prod already has the kept shape, no destructive migration is
-- needed, the columns naturally support per-bucket overrides, and the
-- atomic-RPC approach hides the column shape behind one function call so
-- the cosmetic difference is irrelevant.
--
-- Safe to re-run: `CREATE OR REPLACE FUNCTION` replaces any prior
-- definition. The corresponding init script is
-- `db_schema/init/13_functions_rpc_extended.sql` (search for
-- `check_and_increment_bot_rate_limit`).
--
-- Run with: Supabase SQL editor, `psql -f`, or any standard migration
-- tool. This file is small and safely transactional.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION public.check_and_increment_bot_rate_limit(
    p_bot_id uuid,
    p_bucket text,
    p_limit integer DEFAULT 100,
    p_window_seconds integer DEFAULT 60
) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    INSERT INTO public.bot_rate_limits (
        bot_id, bucket,
        request_count, window_start, window_duration_seconds, max_requests, resets_at
    )
    VALUES (
        p_bot_id, p_bucket,
        1, NOW(), p_window_seconds, p_limit,
        NOW() + make_interval(secs => p_window_seconds)
    )
    ON CONFLICT (bot_id, bucket) DO UPDATE
        SET
            request_count = CASE
                WHEN public.bot_rate_limits.resets_at < NOW() THEN 1
                ELSE public.bot_rate_limits.request_count + 1
            END,
            window_start = CASE
                WHEN public.bot_rate_limits.resets_at < NOW() THEN NOW()
                ELSE public.bot_rate_limits.window_start
            END,
            window_duration_seconds = p_window_seconds,
            max_requests = p_limit,
            resets_at = CASE
                WHEN public.bot_rate_limits.resets_at < NOW() THEN NOW() + make_interval(secs => p_window_seconds)
                ELSE public.bot_rate_limits.resets_at
            END
    RETURNING request_count INTO v_count;

    RETURN v_count > p_limit;
END;
$$;

COMMENT ON FUNCTION public.check_and_increment_bot_rate_limit(uuid, text, integer, integer) IS
    'Atomic per-(bot, bucket) rate-limit check + increment. Returns true if the caller is rate-limited (HTTP 429), false otherwise. Fixes BUGS.md M37 race condition.';

GRANT EXECUTE ON FUNCTION public.check_and_increment_bot_rate_limit(uuid, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_increment_bot_rate_limit(uuid, text, integer, integer) TO service_role;

COMMIT;

-- Tell PostgREST about the new RPC so it shows up in the API immediately
-- (without waiting for the periodic schema cache poll).
NOTIFY pgrst, 'reload schema';
