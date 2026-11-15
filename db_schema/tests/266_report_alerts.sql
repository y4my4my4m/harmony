-- Report notifications after 20261111600001_report_alerts.sql.
--
--   alice     owner of server_1, author of the reported message; not an instance admin here
--   bob       member of server_1, reporter
--   mallory   reported account
--   srvmod    member of server_1 holding MANAGE_MESSAGES
--   repmod    instance moderator; repadmin instance admin
--   quietmod  instance moderator with moderation_reports off
--   gonemod   suspended instance moderator
--   farmod    remote account flagged as a moderator
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(17);

UPDATE public.profiles SET is_admin = false WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('c2660000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'srvmod266@test.local'),
  ('c2660000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'repmod266@test.local'),
  ('c2660000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'repadmin266@test.local'),
  ('c2660000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'quietmod266@test.local'),
  ('c2660000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gonemod266@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_moderator, is_admin, is_suspended) VALUES
  ('c2661000-0000-0000-0000-00000000000d', 'c2660000-0000-0000-0000-00000000000d', 'srvmod266', 'Server Mod', true, false, false, false),
  ('c2661000-0000-0000-0000-00000000000e', 'c2660000-0000-0000-0000-00000000000e', 'repmod266', 'Rep Mod', true, true, false, false),
  ('c2661000-0000-0000-0000-00000000000f', 'c2660000-0000-0000-0000-00000000000f', 'repadmin266', 'Rep Admin', true, false, true, false),
  ('c2661000-0000-0000-0000-000000000010', 'c2660000-0000-0000-0000-000000000010', 'quietmod266', 'Quiet Mod', true, true, false, false),
  ('c2661000-0000-0000-0000-000000000011', 'c2660000-0000-0000-0000-000000000011', 'gonemod266', 'Gone Mod', true, true, false, true);
INSERT INTO public.profiles (id, username, display_name, domain, is_local, is_moderator) VALUES
  ('c2661000-0000-0000-0000-000000000012', 'farmod266', 'Far Mod', 'remote266.example', false, true);
INSERT INTO public.notification_preferences (user_id, moderation_reports)
VALUES ('c2661000-0000-0000-0000-000000000010', false)
ON CONFLICT (user_id) DO UPDATE SET moderation_reports = false;

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('c2661000-0000-0000-0000-00000000000d', '55555555-0000-0000-0000-000000000005', 'accepted');
-- MANAGE_MESSAGES is bit 21.
INSERT INTO public.server_roles (id, server_id, name, permissions)
VALUES ('c2662000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'Mods266', 1::bigint << 21);
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('c2661000-0000-0000-0000-00000000000d', 'c2662000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT ALL ON ids TO authenticated;
CREATE FUNCTION pg_temp.alerted(p_report uuid) RETURNS text[] LANGUAGE sql AS $$
  SELECT COALESCE(array_agg(p.username ORDER BY p.username), '{}')
    FROM public.notifications n JOIN public.profiles p ON p.id = n.user_id
   WHERE n.type = 'report_created' AND n.data->>'report_id' = p_report::text;
$$;
CREATE FUNCTION pg_temp.alert(p_report uuid, p_user uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT n.data FROM public.notifications n
   WHERE n.type = 'report_created' AND n.data->>'report_id' = p_report::text AND n.user_id = p_user;
$$;

-- Instance reports ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO ids SELECT 'user', public.create_report('user', '33333333-0000-0000-0000-000000000003', p_reason => 'spam');
RESET ROLE;
SELECT tests.clear_authentication();

SELECT is(pg_temp.alerted((SELECT v FROM ids WHERE k = 'user')), ARRAY['repadmin266', 'repmod266'],
          'an account report reaches the instance''s admins and moderators');
SELECT ok(NOT ('quietmod266' = ANY (pg_temp.alerted((SELECT v FROM ids WHERE k = 'user')))),
          'not one who turned report notifications off');
SELECT ok(NOT ('gonemod266' = ANY (pg_temp.alerted((SELECT v FROM ids WHERE k = 'user'))))
          AND NOT ('farmod266' = ANY (pg_temp.alerted((SELECT v FROM ids WHERE k = 'user')))),
          'nor a suspended or remote moderator');
SELECT is(pg_temp.alert((SELECT v FROM ids WHERE k = 'user'), 'c2661000-0000-0000-0000-00000000000e')
            - 'priority',
          jsonb_build_object('report_id', (SELECT v FROM ids WHERE k = 'user'), 'report_type', 'user',
                             'category', 'spam', 'reason', 'spam', 'source', 'local', 'scope', 'instance'),
          'the notification names the report and its kind');
SELECT ok(NOT (pg_temp.alert((SELECT v FROM ids WHERE k = 'user'), 'c2661000-0000-0000-0000-00000000000e')::text
               LIKE '%22222222-0000-0000-0000-000000000002%'),
          'and never the reporter');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.create_report('user', '33333333-0000-0000-0000-000000000003', p_reason => 'spam'),
          (SELECT v FROM ids WHERE k = 'user'), 'reporting again returns the open report');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE type = 'report_created' AND data->>'report_id' = (SELECT v FROM ids WHERE k = 'user')::text), 2,
          'and notifies nobody again');

-- A moderator who is the reported account
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO ids SELECT 'mod', public.create_report('user', 'c2661000-0000-0000-0000-00000000000e', p_reason => 'harassment');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT is(pg_temp.alerted((SELECT v FROM ids WHERE k = 'mod')), ARRAY['repadmin266'],
          'a report about a moderator does not reach that moderator');

-- Server reports -----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO ids SELECT 'msg', public.create_report('message', p_reported_message_id => '88888888-0000-0000-0000-000000000008',
                                                   p_reason => 'spam');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT is((SELECT scope_server_id FROM public.reports WHERE id = (SELECT v FROM ids WHERE k = 'msg')),
          '55555555-0000-0000-0000-000000000005'::uuid, 'a channel message report is the server''s');
SELECT is(pg_temp.alerted((SELECT v FROM ids WHERE k = 'msg')), ARRAY['srvmod266'],
          'it reaches the server''s report moderators, not the reported owner nor instance staff');
SELECT is(pg_temp.alert((SELECT v FROM ids WHERE k = 'msg'), 'c2661000-0000-0000-0000-00000000000d')->>'report_server_name',
          'Test Server', 'naming the server');
SELECT is(pg_temp.alert((SELECT v FROM ids WHERE k = 'msg'), 'c2661000-0000-0000-0000-00000000000d')->>'scope',
          'server', 'as a server report');
SELECT ok(pg_temp.alert((SELECT v FROM ids WHERE k = 'msg'), 'c2661000-0000-0000-0000-00000000000d') ->> 'server_id' IS NULL,
          'outside the server''s notification settings');

-- Federated reports --------------------------------------------------------------------------
INSERT INTO ids SELECT 'fed', (public.create_federated_report('https://other266.example/flags/1',
    'https://other266.example/actor', 'other266.example', '33333333-0000-0000-0000-000000000003')->>'report_id')::uuid;
SELECT is(pg_temp.alerted((SELECT v FROM ids WHERE k = 'fed')), ARRAY['repadmin266', 'repmod266'],
          'a report from another instance reaches instance staff');
SELECT is(pg_temp.alert((SELECT v FROM ids WHERE k = 'fed'), 'c2661000-0000-0000-0000-00000000000f')->>'source_instance',
          'other266.example', 'with its origin');

WITH r AS (
    INSERT INTO public.reports (reporter_id, reported_user_id, report_type, reason, category, status, source)
    VALUES ('22222222-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003', 'user', 'other', 'other',
            'resolved', 'local')
    RETURNING id)
INSERT INTO ids SELECT 'settled', id FROM r;
SELECT is(pg_temp.alerted((SELECT v FROM ids WHERE k = 'settled')), '{}'::text[], 'a report stored already settled notifies nobody');

SELECT ok(NOT has_function_privilege('authenticated', 'public.report_alert_recipients(uuid[], public.reports)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.notify_report_moderators()', 'EXECUTE'),
          'clients call neither helper');

SELECT * FROM finish();
ROLLBACK;
