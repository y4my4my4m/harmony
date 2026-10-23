-- 20261027250001_instance_staff_safety.sql: instance staff remove members and messages, suspend
-- and delete servers hosted here, each recorded as staff; a suspended server takes no new
-- messages or members; a remote account suspended here leaves every server hosted here.
--
--   staffa  instance admin            staffm  instance moderator
--   alice   owner of h182 and d182    bob     local member of h182
--   mallory joins h182 while suspended
--   rm1     remote182.test, member of h182 and of the copy c182
--   rm2     remote182.test, member of h182, suspended by the moderator
--   rm3     blocked182.test, member of h182, its domain suspended by the admin

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(51);

INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES
  ('e1820000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staffa@test.local'),
  ('e1820000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staffm@test.local');

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin, is_moderator)
VALUES
  ('f1820000-0000-0000-0000-00000000000a', 'e1820000-0000-0000-0000-00000000000a', 'staffa', 'Staff A', true, true, false),
  ('f1820000-0000-0000-0000-00000000000b', 'e1820000-0000-0000-0000-00000000000b', 'staffm', 'Staff M', true, false, true);

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, inbox_url, is_local)
VALUES
  ('f1820000-0000-0000-0000-000000000001', 'rm1', 'rm1', 'remote182.test',
   'https://remote182.test/users/rm1', 'https://remote182.test/users/rm1/inbox', false),
  ('f1820000-0000-0000-0000-000000000002', 'rm2', 'rm2', 'remote182.test',
   'https://remote182.test/users/rm2', 'https://remote182.test/users/rm2/inbox', false),
  ('f1820000-0000-0000-0000-000000000003', 'rm3', 'rm3', 'blocked182.test',
   'https://blocked182.test/users/rm3', 'https://blocked182.test/users/rm3/inbox', false);

INSERT INTO public.servers (id, name, owner, public, federation_enabled, is_local_server, ap_id)
VALUES
  ('f1820000-0000-0000-0000-0000000000a1', 'Hosted182', '11111111-0000-0000-0000-000000000001', true, true, true, NULL),
  ('f1820000-0000-0000-0000-0000000000a2', 'Copy182', '11111111-0000-0000-0000-000000000001', true, true, false,
   'https://remote182.test/servers/c182'),
  ('f1820000-0000-0000-0000-0000000000a3', 'Doomed182', '11111111-0000-0000-0000-000000000001', false, false, true, NULL);

INSERT INTO public.channels (id, server_id, name, type)
VALUES
  ('f1820000-0000-0000-0000-0000000000c1', 'f1820000-0000-0000-0000-0000000000a1', 'general', 0),
  ('f1820000-0000-0000-0000-0000000000c2', 'f1820000-0000-0000-0000-0000000000a2', 'general', 0);

INSERT INTO public.user_servers (server_id, user_id, status)
VALUES
  ('f1820000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001', 'accepted'),
  ('f1820000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000002', 'accepted'),
  ('f1820000-0000-0000-0000-0000000000a1', 'f1820000-0000-0000-0000-00000000000a', 'accepted'),
  ('f1820000-0000-0000-0000-0000000000a1', 'f1820000-0000-0000-0000-000000000001', 'accepted'),
  ('f1820000-0000-0000-0000-0000000000a1', 'f1820000-0000-0000-0000-000000000002', 'accepted'),
  ('f1820000-0000-0000-0000-0000000000a1', 'f1820000-0000-0000-0000-000000000003', 'accepted'),
  ('f1820000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002', 'accepted'),
  ('f1820000-0000-0000-0000-0000000000a2', 'f1820000-0000-0000-0000-000000000001', 'accepted'),
  ('f1820000-0000-0000-0000-0000000000a2', 'f1820000-0000-0000-0000-000000000002', 'accepted'),
  ('f1820000-0000-0000-0000-0000000000a3', '11111111-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT DO NOTHING;

INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES
  ('f1820000-0000-0000-0000-0000000000d1', 'f1820000-0000-0000-0000-0000000000c1',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"spam"}]'),
  ('f1820000-0000-0000-0000-0000000000d2', 'f1820000-0000-0000-0000-0000000000c2',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"in a copy"}]');

-- Callers ------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.staff_remove_member('f1820000-0000-0000-0000-0000000000a1',
                    'f1820000-0000-0000-0000-000000000001', false, NULL)$q$,
                 '42501', 'Instance admins and moderators only', 'a member is not instance staff');
