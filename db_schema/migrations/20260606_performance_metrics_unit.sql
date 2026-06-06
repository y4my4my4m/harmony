-- Add the missing `unit` column to performance_metrics.
--
-- The federation worker (PerformanceMonitor) and the record_performance_metric()
-- RPC both write a `unit` (e.g. 'ms', 'count', 'bytes'), but the init table
-- definition (06_tables_misc.sql) historically omitted the column. On instances
-- deployed from that init, the worker fails every flush with:
--   "Could not find the 'unit' column of 'performance_metrics' in the schema cache"
--
-- Idempotent: safe to run repeatedly.
BEGIN;

ALTER TABLE public.performance_metrics
    ADD COLUMN IF NOT EXISTS unit text;

COMMENT ON COLUMN public.performance_metrics.unit IS
    'Unit of `value` (e.g. ms, count, bytes). Written by the federation worker and record_performance_metric().';

COMMIT;

-- Tell PostgREST to reload its schema cache so the new column is visible to the
-- worker immediately (otherwise it can take up to ~10 minutes).
NOTIFY pgrst, 'reload schema';
