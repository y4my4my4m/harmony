-- Final review: server-presence:<server> (which carries member:update bio/pronouns/avatar) is
-- subscribable by accepted members only; and moderate_server_profile's reset audit row is written
-- only when something was cleared (20261112100004_server_profile_review_fixes.sql).
--
--   owner mallory (33..) owns the server; alice (11..) accepted; pend (f249..c1) pending;
--   bob (22..) not a member of the server.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(7);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2490000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pend249@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f2490000-0000-0000-0000-0000000000c1', 'f2490000-0000-0000-0000-0000000000a1', 'pend249', 'Pend', true);
INSERT INTO public.servers (id, name, owner) VALUES
  ('f2490000-0000-0000-0000-000000000001', 'Presence249', '33333333-0000-0000-0000-000000000003');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('33333333-0000-0000-0000-000000000003', 'f2490000-0000-0000-0000-000000000001', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', 'f2490000-0000-0000-0000-000000000001', 'accepted'),
  ('f2490000-0000-0000-0000-0000000000c1', 'f2490000-0000-0000-0000-000000000001', 'pending')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = EXCLUDED.status;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.can_subscribe_to_topic('server-presence:f2490000-0000-0000-0000-000000000001'), true,
          'an accepted member can subscribe to server presence');
SELECT tests.authenticate_as('f2490000-0000-0000-0000-0000000000a1');
SELECT is(public.can_subscribe_to_topic('server-presence:f2490000-0000-0000-0000-000000000001'), false,
          'a pending applicant cannot');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.can_subscribe_to_topic('server-presence:f2490000-0000-0000-0000-000000000001'), false,
          'a non-member cannot');
SELECT tests.clear_authentication();

-- reset audit only when something changed ---------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.moderate_server_profile('f2490000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
                                      NULL, false, true);
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = 'f2490000-0000-0000-0000-000000000001' AND action = 'member.profile_reset'),
          0, 'resetting an already-empty profile writes no audit row');

UPDATE public.user_servers SET bio = 'hello'
 WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2490000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.moderate_server_profile('f2490000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
                                      NULL, false, true);
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = 'f2490000-0000-0000-0000-000000000001' AND action = 'member.profile_reset'),
          1, 'resetting a non-empty profile writes exactly one');
SELECT is((SELECT bio FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2490000-0000-0000-0000-000000000001'),
          NULL, 'and clears it');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.moderate_server_profile('f2490000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
                                      NULL, false, true);
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = 'f2490000-0000-0000-0000-000000000001' AND action = 'member.profile_reset'),
          1, 'a second reset adds none');

SELECT * FROM finish();
ROLLBACK;
