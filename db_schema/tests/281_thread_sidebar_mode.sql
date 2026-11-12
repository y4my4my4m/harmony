-- 20261112700001_thread_sidebar_mode.sql: which threads the channel sidebar lists, per server.
--
--   alice  owns S (MANAGE_SERVER)    bob  a member    carol  not a member
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(35);

INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('28000000-0000-0000-0000-000000000001', 'Sidebar', '11111111-0000-0000-0000-000000000001', true);
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('28000000-0000-0000-0000-000000000002', '28000000-0000-0000-0000-000000000001', 'general', 0);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', '28000000-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', '28000000-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT DO NOTHING;

SELECT throws_ok($q$INSERT INTO public.server_settings (server_id, thread_sidebar) VALUES ('28000000-0000-0000-0000-000000000001', 'some')$q$,
    '23514', NULL, 'a mode other than all or joined is refused');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_server_thread_sidebar('28000000-0000-0000-0000-000000000001'),
    '{"mode":"all","server_value":null,"instance_default":"all"}'::jsonb, 'the default is all');

SELECT tests.clear_authentication();
INSERT INTO public.instance_config (config_key, config_value) VALUES ('thread_sidebar_default', '"joined"')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_server_thread_sidebar('28000000-0000-0000-0000-000000000001'),
    '{"mode":"joined","server_value":null,"instance_default":"joined"}'::jsonb, 'the instance default applies');

SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '"garbage"' WHERE config_key = 'thread_sidebar_default';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_server_thread_sidebar('28000000-0000-0000-0000-000000000001')->>'mode', 'all', 'an unknown instance default reads as all');

SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '"joined"' WHERE config_key = 'thread_sidebar_default';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_server_thread_sidebar('28000000-0000-0000-0000-000000000001', 'all'),
    '{"mode":"all","server_value":"all","instance_default":"joined"}'::jsonb, 'the server value wins over the instance default');
SELECT is(public.set_server_thread_sidebar('28000000-0000-0000-0000-000000000001', 'joined')->>'mode', 'joined', 'a manager sets joined');
SELECT is(public.set_server_thread_sidebar('28000000-0000-0000-0000-000000000001', NULL),
    '{"mode":"joined","server_value":null,"instance_default":"joined"}'::jsonb, 'NULL returns the server to the instance default');
SELECT throws_ok($q$SELECT public.set_server_thread_sidebar('28000000-0000-0000-0000-000000000001', 'nope')$q$,
    '22023', NULL, 'an unknown mode is refused');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.get_server_thread_sidebar('28000000-0000-0000-0000-000000000001')$q$,
    '42501', NULL, 'a member without MANAGE_SERVER cannot read the setting');
SELECT throws_ok($q$SELECT public.set_server_thread_sidebar('28000000-0000-0000-0000-000000000001', 'all')$q$,
    '42501', NULL, 'nor change it');
SELECT is(public.server_thread_sidebar_mode('28000000-0000-0000-0000-000000000001'), 'joined', 'a member reads the effective mode');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.server_thread_sidebar_mode('28000000-0000-0000-0000-000000000001')$q$,
    '42501', NULL, 'a non-member cannot read the mode');

SELECT tests.clear_authentication();
SELECT throws_ok($q$SELECT public.get_server_thread_sidebar('28000000-0000-0000-0000-000000000001')$q$,
    '42501', NULL, 'signed out, nothing is readable');

SELECT is(public.server_thread_sidebar_state('28000000-0000-0000-0000-000000000001')->>'mode', 'joined', 'service_role reads the state');

