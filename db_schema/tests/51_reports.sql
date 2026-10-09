-- Reports after 20261005000001_reports_federation_parity.sql: client writes through
-- create_report, moderator writes through moderate_report, federated reports through
-- create_federated_report, domain limits through set_domain_moderation.
--
--   alice    owner of server_1, author of the reported content; not an instance admin here
--   bob      member of server_1, reporter
--   mallory  member of nothing
--   srvmod   member of server_1 holding MANAGE_MESSAGES
--   repmod   instance moderator
--   repadmin instance admin
--   faraway  remote account on remote.example

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(72);

-- promote_first_user_to_admin made alice an instance admin in the fixtures.
UPDATE public.profiles SET is_admin = false WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('dddddddd-0000-0000-0000-000000000051', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'srvmod@test.local'),
  ('eeeeeeee-0000-0000-0000-000000000051', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'repmod@test.local'),
  ('ffffffff-0000-0000-0000-000000000051', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'repadmin@test.local');

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_moderator, is_admin) VALUES
  ('51000000-0000-0000-0000-00000000000d', 'dddddddd-0000-0000-0000-000000000051', 'srvmod', 'Server Mod', true, false, false),
  ('51000000-0000-0000-0000-00000000000e', 'eeeeeeee-0000-0000-0000-000000000051', 'repmod', 'Rep Mod', true, true, false),
  ('51000000-0000-0000-0000-00000000000f', 'ffffffff-0000-0000-0000-000000000051', 'repadmin', 'Rep Admin', true, false, true);

INSERT INTO public.profiles (id, username, display_name, domain, is_local, federated_id, inbox_url, shared_inbox_url) VALUES
  ('51000000-0000-0000-0000-0000000000a1', 'faraway', 'Far Away', 'remote.example', false,
   'https://remote.example/users/faraway', 'https://remote.example/users/faraway/inbox', 'https://remote.example/inbox'),
  ('51000000-0000-0000-0000-0000000000a2', 'quiet', 'Already Quiet', 'remote.example', false,
   'https://remote.example/users/quiet', 'https://remote.example/users/quiet/inbox', 'https://remote.example/inbox');
UPDATE public.profiles SET is_silenced = true, silenced_at = now() - interval '1 day', silenced_reason = 'own'
 WHERE id = '51000000-0000-0000-0000-0000000000a2';

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('51000000-0000-0000-0000-00000000000d', '55555555-0000-0000-0000-000000000005', 'accepted');
-- MANAGE_MESSAGES is bit 21.
INSERT INTO public.server_roles (id, server_id, name, permissions)
VALUES ('51000000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'Mods', 1::bigint << 21);
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('51000000-0000-0000-0000-00000000000d', '51000000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('51000000-0000-0000-0000-0000000000b1', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"public post"}]', 'public'),
  ('51000000-0000-0000-0000-0000000000b2', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"followers post"}]', 'followers'),
  ('51000000-0000-0000-0000-0000000000b3', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob post"}]', 'public');

INSERT INTO public.messages (id, channel_id, user_id, content, encrypted) VALUES
  ('51000000-0000-0000-0000-0000000000c1', '66666666-0000-0000-0000-000000000006',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"ciphertext"}]', true);

