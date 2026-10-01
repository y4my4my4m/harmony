-- Internal SECURITY DEFINER functions after 20261004200001_revoke_internal_definers.sql.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(6);

CREATE TEMP TABLE internal_fn AS
SELECT p.oid::regprocedure AS fn, p.proname
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('queue_federation_job', 'cleanup_dead_endpoint_users', 'log_admin_action',
                     'create_default_server_structure', 'bump_server_channel_epochs',
                     'fetch_link_preview', 'purge_stale_invites');

SELECT cmp_ok((SELECT count(DISTINCT proname) FROM internal_fn), '=', 7::bigint,
              'all seven internal functions exist');

SELECT is_empty(
    $q$SELECT fn FROM internal_fn
        WHERE has_function_privilege('anon', fn, 'EXECUTE')
           OR has_function_privilege('authenticated', fn, 'EXECUTE')$q$,
    'clients hold no EXECUTE on internal definer functions');

SELECT is_empty(
    $q$SELECT fn FROM internal_fn WHERE NOT has_function_privilege('service_role', fn, 'EXECUTE')$q$,
    'the service role keeps EXECUTE');

SELECT is_empty(
    $q$SELECT fn FROM internal_fn
        WHERE NOT has_function_privilege('postgres', fn, 'EXECUTE')
           OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin')
               AND NOT has_function_privilege('supabase_admin', fn, 'EXECUTE'))$q$,
    'the owners of definer callers keep EXECUTE');

-- A definer caller still reaches queue_federation_job for an authenticated session.
CREATE FUNCTION pg_temp.enqueue_as_definer() RETURNS uuid
LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT public.queue_federation_job('test-job', '{}'::jsonb)
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.enqueue_as_definer() TO authenticated;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.queue_federation_job('push-notification', '{"user_id":"x"}'::jsonb)$q$,
    '42501', NULL, 'an authenticated client cannot enqueue a federation job');
SELECT lives_ok($q$SELECT pg_temp.enqueue_as_definer()$q$,
                'a SECURITY DEFINER caller still enqueues for an authenticated session');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
