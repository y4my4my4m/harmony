-- =============================================================================
-- Optimize RLS auth calls (perf advisor: auth_rls_initplan 0003)
-- =============================================================================
-- Supabase flags any RLS policy whose USING / WITH CHECK expression calls
-- auth.uid() / auth.role() / auth.jwt() / current_setting() directly, because
-- the planner re-evaluates them once PER ROW. Wrapping each call in a scalar
-- subquery -- (select auth.uid()) -- makes Postgres evaluate it ONCE per query
-- (an InitPlan) and cache the result.
--
-- These functions are all STABLE within a statement, so the wrapped form returns
-- the identical value. This rewrite is SEMANTICS-PRESERVING: same access rules,
-- fewer evaluations. No policy is added, dropped, or has its logic changed.
--
-- Why programmatic (not hand-written DROP/CREATE):
--   * prod policy NAMES have drifted from db_schema/init, so name-keyed edits
--     would miss the legacy-named policies that actually carry the warnings.
--   * This loops over pg_policy and rewrites whatever exists, in place, via
--     ALTER POLICY -- so it self-heals drift on every environment.
--
-- Safety:
--   * Wrapped in BEGIN/COMMIT -> all-or-nothing. A bad rewrite aborts the whole
--     migration with no partial changes.
--   * Idempotent: a policy whose expression already contains "(select auth..."
--     / "(select current_setting..." is skipped, so re-running is a no-op.
--   * Only touches schema public.
--
-- RECOMMENDED ROLLOUT: run on local/staging first, confirm the app works AND the
-- advisor warnings clear, THEN run on prod.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  r     record;
  newq  text;
  newc  text;
  stmt  text;
BEGIN
  FOR r IN
    SELECT n.nspname                               AS sch,
           c.relname                               AS tbl,
           pol.polname                             AS name,
           pg_get_expr(pol.polqual, pol.polrelid)      AS qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS withcheck
    FROM pg_policy pol
    JOIN pg_class     c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  LOOP
    newq := r.qual;
    newc := r.withcheck;

    -- USING expression
    IF newq IS NOT NULL THEN
      IF newq !~* '\(\s*select\s+auth\.' THEN
        newq := regexp_replace(newq, 'auth\.(uid|role|jwt)\s*\(\s*\)', '(select auth.\1())', 'gi');
      END IF;
      IF newq !~* '\(\s*select\s+current_setting' THEN
        newq := regexp_replace(newq, 'current_setting\s*\(([^)]*)\)', '(select current_setting(\1))', 'gi');
      END IF;
    END IF;

    -- WITH CHECK expression
    IF newc IS NOT NULL THEN
      IF newc !~* '\(\s*select\s+auth\.' THEN
        newc := regexp_replace(newc, 'auth\.(uid|role|jwt)\s*\(\s*\)', '(select auth.\1())', 'gi');
      END IF;
      IF newc !~* '\(\s*select\s+current_setting' THEN
        newc := regexp_replace(newc, 'current_setting\s*\(([^)]*)\)', '(select current_setting(\1))', 'gi');
      END IF;
    END IF;

    -- Only issue ALTER when something actually changed.
    IF (newq IS DISTINCT FROM r.qual) OR (newc IS DISTINCT FROM r.withcheck) THEN
      stmt := format('ALTER POLICY %I ON %I.%I', r.name, r.sch, r.tbl);
      -- Re-emit only the clauses the policy originally had.
      IF r.qual IS NOT NULL THEN
        stmt := stmt || format(' USING (%s)', newq);
      END IF;
      IF r.withcheck IS NOT NULL THEN
        stmt := stmt || format(' WITH CHECK (%s)', newc);
      END IF;
      EXECUTE stmt;
      RAISE NOTICE 'Rewrote RLS policy %.% -> %', r.sch, r.tbl, r.name;
    END IF;
  END LOOP;
END
$$;

COMMIT;
