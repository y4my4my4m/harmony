-- 20261026700002_federation_read_scope.sql.
--
--   server_1 (5555…5), federation on; private channel (f177a…c1): @everyone denied VIEW_CHANNEL,
--   "Staff" allowed.
--   r1, r2 on x.example; r3 on y.example. r1 and r3 hold "Staff"; r2 does not.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';
INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
  ('f177a000-0000-0000-0000-0000000000e1', 'r1', 'R1', false, 'x.example', 'https://x.example/users/r1'),
  ('f177a000-0000-0000-0000-0000000000e2', 'r2', 'R2', false, 'x.example', 'https://x.example/users/r2'),
  ('f177a000-0000-0000-0000-0000000000e3', 'r3', 'R3', false, 'y.example', 'https://y.example/users/r3');
INSERT INTO public.user_servers (user_id, server_id, status, created_at) VALUES
  ('f177a000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005', 'accepted', '2026-10-01T00:00:00Z'),
  ('f177a000-0000-0000-0000-0000000000e2', '55555555-0000-0000-0000-000000000005', 'accepted', '2026-10-01T00:00:00Z'),
  ('f177a000-0000-0000-0000-0000000000e3', '55555555-0000-0000-0000-000000000005', 'accepted', '2026-10-10T00:00:00Z');
INSERT INTO public.server_roles (id, server_id, name, permissions, position) VALUES
  ('f177a000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'Staff 177a', 0, 4);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f177a000-0000-0000-0000-0000000000e1', 'f177a000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005'),
  ('f177a000-0000-0000-0000-0000000000e3', 'f177a000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f177a000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'staff-177a', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT 'f177a000-0000-0000-0000-0000000000c1', 'role', r.id, 0, 2
  FROM public.server_roles r WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('f177a000-0000-0000-0000-0000000000c1', 'role', 'f177a000-0000-0000-0000-0000000000d1', 2, 0);

-- Delivery ---------------------------------------------------------------------------------
SELECT is((SELECT array_agg(instance ORDER BY instance) FROM public.federation_channel_recipients('f177a000-0000-0000-0000-0000000000c1')),
          ARRAY['y.example'],
          'a private channel reaches only instances whose every member views it');
SELECT is((SELECT array_agg(instance ORDER BY instance) FROM public.federation_channel_recipients('66666666-0000-0000-0000-000000000006')),
          ARRAY['x.example', 'y.example'],
          'a channel everyone views reaches every member instance');
SELECT is((SELECT member_ap_ids FROM public.federation_channel_recipients('66666666-0000-0000-0000-000000000006') WHERE instance = 'x.example'),
          ARRAY['https://x.example/users/r1', 'https://x.example/users/r2'],
          'an instance''s group names its members');

-- Signed reads -----------------------------------------------------------------------------
SELECT ok(NOT ('f177a000-0000-0000-0000-0000000000c1'::uuid = ANY (
              (SELECT member_channel_ids FROM public.federation_group_access('55555555-0000-0000-0000-000000000005', 'https://x.example/users/r1'))::uuid[])),
          'a member whose instance hosts a non-viewer does not read the private channel');
SELECT ok('66666666-0000-0000-0000-000000000006'::uuid = ANY (
              (SELECT member_channel_ids FROM public.federation_group_access('55555555-0000-0000-0000-000000000005', 'https://x.example/users/r1'))::uuid[]),
          'that member still reads the channel everyone views');
SELECT ok('f177a000-0000-0000-0000-0000000000c1'::uuid = ANY (
              (SELECT member_channel_ids FROM public.federation_group_access('55555555-0000-0000-0000-000000000005', 'https://y.example/users/r3'))::uuid[]),
          'a member whose instance members all view the channel reads it');

INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f177a000-0000-0000-0000-0000000000e2', 'f177a000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005');
SELECT is((SELECT array_agg(instance ORDER BY instance) FROM public.federation_channel_recipients('f177a000-0000-0000-0000-0000000000c1')),
          ARRAY['x.example', 'y.example'],
          'once every member there views it, the instance receives the private channel');
SELECT ok('f177a000-0000-0000-0000-0000000000c1'::uuid = ANY (
              (SELECT member_channel_ids FROM public.federation_group_access('55555555-0000-0000-0000-000000000005', 'https://x.example/users/r1'))::uuid[]),
          'and its members read it');

-- History ----------------------------------------------------------------------------------
UPDATE public.server_roles SET permissions = permissions & ~4194304::bigint
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
SELECT is((public.federation_history_cutoffs('55555555-0000-0000-0000-000000000005', 'https://y.example/users/r3')
            ->> '66666666-0000-0000-0000-000000000006')::timestamptz,
          '2026-10-10T00:00:00Z'::timestamptz,
          'a member without READ_MESSAGE_HISTORY reads from its membership on');
SELECT is((public.federation_history_cutoffs('55555555-0000-0000-0000-000000000005', NULL)
            ->> '66666666-0000-0000-0000-000000000006'),
          'infinity', 'an anonymous reader reads no history of such a channel');
UPDATE public.server_roles SET permissions = permissions | 4194304::bigint
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
SELECT is(public.federation_history_cutoffs('55555555-0000-0000-0000-000000000005', 'https://y.example/users/r3'),
          '{}'::jsonb, 'with READ_MESSAGE_HISTORY there is no cutoff');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.federation_history_cutoffs('55555555-0000-0000-0000-000000000005', NULL)$q$,
                 '42501', NULL, 'federation_history_cutoffs is for service callers');
SELECT tests.clear_authentication();

-- Attachments of deleted messages ----------------------------------------------------------
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f177a000-0000-0000-0000-0000000000a1', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"file","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/f177a.png","url":"x"}]');
SELECT is(public.federation_media_access('c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/f177a.png', 'y.example'),
          true, 'a member instance reads an attachment of a live message');
UPDATE public.messages SET is_deleted = true WHERE id = 'f177a000-0000-0000-0000-0000000000a1';
SELECT is(public.federation_media_access('c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/f177a.png', 'y.example'),
          false, 'an attachment named only by a deleted message is not served');

SELECT * FROM finish();
ROLLBACK;
