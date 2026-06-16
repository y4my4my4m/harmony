-- =============================================================================
-- PROD access recovery: restore baseline role privileges missing on db.mony.lol
-- =============================================================================
-- Diagnostic (2026-06-15, prod vs staging) found prod is missing `USAGE` on
-- schema public for the `anon` role (staging has it). Without schema USAGE every
-- PostgREST request from an unauthenticated client -- the entire login/landing
-- page, and the brief pre-session window right after sign-in -- fails with
-- 401 / 42501 "permission denied for table ...". This is the root cause of the
-- login failures and "nothing loads".
--
-- `authenticated` / `service_role` USAGE is re-asserted defensively (idempotent;
-- prod already has it). Authenticated TABLE grants are intentionally curated on
-- prod and are NOT touched here.
--
-- anon also lacked SELECT on the public funding data the login/landing view
-- reads before authentication. Only world-public tables are granted to anon;
-- RLS still gates row visibility. Guarded so a table absent on this DB is
-- skipped rather than aborting. Idempotent and safe to re-run.
-- =============================================================================

BEGIN;

-- The critical fix: schema-level access for anonymous PostgREST callers.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Public landing/login data read by anonymous clients (anon was missing these).
DO $g$
DECLARE
  t text;
  public_anon_read text[] := ARRAY[
    'public.instance_funding',
    'public.instance_supporter_tiers',
    'public.instance_supporters',
    'public.instance_config'
  ];
BEGIN
  FOREACH t IN ARRAY public_anon_read LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON %s TO anon', t);
    ELSE
      RAISE NOTICE 'grants-recovery skipped missing table: %', t;
    END IF;
  END LOOP;
END
$g$;

NOTIFY pgrst, 'reload schema';

COMMIT;
