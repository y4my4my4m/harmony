-- servers.sidebar_banner after 20261014100002_server_sidebar_banner.sql: off by default,
-- written through update_server by the owner, refused for a member without MANAGE_SERVER.
--
--   server_1 (55555555-...05)  owner alice; bob is a plain member

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(6);

CREATE FUNCTION pg_temp.flag() RETURNS boolean
LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT sidebar_banner FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.flag() TO authenticated, anon;

SELECT is(pg_temp.flag(), false, 'a server starts without the sidebar banner');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(
    (public.update_server('55555555-0000-0000-0000-000000000005', '{"sidebar_banner": true}'::jsonb)) -> 'sidebar_banner',
    'true'::jsonb,
    'update_server returns the flag the owner set');
SELECT is(pg_temp.flag(), true, 'the owner turns the sidebar banner on');
SELECT throws_ok(
    $$SELECT public.update_server('55555555-0000-0000-0000-000000000005', '{"sidebar_banner": "yes"}'::jsonb)$$,
    '22023', 'sidebar_banner must be a boolean',
    'the flag is a boolean');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $$SELECT public.update_server('55555555-0000-0000-0000-000000000005', '{"sidebar_banner": false}'::jsonb)$$,
    '42501', 'Missing permission: MANAGE_SERVER',
    'a member without MANAGE_SERVER cannot change it');
SELECT tests.clear_authentication();
SELECT is(pg_temp.flag(), true, 'the refused change left the flag on');

SELECT * FROM finish();
ROLLBACK;