SELECT throws_ok($q$SELECT * FROM public.staff_hosted_servers()$q$,
                 '42501', NULL, 'nor reads the hosted servers');
SELECT throws_ok($q$SELECT public.staff_set_server_suspended('f1820000-0000-0000-0000-0000000000a1', true, 'x')$q$,
                 '42501', NULL, 'nor suspends');

SELECT tests.authenticate_as('e1820000-0000-0000-0000-00000000000b');
SELECT is((SELECT array_agg(name ORDER BY name)::text FROM public.staff_hosted_servers('182')),
          ARRAY['Doomed182', 'Hosted182']::text,
          'the hosted servers list servers hosted here, not copies');
SELECT is((SELECT row(member_count, remote_member_count, total_count)::text
             FROM public.staff_hosted_servers('hosted182')),
          row(6, 3, 1::bigint)::text, 'with their member counts');
SELECT throws_ok($q$SELECT public.staff_remove_member('f1820000-0000-0000-0000-0000000000a2',
                    '22222222-0000-0000-0000-000000000002', false, NULL)$q$,
                 'P0002', NULL, 'a copy of a server hosted elsewhere is refused');
SELECT throws_ok($q$SELECT public.staff_remove_message('f1820000-0000-0000-0000-0000000000d2', NULL)$q$,
                 'P0002', NULL, 'and so is a message in it');
SELECT is((SELECT user_id FROM public.staff_server_members('f1820000-0000-0000-0000-0000000000a1') LIMIT 1),
          '11111111-0000-0000-0000-000000000001'::uuid, 'members list the owner first');
SELECT throws_ok($q$SELECT * FROM public.staff_server_messages('f1820000-0000-0000-0000-0000000000a1')$q$,
                 '22023', NULL, 'messages are read per channel or per author');
SELECT is((SELECT count(*)::int FROM public.staff_server_messages('f1820000-0000-0000-0000-0000000000a1',
                                                                   'f1820000-0000-0000-0000-0000000000c1')),
          1, 'a channel''s messages are listed');

-- Remove a member ----------------------------------------------------------------------------
SELECT lives_ok($q$SELECT public.staff_remove_member('f1820000-0000-0000-0000-0000000000a1',
                   'f1820000-0000-0000-0000-000000000001', false, 'raid account')$q$,
                'a moderator removes a member from another instance');
SELECT throws_ok($q$SELECT public.staff_remove_member('f1820000-0000-0000-0000-0000000000a1',
                    'f1820000-0000-0000-0000-00000000000a', false, NULL)$q$,
                 '42501', 'Moderators cannot act on instance staff', 'a moderator does not remove an admin');
SELECT throws_ok($q$SELECT public.staff_remove_member('f1820000-0000-0000-0000-0000000000a1',
                    '11111111-0000-0000-0000-000000000001', true, NULL)$q$,
                 '42501', NULL, 'the owner is neither removed nor banned');
SELECT throws_ok($q$SELECT public.staff_remove_member('f1820000-0000-0000-0000-0000000000a1',
                    '33333333-0000-0000-0000-000000000003', false, NULL)$q$,
                 'P0002', NULL, 'an account that is not a member is refused');
SELECT tests.clear_authentication();

SELECT ok(NOT EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f1820000-0000-0000-0000-0000000000a1'
                        AND user_id = 'f1820000-0000-0000-0000-000000000001'),
          'the membership is gone');
SELECT is((SELECT row(reason, summary, staff)::text FROM public.federation_member_removals
            WHERE server_id = 'f1820000-0000-0000-0000-0000000000a1'
              AND profile_id = 'f1820000-0000-0000-0000-000000000001'),
          row('kick', 'raid account', true)::text,
          'the Group''s Remove is queued, marked as staff, with the reason');
SELECT is((SELECT row(actor_id, reason, details ->> 'staff')::text FROM public.server_audit_log
            WHERE server_id = 'f1820000-0000-0000-0000-0000000000a1' AND action = 'member.kick'
              AND target_id = 'f1820000-0000-0000-0000-000000000001'),
          row('f1820000-0000-0000-0000-00000000000b'::uuid, 'raid account', 'true')::text,
          'the audit log names the staff member and marks the row as staff');
SELECT is((SELECT row(m.metadata ->> 'type', m.metadata ->> 'actor_id', m.metadata ->> 'staff')::text
             FROM public.messages m JOIN public.channels c ON c.id = m.channel_id
            WHERE c.server_id = 'f1820000-0000-0000-0000-0000000000a1' AND m.is_system
              AND m.metadata ->> 'type' = 'member_kick'
              AND m.metadata ->> 'subject_id' = 'f1820000-0000-0000-0000-000000000001'),
          row('member_kick', 'f1820000-0000-0000-0000-00000000000b', 'true')::text,
          'the system message names staff');