-- Surface ---------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.moderate_report(uuid, text, text, text, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_reports_with_details(text, integer, integer, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_domain_moderation(text, text, text)', 'EXECUTE'),
          'anon calls none of the report RPCs');
SELECT ok(NOT has_function_privilege('authenticated', 'public.create_federated_report(text, text, text, uuid, uuid[], text, text[])', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.report_content_snapshot(uuid, uuid[], uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.create_federated_report(text, text, text, uuid, uuid[], text, text[])', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.create_federated_report(text, text, text, uuid, uuid[], text, text[])', 'EXECUTE'),
          'federated reports and snapshots are service-side');
SELECT ok(NOT has_table_privilege('authenticated', 'public.reports', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.reports', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.reports', 'DELETE')
          AND NOT has_table_privilege('anon', 'public.reports', 'SELECT'),
          'clients write no report rows directly');
SELECT ok(has_column_privilege('authenticated', 'public.reports', 'status', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.reports', 'resolved_by', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.reports', 'assigned_to', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.reports', 'content_snapshot', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.reports', 'resolution_note', 'SELECT'),
          'reporters read no moderator identity, note or snapshot');
SELECT ok(NOT has_table_privilege('authenticated', 'public.instance_actor_keys', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.instance_actor_keys', 'SELECT'),
          'the instance actor key is not readable by clients');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = 'public.reports'::regclass AND polcmd <> 'r'),
          0, 'reports carries no write policy');

-- create_report ---------------------------------------------------------------------
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid) ON COMMIT DROP;
CREATE TEMP TABLE fed (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON ids, fed TO PUBLIC;

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');

INSERT INTO ids SELECT 'msg', public.create_report('message', p_reported_message_id => '88888888-0000-0000-0000-000000000008',
    p_reason => 'harassment', p_comment => 'rude', p_evidence_text => 'ignored for plaintext');
SELECT isnt((SELECT v FROM ids WHERE k = 'msg'), NULL, 'a member reports a channel message');
SELECT is(public.create_report('message', p_reported_message_id => '88888888-0000-0000-0000-000000000008', p_reason => 'spam'),
          (SELECT v FROM ids WHERE k = 'msg'), 'a second report on the same target returns the open one');

INSERT INTO ids SELECT 'dm', public.create_report('message', p_reported_message_id => '99999999-0000-0000-0000-000000000009');
INSERT INTO ids SELECT 'enc', public.create_report('message', p_reported_message_id => '51000000-0000-0000-0000-0000000000c1',
    p_evidence_text => 'the plaintext bob saw');
INSERT INTO ids SELECT 'post', public.create_report('post', p_reported_post_id => '51000000-0000-0000-0000-0000000000b1',
    p_reason => 'illegal_content');
INSERT INTO ids SELECT 'remote_fwd', public.create_report('user', p_reported_user_id => '51000000-0000-0000-0000-0000000000a1',
    p_reason => 'spam', p_forward => true);
INSERT INTO ids SELECT 'local_fwd', public.create_report('user', p_reported_user_id => '11111111-0000-0000-0000-000000000001',
    p_reason => 'other', p_forward => true);
INSERT INTO ids SELECT 'remote_nofwd', public.create_report('user', p_reported_user_id => '51000000-0000-0000-0000-0000000000a2',
    p_reason => 'nsfw');

SELECT throws_ok($q$SELECT public.create_report('message', p_reported_message_id => '88888888-0000-0000-0000-000000000008',
                     p_reported_user_id => '33333333-0000-0000-0000-000000000003')$q$,
                 '22023', NULL, 'the reported account must be the author');
SELECT throws_ok($q$SELECT public.create_report('post', p_reported_post_id => '51000000-0000-0000-0000-0000000000b2')$q$,
                 'P0002', 'Post not found', 'a followers-only post is not reportable by a non-follower');
SELECT throws_ok($q$SELECT public.create_report('post', p_reported_post_id => '51000000-0000-0000-0000-0000000000b3')$q$,
                 '22023', 'Cannot report yourself', 'nobody reports themselves');
SELECT throws_ok($q$SELECT public.create_report('user', p_reported_user_id => '11111111-0000-0000-0000-000000000001', p_category => 'gossip')$q$,
                 '22023', NULL, 'categories are spam, legal, violation and other');
SELECT throws_ok($q$SELECT public.create_report('channel')$q$, '22023', NULL, 'report types are fixed');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.create_report('message', p_reported_message_id => '88888888-0000-0000-0000-000000000008')$q$,
                 'P0002', 'Message not found', 'a non-member cannot report a channel message');
SELECT throws_ok($q$SELECT public.create_report('message', p_reported_message_id => '99999999-0000-0000-0000-000000000009')$q$,
                 'P0002', 'Message not found', 'a non-participant cannot report a DM');
