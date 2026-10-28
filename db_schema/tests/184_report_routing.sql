-- 20261027400001_report_routing.sql: a report about a message in a server hosted elsewhere is
-- also queued for the server's moderators (forward_to_server); a Flag at a local server's
-- Group inbox files a report scoped to the server; settling it queues the Group's Resolve;
-- the Resolve settles the reporting instance's report; a domain's reports can be ignored.
--
--   copy184    a server hosted on host184.test (is_local_server false); bob is a member
--   m_host     its message by troll184 (host184.test)
--   m_third    its message by far184 (third184.test)
--   server_1   the fixtures' local server; alice owns it and is no instance admin here
--   admin184   instance admin
--
-- queue_federation_job is replaced for the transaction so queued jobs can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(45);

CREATE TABLE tests.jobs184 (name text, data jsonb);
GRANT INSERT, SELECT, DELETE ON tests.jobs184 TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs184 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

-- promote_first_user_to_admin made alice an instance admin in the fixtures.
UPDATE public.profiles SET is_admin = false WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1840000-0000-0000-0000-0000000000a0', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin184@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin) VALUES
  ('f1840000-0000-0000-0000-000000000001', 'f1840000-0000-0000-0000-0000000000a0', 'admin184', 'Admin', true, true);
INSERT INTO public.profiles (id, username, display_name, domain, is_local, federated_id, inbox_url) VALUES
  ('f1840000-0000-0000-0000-000000000002', 'troll184', 'Troll', 'host184.test', false,
   'https://host184.test/users/troll184', 'https://host184.test/users/troll184/inbox'),
  ('f1840000-0000-0000-0000-000000000003', 'far184', 'Far', 'third184.test', false,
   'https://third184.test/users/far184', 'https://third184.test/users/far184/inbox');

INSERT INTO public.servers (id, name, owner, public, is_local_server, federation_enabled, ap_id,
                            federation_inbox_url, federation_domain, host_domain)
VALUES ('f1840000-0000-0000-0000-0000000000c0', 'Elsewhere', 'f1840000-0000-0000-0000-000000000002', true, false, true,
        'https://host184.test/servers/f1840000-0000-0000-0000-0000000000c0',
        'https://host184.test/servers/f1840000-0000-0000-0000-0000000000c0/inbox', 'host184.test', 'host184.test');
INSERT INTO public.channels (id, server_id, name, type, is_remote, ap_id)
VALUES ('f1840000-0000-0000-0000-0000000000c1', 'f1840000-0000-0000-0000-0000000000c0', 'general', 0, true,
        'https://host184.test/servers/f1840000-0000-0000-0000-0000000000c0/channels/f1840000-0000-0000-0000-0000000000c1');
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1840000-0000-0000-0000-0000000000c0', 'accepted')
ON CONFLICT DO NOTHING;
INSERT INTO public.messages (id, channel_id, user_id, content, metadata) VALUES
  ('f1840000-0000-0000-0000-0000000000d1', 'f1840000-0000-0000-0000-0000000000c1', 'f1840000-0000-0000-0000-000000000002',
   '[{"type":"text","text":"from the host"}]', '{"ap_id": "https://host184.test/messages/h1", "federated": true}'),
  ('f1840000-0000-0000-0000-0000000000d2', 'f1840000-0000-0000-0000-0000000000c1', 'f1840000-0000-0000-0000-000000000003',
   '[{"type":"text","text":"from a third instance"}]', '{"ap_id": "https://third184.test/messages/t1", "federated": true}');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid) ON COMMIT DROP;
GRANT ALL ON ids TO PUBLIC;

-- Surface ---------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text, boolean, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text, boolean, uuid)', 'EXECUTE'),
          'create_report takes p_forward_to_server, for signed-in callers');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname = 'create_report' AND pronamespace = 'public'::regnamespace),
          1, 'one create_report: the ten-argument form is gone');
SELECT ok(NOT has_function_privilege('authenticated', 'public.create_federated_server_report(text, text, text, uuid, uuid, text, text, text[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.create_federated_server_report(text, text, text, uuid, uuid, text, text, text[])', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.create_federated_server_report(text, text, text, uuid, uuid, text, text, text[])', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.apply_server_report_resolution(uuid, text, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.apply_server_report_resolution(uuid, text, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.apply_server_report_resolution(uuid, text, text)', 'EXECUTE'),
          'server reports and resolutions are written by the service role only');
