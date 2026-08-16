-- Emits one row per public function with everything needed to judge whether it
-- belongs on the client-facing surface. PostgREST exposes every function in
-- `public` as an RPC endpoint, so this is the HTTP attack surface.
--
-- Columns: name | args | returns | security | search_path | grants | bound_to
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'

WITH trigger_bound AS (
    SELECT DISTINCT tgfoid AS oid FROM pg_trigger WHERE NOT tgisinternal
),
policy_text AS (
    SELECT string_agg(
               coalesce(pg_get_expr(polqual, polrelid), '') || ' ' ||
               coalesce(pg_get_expr(polwithcheck, polrelid), ''), ' ') AS body
      FROM pg_policy
),
grants AS (
    SELECT r.routine_name,
           r.specific_name,
           string_agg(DISTINCT g.grantee, '+' ORDER BY g.grantee) AS grantees
      FROM information_schema.routines r
      JOIN information_schema.role_routine_grants g
        ON g.specific_name = r.specific_name
     WHERE r.routine_schema = 'public'
       AND g.grantee IN ('anon', 'authenticated', 'service_role')
     GROUP BY r.routine_name, r.specific_name
)
SELECT p.proname
       || '|' || pg_get_function_identity_arguments(p.oid)
       || '|' || pg_get_function_result(p.oid)
       || '|' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
       || '|' || coalesce(array_to_string(p.proconfig, ' '), '')
       || '|' || coalesce(max(g.grantees), '')
       || '|' || CASE
                   WHEN p.oid IN (SELECT oid FROM trigger_bound) THEN 'trigger'
                   WHEN (SELECT body FROM policy_text) LIKE '%' || p.proname || '(%' THEN 'policy'
                   ELSE ''
                 END
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN grants g ON g.routine_name = p.proname
 WHERE n.nspname = 'public'
   AND p.prokind = 'f'
 GROUP BY p.oid, p.proname, p.prosecdef, p.proconfig
 ORDER BY p.proname, pg_get_function_identity_arguments(p.oid);
