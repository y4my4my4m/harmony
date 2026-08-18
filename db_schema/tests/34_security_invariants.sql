-- Catalog-level invariants.
--
-- Every other test file names the object it checks, so it covers whatever the
-- author remembered. These are derived from pg_catalog instead: each one holds
-- over every function, policy or table at once, and a new object that repeats an
-- old defect fails here without anyone extending a list.
--
-- Each assertion is preceded by a guard on the population it scans. A derivation
-- that silently matches nothing passes every emptiness check, which is the one
-- failure mode a catalog test cannot see from the inside.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(17);

-- SECURITY DEFINER search_path ------------------------------------------------
-- A SECURITY DEFINER function runs with the owner's privileges and resolves
-- unqualified names against the caller's search_path. A caller who prepends a
-- schema they can write shadows any unqualified table or function the body
-- touches and the shadowed object runs as the owner. `SET search_path` in the
-- declaration pins resolution at definition time and appears in proconfig.
SELECT cmp_ok((SELECT count(*) FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.prosecdef),
              '>=', 250::bigint,
              'the catalog scan still sees the SECURITY DEFINER population');

SELECT is_empty(
    $q$SELECT p.oid::regprocedure::text AS unpinned_definer
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosecdef
          AND NOT coalesce(
                (SELECT true FROM unnest(p.proconfig) c WHERE c LIKE 'search\_path=%'),
                false)
        ORDER BY 1$q$,
    'every SECURITY DEFINER function in public pins its search_path');

