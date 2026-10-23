-- 20261027300001_instance_remote_server_tools.sql: instance staff remove local members from a
-- server hosted elsewhere (notice, queued Leave, optional keep-out), block it (every local member
-- leaves, joins refused) and hide its media, on this instance only. Members and clients write
-- nothing directly; a member reads only their own keep-out. The upgrade turns bans made on copies
-- into keep-outs of local accounts and deletes them.
--
--   copy183   is_local_server false: bob, mallory, rm183 (remote.test) accepted
--   local183  a local server
--   alice     instance admin; banned (fixture) instance moderator

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(56);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
UPDATE public.profiles SET is_moderator = true WHERE id = '44444444-0000-0000-0000-000000000004';

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, inbox_url, is_local)
VALUES ('f1830000-0000-0000-0000-000000000001', 'rm183', 'rm183', 'remote.test',
        'https://remote.test/users/rm183', 'https://remote.test/users/rm183/inbox', false);

INSERT INTO public.servers (id, name, owner, public, federation_enabled, is_local_server, ap_id, host_domain)
VALUES
  ('f1830000-0000-0000-0000-0000000000c1', 'Elsewhere', 'f1830000-0000-0000-0000-000000000001', true, true, false,
   'https://remote.test/servers/f1830000-0000-0000-0000-0000000000c1', 'remote.test'),
  ('f1830000-0000-0000-0000-0000000000c2', 'Home', '11111111-0000-0000-0000-000000000001', true, true, true, NULL, NULL);

INSERT INTO public.user_servers (server_id, user_id, status)
VALUES
  ('f1830000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', 'accepted'),
  ('f1830000-0000-0000-0000-0000000000c1', '33333333-0000-0000-0000-000000000003', 'accepted'),
  ('f1830000-0000-0000-0000-0000000000c1', 'f1830000-0000-0000-0000-000000000001', 'accepted'),
  ('f1830000-0000-0000-0000-0000000000c2', '22222222-0000-0000-0000-000000000002', 'accepted')
ON CONFLICT DO NOTHING;

-- Structure and grants -----------------------------------------------------------------------
SELECT has_table('public', 'instance_server_blocks', 'instance_server_blocks exists');
SELECT has_table('public', 'instance_server_keepouts', 'instance_server_keepouts exists');
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.instance_server_leaves', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.instance_server_leaves', 'SELECT'),
  'clients cannot read instance_server_leaves');
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.instance_server_blocks', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.instance_server_blocks', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.instance_server_keepouts', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.instance_server_keepouts', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.instance_server_blocks', 'SELECT'),
  'clients change blocks and keep-outs only through the RPCs');
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.instance_server_member_leaves(uuid, uuid, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.instance_keepouts_from_copy_bans()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.instance_keepouts_from_copy_bans()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.instance_set_server_blocked(uuid, boolean, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.instance_media_hidden_servers()', 'EXECUTE'),
  'the internal functions are no client''s, the staff RPCs not anon''s');
SELECT ok(
  has_function_privilege('authenticated', 'public.instance_remove_member(uuid, uuid, boolean, text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.instance_remote_servers(uuid)', 'EXECUTE'),
  'signed-in clients reach the staff RPCs, which check the caller');

-- Not staff ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.instance_remove_member('f1830000-0000-0000-0000-0000000000c1', '33333333-0000-0000-0000-000000000003')$q$,
                 '42501', NULL, 'a member who is not staff removes nobody');
SELECT throws_ok($q$SELECT public.instance_set_server_blocked('f1830000-0000-0000-0000-0000000000c1', true)$q$,
                 '42501', NULL, 'a member who is not staff blocks nothing');
SELECT throws_ok($q$SELECT public.instance_set_server_media_hidden('f1830000-0000-0000-0000-0000000000c1', true)$q$,
                 '42501', NULL, 'nor hides media');
