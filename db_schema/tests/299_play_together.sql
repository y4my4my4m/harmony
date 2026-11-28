-- 20261117500001_play_together.sql: activity apps, sessions, relay functions.
--
--   DM 77...07         alice + bob
--   #general 66...06   server_1 text channel; mallory not a member
--   #lounge  29900..01 server_1 voice channel; alice connected, bob not
--   #quiet   29900..02 server_1 text channel where @everyone lacks SEND_MESSAGES (override deny)
--   copy 29920..01     a copy server (is_local_server false) with a text channel
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(45);

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('29900000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'lounge', 1),
  ('29900000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'quiet', 0);
INSERT INTO public.voice_channel_participants (channel_id, user_id, server_id) VALUES
  ('29900000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT '29900000-0000-0000-0000-000000000002', 'role', sr.id, 0, 4096
  FROM public.server_roles sr WHERE sr.server_id = '55555555-0000-0000-0000-000000000005' AND sr.is_default;
INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('29920000-0000-0000-0000-000000000001', 'Copy', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', '29920000-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT DO NOTHING;
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('29900000-0000-0000-0000-000000000003', '29920000-0000-0000-0000-000000000001', 'remote', 0);

-- Catalog. ---------------------------------------------------------------------------------------
SELECT is((SELECT enabled AND builtin FROM public.activity_apps WHERE id = 'drawinphone'), true,
  'DrawinPhone ships enabled');

-- Refusals. --------------------------------------------------------------------------------------
SELECT is(public.activity_join_refusal('11111111-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000007', NULL), NULL,
  'alice may join in her DM');
SELECT is(public.activity_join_refusal('33333333-0000-0000-0000-000000000003', '77777777-0000-0000-0000-000000000007', NULL), 'NOT_FOUND',
  'mallory may not join a DM she is not in');
SELECT is(public.activity_join_refusal('33333333-0000-0000-0000-000000000003', NULL, '66666666-0000-0000-0000-000000000006'), 'NOT_FOUND',
  'mallory may not join in a server she is not in');
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '29900000-0000-0000-0000-000000000001'), 'NOT_IN_CALL',
  'bob is not in the voice call');
SELECT is(public.activity_join_refusal('11111111-0000-0000-0000-000000000001', NULL, '29900000-0000-0000-0000-000000000001'), NULL,
  'alice is in the voice call');
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '29900000-0000-0000-0000-000000000002', true), 'CANNOT_SEND',
  'bob cannot start where he cannot send');
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '29900000-0000-0000-0000-000000000002', false), 'CANNOT_SEND',
  'bob cannot join there either (20261121100001)');
SELECT is(public.activity_join_refusal('11111111-0000-0000-0000-000000000001', NULL, '29900000-0000-0000-0000-000000000003'), 'SERVER_NOT_LOCAL',
  'a copy''s channel is refused');
SELECT is(public.activity_join_refusal('11111111-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000007', '66666666-0000-0000-0000-000000000006'),
  'ACTIVITY_CONTEXT', 'two contexts at once are refused');

INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001');
SELECT is(public.activity_join_refusal('11111111-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000007', NULL), 'NOT_FOUND',
  'a block refuses the DM as a conversation out of reach (20261123500004)');
DELETE FROM public.user_blocks WHERE blocker_id = '22222222-0000-0000-0000-000000000002';

-- Starting. --------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE TEMP TABLE started ON COMMIT DROP AS
  SELECT public.start_activity_session('drawinphone', '77777777-0000-0000-0000-000000000007', NULL) AS r;
SELECT is((SELECT r -> 'session' ->> 'context' FROM started), 'direct', 'alice starts DrawinPhone in the DM');
SELECT is((SELECT (r ->> 'existing')::boolean FROM started), false, 'a new session');
SELECT is((SELECT r -> 'session' ->> 'host_id' FROM started), '11111111-0000-0000-0000-000000000001', 'the starter hosts');
SELECT tests.clear_authentication();

SELECT is((SELECT m.metadata ->> 'type' FROM public.messages m
            WHERE m.id = (SELECT (r -> 'session' ->> 'message_id')::uuid FROM started)),
  'activity_started', 'a system row announces it');
SELECT is((SELECT m.user_id IS NULL AND m.is_system FROM public.messages m
            WHERE m.id = (SELECT (r -> 'session' ->> 'message_id')::uuid FROM started)),
  true, 'the row is authorless');
SELECT is((SELECT m.metadata ->> 'session_id' FROM public.messages m
            WHERE m.id = (SELECT (r -> 'session' ->> 'message_id')::uuid FROM started)),
  (SELECT r -> 'session' ->> 'id' FROM started), 'the row names the session');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((public.start_activity_session('drawinphone', '77777777-0000-0000-0000-000000000007', NULL) ->> 'existing')::boolean,
  true, 'bob gets the running session rather than a second one');
SELECT is(jsonb_array_length(public.get_activity_sessions('77777777-0000-0000-0000-000000000007', NULL)), 1,
  'bob sees one active session in the DM');
SELECT is(public.get_activity_session((SELECT (r -> 'session' ->> 'id')::uuid FROM started)) ->> 'status', 'active',
  'bob reads the session');
SELECT throws_ok($$SELECT public.start_activity_session('drawinphone', NULL, '29900000-0000-0000-0000-000000000001')$$,
  '42501', 'NOT_IN_CALL', 'bob cannot start in a call he is not in');
