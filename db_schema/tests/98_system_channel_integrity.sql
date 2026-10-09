-- 20261009500001_system_channel_integrity.sql: server_settings.system_channel_id names a
-- channel of its own server or is NULL, and deleting that channel never blocks a join.
--
--   server_1 (55555555-...05)  owner alice; announcements (98...a1)
--   server_2 (98...02)         owner bob; lobby (98...b1)
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(10);

INSERT INTO public.servers (id, name, owner)
VALUES ('98000000-0000-0000-0000-000000000002', 'Other Server', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('98000000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'announcements', 0),
  ('98000000-0000-0000-0000-0000000000b1', '98000000-0000-0000-0000-000000000002', 'lobby', 0);
INSERT INTO public.server_settings (server_id)
VALUES ('55555555-0000-0000-0000-000000000005')
ON CONFLICT (server_id) DO NOTHING;

-- Shape. ------------------------------------------------------------------------------------------
SELECT is((SELECT confdeltype::text FROM pg_constraint
            WHERE conrelid = 'public.server_settings'::regclass
              AND conname = 'server_settings_system_channel_id_fkey'),
          'n', 'system_channel_id references channels ON DELETE SET NULL');
SELECT ok(NOT has_function_privilege('authenticated', 'public.server_settings_system_channel_check()', 'EXECUTE'),
          'authenticated cannot call the check');

-- Writes. -----------------------------------------------------------------------------------------
SELECT throws_ok($$UPDATE public.server_settings SET system_channel_id = '98000000-0000-0000-0000-0000000000b1'
                    WHERE server_id = '55555555-0000-0000-0000-000000000005'$$,
                 '23514', NULL, 'another server''s channel is refused');
SELECT throws_ok($$UPDATE public.server_settings SET system_channel_id = '98000000-0000-0000-0000-0000000000ff'
                    WHERE server_id = '55555555-0000-0000-0000-000000000005'$$,
                 '23514', NULL, 'a missing channel is refused');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$UPDATE public.server_settings SET system_channel_id = '98000000-0000-0000-0000-0000000000a1'
                   WHERE server_id = '55555555-0000-0000-0000-000000000005'$$,
                'the owner sets a channel of the server');
SELECT tests.clear_authentication();
SELECT is((SELECT system_channel_id FROM public.server_settings WHERE server_id = '55555555-0000-0000-0000-000000000005'),
          '98000000-0000-0000-0000-0000000000a1'::uuid, 'the owner''s write is stored');

-- Joins post to the system channel, then fall back once it is deleted. ----------------------------
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = '98000000-0000-0000-0000-0000000000a1' AND metadata ->> 'type' = 'member_join'),
          1, 'a join posts in the system channel');
DELETE FROM public.user_servers
 WHERE user_id = '33333333-0000-0000-0000-000000000003' AND server_id = '55555555-0000-0000-0000-000000000005';

DELETE FROM public.channels WHERE id = '98000000-0000-0000-0000-0000000000a1';
SELECT is((SELECT system_channel_id FROM public.server_settings WHERE server_id = '55555555-0000-0000-0000-000000000005'),
          NULL::uuid, 'deleting the system channel clears the setting');

SELECT lives_ok($$INSERT INTO public.user_servers (user_id, server_id, status)
                  VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted')$$,
                'a join after the system channel is deleted succeeds');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = public.get_default_channel('55555555-0000-0000-0000-000000000005')
              AND metadata ->> 'type' = 'member_join'
              AND user_id = '33333333-0000-0000-0000-000000000003'),
          1, 'that join posts in the default channel');

SELECT * FROM finish();
ROLLBACK;
