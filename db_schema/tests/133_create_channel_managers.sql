-- create_channel by members who manage channels without owning the server, after
-- 20261013000001_create_channel_read_back.sql.
--
-- Fixture server_1: alice owns it, bob is a member without permissions.
-- Added: dana (a role with MANAGE_CHANNELS) and erin (a role with ADMINISTRATOR).

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(7);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1330000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dana133@test.local'),
  ('f1330000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin133@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1330000-0000-0000-0000-0000000000c1', 'f1330000-0000-0000-0000-0000000000a1', 'dana133', 'Dana', true),
  ('f1330000-0000-0000-0000-0000000000c2', 'f1330000-0000-0000-0000-0000000000a2', 'erin133', 'Erin', true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1330000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1330000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'accepted');

-- Bit 2 is MANAGE_CHANNELS, bit 1 VIEW_CHANNEL, bit 0 ADMINISTRATOR.
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1331000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'channel managers 133', 2, 6),
  ('f1331000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'admins 133', 3, 1),
  ('f1331000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'secret club 133', 1, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f1330000-0000-0000-0000-0000000000c1', 'f1331000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('f1330000-0000-0000-0000-0000000000c2', 'f1331000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');

CREATE TEMP TABLE made (k text PRIMARY KEY, id uuid, name text);
GRANT ALL ON made TO authenticated;

SELECT tests.authenticate_as('f1330000-0000-0000-0000-0000000000a2');
INSERT INTO made SELECT 'admin', c.id, c.name
  FROM public.create_channel('55555555-0000-0000-0000-000000000005', 'admin-made-133') c;
SELECT tests.clear_authentication();
SELECT is((SELECT name FROM public.channels WHERE id = (SELECT id FROM made WHERE k = 'admin')), 'admin-made-133',
    'a member with ADMINISTRATOR who does not own the server creates a channel and gets its row back');

SELECT tests.authenticate_as('f1330000-0000-0000-0000-0000000000a1');
INSERT INTO made SELECT 'manager', c.id, c.name
  FROM public.create_channel('55555555-0000-0000-0000-000000000005', 'manager-made-133') c;
INSERT INTO made SELECT 'manager-private', c.id, c.name
  FROM public.create_channel('55555555-0000-0000-0000-000000000005', 'club-133', 0, NULL, true,
                             ARRAY['f1331000-0000-0000-0000-000000000003']::uuid[]) c;
SELECT tests.clear_authentication();
SELECT is((SELECT name FROM public.channels WHERE id = (SELECT id FROM made WHERE k = 'manager')), 'manager-made-133',
    'a member with MANAGE_CHANNELS creates a channel');
SELECT is((SELECT name FROM made WHERE k = 'manager-private'), 'club-133',
    'a manager creating a private channel it cannot view still gets the new id and name');
SELECT is((SELECT count(*)::int FROM public.channel_permission_overrides
            WHERE channel_id = (SELECT id FROM made WHERE k = 'manager-private')), 2,
    'the private channel carries the @everyone deny and the role allow');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_channel('55555555-0000-0000-0000-000000000005', 'bob-133')$q$,
    '42501', NULL, 'a member without MANAGE_CHANNELS still cannot create a channel');
SELECT tests.clear_authentication();

SELECT is(prosecdef, false, 'create_channel stays SECURITY INVOKER, so channel RLS and guards apply')
  FROM pg_proc WHERE oid = 'public.create_channel(uuid, text, integer, uuid, boolean, uuid[], text, integer, boolean, boolean, text)'::regprocedure;
SELECT ok(NOT has_function_privilege('anon', 'public.create_channel(uuid, text, integer, uuid, boolean, uuid[], text, integer, boolean, boolean, text)', 'EXECUTE'),
    'anon cannot call create_channel');

SELECT * FROM finish();
ROLLBACK;
