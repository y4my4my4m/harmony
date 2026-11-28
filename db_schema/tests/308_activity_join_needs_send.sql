-- 20261121100001_activity_join_needs_send.sql: joining a text channel's activity takes Send Messages,
-- and an active server timeout refuses activities in text and voice channels.
--
--   #general 66...06   server_1 text channel; alice owner, bob member
--   #mute    30800..01 server_1 text channel where @everyone lacks SEND_MESSAGES (override deny)
--   #stage   30800..02 server_1 voice channel; bob connected
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('30800000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'mute', 0),
  ('30800000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'stage', 1);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT '30800000-0000-0000-0000-000000000001', 'role', sr.id, 0, 4096
  FROM public.server_roles sr WHERE sr.server_id = '55555555-0000-0000-0000-000000000005' AND sr.is_default;
INSERT INTO public.voice_channel_participants (channel_id, user_id, server_id) VALUES
  ('30800000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.activity_sessions (id, app_id, context, channel_id, server_id, started_by, host_id, members) VALUES
  ('30810000-0000-0000-0000-000000000001', 'drawinphone', 'channel', '30800000-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   ARRAY['11111111-0000-0000-0000-000000000001']::uuid[]);

-- Send Messages. ---------------------------------------------------------------------------------
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '30800000-0000-0000-0000-000000000001', false), 'CANNOT_SEND',
  'bob cannot join a text channel''s activity where he cannot send');
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '30800000-0000-0000-0000-000000000001', true), 'CANNOT_SEND',
  'nor start one there');
SELECT is(public.activity_session_admit('30810000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002') ->> 'refusal', 'CANNOT_SEND',
  'the relay''s admit refuses him a running session there');
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '66666666-0000-0000-0000-000000000006', false), NULL,
  'bob joins where he can send');

-- Seen, with the reason. -------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.get_activity_sessions(NULL, '30800000-0000-0000-0000-000000000001') -> 0 ->> 'refusal', 'CANNOT_SEND',
  'bob sees the running session where he cannot send, with the reason');
SELECT is(public.get_activity_session('30810000-0000-0000-0000-000000000001') ->> 'refusal', 'CANNOT_SEND',
  'and reads it by id with the reason');
SELECT is((public.get_activity_sessions(NULL, '66666666-0000-0000-0000-000000000006') -> 0), NULL,
  'a channel with nothing running lists nothing');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(jsonb_array_length(public.get_activity_sessions(NULL, '30800000-0000-0000-0000-000000000001')), 0,
  'mallory, outside the server, still sees nothing');
SELECT tests.clear_authentication();

-- Timeouts. --------------------------------------------------------------------------------------
INSERT INTO public.server_member_timeouts (server_id, user_id, until, reason) VALUES
  ('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', now() + interval '1 hour', 'test');
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '66666666-0000-0000-0000-000000000006', false), 'MEMBER_TIMED_OUT',
  'a timed-out member cannot join in a text channel');
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '30800000-0000-0000-0000-000000000002', false), 'MEMBER_TIMED_OUT',
  'nor in the voice call he is connected to');
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '66666666-0000-0000-0000-000000000006', true), 'MEMBER_TIMED_OUT',
  'nor start one');
SELECT is(public.activity_join_refusal('11111111-0000-0000-0000-000000000001', NULL, '66666666-0000-0000-0000-000000000006', false), NULL,
  'another member is unaffected');

UPDATE public.server_member_timeouts SET until = now() - interval '1 minute'
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '66666666-0000-0000-0000-000000000006', false), NULL,
  'an expired timeout refuses nothing');
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', NULL, '30800000-0000-0000-0000-000000000002', false), 'NOT_IN_CALL',
  'the timeout took him out of the call (voice_leave_on_timeout)');

SELECT * FROM finish();
ROLLBACK;