SELECT throws_ok($q$SELECT * FROM public.instance_remote_servers()$q$,
                 '42501', NULL, 'nor lists the servers');
SELECT tests.clear_authentication();

-- Refusals -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.instance_set_server_blocked('f1830000-0000-0000-0000-0000000000c2', true)$q$,
                 '22023', NULL, 'a server hosted here is not blocked through these tools');
SELECT throws_ok($q$SELECT public.instance_remove_member('f1830000-0000-0000-0000-0000000000c2', '22222222-0000-0000-0000-000000000002')$q$,
                 '22023', NULL, 'nor are its members removed');
SELECT throws_ok($q$SELECT public.instance_remove_member('f1830000-0000-0000-0000-0000000000c1', 'f1830000-0000-0000-0000-000000000001')$q$,
                 '22023', NULL, 'a member from another instance is not removed');
SELECT throws_ok($q$SELECT public.instance_remove_member('f1830000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001')$q$,
                 '22023', NULL, 'staff do not remove themselves');

-- Remove with keep-out -----------------------------------------------------------------------
SELECT is(public.instance_remove_member('f1830000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002',
                                        true, '  spam links  ')::text,
          '{"removed": true, "kept_out": true}', 'an admin removes bob and keeps him out');
SELECT tests.clear_authentication();

SELECT ok(NOT EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f1830000-0000-0000-0000-0000000000c1'
                        AND user_id = '22222222-0000-0000-0000-000000000002'),
          'bob is no longer a member');
SELECT ok(EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f1830000-0000-0000-0000-0000000000c2'
                    AND user_id = '22222222-0000-0000-0000-000000000002'),
          'his other servers are untouched');
SELECT is((SELECT concat_ws('/', data->>'action', data->>'reason', data->'server'->>'id', data->'server'->>'name')
             FROM public.notifications
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'server_instance_removed'),
          'remove/spam links/f1830000-0000-0000-0000-0000000000c1/Elsewhere',
          'bob is told, with the reason');
SELECT is((SELECT reason FROM public.instance_server_leaves
            WHERE server_id = 'f1830000-0000-0000-0000-0000000000c1'
              AND profile_id = '22222222-0000-0000-0000-000000000002' AND delivered_at IS NULL),
          'removed', 'his Leave is queued');
SELECT is((SELECT reason || '/' || set_by FROM public.instance_server_keepouts
            WHERE server_id = 'f1830000-0000-0000-0000-0000000000c1'
              AND profile_id = '22222222-0000-0000-0000-000000000002'),
          'spam links/11111111-0000-0000-0000-000000000001', 'the keep-out names the reason and who set it');
SELECT ok(EXISTS (SELECT 1 FROM public.admin_audit_log
                   WHERE action_type = 'instance_server_member_removed'
                     AND target_id = '22222222-0000-0000-0000-000000000002'
                     AND action_details->>'kept_out' = 'true'),
          'the removal is audit-logged');
SELECT ok(EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f1830000-0000-0000-0000-0000000000c1'
                    AND user_id = 'f1830000-0000-0000-0000-000000000001'),
          'the member from another instance stays');
SELECT throws_ok($q$INSERT INTO public.user_servers (server_id, user_id, status)
                   VALUES ('f1830000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', 'accepted')$q$,
                 '42501', 'KEPT_OUT_HERE: this instance keeps the account out of the server',
                 'bob cannot rejoin');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.instance_server_keepouts), 1, 'bob reads his own keep-out');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.instance_server_keepouts), 0, 'another member reads none');
SELECT tests.clear_authentication();

