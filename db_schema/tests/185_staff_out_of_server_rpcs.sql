-- 20261027500001_staff_out_of_server_rpcs.sql: an instance admin holds no power inside a server
-- through channel webhooks, server sounds, template export, channel encryption, their own or
-- anyone's membership row; the owner still does. Channel webhooks refuse a copy of a remote server.
-- 20261027200001_server_copies_authority.sql: on a copy, ADMINISTRATOR shows no hidden channel.
--
-- alice (fixture) is instance admin. o185 owns s185; alice is a pending member of it.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(11);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('18500000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o185@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('18510000-0000-0000-0000-0000000000a1', '18500000-0000-0000-0000-0000000000a1', 'o185', 'Owner', true);
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO public.servers (id, name, owner) VALUES
  ('18520000-0000-0000-0000-000000000001', 'Server 185', '18510000-0000-0000-0000-0000000000a1');
INSERT INTO public.servers (id, name, owner, is_local_server, ap_id) VALUES
  ('18520000-0000-0000-0000-000000000002', 'Copy 185', '18510000-0000-0000-0000-0000000000a1', false,
   'https://host.test/servers/18520000-0000-0000-0000-000000000002');
INSERT INTO public.channels (id, server_id, name, type, is_remote) VALUES
  ('18530000-0000-0000-0000-000000000001', '18520000-0000-0000-0000-000000000001', 'general', 0, false),
  ('18530000-0000-0000-0000-000000000002', '18520000-0000-0000-0000-000000000002', 'general', 0, true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('18510000-0000-0000-0000-0000000000a1', '18520000-0000-0000-0000-000000000001', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', '18520000-0000-0000-0000-000000000001', 'pending');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(NOT public.can_manage_server_sounds('18520000-0000-0000-0000-000000000001'),
  'an instance admin does not manage a server''s sounds');
SELECT throws_ok($q$SELECT public.export_server_template('18520000-0000-0000-0000-000000000001')$q$,
  '42501', NULL, 'nor exports it as a template');
SELECT throws_ok($q$SELECT public.set_channel_encryption('18530000-0000-0000-0000-000000000001', NULL, NULL, 'shared')$q$,
  '42501', NULL, 'nor changes a channel''s encryption');
SELECT throws_ok($q$UPDATE public.user_servers SET status = 'accepted'
                     WHERE user_id = '11111111-0000-0000-0000-000000000001'
                       AND server_id = '18520000-0000-0000-0000-000000000001'$q$,
  '42501', NULL, 'nor accepts their own pending membership');

-- can_manage_channel_webhooks is for service callers: called as postgres with the caller's claims.
SELECT tests.clear_authentication();
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
SELECT ok(NOT public.can_manage_channel_webhooks('18530000-0000-0000-0000-000000000001'),
  'an instance admin does not manage a channel''s webhooks');
SELECT set_config('request.jwt.claim.sub', '18500000-0000-0000-0000-0000000000a1', true);
SELECT ok(public.can_manage_channel_webhooks('18530000-0000-0000-0000-000000000001'),
  'the owner does');
SELECT ok(NOT public.can_manage_channel_webhooks('18530000-0000-0000-0000-000000000002'),
  'nobody manages webhooks of a copy of a remote server, its recorded owner included');

SELECT tests.authenticate_as('18500000-0000-0000-0000-0000000000a1');
SELECT ok(public.can_manage_server_sounds('18520000-0000-0000-0000-000000000001'),
  'the owner manages the server''s sounds');

-- Memberships: an instance admin changes no one's row through RLS.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.user_servers SET status = 'banned'
 WHERE user_id = '18510000-0000-0000-0000-0000000000a1' AND server_id = '18520000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is((SELECT status FROM public.user_servers
            WHERE user_id = '18510000-0000-0000-0000-0000000000a1' AND server_id = '18520000-0000-0000-0000-000000000001'),
          'accepted', 'an instance admin does not change another member''s membership');

-- A copy: ADMINISTRATOR and ownership show no channel @everyone may not view.
INSERT INTO public.channels (id, server_id, name, type, is_remote) VALUES
  ('18530000-0000-0000-0000-000000000003', '18520000-0000-0000-0000-000000000002', 'staff', 0, true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', '18520000-0000-0000-0000-000000000002', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('18540000-0000-0000-0000-000000000001', '18520000-0000-0000-0000-000000000002', 'copyadmin185', 5, 1);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('11111111-0000-0000-0000-000000000001', '18540000-0000-0000-0000-000000000001', '18520000-0000-0000-0000-000000000002');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT '18530000-0000-0000-0000-000000000003', 'role', r.id, 0, 2
  FROM public.server_roles r WHERE r.server_id = '18520000-0000-0000-0000-000000000002' AND r.is_default;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok('18530000-0000-0000-0000-000000000003' NOT IN (SELECT public.current_user_viewable_channel_ids()),
  'a copy-local ADMINISTRATOR role shows no channel hidden from @everyone');
SELECT ok('18530000-0000-0000-0000-000000000002' IN (SELECT public.current_user_viewable_channel_ids()),
  'the copy''s open channel stays visible');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