SELECT throws_ok($$SELECT public.start_activity_session('drawinphone', NULL, '29900000-0000-0000-0000-000000000002')$$,
  '42501', 'CANNOT_SEND', 'bob cannot start where he cannot send');
SELECT throws_ok($$SELECT public.start_activity_session('nope', '77777777-0000-0000-0000-000000000007', NULL)$$,
  'P0002', 'ACTIVITY_APP_UNAVAILABLE', 'an unknown app is refused');
SELECT throws_ok($$SELECT public.set_activity_app_enabled('drawinphone', false)$$,
  '42501', NULL, 'a member cannot turn an app off');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$SELECT public.start_activity_session('drawinphone', '77777777-0000-0000-0000-000000000007', NULL)$$,
  '42501', 'NOT_FOUND', 'mallory cannot start in the DM');
SELECT is(public.get_activity_session((SELECT (r -> 'session' ->> 'id')::uuid FROM started)), NULL,
  'mallory cannot read the session');
SELECT is(jsonb_array_length(public.get_activity_sessions('77777777-0000-0000-0000-000000000007', NULL)), 0,
  'nor list it');
SELECT tests.clear_authentication();

-- Relay. -----------------------------------------------------------------------------------------
SELECT is(public.activity_session_admit((SELECT (r -> 'session' ->> 'id')::uuid FROM started), '22222222-0000-0000-0000-000000000002') -> 'member' ->> 'username',
  'bob', 'the relay admits bob');
SELECT is((public.activity_session_admit((SELECT (r -> 'session' ->> 'id')::uuid FROM started), '22222222-0000-0000-0000-000000000002') ->> 'can_end')::boolean,
  false, 'bob cannot end it');
SELECT is((public.activity_session_admit((SELECT (r -> 'session' ->> 'id')::uuid FROM started), '11111111-0000-0000-0000-000000000001') ->> 'can_end')::boolean,
  true, 'alice, the starter, can');
SELECT is(public.activity_session_admit((SELECT (r -> 'session' ->> 'id')::uuid FROM started), '33333333-0000-0000-0000-000000000003') ->> 'refusal',
  'NOT_FOUND', 'the relay refuses mallory');
SELECT is(public.activity_session_sync((SELECT (r -> 'session' ->> 'id')::uuid FROM started),
    ARRAY['11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002']::uuid[],
    '22222222-0000-0000-0000-000000000002'),
  true, 'the relay records members');
SELECT is((SELECT cardinality(members) || '/' || host_id FROM public.activity_sessions
            WHERE id = (SELECT (r -> 'session' ->> 'id')::uuid FROM started)),
  '2/22222222-0000-0000-0000-000000000002', 'members are distinct and bob hosts');

SELECT is(public.activity_session_finish((SELECT (r -> 'session' ->> 'id')::uuid FROM started), 'host_ended'), true,
  'the relay ends the session');
SELECT is(public.activity_session_finish((SELECT (r -> 'session' ->> 'id')::uuid FROM started), 'again'), false,
  'a second finish changes nothing');
SELECT is((SELECT m.metadata ->> 'type' || ':' || (m.metadata ->> 'player_count') FROM public.messages m
            WHERE m.id = (SELECT (r -> 'session' ->> 'message_id')::uuid FROM started)),
  'activity_ended:2', 'the system row records the end and both players');
SELECT is(public.activity_session_sync((SELECT (r -> 'session' ->> 'id')::uuid FROM started), '{}', NULL), false,
  'an ended session takes no sync');
SELECT is(public.activity_session_admit((SELECT (r -> 'session' ->> 'id')::uuid FROM started), '11111111-0000-0000-0000-000000000001') ->> 'refusal',
  'ENDED', 'nor new members');

-- Stale sessions. --------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE TEMP TABLE voice ON COMMIT DROP AS
  SELECT public.start_activity_session('drawinphone', NULL, '29900000-0000-0000-0000-000000000001') AS r;
SELECT is((SELECT r -> 'session' ->> 'context' FROM voice), 'voice', 'alice starts one in her call');
SELECT tests.clear_authentication();
UPDATE public.activity_sessions SET last_active_at = now() - interval '4 minutes'
 WHERE id = (SELECT (r -> 'session' ->> 'id')::uuid FROM voice);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_activity_session((SELECT (r -> 'session' ->> 'id')::uuid FROM voice)) ->> 'status', 'ended',
  'a session the relay stopped touching reads as ended');
SELECT is((public.start_activity_session('drawinphone', NULL, '29900000-0000-0000-0000-000000000001') ->> 'existing')::boolean,
  false, 'and a new start replaces it');
SELECT tests.clear_authentication();
SELECT is((SELECT end_reason FROM public.activity_sessions WHERE id = (SELECT (r -> 'session' ->> 'id')::uuid FROM voice)),
  'idle', 'the stale one finished as idle');

-- Turning an app off ends its sessions. -----------------------------------------------------------
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_activity_app_enabled('drawinphone', false), false, 'an admin turns DrawinPhone off');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.activity_sessions WHERE app_id = 'drawinphone' AND status = 'active'), 0,
  'no session of it is left running');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.start_activity_session('drawinphone', '77777777-0000-0000-0000-000000000007', NULL)$$,
  'P0002', 'ACTIVITY_APP_UNAVAILABLE', 'nor can one start');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