SELECT tests.clear_authentication();

INSERT INTO public.reports (reporter_id, reported_user_id, reason, report_type, content_snapshot)
SELECT '33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', 'spam', 'user', '{}'
  FROM generate_series(1, 20);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.create_report('user', p_reported_user_id => '11111111-0000-0000-0000-000000000001')$q$,
                 'PT429', 'Report rate limit exceeded', 'a reporter files at most 20 reports an hour');
SELECT tests.clear_authentication();
DELETE FROM public.reports WHERE reporter_id = '33333333-0000-0000-0000-000000000003';

SELECT is((SELECT count(*)::int FROM public.reports WHERE reporter_id = '22222222-0000-0000-0000-000000000002'),
          7, 'seven reports from bob, the duplicate folded into the first');

SELECT results_eq(
    $q$SELECT reported_user_id, scope_server_id, category, reason, comment, status, source, forward, federation_status
         FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'msg')$q$,
    $q$VALUES ('11111111-0000-0000-0000-000000000001'::uuid, '55555555-0000-0000-0000-000000000005'::uuid,
               'violation', 'harassment', 'rude', 'pending', 'local', false, 'skipped')$q$,
    'a message report derives its author, scope and category');
SELECT is((SELECT content_snapshot->'message'->'content'->0->>'text' FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'msg')),
          'channel message', 'the snapshot holds the message as reported');
SELECT is((SELECT content_snapshot->'message' ? 'evidence_text' FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'msg')),
          false, 'reporter text is not stored for a plaintext message');
SELECT is((SELECT content_snapshot->'account'->>'username' FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'msg')),
          'alice', 'the snapshot holds the reported account');
SELECT results_eq(
    $q$SELECT content_snapshot->'message'->>'evidence_text', content_snapshot->'message'->>'evidence_source'
         FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'enc')$q$,
    $q$VALUES ('the plaintext bob saw', 'reporter')$q$,
    'an encrypted message keeps the reporter''s plaintext, marked as theirs');
SELECT is((SELECT scope_server_id FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'dm')),
          NULL::uuid, 'a DM report has no server scope');
SELECT results_eq(
    $q$SELECT report_type, reported_user_id, category, content_snapshot->'posts'->0->'content'->0->>'text'
         FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'post')$q$,
    $q$VALUES ('post', '11111111-0000-0000-0000-000000000001'::uuid, 'legal', 'public post')$q$,
    'a post report derives its author and keeps the post');
SELECT results_eq(
    $q$SELECT forward, federation_status FROM public.reports
        WHERE id IN ((SELECT v FROM ids WHERE k = 'remote_fwd'), (SELECT v FROM ids WHERE k = 'local_fwd'))
        ORDER BY reported_user_id = '11111111-0000-0000-0000-000000000001'$q$,
    $q$VALUES (true, 'queued'), (false, 'skipped')$q$,
    'forwarding is queued for a remote account and ignored for a local one');

UPDATE public.messages SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true
 WHERE id = '88888888-0000-0000-0000-000000000008';
UPDATE public.profiles SET display_name = 'Renamed' WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT results_eq(
    $q$SELECT content_snapshot->'message'->'content'->0->>'text', content_snapshot->'account'->>'display_name'
         FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'msg')$q$,
    $q$VALUES ('channel message', 'Alice')$q$,
    'deleting the message and renaming the account leave the evidence intact');

-- Reading -----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(status)::int FROM public.reports), 7, 'a reporter reads its own reports');
SELECT throws_ok($q$SELECT resolved_by FROM public.reports$q$, '42501', NULL, 'a reporter cannot read resolved_by');
SELECT throws_ok($q$SELECT * FROM public.get_reports_with_details()$q$, '42501', NULL,
                 'a reporter cannot list the queue');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.reports), 0, 'a stranger sees no reports');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.reports), 2,
          'the server owner sees the reports scoped to the server');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000051');
SELECT is((SELECT count(*)::int FROM public.reports), 2,
          'a MANAGE_MESSAGES holder sees the reports scoped to the server');