SELECT ok(EXISTS (SELECT 1 FROM public.admin_audit_log WHERE action_type = 'server_member_remove'
                   AND admin_id = 'f1820000-0000-0000-0000-00000000000b'),
          'and the instance moderation log records it');

-- Ban ----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('e1820000-0000-0000-0000-00000000000a');
SELECT lives_ok($q$SELECT public.staff_remove_member('f1820000-0000-0000-0000-0000000000a1',
                   '22222222-0000-0000-0000-000000000002', true, 'threats')$q$,
                'an admin bans a local member');
SELECT tests.clear_authentication();
SELECT is((SELECT banned_by FROM public.server_bans WHERE server_id = 'f1820000-0000-0000-0000-0000000000a1'
            AND user_id = '22222222-0000-0000-0000-000000000002'),
          'f1820000-0000-0000-0000-00000000000a'::uuid, 'the ban is stored');
SELECT is((SELECT details ->> 'staff' FROM public.server_audit_log
            WHERE server_id = 'f1820000-0000-0000-0000-0000000000a1' AND action = 'member.ban'),
          'true', 'the ban is recorded as staff');
SELECT is((SELECT count(*)::int FROM public.federation_member_removals
            WHERE profile_id = '22222222-0000-0000-0000-000000000002'),
          0, 'a local member is not sent a Remove');

-- Remove a message ---------------------------------------------------------------------------
SELECT tests.authenticate_as('e1820000-0000-0000-0000-00000000000b');
SELECT lives_ok($q$SELECT public.staff_remove_message('f1820000-0000-0000-0000-0000000000d1', 'spam link')$q$,
                'a moderator removes a message');
SELECT is(public.staff_remove_message('f1820000-0000-0000-0000-0000000000d1', NULL) ->> 'already_removed',
          'true', 'removing it again changes nothing');
SELECT tests.clear_authentication();
SELECT is((SELECT is_deleted FROM public.messages WHERE id = 'f1820000-0000-0000-0000-0000000000d1'),
          true, 'the message is removed');
SELECT is((SELECT array_agg(row(actor_id, reason, details ->> 'staff')::text)::text FROM public.server_audit_log
            WHERE server_id = 'f1820000-0000-0000-0000-0000000000a1' AND action = 'message.delete'),
          ARRAY[row('f1820000-0000-0000-0000-00000000000b'::uuid, 'spam link', 'true')::text]::text,
          'one audit row, as staff, with the reason');

-- Suspend ------------------------------------------------------------------------------------
SELECT tests.authenticate_as('e1820000-0000-0000-0000-00000000000b');
SELECT lives_ok($q$SELECT public.staff_set_server_suspended('f1820000-0000-0000-0000-0000000000a1', true, 'raids')$q$,
                'a moderator suspends the server');
SELECT tests.clear_authentication();
SELECT is((SELECT row(suspended_at IS NOT NULL, suspended_reason, suspended_by)::text FROM public.servers
            WHERE id = 'f1820000-0000-0000-0000-0000000000a1'),
          row(true, 'raids', 'f1820000-0000-0000-0000-00000000000b'::uuid)::text, 'the suspension is stored');
SELECT is((SELECT row(reason, details ->> 'staff')::text FROM public.server_audit_log
            WHERE server_id = 'f1820000-0000-0000-0000-0000000000a1' AND action = 'server.suspend'),
          row('raids', 'true')::text, 'and recorded as staff');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_like($q$INSERT INTO public.messages (channel_id, user_id, content)
                     VALUES ('f1820000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001',
                             '[{"type":"text","text":"hello"}]')$q$,
                   'SERVER_SUSPENDED%', 'the owner cannot post in a suspended server');
SELECT throws_like($q$UPDATE public.servers SET suspended_at = NULL WHERE id = 'f1820000-0000-0000-0000-0000000000a1'$q$,
                   'SERVER_SUSPENSION_STAFF_ONLY%', 'nor lift the suspension');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_like($q$SELECT public.join_public_server('f1820000-0000-0000-0000-0000000000a1')$q$,
                   'SERVER_SUSPENDED%', 'nobody joins a suspended server');
