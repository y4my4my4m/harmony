-- =============================================================================
-- Migration Tracking Table
-- =============================================================================
-- Tracks which migration files have been applied to this database.
-- Used by the SaaS update system to run only new migrations.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.harmony_applied_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.harmony_applied_migrations IS 'Tracks applied db_schema/migrations files for incremental updates';

DO $$ BEGIN
  RAISE NOTICE 'Migration tracking table ready';
END $$;
