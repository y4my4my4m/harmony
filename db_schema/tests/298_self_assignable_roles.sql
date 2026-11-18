-- 20261116400001_self_assignable_roles.sql: self-assignable roles, the join role.
--
--   server_1 (55555555-...05)  owner alice, member bob, mallory not a member
--   @everyone (0)              VIEW_CHANNEL, SEND_MESSAGES (4098)
--   pick  (1)                  self-assignable, no bits
--   spoil (1)                  self-assignable, override opens #general to it
--   kicky (3)                  self-assignable, KICK_MEMBERS
--   mod   (5)                  MANAGE_MESSAGES
--   above (6)                  self-assignable, no bits, above mod
--   plain (1)                  not self-assignable
--   adm   (900)                administrator, self-assignable
--   leaky (1)                  self-assignable, override allows MANAGE_MESSAGES
--   copy server                a copy (is_local_server false) with a self-assignable role
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(30);

UPDATE public.server_roles SET permissions = 4098, position = 0
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
INSERT INTO public.server_roles (id, server_id, name, position, permissions, is_default, is_admin, self_assignable, self_assign_group) VALUES
  ('29800000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'pick', 1, 0, false, false, true, 'Colours'),
  ('29800000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'spoil', 1, 0, false, false, true, 'Channels'),
  ('29800000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'kicky', 3, 512, false, false, true, NULL),
  ('29800000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'mod', 5, 2097152, false, false, false, NULL),
  ('29800000-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000005', 'above', 6, 0, false, false, true, NULL),
  ('29800000-0000-0000-0000-000000000006', '55555555-0000-0000-0000-000000000005', 'plain', 1, 0, false, false, false, NULL),
  ('29800000-0000-0000-0000-000000000007', '55555555-0000-0000-0000-000000000005', 'adm', 900, 1, false, true, true, NULL),
  ('29800000-0000-0000-0000-000000000008', '55555555-0000-0000-0000-000000000005', 'leaky', 1, 0, false, false, true, NULL);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('66666666-0000-0000-0000-000000000006', 'role', '29800000-0000-0000-0000-000000000002', 2, 0),
  ('66666666-0000-0000-0000-000000000006', 'role', '29800000-0000-0000-0000-000000000008', 2097152, 0);
INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('29820000-0000-0000-0000-000000000001', 'Copy', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.server_roles (id, server_id, name, position, permissions, self_assignable) VALUES
  ('29800000-0000-0000-0000-000000000009', '29820000-0000-0000-0000-000000000001', 'remote', 1, 0, true);

-- Which roles may be picked. ---------------------------------------------------------------------
SELECT is(public.self_assign_refusal('29800000-0000-0000-0000-000000000001'), NULL, 'a self-assignable role without bits may be picked');
SELECT is(public.self_assign_refusal('29800000-0000-0000-0000-000000000002'), NULL, 'a role an override opens a channel to may be picked');
SELECT is(public.self_assign_refusal('29800000-0000-0000-0000-000000000003'), 'ROLE_GRANTS_PERMISSIONS', 'a role with bits beyond @everyone cannot');
SELECT is(public.self_assign_refusal('29800000-0000-0000-0000-000000000005'), 'ROLE_RANKS_TOO_HIGH', 'a role above a permission-granting role cannot');
SELECT is(public.self_assign_refusal('29800000-0000-0000-0000-000000000006'), 'NOT_SELF_ASSIGNABLE', 'an unmarked role cannot');
SELECT is(public.self_assign_refusal('29800000-0000-0000-0000-000000000007'), 'ROLE_IS_ADMIN', 'an administrator role cannot');
SELECT is(public.self_assign_refusal('29800000-0000-0000-0000-000000000008'), 'ROLE_OVERRIDE_GRANTS', 'a role whose override grants a moderation bit cannot');
SELECT is(public.self_assign_refusal('29800000-0000-0000-0000-000000000009'), 'SERVER_NOT_LOCAL', 'a copy''s role cannot');
SELECT is(public.self_assign_refusal('29800000-0000-0000-0000-0000000000ff'), 'ROLE_NOT_FOUND', 'an unknown role cannot');
SELECT is(public.self_assign_refusal((SELECT id FROM public.server_roles
                                       WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default)),
  'NOT_SELF_ASSIGNABLE', '@everyone cannot, even when marked');

-- A member picks and drops. -------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_my_self_assignable_role('29800000-0000-0000-0000-000000000001', true), true, 'bob picks a role');
SELECT is(public.set_my_self_assignable_role('29800000-0000-0000-0000-000000000001', true), true, 'picking it again changes nothing');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.user_roles
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = '29800000-0000-0000-0000-000000000001'),
  1, 'bob holds the role once');
SELECT is((SELECT assigned_by FROM public.user_roles
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = '29800000-0000-0000-0000-000000000001'),
  '22222222-0000-0000-0000-000000000002'::uuid, 'assigned by bob himself');
SELECT is((SELECT actor_id::text || ' ' || action FROM public.server_audit_log
            WHERE action = 'member.role_add' AND target_id = '22222222-0000-0000-0000-000000000002'
              AND details ->> 'role_id' = '29800000-0000-0000-0000-000000000001'),
  '22222222-0000-0000-0000-000000000002 member.role_add', 'the audit log names bob as the actor');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.set_my_self_assignable_role('29800000-0000-0000-0000-000000000003', true)$$,
  '42501', 'ROLE_GRANTS_PERMISSIONS', 'a role with bits is refused');
SELECT throws_ok($$SELECT public.set_my_self_assignable_role('29800000-0000-0000-0000-000000000006', true)$$,
  '42501', 'NOT_SELF_ASSIGNABLE', 'an unmarked role is refused');
SELECT throws_ok($$SELECT public.set_my_self_assignable_role('29800000-0000-0000-0000-000000000006', false)$$,
  '42501', 'NOT_SELF_ASSIGNABLE', 'nor can an unmarked role be dropped');
SELECT is(public.set_my_self_assignable_role('29800000-0000-0000-0000-000000000001', false), false, 'bob drops the role');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.user_roles
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = '29800000-0000-0000-0000-000000000001'),
  0, 'bob no longer holds it');

