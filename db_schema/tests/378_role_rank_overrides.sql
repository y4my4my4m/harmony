-- 20261116400001_self_assignable_roles.sql, ROLE_RANKS_TOO_HIGH: a role whose power comes from a
-- channel override alone counts as permission-granting, and a role without a position ranks nowhere.
--
--   server_1 (55555555-...05), @everyone (0) VIEW_CHANNEL, SEND_MESSAGES (4098)
--   low    (1)     self-assignable
--   host   (5)     no server permissions, override allows MUTE_MEMBERS
--   high   (6)     self-assignable, above host
--   level  (5)     self-assignable, beside host
--   opened (3)     override allows VIEW_CHANNEL and SEND_MESSAGES, which @everyone has
--   adrift (null)  self-assignable
--   unset  (null)  override allows MUTE_MEMBERS
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(9);

UPDATE public.server_roles SET permissions = 4098, position = 0
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
INSERT INTO public.server_roles (id, server_id, name, position, permissions, self_assignable) VALUES
  ('37800000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'low', 1, 0, true),
  ('37800000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'host', 5, 0, false),
  ('37800000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'high', 6, 0, true),
  ('37800000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'level', 5, 0, true),
  ('37800000-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000005', 'opened', 3, 0, false),
  ('37800000-0000-0000-0000-000000000006', '55555555-0000-0000-0000-000000000005', 'adrift', NULL, 0, true);

SELECT is(public.self_assign_refusal('37800000-0000-0000-0000-000000000003'), NULL,
          'without an override no role here grants anything');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('66666666-0000-0000-0000-000000000006', 'role', '37800000-0000-0000-0000-000000000002', 1::bigint << 27, 0),
  ('66666666-0000-0000-0000-000000000006', 'role', '37800000-0000-0000-0000-000000000005', 4098, 0);

SELECT is(public.self_assign_refusal('37800000-0000-0000-0000-000000000001'), NULL,
          'a role below the one with the override may be picked');
SELECT is(public.self_assign_refusal('37800000-0000-0000-0000-000000000003'), 'ROLE_RANKS_TOO_HIGH',
          'a role above it cannot');
SELECT is(public.self_assign_refusal('37800000-0000-0000-0000-000000000004'), 'ROLE_RANKS_TOO_HIGH',
          'nor one beside it');
SELECT is(public.self_assign_refusal('37800000-0000-0000-0000-000000000006'), 'ROLE_RANKS_TOO_HIGH',
          'nor one without a position');

UPDATE public.channel_permission_overrides SET allow_permissions = 0, deny_permissions = 1::bigint << 27
 WHERE role_id = '37800000-0000-0000-0000-000000000002';
SELECT is(public.self_assign_refusal('37800000-0000-0000-0000-000000000003'), NULL,
          'an override that only denies grants nothing, nor does one within @everyone and VIEW_CHANNEL');

INSERT INTO public.server_roles (id, server_id, name, position, permissions, self_assignable)
VALUES ('37800000-0000-0000-0000-000000000007', '55555555-0000-0000-0000-000000000005', 'unset', NULL, 0, false);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
VALUES ('66666666-0000-0000-0000-000000000006', 'role', '37800000-0000-0000-0000-000000000007', 1::bigint << 27, 0);
SELECT is(public.self_assign_refusal('37800000-0000-0000-0000-000000000001'), 'ROLE_RANKS_TOO_HIGH',
          'a granting role without a position ranks lowest: every role outranks it');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.set_my_self_assignable_role('37800000-0000-0000-0000-000000000006', true)$$,
  '42501', 'ROLE_RANKS_TOO_HIGH', 'a member cannot pick the one without a position');
SELECT throws_ok($$SELECT public.open_role_refusal('37800000-0000-0000-0000-000000000006')$$,
  '42501', NULL, 'clients do not call open_role_refusal');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