-- A specific @mention in a thread reply adds the member --------------------------------------
-- dave (the fixture's banned account) is no member of S; eve is a member who blocked bob;
-- carol joins S here.
SELECT tests.clear_authentication();
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('28000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'eve280@test.local')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('28000000-0000-0000-0000-0000000000b1', '28000000-0000-0000-0000-0000000000a1', 'eve280', 'Eve', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('33333333-0000-0000-0000-000000000003', '28000000-0000-0000-0000-000000000001', 'accepted'),
  ('28000000-0000-0000-0000-0000000000b1', '28000000-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT DO NOTHING;
INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('28000000-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.server_roles (id, server_id, name, position, permissions, is_default)
SELECT '28000000-0000-0000-0000-000000000006', '28000000-0000-0000-0000-000000000001', 'everyone', 0, 0, true
 WHERE NOT EXISTS (SELECT 1 FROM public.server_roles WHERE server_id = '28000000-0000-0000-0000-000000000001' AND is_default);
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('28000000-0000-0000-0000-000000000007', '28000000-0000-0000-0000-000000000001', 'crew', 1, 0);
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('28000000-0000-0000-0000-000000000005', '28000000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"starter"}]'::jsonb);
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by) VALUES
  ('28000000-0000-0000-0000-000000000004', '28000000-0000-0000-0000-000000000002', '28000000-0000-0000-0000-000000000005', 'T', '11111111-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.joined(p_user uuid) RETURNS int LANGUAGE sql AS $fn$
  SELECT count(*)::int FROM public.thread_members
   WHERE thread_id = '28000000-0000-0000-0000-000000000004' AND user_id = p_user;
$fn$;
CREATE FUNCTION pg_temp.members() RETURNS int LANGUAGE sql AS $fn$
  SELECT count(*)::int FROM public.thread_members WHERE thread_id = '28000000-0000-0000-0000-000000000004';
$fn$;
CREATE FUNCTION pg_temp.member_count() RETURNS int LANGUAGE sql AS $fn$
  SELECT member_count FROM public.threads WHERE id = '28000000-0000-0000-0000-000000000004';
$fn$;
-- Posts a reply in T (a channel message when p_thread is false) with the given content.
CREATE FUNCTION pg_temp.reply(p_user uuid, p_content jsonb, p_thread boolean DEFAULT true, p_system boolean DEFAULT false)
RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO public.messages (channel_id, thread_id, user_id, content, is_system)
  VALUES ('28000000-0000-0000-0000-000000000002',
          CASE WHEN p_thread THEN '28000000-0000-0000-0000-000000000004'::uuid END,
          p_user, p_content, p_system);
$fn$;
CREATE FUNCTION pg_temp.mention(p_user uuid) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('type', 'mention', 'username', (SELECT username FROM public.profiles WHERE id = p_user)));
$fn$;

SELECT is(pg_temp.joined('33333333-0000-0000-0000-000000000003'), 0, 'carol is not in T to start');
SELECT pg_temp.reply('22222222-0000-0000-0000-000000000002', pg_temp.mention('33333333-0000-0000-0000-000000000003'));
SELECT is(pg_temp.joined('33333333-0000-0000-0000-000000000003'), 1, 'a mention joins a viewer');
SELECT is(pg_temp.member_count(), pg_temp.members(), 'and member_count counts the new member');

-- Carol leaves; a mention brings her back.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.leave_thread('28000000-0000-0000-0000-000000000004');
SELECT tests.clear_authentication();
SELECT is(pg_temp.joined('33333333-0000-0000-0000-000000000003'), 0, 'carol left');
SELECT pg_temp.reply('22222222-0000-0000-0000-000000000002', pg_temp.mention('33333333-0000-0000-0000-000000000003'));
SELECT is(pg_temp.joined('33333333-0000-0000-0000-000000000003'), 1, 'a mention brings back someone who left');
SELECT is((SELECT count(*)::int FROM public.thread_departures
            WHERE thread_id = '28000000-0000-0000-0000-000000000004' AND user_id = '33333333-0000-0000-0000-000000000003'),
          0, 'and ends the departure');

-- Someone who cannot view the channel.
SELECT pg_temp.reply('22222222-0000-0000-0000-000000000002', pg_temp.mention('44444444-0000-0000-0000-000000000004'));
SELECT is(pg_temp.joined('44444444-0000-0000-0000-000000000004'), 0, 'mention of a non-viewer joins no one');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.notifications WHERE user_id = '44444444-0000-0000-0000-000000000004' AND type = 'mention'),
          'and notifies no one');

-- Carol and a blocker in one reply.
DELETE FROM public.thread_members WHERE thread_id = '28000000-0000-0000-0000-000000000004' AND user_id = '33333333-0000-0000-0000-000000000003';
SELECT pg_temp.reply('22222222-0000-0000-0000-000000000002', jsonb_build_array(
  jsonb_build_object('type', 'mention', 'username', 'mallory'),
  jsonb_build_object('type', 'mention', 'username', 'eve280')));
SELECT is(pg_temp.joined('33333333-0000-0000-0000-000000000003'), 1, 'a blocker is not joined, the others are (the others)');
SELECT is(pg_temp.joined('28000000-0000-0000-0000-0000000000b1'), 0, 'a blocker is not joined, the others are (the blocker)');

-- Role and @everyone mentions add no one.
SELECT pg_temp.reply('11111111-0000-0000-0000-000000000001', jsonb_build_array(
  jsonb_build_object('type', 'role_mention', 'roleId', '28000000-0000-0000-0000-000000000007'),
  jsonb_build_object('type', 'role_mention', 'roleId', (SELECT id FROM public.server_roles WHERE server_id = '28000000-0000-0000-0000-000000000001' AND is_default))));
SELECT is(pg_temp.members(), 3, 'a role or @everyone mention joins no one (alice, bob and carol only)');

-- History import joins no one.
DELETE FROM public.thread_members WHERE thread_id = '28000000-0000-0000-0000-000000000004' AND user_id = '33333333-0000-0000-0000-000000000003';
SELECT set_config('harmony.history_import', 'true', true);
SELECT pg_temp.reply('22222222-0000-0000-0000-000000000002', pg_temp.mention('33333333-0000-0000-0000-000000000003'));
SELECT set_config('harmony.history_import', 'false', true);
SELECT is(pg_temp.joined('33333333-0000-0000-0000-000000000003'), 0, 'a mention under the history-import flag joins no one');

-- A channel message, a system reply and a self-mention.
SELECT pg_temp.reply('22222222-0000-0000-0000-000000000002', pg_temp.mention('33333333-0000-0000-0000-000000000003'), false);
SELECT is(pg_temp.joined('33333333-0000-0000-0000-000000000003'), 0, 'a channel message mention joins no thread');
SELECT pg_temp.reply(NULL, pg_temp.mention('33333333-0000-0000-0000-000000000003'), true, true);
SELECT is(pg_temp.joined('33333333-0000-0000-0000-000000000003'), 0, 'a system reply joins no one');
SELECT pg_temp.reply('22222222-0000-0000-0000-000000000002', pg_temp.mention('22222222-0000-0000-0000-000000000002'));
SELECT is(pg_temp.member_count(), pg_temp.members(), 'an author mentioning themselves changes nothing');

-- A bot-authored reply (no user_id) mentioning a viewer joins them.
DELETE FROM public.thread_members WHERE thread_id = '28000000-0000-0000-0000-000000000004' AND user_id = '33333333-0000-0000-0000-000000000003';
INSERT INTO public.bots (id, username, display_name, owner_id, is_public) VALUES
  ('28000000-0000-0000-0000-0000000000d1', 'relay280', 'Relay', '11111111-0000-0000-0000-000000000001', true);
INSERT INTO public.messages (channel_id, thread_id, bot_id, content) VALUES
  ('28000000-0000-0000-0000-000000000002', '28000000-0000-0000-0000-000000000004',
   '28000000-0000-0000-0000-0000000000d1', pg_temp.mention('33333333-0000-0000-0000-000000000003'));
SELECT is(pg_temp.joined('33333333-0000-0000-0000-000000000003'), 1, 'a bot-authored reply''s mention joins a viewer');

-- Content that is not an array joins no one and does not fail the insert. The table refuses such
-- content, and other triggers fail on it, so its checks are dropped and only the thread trigger is
-- left on, for this test (rolled back with the rest).
ALTER TABLE public.messages DROP CONSTRAINT messages_content_is_array;
ALTER TABLE public.messages DROP CONSTRAINT messages_content_not_empty;
ALTER TABLE public.messages DISABLE TRIGGER USER;
ALTER TABLE public.messages ENABLE TRIGGER trigger_thread_message_insert;
DELETE FROM public.thread_members WHERE thread_id = '28000000-0000-0000-0000-000000000004' AND user_id = '33333333-0000-0000-0000-000000000003';
SELECT lives_ok($q$SELECT pg_temp.reply('22222222-0000-0000-0000-000000000002', '{"type":"mention","username":"carol"}'::jsonb)$q$,
    'a reply whose content is not an array is accepted');
SELECT is(pg_temp.joined('33333333-0000-0000-0000-000000000003'), 0, 'and joins no one');
SELECT is(pg_temp.members(), 2, 'and nobody else is added (alice and bob only)');
ALTER TABLE public.messages ENABLE TRIGGER USER;

-- The mention notification names the thread.
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('28000000-0000-0000-0000-0000000000c1', '28000000-0000-0000-0000-000000000002', '28000000-0000-0000-0000-000000000004',
   '22222222-0000-0000-0000-000000000002', pg_temp.mention('33333333-0000-0000-0000-000000000003')),
  ('28000000-0000-0000-0000-0000000000c2', '28000000-0000-0000-0000-000000000002', NULL,
   '22222222-0000-0000-0000-000000000002', pg_temp.mention('33333333-0000-0000-0000-000000000003'));
SELECT is((SELECT data->'thread'->>'id' FROM public.notifications
            WHERE user_id = '33333333-0000-0000-0000-000000000003' AND type = 'mention'
              AND data->>'message_id' = '28000000-0000-0000-0000-0000000000c1'),
          '28000000-0000-0000-0000-000000000004', 'a thread reply''s mention notification names the thread');
SELECT ok((SELECT COALESCE(jsonb_typeof(data->'thread'), 'null') = 'null' FROM public.notifications
            WHERE user_id = '33333333-0000-0000-0000-000000000003' AND type = 'mention'
              AND data->>'message_id' = '28000000-0000-0000-0000-0000000000c2'),
          'and a channel message''s does not');
SELECT * FROM finish();
ROLLBACK;
