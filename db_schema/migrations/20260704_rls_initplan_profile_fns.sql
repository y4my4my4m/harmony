-- =============================================================================
-- Optimize RLS profile-helper calls (same treatment as 20260616_optimize_rls_initplan)
-- =============================================================================
-- 20260616_optimize_rls_initplan.sql wrapped auth.uid()/role()/jwt() in scalar
-- subqueries so the planner evaluates them ONCE per query (InitPlan) instead
-- of once PER ROW. But most Harmony policies gate on our own helpers instead:
--   get_current_profile_id()        (SELECT on profiles per evaluation!)
--   get_current_user_profile_id()
--   is_current_user_admin()
--   is_current_user_moderator()
-- Called bare inside a policy these re-run per row - and unlike auth.uid(),
-- each evaluation is a real table lookup, so the per-row tax is much worse.
-- All four are STABLE and zero-argument, so (select fn()) returns the
-- identical value: SEMANTICS-PRESERVING. No policy is added, dropped, or has
-- its logic changed.
--
-- SAFETY DESIGN (mirrors 20260616_optimize_rls_initplan.sql):
--   * Transactional (BEGIN/COMMIT): any error rolls back EVERYTHING.
--   * No double-wrapping: a clause already containing "(select fn(" for any
--     target is SKIPPED entirely, so re-running is a no-op, no nesting.
--   * Word-boundary match: the target must be preceded by a non-identifier,
--     non-dot character (or string start). Identifiers merely containing the
--     substring are never touched; foo.get_current_profile_id() is left alone
--     (only the optional public. qualifier is recognized).
--
-- RECOMMENDED ROLLOUT: local -> staging -> prod off-peak (ALTER POLICY briefly
-- locks each touched table).
--
-- PREVIEW (no changes) - run first to see what WOULD change:
--   SELECT schemaname, tablename, policyname,
--          regexp_replace(coalesce(qual,''),       '([^a-zA-Z0-9_.]|^)((public\.)?(get_current_profile_id|get_current_user_profile_id|is_current_user_admin|is_current_user_moderator))\(\)', '\1(select \2())', 'g') AS new_using,
--          regexp_replace(coalesce(with_check,''), '([^a-zA-Z0-9_.]|^)((public\.)?(get_current_profile_id|get_current_user_profile_id|is_current_user_admin|is_current_user_moderator))\(\)', '\1(select \2())', 'g') AS new_check
--   FROM pg_policies
--   WHERE schemaname='public'
--     AND ( coalesce(qual,'')       ~* '([^a-zA-Z0-9_.]|^)(public\.)?(get_current_profile_id|get_current_user_profile_id|is_current_user_admin|is_current_user_moderator)\(\)'
--        OR coalesce(with_check,'') ~* '([^a-zA-Z0-9_.]|^)(public\.)?(get_current_profile_id|get_current_user_profile_id|is_current_user_admin|is_current_user_moderator)\(\)' );
-- =============================================================================

BEGIN;

DO $do$
DECLARE
  r       record;
  newq    text;
  newc    text;
  stmt    text;
  n_done  integer := 0;
  -- match a helper call (optionally public.-qualified) that is NOT part of a
  -- larger identifier and NOT preceded by a dot
  re_find  constant text := '([^a-zA-Z0-9_.]|^)((public\.)?(get_current_profile_id|get_current_user_profile_id|is_current_user_admin|is_current_user_moderator))\(\)';
  re_repl  constant text := '\1(select \2())';
  -- detects a clause that is ALREADY wrapped (skip it -> idempotent, no nesting)
  re_wrapped constant text := '\(\s*select\s+(public\.)?(get_current_profile_id|get_current_user_profile_id|is_current_user_admin|is_current_user_moderator)\s*\(';
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
       AND newq ~* re_find THEN
      newq := regexp_replace(newq, re_find, re_repl, 'g');
    END IF;

    -- WITH CHECK: same treatment
    IF newc IS NOT NULL
       AND newc !~* re_wrapped
       AND newc ~* re_find THEN
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

  RAISE NOTICE 'profile_fns_rls_initplan: wrapped % policies', n_done;
END
$do$;

COMMIT;