-- Bare helper calls in policy expressions -------------------------------------
-- get_current_profile_id(), is_current_user_admin(), is_current_user_moderator()
-- and auth.uid() depend only on the session, not on the row. Written bare in a
-- policy the planner treats them as ordinary function calls in the qual and
-- evaluates them once per row scanned; wrapped as `(SELECT f())` they become an
-- InitPlan evaluated once per statement.
--
-- pg_get_expr renders a wrapped call as `( SELECT f() AS f)`. Deleting every
-- `SELECT f()` therefore leaves only the bare occurrences behind.
CREATE OR REPLACE FUNCTION pg_temp.calls_helper_bare(p_expr text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT r ~ '(^|[^[:alnum:]_.])(public\.)?(get_current_profile_id|is_current_user_admin|is_current_user_moderator)\(\)'
      OR r ~ '(^|[^[:alnum:]_.])auth\.uid\(\)'
    FROM (
      SELECT regexp_replace(
               coalesce(p_expr, ''),
               'SELECT[[:space:]]+((public\.)?(get_current_profile_id|is_current_user_admin|is_current_user_moderator)|auth\.uid)\(\)',
               '', 'g') AS r
    ) s;
$fn$;

SELECT is(pg_temp.calls_helper_bare('(user_id = get_current_profile_id())'), true,
          'the bare-call detector flags an unwrapped get_current_profile_id()');
SELECT is(pg_temp.calls_helper_bare(
            '(user_id = ( SELECT get_current_profile_id() AS get_current_profile_id))'), false,
          'the bare-call detector clears the scalar-subquery form');
SELECT is(pg_temp.calls_helper_bare('(auth_user_id = auth.uid())'), true,
          'the bare-call detector flags an unwrapped auth.uid()');

SELECT cmp_ok((SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
              '>=', 250::bigint,
              'the catalog scan still sees the policy population');

SELECT is_empty(
    $q$SELECT tablename, policyname
         FROM pg_policies
        WHERE schemaname = 'public'
          AND (pg_temp.calls_helper_bare(qual) OR pg_temp.calls_helper_bare(with_check))
        ORDER BY 1, 2$q$,
    'no policy calls a session helper outside a scalar subquery');

-- RLS enabled with no policy --------------------------------------------------
-- RLS with no policy is a deny-all: every command returns zero rows for every
-- role except one holding BYPASSRLS or owning the table. Nothing raises, so the
-- table reads as permanently empty.
--
-- Four tables are deny-all on purpose. They are written by federation-backend
-- and the cron jobs, both of which connect as service_role and bypass RLS, and
-- no client path selects from them. Any fifth table joining them is an outage.
SELECT cmp_ok((SELECT count(*) FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
                 AND c.relrowsecurity),
              '>=', 100::bigint,
              'the catalog scan still sees the RLS-enabled table population');

SELECT is_empty(
    $q$SELECT c.relname AS rls_without_policy
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relrowsecurity
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
          AND c.relname NOT IN ('activity_processing_logs',
                                'activitypub_processing_stats',
                                'federation_delivery_stats',
                                'files')
        ORDER BY 1$q$,
    'no table has RLS enabled without a policy beyond the service-role-only four');

-- FOR ALL, TO PUBLIC, no WITH CHECK -------------------------------------------
-- A policy with no WITH CHECK reuses its USING expression as the write check,
-- evaluated against the NEW row. With FOR ALL and no TO clause that one
-- expression governs SELECT, INSERT, UPDATE and DELETE for every role holding
-- the table grant.
--
-- The shape itself is common and correct here: 28 policies use it, and each
-- constrains the row to the caller. What made "System can manage federated
-- profiles" a takeover was a top-level OR branch carrying no identity test at
-- all -- USING ((is_local = false) OR (auth_user_id = auth.uid())) -- since
-- permissive disjuncts widen, and the first branch admits every remote profile
-- for UPDATE and DELETE.
--
-- Splitting on OR at paren depth zero is what separates that from a policy whose
-- ORs sit under an AND. Parenthesis counting ignores string literals; no policy
-- expression in this schema contains a parenthesis inside a literal, and a
-- miscount would merge branches rather than invent one.
CREATE OR REPLACE FUNCTION pg_temp.or_branches(p_expr text)
RETURNS SETOF text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  s        text := btrim(coalesce(p_expr, ''));
  depth    int;
  i        int;
  close_at int;
  start    int;
  ch       text;
BEGIN
  -- Strip enclosing parens until the leading one no longer closes at the end.
  LOOP
    EXIT WHEN length(s) < 2 OR left(s, 1) <> '(';
    depth := 0; close_at := 0;
    FOR i IN 1..length(s) LOOP
      ch := substr(s, i, 1);
      IF ch = '(' THEN depth := depth + 1;
      ELSIF ch = ')' THEN
        depth := depth - 1;
        IF depth = 0 THEN close_at := i; EXIT; END IF;
      END IF;
    END LOOP;
    EXIT WHEN close_at <> length(s);
    s := btrim(substr(s, 2, length(s) - 2));
  END LOOP;

  depth := 0; start := 1; i := 1;
  WHILE i <= length(s) LOOP
    ch := substr(s, i, 1);
    IF ch = '(' THEN depth := depth + 1;
    ELSIF ch = ')' THEN depth := depth - 1;
    ELSIF depth = 0 AND upper(substr(s, i, 4)) = ' OR '
          AND (i = 1 OR substr(s, i - 1, 1) !~ '[[:alnum:]_]') THEN
      RETURN NEXT btrim(substr(s, start, i - start));
      start := i + 4;
      i := i + 3;
    END IF;
    i := i + 1;
  END LOOP;
  RETURN NEXT btrim(substr(s, start));
END;
$fn$;

-- An identity predicate is any call that reads who is asking. A branch without
-- one grants on row content alone.
CREATE OR REPLACE FUNCTION pg_temp.branch_unguarded(p_expr text)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM pg_temp.or_branches(p_expr) AS b(branch)
     WHERE branch !~ 'auth\.(uid|role|jwt)\(\)'
       AND branch !~ '(^|[^[:alnum:]_.])(public\.)?(get_current_profile_id|is_current_user_[a-z_]+|current_user_[a-z_]+)\('
  );
$fn$;

SELECT is(pg_temp.branch_unguarded(
            '((is_local = false) OR (auth_user_id = ( SELECT auth.uid() AS uid)))'), true,
          'the branch detector flags the qual that made federated profiles writable');
SELECT is(pg_temp.branch_unguarded(
            '((auth_user_id = ( SELECT auth.uid() AS uid)))'), false,
          'the branch detector clears a qual whose every branch tests identity');

SELECT cmp_ok((SELECT count(*) FROM pg_policy p
                JOIN pg_class c ON c.oid = p.polrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND p.polcmd = '*'
                 AND p.polwithcheck IS NULL AND p.polroles = '{0}'),
              '>=', 20::bigint,
              'the catalog scan still sees the FOR ALL / TO PUBLIC / no-WITH-CHECK population');

SELECT is_empty(
    $q$SELECT c.relname AS tbl, p.polname AS policy, b.branch
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL pg_temp.or_branches(pg_get_expr(p.polqual, p.polrelid)) AS b(branch)
        WHERE n.nspname = 'public'
          AND p.polcmd = '*'
          AND p.polwithcheck IS NULL
          AND p.polroles = '{0}'
          AND branch !~ 'auth\.(uid|role|jwt)\(\)'
          AND branch !~ '(^|[^[:alnum:]_.])(public\.)?(get_current_profile_id|is_current_user_[a-z_]+|current_user_[a-z_]+)\('
        ORDER BY 1, 2$q$,
    'every FOR ALL policy with no TO and no WITH CHECK tests identity in each OR branch');

-- Federation trigger lists ----------------------------------------------------
-- Both bodies name their triggers literally. 30_reconciled_functions.sql pins
-- the disable side by calling it and reading tgenabled; the enable side cannot
-- be pinned the same way, because a trigger absent from both lists is never
-- disabled and so reads as enabled afterwards regardless. The list is therefore
-- read out of prosrc and compared against the catalog.
--
-- Federation triggers are those whose handler reaches queue_federation_job with
-- a 'federate-' job type, transitively. queue_federation_job also carries
-- send-push-notification, which a maintenance window must not stop, so the job
-- type is what selects.
CREATE TEMP VIEW inv_fed_triggers AS
WITH RECURSIVE fed_fn AS (
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosrc ~ 'queue_federation_job[[:space:]]*\([[:space:]]*''federate-'
  UNION
    SELECT c.oid, c.proname
    FROM fed_fn f
    JOIN pg_proc c ON c.prosrc ~ ('(^|[^A-Za-z0-9_.])' || f.proname || '[[:space:]]*\(')
    JOIN pg_namespace cn ON cn.oid = c.pronamespace AND cn.nspname = 'public'
)
SELECT t.tgname::text AS tgname, t.tgrelid::regclass::text AS tbl
FROM pg_trigger t
WHERE NOT t.tgisinternal AND t.tgfoid IN (SELECT oid FROM fed_fn);

SELECT cmp_ok((SELECT count(*) FROM inv_fed_triggers), '>=', 28::bigint,
              'the catalog walk still finds every federation trigger');

SELECT is_empty(
    $q$SELECT f.tgname, f.tbl
         FROM inv_fed_triggers f
        WHERE NOT EXISTS (
                SELECT 1
                  FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public'
                   AND p.proname = 'enable_federation_triggers'
                   AND p.prosrc ~ ('ENABLE[[:space:]]+TRIGGER[[:space:]]+' || f.tgname || '[[:space:]]*;'))
        ORDER BY 1$q$,
    'enable_federation_triggers names every trigger that queues federation work');

SELECT set_eq(
    $q$SELECT (regexp_matches(p.prosrc, 'ENABLE[[:space:]]+TRIGGER[[:space:]]+([A-Za-z0-9_]+)', 'g'))[1]
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'enable_federation_triggers'$q$,
    $q$SELECT (regexp_matches(p.prosrc, 'DISABLE[[:space:]]+TRIGGER[[:space:]]+([A-Za-z0-9_]+)', 'g'))[1]
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'disable_federation_triggers'$q$,
    'the enable and disable lists name the same triggers');

-- profiles.auth_user_id ---------------------------------------------------------
-- get_current_profile_id() is `SELECT id FROM profiles WHERE auth_user_id =
-- auth.uid() LIMIT 1` with no ORDER BY. Two rows sharing an auth_user_id make
-- the identity of the caller depend on the plan. Production carries a plain
-- btree named idx_profiles_auth_user_id_unique and nothing else, so an index
-- check would pass there; the constraint is what enforces it.
SELECT is(
    (SELECT count(*)::int
       FROM pg_constraint
      WHERE conrelid = 'public.profiles'::regclass
        AND contype = 'u'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                             WHERE attrelid = 'public.profiles'::regclass
                               AND attname = 'auth_user_id'
                               AND NOT attisdropped)]),
    1,
    'profiles.auth_user_id carries a UNIQUE constraint, not merely an index named like one');

-- Not asserted: SECURITY DEFINER functions granted to anon and reached by no
-- trigger or policy. 225 of the 256 SECURITY DEFINER functions in public are
-- executable by anon, and nearly all of them are RPCs the client calls directly,
-- which no catalog reference records. The set is dominated by legitimate entries
-- and an assertion over it would encode the current grant list rather than an
-- invariant.

SELECT * FROM finish();
ROLLBACK;
