-- 20261124600003_admin_instance_stats.sql: a refresh that raises leaves admin_instance_stats() the
-- stored snapshot. The statement_timeout is an error OTHERS does not name.
--
--   alice  instance admin, bob instance moderator
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
UPDATE public.profiles SET is_moderator = true WHERE id = '22222222-0000-0000-0000-000000000002';

CREATE FUNCTION pg_temp.read_as(p_auth uuid, p_key text, p_refresh boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM tests.authenticate_as(p_auth);
    PERFORM set_config('tests.snap_' || p_key, public.admin_instance_stats(p_refresh)::text, true);
    PERFORM tests.clear_authentication();
END;
$$;
CREATE FUNCTION pg_temp.snap(p_key text) RETURNS jsonb LANGUAGE sql AS $$
    SELECT current_setting('tests.snap_' || p_key)::jsonb
$$;

SELECT pg_temp.read_as('aaaaaaaa-0000-0000-0000-000000000001', 'fresh', false);
SELECT is(pg_temp.snap('fresh') -> 'refresh_failed', 'false'::jsonb, 'a refresh that runs says so');
SELECT ok((pg_temp.snap('fresh') ->> 'age_seconds')::numeric < 60, 'and is new');

UPDATE public.admin_instance_stats SET computed_at = computed_at - interval '901 seconds', users_total = 4242;
SELECT set_config('tests.before', (SELECT computed_at::text FROM public.admin_instance_stats), true);

CREATE FUNCTION pg_temp.break(p_statement text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format($f$CREATE OR REPLACE FUNCTION public.refresh_admin_instance_stats(p_exact_limit bigint DEFAULT 2000000)
                      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $b$
                      BEGIN
                          DELETE FROM public.admin_instance_stats WHERE id;
                          %s
                          RETURN true;
                      END; $b$ $f$, p_statement);
END;
$$;

-- An error ------------------------------------------------------------------------------------------
SELECT pg_temp.break('RAISE EXCEPTION ''counting failed'' USING ERRCODE = ''53100'';');
SELECT pg_temp.read_as('aaaaaaaa-0000-0000-0000-000000000001', 'error', false);
SELECT is(pg_temp.snap('error') -> 'refresh_failed', 'true'::jsonb, 'a refresh that raises is reported');
SELECT is((pg_temp.snap('error') ->> 'users_total')::int, 4242, 'with the stored snapshot');
SELECT is((pg_temp.snap('error') ->> 'computed_at')::timestamptz, current_setting('tests.before')::timestamptz, 'and its time');
SELECT ok((pg_temp.snap('error') ->> 'age_seconds')::numeric >= 901, 'and its age');
SELECT is(pg_temp.snap('error') -> 'refreshing_elsewhere', 'false'::jsonb, 'no other session is refreshing');
SELECT is((SELECT count(*)::int FROM public.admin_instance_stats), 1, 'what the refresh wrote is undone');

SELECT pg_temp.read_as('bbbbbbbb-0000-0000-0000-000000000002', 'mod', false);
SELECT ok((pg_temp.snap('mod') ->> 'users_total')::int = 4242 AND NOT (pg_temp.snap('mod') ? 'db_size_bytes'),
          'a moderator reads it too, without the database figures');

-- The statement timeout -----------------------------------------------------------------------------
SELECT pg_temp.break('RAISE EXCEPTION ''canceling statement due to statement timeout'' USING ERRCODE = ''57014'';');
SELECT pg_temp.read_as('aaaaaaaa-0000-0000-0000-000000000001', 'timeout', true);
SELECT is(pg_temp.snap('timeout') -> 'refresh_failed', 'true'::jsonb, 'a statement timeout is reported the same way');
SELECT is((pg_temp.snap('timeout') ->> 'users_total')::int, 4242, 'with the stored snapshot');

-- Nothing to fall back on ---------------------------------------------------------------------------
DELETE FROM public.admin_instance_stats;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
DO $$
BEGIN
    PERFORM set_config('tests.no_fallback', 'none', true);
    PERFORM public.admin_instance_stats();
EXCEPTION WHEN query_canceled THEN
    PERFORM set_config('tests.no_fallback', SQLSTATE, true);
END;
$$;
SELECT is(current_setting('tests.no_fallback'), '57014', 'with no snapshot the error is the answer');
SELECT tests.clear_authentication();
SELECT pg_temp.break('RAISE EXCEPTION ''counting failed'' USING ERRCODE = ''53100'';');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.admin_instance_stats()$$, '53100', 'counting failed', 'whatever it is');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$SELECT public.admin_instance_stats()$$, '42501', NULL, 'and a member is refused before any of it');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
