-- ---------------------------------------------------------------------------
-- Round-1 performance fixes - Part 1 of 2 (BUGS.md PH1 / B1).
--
-- This file reconciles the `bot_rate_limits` schema on already-deployed
-- environments. Transactional. Run through any standard migration tool
-- (Supabase CLI `db push`, sqitch, raw psql -f, etc.).
--
-- Part 2 (CONCURRENT index creation) is in the SIBLING file
--   20260520_perf_round1_indexes_concurrent.sql
-- and CANNOT be run through tools that wrap each migration in a single
-- transaction - see the header of that file for run instructions.
--
-- Background:
-- The init schema previously declared `bot_rate_limits` with columns
-- (`limit_max`, `remaining`, `resets_at`, `violations`, `last_violation_at`)
-- - none of which are used by the running gateway code in
-- `bot-gateway/src/auth/BotAuthMiddleware.ts:80-119`. That code reads/writes
-- (`request_count`, `window_start`, `window_duration_seconds`,
-- `max_requests`, `resets_at`, `metadata`) instead. Production
-- (db_schema/latest_dev_backup.sql:18834) already has the gateway-side
-- shape. A fresh install from the old init would create a table whose
-- columns the gateway can't read; the `catch` in `checkRateLimit()`
-- swallows the resulting error and returns `false`, so rate-limiting
-- fail-opens on every fresh install.
--
-- NOTE: This is one of two valid resolutions of the drift. The other is
-- to keep the init shape and rewrite `BotAuthMiddleware.ts` to use it
-- (see BUGS.md "B1 reconciliation choice"). This file picks the
-- conservative path: match what the running code uses today.
--
-- Idempotency:
-- Each ALTER is wrapped in IF NOT EXISTS / IF EXISTS or a DO-block
-- inspection of `information_schema.columns`, so re-running this file
-- is a no-op.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. Add the columns the gateway code reads/writes, only if absent.
ALTER TABLE public.bot_rate_limits
    ADD COLUMN IF NOT EXISTS request_count integer DEFAULT 0;

ALTER TABLE public.bot_rate_limits
    ADD COLUMN IF NOT EXISTS window_start timestamp with time zone DEFAULT now() NOT NULL;

ALTER TABLE public.bot_rate_limits
    ADD COLUMN IF NOT EXISTS window_duration_seconds integer DEFAULT 60;

ALTER TABLE public.bot_rate_limits
    ADD COLUMN IF NOT EXISTS max_requests integer DEFAULT 100;

ALTER TABLE public.bot_rate_limits
    ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- 2. Reconcile the expiry column: handle all four possible naming states.
DO $$
DECLARE
    has_reset boolean;
    has_resets boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'bot_rate_limits'
          AND column_name = 'reset_at'
    ) INTO has_reset;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'bot_rate_limits'
          AND column_name = 'resets_at'
    ) INTO has_resets;

    IF has_resets AND has_reset THEN
        RAISE NOTICE 'bot_rate_limits has both reset_at and resets_at; dropping stale reset_at';
        ALTER TABLE public.bot_rate_limits DROP COLUMN reset_at;
    ELSIF has_reset AND NOT has_resets THEN
        RAISE NOTICE 'Renaming bot_rate_limits.reset_at -> resets_at';
        ALTER TABLE public.bot_rate_limits RENAME COLUMN reset_at TO resets_at;
    ELSIF has_resets THEN
        RAISE NOTICE 'bot_rate_limits.resets_at already present; no rename needed';
    ELSE
        RAISE NOTICE 'Adding bot_rate_limits.resets_at';
        ALTER TABLE public.bot_rate_limits
            ADD COLUMN resets_at timestamp with time zone DEFAULT (now() + '00:01:00'::interval);
    END IF;
END $$;

-- 3. Drop obsolete columns from the old init shape. Unconditional
--    IF EXISTS so re-running this file is a no-op.
ALTER TABLE public.bot_rate_limits DROP COLUMN IF EXISTS limit_max;
ALTER TABLE public.bot_rate_limits DROP COLUMN IF EXISTS remaining;
ALTER TABLE public.bot_rate_limits DROP COLUMN IF EXISTS violations;
ALTER TABLE public.bot_rate_limits DROP COLUMN IF EXISTS last_violation_at;

-- 4. The old index referenced the renamed/dropped column. Drop it; the
--    sibling indexes file (Part 2) creates the correctly-named one.
DROP INDEX IF EXISTS public.idx_bot_rate_limits_reset;

COMMIT;

-- Reload PostgREST's schema cache before the long-running CONCURRENT
-- index builds in Part 2. Without this, PostgREST keeps serving the old
-- schema for the duration of the index builds and the gateway code hits
-- "column not found" on every rate-limit check.
NOTIFY pgrst, 'reload schema';