SELECT throws_ok($q$SELECT * FROM public.get_reports_with_details()$q$, '42501', NULL,
                 'a server moderator cannot list the instance queue');
SELECT results_eq(
    $q$SELECT count(*)::int, count(reporter_id)::int, count(reporter_username)::int, max(total_count)::int
         FROM public.get_reports_with_details(p_server_id => '55555555-0000-0000-0000-000000000005')$q$,
    $q$VALUES (2, 0, 0, 2)$q$,
    'a server moderator lists the server''s reports without the reporter');

SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000051');
SELECT is((SELECT count(*)::int FROM public.reports), 7, 'an instance moderator sees every report');
SELECT results_eq(
    $q$SELECT reporter_username, reported_user_username, reported_message_is_deleted, open_reports_on_target::int
         FROM public.get_reports_with_details() WHERE id = (SELECT v FROM ids WHERE k = 'msg')$q$,
    $q$VALUES ('bob', 'alice', true, 5)$q$,
    'an instance moderator sees reporter, account, deletion state and open report count');
SELECT is((SELECT count(*)::int FROM public.get_reports_with_details(p_status => 'pending', p_limit => 2)),
          2, 'the queue pages');
SELECT tests.clear_authentication();

-- moderate_report -----------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.moderate_report((SELECT v FROM ids WHERE k = 'msg'), 'resolve')$q$,
                 '42501', NULL, 'a reporter cannot settle its report');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000051');
SELECT throws_ok($q$SELECT public.moderate_report((SELECT v FROM ids WHERE k = 'msg'), 'suspend_account')$q$,
                 '42501', NULL, 'a server moderator cannot suspend accounts');
SELECT throws_ok($q$SELECT public.moderate_report((SELECT v FROM ids WHERE k = 'dm'), 'resolve')$q$,
                 '42501', NULL, 'a server moderator cannot settle reports outside the server');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'enc'), 'delete_message', 'Removed.')->>'status',
          'resolved', 'a server moderator deletes a scoped message and resolves the report');
SELECT tests.clear_authentication();

SELECT is((SELECT is_deleted FROM public.messages WHERE id = '51000000-0000-0000-0000-0000000000c1'),
          true, 'the message is deleted');
SELECT results_eq(
    $q$SELECT admin_id, target_type, target_id FROM public.admin_audit_log WHERE action_type = 'report_delete_message'$q$,
    $q$VALUES ('51000000-0000-0000-0000-00000000000d'::uuid, 'report', (SELECT v FROM ids WHERE k = 'enc')::text)$q$,
    'the action is in the audit log under the moderator');
SELECT results_eq(
    $q$SELECT data->>'status', data->>'resolution_note', (data->>'show_resolver')::boolean,
              data ? 'resolver_username', data ? 'from_user_id'
         FROM public.notifications WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'report_update'$q$,
    $q$VALUES ('resolved', 'Removed.', false, false, false)$q$,
    'the reporter is told the outcome without the moderator''s identity');

SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000051');
SELECT throws_ok($q$SELECT public.moderate_report((SELECT v FROM ids WHERE k = 'msg'), 'limit_domain')$q$,
                 '42501', NULL, 'domain actions are for instance admins');
SELECT throws_ok($q$SELECT public.moderate_report((SELECT v FROM ids WHERE k = 'enc'), 'resolve')$q$,
                 '22023', 'Report is closed', 'a closed report cannot be resolved again');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'enc'), 'reopen')->>'status',
          'pending', 'a closed report reopens');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'msg'), 'assign')->>'status',
          'pending', 'assignment leaves the status');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'msg'), 'warn', 'Noted.', 'Keep it civil.')->>'status',
          'resolved', 'warning the author resolves the report');
SELECT throws_ok($q$SELECT public.moderate_report((SELECT v FROM ids WHERE k = 'remote_fwd'), 'forward')$q$,
                 '22023', 'Report already forwarded', 'a forwarded report is not forwarded twice');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'remote_nofwd'), 'forward')->>'status',
          'pending', 'a moderator forwards a report about a remote account');
