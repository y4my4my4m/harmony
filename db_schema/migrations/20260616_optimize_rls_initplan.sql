-- =============================================================================
-- Optimize RLS auth calls (perf advisor: auth_rls_initplan 0003)
-- =============================================================================
-- Supabase flags any RLS policy whose USING / WITH CHECK expression calls
-- auth.uid() / auth.role() / auth.jwt() directly, because the planner
-- re-evaluates them once PER ROW. Wrapping each call in a scalar subquery --
-- (select uid()) -- makes Postgres evaluate it ONCE per query (an InitPlan).
-- These functions are STABLE, so the wrapped form returns the identical value:
-- SEMANTICS-PRESERVING. No policy is added, dropped, or has its logic changed.
--
-- IMPORTANT: in this database the calls are stored UNQUALIFIED -- they render as
-- "uid()" / "role()" / "jwt()" (auth is in the search_path), NOT "auth.uid()".
-- The earlier version of this migration matched only "auth.uid()" and therefore
-- did NOTHING. This version matches the bare forms (and the qualified forms,
-- defensively) while refusing to touch anything else.
--
-- SAFETY DESIGN (read before running on prod):
--   * Transactional (BEGIN/COMMIT): any error rolls back EVERYTHING. No partial.
--   * No double-wrapping: a clause already containing "(select uid("/"(select
--     role("/"(select jwt(" is SKIPPED entirely, so re-running is a no-op and
--     no nesting can occur.
--   * Word-boundary match: the target must be preceded by a non-identifier,
--     non-dot character (or string start), so identifiers that merely CONTAIN
--     the substring are never touched -- e.g. get_current_profile_id(),
--     gen_random_uuid(), 'service_role', is_current_user_admin() are all safe.
--   * Qualified calls keep their qualifier: auth.uid() -> (select auth.uid());
--     a foreign-qualified call like foo.uid() is left untouched.
--   * current_setting() is intentionally NOT handled here (no public policy uses
--     it; the view-side cases are covered by security_invoker elsewhere).
--
-- RECOMMENDED ROLLOUT: run on local -> staging, confirm the app works AND the
-- advisor's auth_rls_initplan group clears, THEN run on prod (ideally off-peak;
-- ALTER POLICY briefly locks each touched table).
--
-- PREVIEW (no changes) -- run this first to see exactly what WOULD change:
--   SELECT schemaname, tablename, policyname,
--          regexp_replace(coalesce(qual,''),       '([^a-zA-Z0-9_.]|^)((auth\.)?(uid|role|jwt))\(\)', '\1(select \2())', 'g') AS new_using,
--          regexp_replace(coalesce(with_check,''), '([^a-zA-Z0-9_.]|^)((auth\.)?(uid|role|jwt))\(\)', '\1(select \2())', 'g') AS new_check
--   FROM pg_policies
--   WHERE schemaname='public'
--     AND ( (coalesce(qual,'')       ~* '([^a-zA-Z0-9_.]|^)(uid|role|jwt)\(\)' AND coalesce(qual,'')       !~* '\(\s*select\s+(auth\.)?(uid|role|jwt)\s*\(')
--        OR (coalesce(with_check,'') ~* '([^a-zA-Z0-9_.]|^)(uid|role|jwt)\(\)' AND coalesce(with_check,'') !~* '\(\s*select\s+(auth\.)?(uid|role|jwt)\s*\(') );
-- =============================================================================

BEGIN;

DO $do$
DECLARE
  r       record;
  newq    text;
  newc    text;
  stmt    text;
  n_done  integer := 0;
  -- match a uid()/role()/jwt() call (optionally auth.-qualified) that is NOT
  -- part of a larger identifier and NOT preceded by a dot
  re_find  constant text := '([^a-zA-Z0-9_.]|^)((auth\.)?(uid|role|jwt))\(\)';
  re_repl  constant text := '\1(select \2())';
  -- detects a clause that is ALREADY wrapped (skip it -> idempotent, no nesting)
  re_wrapped constant text := '\(\s*select\s+(auth\.)?(uid|role|jwt)\s*\(';
BEGIN
  FOR r IN
    SELECT n.nspname                                AS sch,
           c.relname                                AS tbl,
           pol.polname                              AS name,
           pg_get_expr(pol.polqual, pol.polrelid)      AS qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS withcheck
    FROM pg_policy pol
    JOIN pg_class     c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  LOOP
    newq := r.qual;
    newc := r.withcheck;

    -- USING: wrap only if it has a target AND is not already wrapped
    IF newq IS NOT NULL
       AND newq !~* re_wrapped
       AND newq ~* '([^a-zA-Z0-9_.]|^)(auth\.)?(uid|role|jwt)\(\)' THEN
      newq := regexp_replace(newq, re_find, re_repl, 'g');
    END IF;

    -- WITH CHECK: same treatment
    IF newc IS NOT NULL
       AND newc !~* re_wrapped
       AND newc ~* '([^a-zA-Z0-9_.]|^)(auth\.)?(uid|role|jwt)\(\)' THEN
      newc := regexp_replace(newc, re_find, re_repl, 'g');
    END IF;

    IF (newq IS DISTINCT FROM r.qual) OR (newc IS DISTINCT FROM r.withcheck) THEN
      stmt := format('ALTER POLICY %I ON %I.%I', r.name, r.sch, r.tbl);
      IF r.qual IS NOT NULL THEN
        stmt := stmt || format(' USING (%s)', newq);
      END IF;
      IF r.withcheck IS NOT NULL THEN
        stmt := stmt || format(' WITH CHECK (%s)', newc);
      END IF;
      EXECUTE stmt;
      n_done := n_done + 1;
      RAISE NOTICE 'Rewrote RLS policy %.% : %', r.sch, r.tbl, r.name;
    END IF;
  END LOOP;

  RAISE NOTICE 'auth_rls_initplan: wrapped % policies', n_done;
END
$do$;

COMMIT;
