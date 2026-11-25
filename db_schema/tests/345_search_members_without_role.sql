-- search_server_members leaves out a role's members, after 20261123500003_search_members_without_role.sql.
--
--   zed1..zed3  members of server_1; zed1 and zed2 hold Crew
--   alice       owns server_1 and searches it
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(8);

CREATE FUNCTION tests.sm345_names(p_list jsonb) RETURNS text LANGUAGE sql AS $fn$
  SELECT COALESCE(string_agg(m ->> 'username', ',' ORDER BY ord), '')
    FROM jsonb_array_elements(p_list) WITH ORDINALITY AS t(m, ord);
$fn$;

INSERT INTO public.profiles (id, username, display_name, is_local) VALUES
  ('e3450000-0000-0000-0000-000000000001', 'zed1', 'Zed A', true),
  ('e3450000-0000-0000-0000-000000000002', 'zed2', 'Zed B', true),
  ('e3450000-0000-0000-0000-000000000003', 'zed3', 'Zed C', true);
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT id, '55555555-0000-0000-0000-000000000005', 'accepted'
  FROM public.profiles WHERE id::text LIKE 'e3450000-%';

INSERT INTO public.servers (id, name, owner) VALUES
  ('e3451000-0000-0000-0000-000000000001', 'Other', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.server_roles (id, server_id, name, position, is_default) VALUES
  ('e3452000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'Crew', 5, false),
  ('e3452000-0000-0000-0000-000000000002', 'e3451000-0000-0000-0000-000000000001', 'Elsewhere', 5, false);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('e3450000-0000-0000-0000-000000000001', 'e3452000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('e3450000-0000-0000-0000-000000000002', 'e3452000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.sm345_names(public.search_server_members('55555555-0000-0000-0000-000000000005', 'zed', 2)),
          'zed1,zed2', 'the first two matches both hold the role');
SELECT is(tests.sm345_names(public.search_server_members('55555555-0000-0000-0000-000000000005', 'zed', 2,
                                                        'e3452000-0000-0000-0000-000000000001')),
          'zed3', 'left out before the limit, the role''s members leave room for the one who lacks it');
SELECT is(tests.sm345_names(public.search_server_members('55555555-0000-0000-0000-000000000005', 'zed', 20,
                                                        'e3452000-0000-0000-0000-000000000001')),
          'zed3', 'no member holding the role is listed');
SELECT is(tests.sm345_names(public.search_server_members('55555555-0000-0000-0000-000000000005', 'zed', 20,
                                                        'e3452000-0000-0000-0000-000000000002')),
          'zed1,zed2,zed3', 'a role of another server leaves out no one');
SELECT is(tests.sm345_names(public.search_server_members('55555555-0000-0000-0000-000000000005', 'zed', 20, NULL)),
          'zed1,zed2,zed3', 'no role leaves out no one');
RESET ROLE;
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM pg_proc
            WHERE proname = 'search_server_members' AND pronamespace = 'public'::regnamespace),
          1, 'one function: a call with three arguments matches no second overload');
SELECT ok(has_function_privilege('authenticated', 'public.search_server_members(uuid, text, integer, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.search_server_members(uuid, text, integer, uuid)', 'EXECUTE'),
          'members search, anon does not');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.search_server_members('55555555-0000-0000-0000-000000000005', 'zed', 20,
                        'e3452000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'a non-member is refused, role or not');
RESET ROLE;
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