SELECT throws_ok($q$SELECT public.moderate_report((SELECT v FROM ids WHERE k = 'local_fwd'), 'forward')$q$,
                 '22023', NULL, 'a report about a local account cannot be forwarded');
SELECT tests.clear_authentication();

SELECT results_eq(
    $q$SELECT r.status, r.resolution_note, r.resolved_by, r.assigned_to
         FROM public.reports r WHERE r.id = (SELECT v FROM ids WHERE k = 'enc')$q$,
    $q$VALUES ('pending', NULL::text, NULL::uuid, NULL::uuid)$q$,
    'reopening clears the resolution');
SELECT results_eq(
    $q$SELECT r.assigned_to, r.resolved_by FROM public.reports r WHERE r.id = (SELECT v FROM ids WHERE k = 'msg')$q$,
    $q$VALUES ('51000000-0000-0000-0000-00000000000e'::uuid, '51000000-0000-0000-0000-00000000000e'::uuid)$q$,
    'assignment and resolver are recorded');
SELECT is((SELECT data->>'text' FROM public.notifications
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND type = 'moderation_warning'),
          'Keep it civil.', 'the warned author receives the warning text');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'report_update'
              AND data->>'resolution_note' = 'Keep it civil.'),
          0, 'the warning text does not reach the reporter');
SELECT results_eq(
    $q$SELECT forward, federation_status FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'remote_nofwd')$q$,
    $q$VALUES (true, 'queued')$q$,
    'forwarding by a moderator queues the Flag');

SELECT tests.authenticate_as('ffffffff-0000-0000-0000-000000000051');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'post'), 'dismiss', 'Not a violation.', NULL, true)->>'status',
          'dismissed', 'an admin dismisses a report');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT data->>'resolver_username', (data->>'from_user_id')::uuid
         FROM public.notifications
        WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'report_update'
          AND data->>'status' = 'dismissed'$q$,
    $q$VALUES ('repadmin', '51000000-0000-0000-0000-00000000000f'::uuid)$q$,
    'with show_resolver the reporter is told who resolved it');

-- Domain limit ------------------------------------------------------------------------------
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000051');
SELECT throws_ok($q$SELECT public.set_domain_moderation('remote.example', 'limit')$q$,
                 '42501', NULL, 'domain policy is for instance admins');
SELECT tests.authenticate_as('ffffffff-0000-0000-0000-000000000051');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'remote_fwd'), 'limit_domain', NULL, 'spam wave')->>'status',
          'resolved', 'an admin limits the reported account''s domain');
SELECT tests.clear_authentication();

SELECT results_eq(
    $q$SELECT p.is_silenced, p.silenced_at = fi.limited_at
         FROM public.profiles p, public.federated_instances fi
        WHERE p.id = '51000000-0000-0000-0000-0000000000a1' AND fi.domain = 'remote.example'$q$,
    $q$VALUES (true, true)$q$,
    'limiting silences the domain''s accounts at the limit time');

SET LOCAL role service_role;
INSERT INTO public.profiles (id, username, domain, is_local, federated_id)
VALUES ('51000000-0000-0000-0000-0000000000a3', 'newcomer', 'Remote.Example', false, 'https://remote.example/users/newcomer');
RESET role;
SELECT is((SELECT is_silenced FROM public.profiles WHERE id = '51000000-0000-0000-0000-0000000000a3'),
          true, 'an account arriving from a limited domain is silenced');

SELECT tests.authenticate_as('ffffffff-0000-0000-0000-000000000051');
SELECT lives_ok($q$SELECT public.set_domain_moderation('remote.example', 'none')$q$, 'an admin lifts the limit');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT username, is_silenced FROM public.profiles
        WHERE id IN ('51000000-0000-0000-0000-0000000000a1', '51000000-0000-0000-0000-0000000000a2',
                     '51000000-0000-0000-0000-0000000000a3')
        ORDER BY username$q$,
    $q$VALUES ('faraway', false), ('newcomer', false), ('quiet', true)$q$,
    'lifting the limit unsilences only the accounts it silenced');