SELECT ok(has_function_privilege('authenticated', 'public.set_domain_reject_reports(text, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_domain_reject_reports(text, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.server_host_domain(public.servers)', 'EXECUTE'),
          'set_domain_reject_reports is for signed-in callers; server_host_domain is internal');
SELECT ok(has_column_privilege('authenticated', 'public.reports', 'forward_to_server', 'SELECT')
          AND has_column_privilege('authenticated', 'public.reports', 'server_resolution', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.reports', 'server_forward_status', 'SELECT'),
          'a reporter reads its forward choice and the server''s outcome');

-- create_report on a copy -------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO ids SELECT 'host', public.create_report('message', p_reported_message_id => 'f1840000-0000-0000-0000-0000000000d1',
    p_reason => 'harassment', p_comment => 'slurs', p_forward => true);
INSERT INTO ids SELECT 'third', public.create_report('message', p_reported_message_id => 'f1840000-0000-0000-0000-0000000000d2',
    p_reason => 'spam', p_forward => true, p_forward_to_server => true);
SELECT tests.clear_authentication();

SELECT results_eq(
    $q$SELECT forward_to_server, server_forward_status, forward, federation_status, scope_server_id
         FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'host')$q$,
    $q$VALUES (true, 'queued', false, 'skipped', NULL::uuid)$q$,
    'a message in a copy goes to its server by default; the author''s instance is that host, so no account Flag');
SELECT results_eq(
    $q$SELECT forward_to_server, server_forward_status, forward, federation_status
         FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'third')$q$,
    $q$VALUES (true, 'queued', true, 'queued')$q$,
    'an author on a third instance gets the account Flag as well');
SELECT is((SELECT count(*)::int FROM tests.jobs184
            WHERE name = 'federate-report' AND data->>'target' = 'server'
              AND data->>'report_id' IN ((SELECT v FROM ids WHERE k = 'host')::text, (SELECT v FROM ids WHERE k = 'third')::text)),
          2, 'each queues the Flag to the server');
SELECT is((SELECT data->>'type' FROM tests.jobs184 WHERE data->>'target' = 'server' LIMIT 1),
          'create', 'the server job is a create');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT forward_to_server FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'host')),
          true, 'the reporter reads its forward choice');
SELECT tests.clear_authentication();

DELETE FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'third');
DELETE FROM tests.jobs184;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO ids SELECT 'optout', public.create_report('message', p_reported_message_id => 'f1840000-0000-0000-0000-0000000000d2',
    p_forward_to_server => false);
INSERT INTO ids SELECT 'local', public.create_report('message', p_reported_message_id => '88888888-0000-0000-0000-000000000008',
    p_forward_to_server => true);
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT forward_to_server, server_forward_status FROM public.reports
        WHERE id IN ((SELECT v FROM ids WHERE k = 'optout'), (SELECT v FROM ids WHERE k = 'local'))$q$,
    $q$VALUES (false, NULL::text), (false, NULL::text)$q$,
    'unchecked, or a message in a server hosted here: nothing goes to a server');
SELECT is((SELECT count(*)::int FROM tests.jobs184 WHERE data->>'target' = 'server'), 0, 'and no server job is queued');

SELECT tests.authenticate_as('f1840000-0000-0000-0000-0000000000a0');
SELECT results_eq(
    $q$SELECT server_forward->>'server_name', server_forward->>'host', server_forward->>'status', server_forward->>'resolution'
         FROM public.get_reports_with_details() WHERE id = (SELECT v FROM ids WHERE k = 'host')$q$,
    $q$VALUES ('Elsewhere', 'host184.test', 'queued', NULL::text)$q$,
    'instance staff see where the report went');
SELECT is((SELECT server_forward FROM public.get_reports_with_details() WHERE id = (SELECT v FROM ids WHERE k = 'optout')),
          NULL::jsonb, 'and nothing for a report kept here');
SELECT tests.clear_authentication();