-- Moderator ----------------------------------------------------------------------------------
INSERT INTO public.user_servers (server_id, user_id, status)
VALUES ('f1830000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', 'accepted');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($q$SELECT public.instance_remove_member('f1830000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'a moderator does not remove instance staff');
SELECT is(public.instance_remove_member('f1830000-0000-0000-0000-0000000000c1', '33333333-0000-0000-0000-000000000003')::text,
          '{"removed": true, "kept_out": false}', 'a moderator removes mallory without keeping her out');
SELECT is(public.instance_remove_member('f1830000-0000-0000-0000-0000000000c1', '33333333-0000-0000-0000-000000000003')::text,
          '{"removed": false, "kept_out": false}', 'removing her again changes nothing');
SELECT tests.clear_authentication();
SELECT is((SELECT data->>'reason' FROM public.notifications
            WHERE user_id = '33333333-0000-0000-0000-000000000003' AND type = 'server_instance_removed'),
          NULL, 'mallory is told, without a reason');
SELECT lives_ok($q$INSERT INTO public.user_servers (server_id, user_id, status)
                  VALUES ('f1830000-0000-0000-0000-0000000000c1', '33333333-0000-0000-0000-000000000003', 'accepted')$q$,
                'mallory can rejoin');

-- Lift ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT string_agg(username || ':' || standing, ',' ORDER BY username)
             FROM public.instance_remote_server_people('f1830000-0000-0000-0000-0000000000c1')),
          'alice:accepted,bob:kept_out,mallory:accepted',
          'the people list holds local members and kept-out accounts, never remote members');
SELECT is(public.instance_lift_keepout('f1830000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002'),
          true, 'an admin lifts the keep-out');
SELECT is(public.instance_lift_keepout('f1830000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002'),
          false, 'lifting it again finds none');
SELECT tests.clear_authentication();
SELECT lives_ok($q$INSERT INTO public.user_servers (server_id, user_id, status)
                  VALUES ('f1830000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', 'accepted')$q$,
                'bob can rejoin');

-- Block --------------------------------------------------------------------------------------
DELETE FROM public.notifications WHERE type = 'server_instance_removed';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.instance_set_server_blocked('f1830000-0000-0000-0000-0000000000c1', true, 'harassment')::text,
          '{"blocked": true, "members_removed": 3}', 'blocking removes the three local members');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM public.user_servers us JOIN public.profiles p ON p.id = us.user_id
            WHERE us.server_id = 'f1830000-0000-0000-0000-0000000000c1' AND p.is_local IS TRUE),
          0, 'no local membership is left');
SELECT ok(EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f1830000-0000-0000-0000-0000000000c1'
                    AND user_id = 'f1830000-0000-0000-0000-000000000001'),
          'the member from another instance is untouched');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE type = 'server_instance_removed' AND data->>'action' = 'block'),
          3, 'each is told the server was blocked');
SELECT is((SELECT count(*)::int FROM public.instance_server_leaves
            WHERE server_id = 'f1830000-0000-0000-0000-0000000000c1' AND reason = 'blocked'),
          3, 'and each Leave is queued');
SELECT throws_ok($q$INSERT INTO public.user_servers (server_id, user_id, status)
                   VALUES ('f1830000-0000-0000-0000-0000000000c1', '33333333-0000-0000-0000-000000000003', 'pending')$q$,
                 '42501', 'SERVER_BLOCKED_HERE: this instance blocked the server',
                 'nobody here joins a blocked server');
SELECT lives_ok($q$INSERT INTO public.user_servers (server_id, user_id, status)
                  VALUES ('f1830000-0000-0000-0000-0000000000c1', 'f1830000-0000-0000-0000-000000000001', 'accepted')
                  ON CONFLICT (server_id, user_id) DO NOTHING$q$,
                'the copy still records members from other instances');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is((SELECT concat_ws('/', blocked::text, local_members, kept_out, reason, host)
             FROM public.instance_remote_servers('f1830000-0000-0000-0000-0000000000c1')),
          'true/0/0/harassment/remote.test', 'a moderator reads the block, its reason and the host');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.instance_remote_servers() WHERE server_id = 'f1830000-0000-0000-0000-0000000000c2'),
          'servers hosted here are not listed');