SELECT tests.authenticate_as('ffffffff-0000-0000-0000-000000000051');
SELECT lives_ok($q$SELECT public.set_domain_moderation('Remote.Example', 'suspend', 'abuse')$q$, 'an admin suspends a domain');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT is_blocked, limited_at IS NULL FROM public.federated_instances WHERE domain = 'remote.example'$q$,
    $q$VALUES (true, true)$q$,
    'suspension blocks the domain');
SELECT is((SELECT count(*)::int FROM public.admin_audit_log WHERE target_type = 'domain' AND target_id = 'remote.example'),
          3, 'each domain policy change is audited');

-- create_federated_report ---------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO fed VALUES
  ('first', public.create_federated_report('https://other.example/flags/1', 'https://other.example/actor', 'Other.Example',
       '11111111-0000-0000-0000-000000000001',
       ARRAY['51000000-0000-0000-0000-0000000000b1', '51000000-0000-0000-0000-0000000000b3']::uuid[],
       'spam from your user', ARRAY['https://local/users/alice', 'https://local/posts/x'])),
  ('again', public.create_federated_report('https://other.example/flags/1', 'https://other.example/actor', 'other.example',
       '11111111-0000-0000-0000-000000000001', '{}', 'spam from your user')),
  ('second_target', public.create_federated_report('https://other.example/flags/1', 'https://other.example/actor', 'other.example',
       '22222222-0000-0000-0000-000000000002', '{}', 'spam from your user')),
  ('remote_target', public.create_federated_report('https://other.example/flags/2', 'https://other.example/actor', 'other.example',
       '51000000-0000-0000-0000-0000000000a1', '{}', 'x')),
  ('blocked', public.create_federated_report('https://remote.example/flags/3', 'https://remote.example/actor', 'remote.example',
       '11111111-0000-0000-0000-000000000001', '{}', 'x'));
RESET role;

SELECT results_eq(
    $q$SELECT k, v->>'status' FROM fed ORDER BY k$q$,
    $q$VALUES ('again', 'duplicate'), ('blocked', 'blocked'), ('first', 'created'),
              ('remote_target', 'not_local'), ('second_target', 'created')$q$,
    'created, deduplicated per account, refused for remote targets and blocked domains');
SELECT is((SELECT v->>'report_id' FROM fed WHERE k = 'again'), (SELECT v->>'report_id' FROM fed WHERE k = 'first'),
          'a redelivered Flag returns the existing report');
SELECT results_eq(
    $q$SELECT reporter_id, source, source_instance, comment, report_type, reported_post_id,
              metadata->>'actor', jsonb_array_length(content_snapshot->'posts'), federation_status
         FROM public.reports WHERE id = (SELECT (v->>'report_id')::uuid FROM fed WHERE k = 'first')$q$,
    $q$VALUES (NULL::uuid, 'federation', 'other.example', 'spam from your user', 'post',
               '51000000-0000-0000-0000-0000000000b1'::uuid, 'https://other.example/actor', 1, 'skipped')$q$,
    'a federated report is the domain''s, keeps the comment and only the target''s own posts');

SET LOCAL role service_role;
INSERT INTO public.reports (reported_user_id, reason, report_type, source, source_instance, ap_id, content_snapshot)
SELECT '22222222-0000-0000-0000-000000000002', 'other', 'user', 'federation', 'flood.example',
       'https://flood.example/flags/' || g, '{}'
  FROM generate_series(1, 30) g;
INSERT INTO fed VALUES ('flood', public.create_federated_report('https://flood.example/flags/31',
    'https://flood.example/actor', 'flood.example', '22222222-0000-0000-0000-000000000002', '{}', 'x'));
RESET role;
SELECT is((SELECT v->>'status' FROM fed WHERE k = 'flood'), 'rate_limited', 'a domain files at most 30 reports an hour');

SELECT * FROM finish();
ROLLBACK;