-- The server's resolution comes back --------------------------------------------------
SELECT is(public.apply_server_report_resolution((SELECT v FROM ids WHERE k = 'host'),
              'https://evil184.test/servers/f1840000-0000-0000-0000-0000000000c0', 'resolved')->>'status',
          'wrong_group', 'another Group cannot settle it');
SELECT is((SELECT status FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'host')),
          'pending', 'and the report stays open');
SELECT is(public.apply_server_report_resolution((SELECT v FROM ids WHERE k = 'optout'),
              'https://host184.test/servers/f1840000-0000-0000-0000-0000000000c0', 'resolved')->>'status',
          'not_forwarded', 'a report never sent to the server is not settled by it');
SELECT throws_ok($q$SELECT public.apply_server_report_resolution((SELECT v FROM ids WHERE k = 'host'),
                     'https://host184.test/servers/f1840000-0000-0000-0000-0000000000c0', 'deleted')$q$,
                 '22023', NULL, 'outcomes are resolved and dismissed');

DELETE FROM public.notifications WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'report_update';
SELECT is(public.apply_server_report_resolution((SELECT v FROM ids WHERE k = 'host'),
              'https://host184.test/servers/f1840000-0000-0000-0000-0000000000c0/', 'dismissed')->>'report_status',
          'pending', 'the Group''s outcome leaves the local report open');
SELECT results_eq(
    $q$SELECT status, server_resolution, resolved_by, resolved_at IS NULL, server_resolved_at IS NOT NULL
         FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'host')$q$,
    $q$VALUES ('pending', 'dismissed', NULL::uuid, true, true)$q$,
    'it records the server''s outcome for local staff, who decide the report');
SELECT results_eq(
    $q$SELECT data->>'status', data->>'resolved_by_server', data->>'server_host', (data->>'show_resolver')::boolean
         FROM public.notifications WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'report_update'$q$,
    $q$VALUES ('dismissed', 'Elsewhere', 'host184.test', false)$q$,
    'the reporter is told the server''s moderators settled it');

SELECT is(public.apply_server_report_resolution((SELECT v FROM ids WHERE k = 'host'),
              'https://host184.test/servers/f1840000-0000-0000-0000-0000000000c0', 'resolved')->>'report_status',
          'pending', 'a later outcome still leaves the local status alone');
SELECT is((SELECT server_resolution FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'host')),
          'resolved', 'and records the server''s new outcome');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'report_update'),
          1, 'without telling the reporter again');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT server_resolution FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'host')),
          'resolved', 'the reporter reads the server''s outcome');
SELECT tests.clear_authentication();

-- Host: a Flag at a local server's Group inbox ----------------------------------------
DELETE FROM tests.jobs184;
INSERT INTO ids SELECT 'flag', (public.create_federated_server_report(
    'https://member184.test/flags/f1840000-0000-0000-0000-0000000000f1/server',
    'https://member184.test/users/instance.actor', 'Member184.test',
    '55555555-0000-0000-0000-000000000005', '88888888-0000-0000-0000-000000000008',
    'slurs', 'harassment', ARRAY['https://test.local/messages/88888888-0000-0000-0000-000000000008'])->>'report_id')::uuid;
SELECT results_eq(
    $q$SELECT reporter_id, reported_user_id, reported_message_id, scope_server_id, report_type, reason, category,
              comment, source, source_instance, metadata->>'flag_target', metadata->>'actor', federation_status, forward_to_server
         FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'flag')$q$,
    $q$VALUES (NULL::uuid, '11111111-0000-0000-0000-000000000001'::uuid, '88888888-0000-0000-0000-000000000008'::uuid,
               '55555555-0000-0000-0000-000000000005'::uuid, 'message', 'harassment', 'violation', 'slurs', 'federation',
               'member184.test', 'group', 'https://member184.test/users/instance.actor', 'skipped', false)$q$,
    'the Flag files a message report scoped to the server, owned by the sending domain');
SELECT is((SELECT content_snapshot->'message'->'content'->0->>'text' FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'flag')),
          'channel message', 'the message is snapshotted');
SELECT is(public.create_federated_server_report(
    'https://member184.test/flags/f1840000-0000-0000-0000-0000000000f1/server',
    'https://member184.test/users/instance.actor', 'member184.test',
    '55555555-0000-0000-0000-000000000005', '88888888-0000-0000-0000-000000000008')->>'status',
          'duplicate', 'redelivery files no second report');