SELECT is(public.instance_set_server_blocked('f1830000-0000-0000-0000-0000000000c1', true)::text,
          '{"blocked": true, "members_removed": 0}', 'blocking again removes nobody');
SELECT is((SELECT reason FROM public.instance_server_blocks WHERE server_id = 'f1830000-0000-0000-0000-0000000000c1'),
          'harassment', 'and keeps the reason');
SELECT is(public.instance_set_server_blocked('f1830000-0000-0000-0000-0000000000c1', false)::text,
          '{"blocked": false, "members_removed": 0}', 'a moderator allows it again');
SELECT tests.clear_authentication();
SELECT ok(EXISTS (SELECT 1 FROM public.admin_audit_log WHERE action_type = 'instance_server_blocked'
                    AND target_id = 'f1830000-0000-0000-0000-0000000000c1')
          AND EXISTS (SELECT 1 FROM public.admin_audit_log WHERE action_type = 'instance_server_unblocked'),
          'block and unblock are audit-logged');
SELECT lives_ok($q$INSERT INTO public.user_servers (server_id, user_id, status)
                  VALUES ('f1830000-0000-0000-0000-0000000000c1', '33333333-0000-0000-0000-000000000003', 'accepted')$q$,
                'joins work again once it is allowed');

-- Media --------------------------------------------------------------------------------------
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is(public.instance_set_server_media_hidden('f1830000-0000-0000-0000-0000000000c1', true), true,
          'a moderator hides its media');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT ok('f1830000-0000-0000-0000-0000000000c1'::uuid IN (SELECT public.instance_media_hidden_servers()),
          'every signed-in client reads which servers have media hidden');
SELECT is((SELECT count(*)::int FROM public.instance_server_blocks), 0, 'but not the staff rows');
SELECT tests.clear_authentication();

-- Upgrade ------------------------------------------------------------------------------------
INSERT INTO public.servers (id, name, owner, public, federation_enabled, is_local_server, ap_id)
VALUES ('f1830000-0000-0000-0000-0000000000c3', 'Banned here', 'f1830000-0000-0000-0000-000000000001', true, true, false,
        'https://remote.test/servers/f1830000-0000-0000-0000-0000000000c3');
INSERT INTO public.user_servers (server_id, user_id, status)
VALUES ('f1830000-0000-0000-0000-0000000000c3', '44444444-0000-0000-0000-000000000004', 'banned');
INSERT INTO public.server_bans (server_id, user_id, banned_by, reason)
VALUES ('f1830000-0000-0000-0000-0000000000c3', '33333333-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', 'flood'),
       ('f1830000-0000-0000-0000-0000000000c3', 'f1830000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', NULL),
       ('f1830000-0000-0000-0000-0000000000c2', '33333333-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', 'home ban');

SELECT is(public.instance_keepouts_from_copy_bans(), 2,
          'each local account banned on a copy, by a ban row or a banned membership, is kept out');
SELECT is((SELECT string_agg(profile_id::text || '/' || coalesce(reason, '-'), ',' ORDER BY profile_id)
             FROM public.instance_server_keepouts WHERE server_id = 'f1830000-0000-0000-0000-0000000000c3'),
          '33333333-0000-0000-0000-000000000003/flood,44444444-0000-0000-0000-000000000004/-',
          'keeping the ban''s reason');
SELECT is((SELECT count(*)::int FROM public.server_bans WHERE server_id = 'f1830000-0000-0000-0000-0000000000c3')
          + (SELECT count(*)::int FROM public.user_servers WHERE server_id = 'f1830000-0000-0000-0000-0000000000c3'),
          0, 'every ban of the copy is gone, a remote member''s too');
SELECT ok(EXISTS (SELECT 1 FROM public.server_bans WHERE server_id = 'f1830000-0000-0000-0000-0000000000c2'),
          'a ban on a server hosted here stays');
SELECT is(public.instance_keepouts_from_copy_bans(), 0, 'a second run changes nothing');

SELECT * FROM finish();
ROLLBACK;
