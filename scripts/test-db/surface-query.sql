-- Emits one row per public function with everything needed to judge whether it
-- belongs on the client-facing surface. PostgREST exposes every function in
-- `public` as an RPC endpoint, so this is the HTTP attack surface.
--
-- Columns: name | args | returns | security | search_path | grants | bound_to
--
-- Grants are computed with has_function_privilege rather than by listing
-- explicit grantees. PostgreSQL grants EXECUTE to PUBLIC by default, so a
-- function with no row for `anon` in information_schema is still callable by
-- anon; reading grantees alone reports a revoke that did nothing as effective.
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
)
SELECT p.proname
       || '|' || pg_get_function_identity_arguments(p.oid)
       || '|' || pg_get_function_result(p.oid)
       || '|' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
       || '|' || coalesce(array_to_string(p.proconfig, ' '), '')
       || '|' || concat_ws('+',
                    CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'anon' END,
                    CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'authenticated' END,
                    CASE WHEN has_function_privilege('service_role', p.oid, 'EXECUTE') THEN 'service_role' END)
       || '|' || CASE
                   WHEN p.oid IN (SELECT oid FROM trigger_bound) THEN 'trigger'
                   WHEN (SELECT body FROM policy_text) LIKE '%' || p.proname || '(%' THEN 'policy'
                   ELSE ''
                 END
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.prokind = 'f'
 GROUP BY p.oid, p.proname, p.prosecdef, p.proconfig
 ORDER BY p.proname, pg_get_function_identity_arguments(p.oid);