SELECT is(public.create_federated_server_report('https://member184.test/flags/x2', 'https://member184.test/users/instance.actor',
    'member184.test', '55555555-0000-0000-0000-000000000005', 'f1840000-0000-0000-0000-0000000000d1')->>'status',
          'not_found', 'a message of another server is not filed');
SELECT is(public.create_federated_server_report('https://member184.test/flags/x3', 'https://member184.test/users/instance.actor',
    'member184.test', 'f1840000-0000-0000-0000-0000000000c0', 'f1840000-0000-0000-0000-0000000000d1')->>'status',
          'not_local', 'a server hosted elsewhere files nothing here');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT results_eq(
    $q$SELECT source_instance, reporter_id, reporter_username
         FROM public.get_reports_with_details(p_server_id => '55555555-0000-0000-0000-000000000005')
        WHERE id = (SELECT v FROM ids WHERE k = 'flag')$q$,
    $q$VALUES ('member184.test', NULL::uuid, NULL::text)$q$,
    'the server''s moderators list it with its origin and no reporter');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'flag'), 'resolve')->>'status',
          'resolved', 'the server owner resolves it');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT name, data->>'type', data->>'target', data->>'report_id' FROM tests.jobs184$q$,
    $q$VALUES ('federate-report', 'update', 'resolution', (SELECT v FROM ids WHERE k = 'flag')::text)$q$,
    'resolving queues the Group''s Resolve');

SELECT tests.authenticate_as('f1840000-0000-0000-0000-0000000000a0');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'flag'), 'reopen')->>'status', 'pending', 'host staff reopen it');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'flag'), 'dismiss')->>'status', 'dismissed', 'and dismiss it');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM tests.jobs184 WHERE data->>'target' = 'resolution'),
          2, 'reopening queues nothing; the second settlement queues another Resolve');

INSERT INTO ids SELECT 'acct', (public.create_federated_report('https://member184.test/flags/acct',
    'https://member184.test/users/instance.actor', 'member184.test', '11111111-0000-0000-0000-000000000001')->>'report_id')::uuid;
SELECT tests.authenticate_as('f1840000-0000-0000-0000-0000000000a0');
SELECT is(public.moderate_report((SELECT v FROM ids WHERE k = 'acct'), 'dismiss')->>'status', 'dismissed', 'an account Flag''s report is dismissed');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM tests.jobs184 WHERE data->>'report_id' = (SELECT v FROM ids WHERE k = 'acct')::text),
          0, 'and sends no Resolve: it went to no Group');

-- Ignoring a domain's reports ---------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_domain_reject_reports('member184.test', true)$q$,
                 '42501', NULL, 'only an instance admin ignores a domain''s reports');
SELECT tests.authenticate_as('f1840000-0000-0000-0000-0000000000a0');
SELECT lives_ok($q$SELECT public.set_domain_reject_reports('Member184.Test', true)$q$, 'an instance admin ignores them');
SELECT throws_ok($q$SELECT public.set_domain_reject_reports('not a domain', true)$q$, '22023', NULL, 'domains are checked');
SELECT tests.clear_authentication();
SELECT is((SELECT reject_reports FROM public.federated_instances WHERE domain = 'member184.test'), true,
          'the domain carries reject_reports');
SELECT is((SELECT count(*)::int FROM public.admin_audit_log
            WHERE action_type = 'domain_reject_reports' AND target_id = 'member184.test'
              AND admin_id = 'f1840000-0000-0000-0000-000000000001'), 1, 'and the change is audited');
SELECT is(public.create_federated_server_report('https://member184.test/flags/x4', 'https://member184.test/users/instance.actor',
    'member184.test', '55555555-0000-0000-0000-000000000005', '88888888-0000-0000-0000-000000000008')->>'status',
          'ignored', 'a Flag at a Group inbox from that domain is ignored');
SELECT is(public.create_federated_report('https://member184.test/flags/x5', 'https://member184.test/users/instance.actor',
    'member184.test', '22222222-0000-0000-0000-000000000002')->>'status',
          'ignored', 'and so is a Flag about an account');

SELECT * FROM finish();
ROLLBACK;