-- A role that stops qualifying can still be dropped.
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', '29800000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_my_self_assignable_role('29800000-0000-0000-0000-000000000003', false), false,
  'a self-assignable role with bits can be dropped');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$SELECT public.set_my_self_assignable_role('29800000-0000-0000-0000-000000000001', true)$$,
  '42501', 'NOT_A_MEMBER', 'someone outside the server cannot pick');
SELECT tests.clear_authentication();

-- The join role. ------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.set_server_join_role('55555555-0000-0000-0000-000000000005', '29800000-0000-0000-0000-000000000001')$$,
  '42501', 'Missing permission: MANAGE_ROLES', 'a member without Manage roles cannot set it');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.set_server_join_role('55555555-0000-0000-0000-000000000005', '29800000-0000-0000-0000-000000000007')$$,
  '42501', 'ROLE_RESERVED', 'an administrator role cannot be the join role');
SELECT lives_ok($$SELECT public.set_server_join_role('55555555-0000-0000-0000-000000000005', '29800000-0000-0000-0000-000000000006')$$,
  'the owner sets the join role');
SELECT throws_ok($$UPDATE public.server_settings SET default_role_id = '29800000-0000-0000-0000-000000000007'
                    WHERE server_id = '55555555-0000-0000-0000-000000000005'$$,
  '42501', 'The join role cannot be @everyone or an administrator role', 'a direct write of an administrator role is refused');
SELECT tests.clear_authentication();

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'pending');
SELECT is((SELECT count(*)::int FROM public.user_roles
            WHERE user_id = '33333333-0000-0000-0000-000000000003' AND role_id = '29800000-0000-0000-0000-000000000006'),
  0, 'a pending member does not get the join role');
UPDATE public.user_servers SET status = 'accepted'
 WHERE user_id = '33333333-0000-0000-0000-000000000003' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT count(*)::int FROM public.user_roles
            WHERE user_id = '33333333-0000-0000-0000-000000000003' AND role_id = '29800000-0000-0000-0000-000000000006'),
  1, 'accepting the member gives the join role');

-- Removed by a moderator, it is not given back by a later status write.
DELETE FROM public.user_roles WHERE user_id = '33333333-0000-0000-0000-000000000003' AND role_id = '29800000-0000-0000-0000-000000000006';
UPDATE public.user_servers SET status = 'accepted'
 WHERE user_id = '33333333-0000-0000-0000-000000000003' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT count(*)::int FROM public.user_roles
            WHERE user_id = '33333333-0000-0000-0000-000000000003' AND role_id = '29800000-0000-0000-0000-000000000006'),
  0, 'an accepted-to-accepted write does not give it back');

-- On a copy the join role is never applied.
INSERT INTO public.server_settings (server_id, default_role_id)
VALUES ('29820000-0000-0000-0000-000000000001', '29800000-0000-0000-0000-000000000009');
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', '29820000-0000-0000-0000-000000000001', 'accepted');
SELECT is((SELECT count(*)::int FROM public.user_roles
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = '29800000-0000-0000-0000-000000000009'),
  0, 'joining a copy gives no join role');

SELECT * FROM finish();
ROLLBACK;
