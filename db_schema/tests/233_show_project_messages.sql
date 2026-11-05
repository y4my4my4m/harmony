-- 20261106300001_show_project_messages.sql: instance_funding.show_project_messages, on by
-- default, written by instance admins only, read by the federation backend as service_role.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

-- Fixture: alice is an instance admin, bob is not; one funding row written without the switch.
UPDATE public.profiles SET is_admin = (id = '11111111-0000-0000-0000-000000000001')
 WHERE id IN ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002');
DELETE FROM public.instance_funding;
INSERT INTO public.instance_funding (enabled) VALUES (true);

SELECT col_type_is('public', 'instance_funding', 'show_project_messages', 'boolean',
  'show_project_messages is a boolean');
SELECT col_not_null('public', 'instance_funding', 'show_project_messages',
  'show_project_messages is never null');
SELECT col_default_is('public', 'instance_funding', 'show_project_messages', 'true',
  'show_project_messages defaults to on');
SELECT is((SELECT show_project_messages FROM public.instance_funding), true,
  'a funding row written without the switch shows the project''s messages');

-- Privileges
SELECT ok(has_column_privilege('authenticated', 'public.instance_funding', 'show_project_messages', 'SELECT')
          AND has_column_privilege('authenticated', 'public.instance_funding', 'show_project_messages', 'INSERT')
          AND has_column_privilege('authenticated', 'public.instance_funding', 'show_project_messages', 'UPDATE'),
  'signed-in clients hold the column grants; the admin policy decides who writes');
SELECT ok(NOT has_column_privilege('anon', 'public.instance_funding', 'show_project_messages', 'SELECT')
          AND NOT has_column_privilege('anon', 'public.instance_funding', 'show_project_messages', 'UPDATE'),
  'anon holds no privilege on the switch');
SELECT ok(has_column_privilege('service_role', 'public.instance_funding', 'show_project_messages', 'SELECT'),
  'the federation backend reads the switch as service_role');

-- Writes
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT show_project_messages FROM public.instance_funding), true,
  'a member reads the switch');
UPDATE public.instance_funding SET show_project_messages = false;
SELECT tests.clear_authentication();
SELECT is((SELECT show_project_messages FROM public.instance_funding), true,
  'a member''s update changes nothing');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$INSERT INTO public.instance_funding (show_project_messages) VALUES (false)$q$,
  '42501', NULL, 'a member cannot insert a funding row');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.instance_funding SET show_project_messages = false;
SELECT tests.clear_authentication();
SELECT is((SELECT show_project_messages FROM public.instance_funding), false,
  'an instance admin turns the project''s messages off');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$UPDATE public.instance_funding SET show_project_messages = true$q$,
  '42501', NULL, 'signed out cannot write the switch');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
