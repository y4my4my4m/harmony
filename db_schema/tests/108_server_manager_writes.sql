-- Server management after 20261010500001_server_manager_writes.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Added:
--   carol   member without permissions
--   frank   instance moderator, member
--   roles   high (10), mgr (5: MANAGE_CHANNELS, MANAGE_ROLES, MANAGE_EMOJIS, MANAGE_SERVER),
--           low (2), @everyone (0: VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS, ATTACH_FILES,
--           ADD_REACTIONS); bob holds mgr
--   server_2 owned by mallory, with role foreign

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(33);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1080000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol108@test.local'),
  ('f1080000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'frank108@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_moderator) VALUES
  ('f1080000-0000-0000-0000-0000000000c1', 'f1080000-0000-0000-0000-0000000000a1', 'carol108', 'Carol', true, false),
  ('f1080000-0000-0000-0000-0000000000c2', 'f1080000-0000-0000-0000-0000000000a2', 'frank108', 'Frank', true, true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1080000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1080000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'accepted');

UPDATE public.server_roles SET permissions = 462850, position = 0
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
INSERT INTO public.server_roles (id, server_id, name, position, permissions, is_default) VALUES
  ('f1081000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'high', 10, 0, false),
  ('f1081000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'mgr', 5, 156, false),
  ('f1081000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'low', 2, 0, false);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1081000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.servers (id, name, owner) VALUES
  ('f1082000-0000-0000-0000-000000000002', 'Other', '33333333-0000-0000-0000-000000000003');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1081000-0000-0000-0000-000000000009', 'f1082000-0000-0000-0000-000000000002', 'foreign', 1, 1);

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1083000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'ops', 0);

INSERT INTO public.server_settings (server_id) VALUES ('55555555-0000-0000-0000-000000000005')
ON CONFLICT (server_id) DO NOTHING;

INSERT INTO public.bots (id, username, display_name, owner_id, is_public) VALUES
  ('f1084000-0000-0000-0000-000000000001', 'helper108', 'Helper', '11111111-0000-0000-0000-000000000001', true),
  ('f1084000-0000-0000-0000-000000000002', 'second108', 'Second', '11111111-0000-0000-0000-000000000001', true);
INSERT INTO public.bot_server_permissions (id, bot_id, server_id, installed_by) VALUES
  ('f1085000-0000-0000-0000-000000000001', 'f1084000-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001');

-- Roles: rank and grants -------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');

SELECT lives_ok(
    $q$INSERT INTO public.server_roles (id, server_id, name, position, permissions)
       VALUES ('f1081000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'helpers', 3, 16)$q$,
    'a role manager creates a role below their rank with a permission they hold');
SELECT throws_ok(
    $q$INSERT INTO public.server_roles (server_id, name, position) VALUES ('55555555-0000-0000-0000-000000000005', 'top', 5)$q$,
    '42501', NULL, 'not at their own rank');
SELECT throws_ok(
    $q$INSERT INTO public.server_roles (server_id, name, position, permissions) VALUES ('55555555-0000-0000-0000-000000000005', 'admins', 1, 1)$q$,
    '42501', NULL, 'not with ADMINISTRATOR, which they lack');
SELECT throws_ok(
    $q$INSERT INTO public.server_roles (server_id, name, position, is_admin) VALUES ('55555555-0000-0000-0000-000000000005', 'x', 1, true)$q$,
    '42501', NULL, 'not a protected role');

SELECT lives_ok(
    $q$UPDATE public.server_roles SET name = 'lower', color = '#00ff00' WHERE id = 'f1081000-0000-0000-0000-000000000003'$q$,
    'edits a role below their rank');
SELECT throws_ok(
    $q$UPDATE public.server_roles SET position = 7 WHERE id = 'f1081000-0000-0000-0000-000000000003'$q$,
    '42501', NULL, 'cannot move a role to their rank or above');
SELECT throws_ok(
    $q$UPDATE public.server_roles SET name = 'mine' WHERE id = 'f1081000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'cannot edit a role above them');
SELECT throws_ok(
    $q$UPDATE public.server_roles SET permissions = 4 WHERE id = 'f1081000-0000-0000-0000-000000000002'$q$,
    '42501', NULL, 'cannot edit their own highest role');
SELECT throws_ok(
    $q$UPDATE public.server_roles SET permissions = 1024 WHERE id = 'f1081000-0000-0000-0000-000000000003'$q$,
    '42501', NULL, 'cannot add BAN_MEMBERS, which they lack');

SELECT lives_ok(
    $q$UPDATE public.server_roles SET permissions = permissions | 128 WHERE is_default AND server_id = '55555555-0000-0000-0000-000000000005'$q$,
    'adds a permission they hold to @everyone');
SELECT throws_ok(
    $q$UPDATE public.server_roles SET position = 1 WHERE is_default AND server_id = '55555555-0000-0000-0000-000000000005'$q$,
    '42501', NULL, '@everyone keeps its position');

-- Role assignment ---------------------------------------------------------------------------
SELECT lives_ok(
    $q$INSERT INTO public.user_roles (user_id, role_id, server_id)
       VALUES ('f1080000-0000-0000-0000-0000000000c1', 'f1081000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005')$q$,
    'assigns a role below their rank');
SELECT throws_ok(
    $q$INSERT INTO public.user_roles (user_id, role_id, server_id)
       VALUES ('f1080000-0000-0000-0000-0000000000c1', 'f1081000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005')$q$,
    '42501', NULL, 'cannot assign a role above them');
SELECT throws_ok(
    $q$INSERT INTO public.user_roles (user_id, role_id, server_id)
       VALUES ('22222222-0000-0000-0000-000000000002', 'f1081000-0000-0000-0000-000000000009', '55555555-0000-0000-0000-000000000005')$q$,
    '42501', NULL, 'cannot attach another server''s role');
SELECT lives_ok(
    $q$DELETE FROM public.user_roles WHERE user_id = 'f1080000-0000-0000-0000-0000000000c1'
       AND role_id = 'f1081000-0000-0000-0000-000000000003'$q$,
    'removes a role below their rank');
SELECT throws_ok(
    $q$DELETE FROM public.server_roles WHERE id = 'f1081000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'cannot delete a role above them');
SELECT lives_ok(
    $q$DELETE FROM public.server_roles WHERE id = 'f1081000-0000-0000-0000-000000000004'$q$,
    'deletes a role below their rank');

-- Emojis, settings --------------------------------------------------------------------------
SELECT lives_ok(
    $q$INSERT INTO public.emojis (id, name, url, server_id, uploader)
       VALUES ('f1086000-0000-0000-0000-000000000001', 'wave108', 'https://e.test/wave.png',
               '55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002')$q$,
    'an emoji manager adds a server emoji');
SELECT throws_ok(
    $q$INSERT INTO public.emojis (name, url, server_id, uploader, scope)
       VALUES ('inst108', 'https://e.test/i.png', '55555555-0000-0000-0000-000000000005',
               '22222222-0000-0000-0000-000000000002', 'instance')$q$,
    '42501', NULL, 'but no instance emoji');

SELECT lives_ok(
    $q$UPDATE public.server_settings SET invite_permissions = '{"who_can_create":"everyone"}'::jsonb
       WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
    'a server manager saves invite settings');
SELECT throws_ok(
    $q$UPDATE public.server_settings SET default_role_id = 'f1081000-0000-0000-0000-000000000001'
       WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
    '42501', NULL, 'cannot make a role above them the default role');
SELECT lives_ok(
    $q$UPDATE public.server_settings SET default_role_id = 'f1081000-0000-0000-0000-000000000003'
       WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
    'can make a role below them the default role');

-- Bots --------------------------------------------------------------------------------------
SELECT lives_ok(
    $q$UPDATE public.bot_server_permissions SET is_active = false, attach_files = true
       WHERE id = 'f1085000-0000-0000-0000-000000000001'$q$,
    'a server manager edits a bot installation within their permissions');
SELECT throws_ok(
    $q$UPDATE public.bot_server_permissions SET ban_members = true WHERE id = 'f1085000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'cannot give a bot BAN_MEMBERS, which they lack');
SELECT throws_ok(
    $q$SELECT public.add_bot_to_server('f1084000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
                                       '22222222-0000-0000-0000-000000000002', '{"kick_members": true}')$q$,
    '42501', NULL, 'cannot install a bot with KICK_MEMBERS');
SELECT lives_ok(
    $q$SELECT public.add_bot_to_server('f1084000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
                                       '22222222-0000-0000-0000-000000000002', '{}')$q$,
    'installs a bot with the default flags');

-- Channel overrides -------------------------------------------------------------------------
SELECT lives_ok(
    $q$INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
       VALUES ('f1083000-0000-0000-0000-000000000001', 'role', 'f1081000-0000-0000-0000-000000000003', 16, 0)$q$,
    'a channel manager adds an override allowing a permission they hold');
SELECT throws_ok(
    $q$INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
       VALUES ('f1083000-0000-0000-0000-000000000001', 'role', (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), 1, 0)$q$,
    '42501', NULL, 'not one allowing ADMINISTRATOR');

-- No permission -----------------------------------------------------------------------------
SELECT tests.authenticate_as('f1080000-0000-0000-0000-0000000000a1');
SELECT throws_ok(
    $q$INSERT INTO public.server_roles (server_id, name, position) VALUES ('55555555-0000-0000-0000-000000000005', 'nope', 1)$q$,
    '42501', NULL, 'a member without MANAGE_ROLES creates no role');
SELECT throws_ok(
    $q$INSERT INTO public.emojis (name, url, server_id, uploader)
       VALUES ('nope108', 'https://e.test/n.png', '55555555-0000-0000-0000-000000000005', 'f1080000-0000-0000-0000-0000000000c1')$q$,
    '42501', NULL, 'nor an emoji');

SELECT tests.authenticate_as('f1080000-0000-0000-0000-0000000000a2');
SELECT throws_ok(
    $q$INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
       VALUES ('f1083000-0000-0000-0000-000000000001', 'role', 'f1081000-0000-0000-0000-000000000001', 0, 2)$q$,
    '42501', NULL, 'an instance moderator no longer edits overrides');

-- Owner -------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$UPDATE public.server_roles SET permissions = 3 WHERE is_default AND server_id = '55555555-0000-0000-0000-000000000005'$q$,
    'the owner saves @everyone''s permissions');
SELECT lives_ok(
    $q$UPDATE public.server_roles SET position = 11, permissions = 1 WHERE id = 'f1081000-0000-0000-0000-000000000001'$q$,
    'the owner edits any role');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