SELECT tests.clear_authentication();
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, content, is_system, metadata)
                  VALUES ('f1820000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"was kicked from the server"}]',
                          true, '{"type":"member_kick"}')$q$,
                'system messages still land');
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                  VALUES ('f1820000-0000-0000-0000-0000000000c2', '22222222-0000-0000-0000-000000000002',
                          '[{"type":"text","text":"elsewhere"}]')$q$,
                'other servers are not affected');

SELECT tests.authenticate_as('e1820000-0000-0000-0000-00000000000a');
SELECT lives_ok($q$SELECT public.staff_set_server_suspended('f1820000-0000-0000-0000-0000000000a1', false, NULL)$q$,
                'an admin lifts the suspension');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                  VALUES ('f1820000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001',
                          '[{"type":"text","text":"back"}]')$q$,
                'the owner posts again');
SELECT tests.clear_authentication();
SELECT is((SELECT suspended_at FROM public.servers WHERE id = 'f1820000-0000-0000-0000-0000000000a1'),
          NULL, 'the suspension is cleared');
SELECT ok(EXISTS (SELECT 1 FROM public.server_audit_log
                   WHERE server_id = 'f1820000-0000-0000-0000-0000000000a1' AND action = 'server.unsuspend'),
          'and the lift is recorded');

-- Remote accounts suspended here -------------------------------------------------------------
SELECT tests.authenticate_as('e1820000-0000-0000-0000-00000000000b');
SELECT lives_ok($q$SELECT public.moderate_user(NULL, 'f1820000-0000-0000-0000-000000000002', 'suspend', 'spam')$q$,
                'a moderator suspends a remote account');
SELECT tests.clear_authentication();
SELECT is((SELECT row(reason, staff)::text FROM public.federation_member_removals
            WHERE server_id = 'f1820000-0000-0000-0000-0000000000a1'
              AND profile_id = 'f1820000-0000-0000-0000-000000000002'),
          row('suspended', true)::text, 'it leaves the server hosted here with a Remove');
SELECT ok(EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f1820000-0000-0000-0000-0000000000a2'
                    AND user_id = 'f1820000-0000-0000-0000-000000000002'),
          'a server hosted elsewhere keeps it');
SELECT is((SELECT row(actor_id, details ->> 'cause', details ->> 'staff')::text FROM public.server_audit_log
            WHERE server_id = 'f1820000-0000-0000-0000-0000000000a1' AND action = 'member.kick'
              AND target_id = 'f1820000-0000-0000-0000-000000000002'),
          row('f1820000-0000-0000-0000-00000000000b'::uuid, 'account_suspended', 'true')::text,
          'the server''s audit log says why');

SELECT tests.authenticate_as('e1820000-0000-0000-0000-00000000000a');
SELECT lives_ok($q$SELECT public.set_domain_moderation('blocked182.test', 'suspend', 'abuse')$q$,
                'an admin suspends a domain');
SELECT tests.clear_authentication();
SELECT is((SELECT row(reason, staff)::text FROM public.federation_member_removals
            WHERE profile_id = 'f1820000-0000-0000-0000-000000000003'),
          row('suspended', true)::text, 'its members leave the servers hosted here');
SELECT is((SELECT details ->> 'cause' FROM public.server_audit_log
            WHERE action = 'member.kick' AND target_id = 'f1820000-0000-0000-0000-000000000003'),
          'domain_suspended', 'recorded as a domain suspension');

-- Delete -------------------------------------------------------------------------------------
SELECT tests.authenticate_as('e1820000-0000-0000-0000-00000000000a');
SELECT is(public.staff_delete_server('f1820000-0000-0000-0000-0000000000a3', 'abandoned spam') ->> 'members',
          '1', 'an admin deletes a server');
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM public.servers WHERE id = 'f1820000-0000-0000-0000-0000000000a3'),
          'the server is gone');
SELECT is((SELECT action_details ->> 'reason' FROM public.admin_audit_log
            WHERE action_type = 'server_delete' AND target_id = 'f1820000-0000-0000-0000-0000000000a3'),
          'abandoned spam', 'the instance moderation log keeps it');

-- Privileges ---------------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.staff_remove_member(uuid, uuid, boolean, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.staff_remove_member(uuid, uuid, boolean, text)', 'EXECUTE'),
          'signed-in clients reach the staff functions; anon does not');
SELECT ok(NOT has_function_privilege('authenticated', 'public.staff_caller(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.remove_suspended_remote_members(uuid[], text)', 'EXECUTE'),
          'the helpers are not client endpoints');

SELECT * FROM finish();
ROLLBACK;
