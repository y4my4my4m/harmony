-- Call, voice and presence from 20261006800001_private_call_channels.sql: read and send
-- rules, ring_dm_call, federated_voice_calls.direction, restricted voice channels, presence,
-- servers.is_local_server.
--
-- Fixtures: alice owns server_1, bob is a member, mallory belongs to nothing, banned holds a
-- banned row; alice and bob share DM 7777.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(94);

-- server_1 voice channels: open, hidden from @everyone, CONNECT denied to @everyone. A
-- text channel hidden from @everyone holds a thread; general holds another.
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('70000000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'voice', 1),
  ('70000000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'staff-voice', 1),
  ('70000000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'listen-only', 1),
  ('70000000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005', 'staff', 0);
-- Bit 1 VIEW_CHANNEL, bit 24 CONNECT.
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT ch, 'role', r.id, 0, deny
  FROM public.server_roles r,
       (VALUES ('70000000-0000-0000-0000-0000000000c2'::uuid, 2::bigint),
               ('70000000-0000-0000-0000-0000000000c3'::uuid, 16777216::bigint),
               ('70000000-0000-0000-0000-0000000000c4'::uuid, 2::bigint)) AS o(ch, deny)
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('70000000-0000-0000-0000-0000000000e4', '70000000-0000-0000-0000-0000000000c4',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"staff"}]'::jsonb);
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by) VALUES
  ('70000000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006',
   '88888888-0000-0000-0000-000000000008', 'open thread', '11111111-0000-0000-0000-000000000001'),
  ('70000000-0000-0000-0000-0000000000d4', '70000000-0000-0000-0000-0000000000c4',
   '70000000-0000-0000-0000-0000000000e4', 'staff thread', '11111111-0000-0000-0000-000000000001');

-- READ ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT is(public.can_subscribe_to_topic('dm-call:77777777-0000-0000-0000-000000000007'), false,
          'anon cannot read a DM call topic');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.can_subscribe_to_topic('dm-call:77777777-0000-0000-0000-000000000007'), true,
          'a participant reads the DM call topic');
SELECT is(public.can_subscribe_to_topic('dm-calls:22222222-0000-0000-0000-000000000002'), true,
          'a user reads their own ring topic');
SELECT is(public.can_subscribe_to_topic('dm-calls:11111111-0000-0000-0000-000000000001'), false,
          'a user cannot read another user''s ring topic');
SELECT is(public.can_subscribe_to_topic('voice-channels:55555555-0000-0000-0000-000000000005'), true,
          'an accepted member reads the server voice topic');
SELECT is(public.can_subscribe_to_topic('harmony-voice-70000000-0000-0000-0000-0000000000c1'), true,
          'a member with VIEW_CHANNEL and CONNECT reads the voice room');
SELECT is(public.can_subscribe_to_topic('harmony-voice-70000000-0000-0000-0000-0000000000c2'), false,
          'a member without VIEW_CHANNEL cannot read the voice room');
SELECT is(public.can_subscribe_to_topic('harmony-voice-70000000-0000-0000-0000-0000000000c3'), false,
          'a member without CONNECT cannot read the voice room');
SELECT is(public.can_subscribe_to_topic('harmony-voice-dm-77777777-0000-0000-0000-000000000007'), true,
          'a participant reads the DM voice room');
SELECT is(public.can_subscribe_to_topic('harmony-voice-federated-dm-77777777-0000-0000-0000-000000000007-1700000000000'), true,
          'a participant reads the federated DM voice room');
SELECT is(public.can_subscribe_to_topic('harmony-voice-federated-dm-77777777-0000-0000-0000-000000000007'), false,
          'a federated DM room without its timestamp is refused');
SELECT is(public.can_subscribe_to_topic('harmony-voice-dm-77777777-0000-0000-0000-000000000007-1'), false,
          'a DM room with a suffix is refused');
SELECT is(public.can_subscribe_to_topic('easter-egg:70000000-0000-0000-0000-0000000000c1'), true,
          'a member who can join the voice room reads its easter-egg topic');
SELECT is(public.can_subscribe_to_topic('easter-egg:dm-77777777-0000-0000-0000-000000000007'), true,
          'a participant reads the DM easter-egg topic');
SELECT is(public.can_subscribe_to_topic('typing:conversation:77777777-0000-0000-0000-000000000007'), true,
          'a participant reads DM typing');
SELECT is(public.can_subscribe_to_topic('typing:channel:66666666-0000-0000-0000-000000000006'), true,
          'a member reads channel typing');
SELECT is(public.can_subscribe_to_topic('typing:channel:70000000-0000-0000-0000-0000000000c4'), false,
          'a member cannot read typing in a channel they cannot view');
SELECT is(public.can_subscribe_to_topic('typing:thread:70000000-0000-0000-0000-0000000000d1'), true,
          'a member reads typing in a thread of a viewable channel');
SELECT is(public.can_subscribe_to_topic('typing:thread:70000000-0000-0000-0000-0000000000d4'), false,
          'a member cannot read typing in a thread of a hidden channel');
SELECT is(public.can_subscribe_to_topic('typing:thread:70000000-0000-0000-0000-0000000000ff'), false,
          'typing in an unknown thread is refused');
SELECT is(public.can_subscribe_to_topic('typing:bogus:77777777-0000-0000-0000-000000000007'), false,
          'an unknown typing context is refused');
SELECT is(public.can_subscribe_to_topic('dm-call:not-a-uuid'), false,
          'a malformed DM call topic is refused rather than raising');
SELECT is(public.can_subscribe_to_topic('harmony-voice-not-a-uuid'), false,
          'a malformed voice room is refused rather than raising');
SELECT is(public.can_subscribe_to_topic('view-context:aaaaaaaa-0000-0000-0000-000000000001'), false,
          'view-context has no rule');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.can_subscribe_to_topic('harmony-voice-70000000-0000-0000-0000-0000000000c2'), true,
          'the server owner reads a voice room hidden from @everyone');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.can_subscribe_to_topic('dm-call:77777777-0000-0000-0000-000000000007'), false,
          'a non-participant cannot read the DM call topic');
SELECT is(public.can_subscribe_to_topic('voice-channels:55555555-0000-0000-0000-000000000005'), false,
          'a non-member cannot read the server voice topic');
SELECT is(public.can_subscribe_to_topic('harmony-voice-70000000-0000-0000-0000-0000000000c1'), false,
          'a non-member cannot read the voice room');
SELECT is(public.can_subscribe_to_topic('harmony-voice-dm-77777777-0000-0000-0000-000000000007'), false,
          'a non-participant cannot read the DM voice room');
SELECT is(public.can_subscribe_to_topic('typing:conversation:77777777-0000-0000-0000-000000000007'), false,
          'a non-participant cannot read DM typing');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is(public.can_subscribe_to_topic('voice-channels:55555555-0000-0000-0000-000000000005'), false,
          'a banned member cannot read the server voice topic');

SELECT tests.clear_authentication();
INSERT INTO public.server_member_timeouts (server_id, user_id, until)
VALUES ('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', now() + interval '1 hour');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.can_subscribe_to_topic('harmony-voice-70000000-0000-0000-0000-0000000000c1'), false,
          'a timed-out member cannot read the voice room');
SELECT tests.clear_authentication();
DELETE FROM public.server_member_timeouts
 WHERE server_id = '55555555-0000-0000-0000-000000000005'
   AND user_id = '22222222-0000-0000-0000-000000000002';

-- SEND ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.can_send_to_topic('dm-call:77777777-0000-0000-0000-000000000007'), true,
          'a participant sends on the DM call topic');
SELECT is(public.can_send_to_topic('dm-calls:22222222-0000-0000-0000-000000000002'), false,
          'nobody sends on a ring topic, its owner included');
SELECT is(public.can_send_to_topic('voice-channels:55555555-0000-0000-0000-000000000005'), true,
          'an accepted member sends on the server voice topic');
SELECT is(public.can_send_to_topic('harmony-voice-70000000-0000-0000-0000-0000000000c1'), true,
          'a member who can join the voice room sends on it');
SELECT is(public.can_send_to_topic('harmony-voice-70000000-0000-0000-0000-0000000000c3'), false,
          'a member without CONNECT cannot send on the voice room');
SELECT is(public.can_send_to_topic('typing:channel:66666666-0000-0000-0000-000000000006'), true,
          'a member sends channel typing');
SELECT is(public.can_send_to_topic('user:22222222-0000-0000-0000-000000000002'), true,
          'a user sends on their own user topic');
SELECT is(public.can_send_to_topic('user:11111111-0000-0000-0000-000000000001'), false,
          'a user cannot send on another user topic');
SELECT is(public.can_send_to_topic('server-presence:55555555-0000-0000-0000-000000000005'), true,
          'an accepted member sends server presence');
SELECT is(public.can_send_to_topic('feed:public'), false,
          'a readable feed topic takes no client send');
SELECT is(public.can_send_to_topic('server-structure:55555555-0000-0000-0000-000000000005'), false,
          'server-structure takes no client send');
SELECT is(public.can_send_to_topic('dm-conversation-77777777-0000-0000-0000-000000000007'), false,
          'dm-conversation takes no client send');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.can_send_to_topic('dm-calls:22222222-0000-0000-0000-000000000002'), false,
          'a DM partner cannot send on the other''s ring topic');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.can_send_to_topic('dm-call:77777777-0000-0000-0000-000000000007'), false,
          'a non-participant cannot send on the DM call topic');

SELECT tests.clear_authentication();
SELECT ok(has_function_privilege('authenticated', 'public.can_send_to_topic(text)', 'EXECUTE'),
          'authenticated may evaluate the send gate');
SELECT ok(NOT has_function_privilege('anon', 'public.can_send_to_topic(text)', 'EXECUTE'),
          'anon may not evaluate the send gate');

-- RING ---------------------------------------------------------------------------------------
DELETE FROM realtime.messages WHERE topic LIKE 'dm-calls:%';

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.ring_dm_call('77777777-0000-0000-0000-000000000007',
                              ARRAY['22222222-0000-0000-0000-000000000002',
                                    '33333333-0000-0000-0000-000000000003',
                                    '11111111-0000-0000-0000-000000000001']::uuid[],
                              'initiate', 'video', '99999999-0000-0000-0000-000000000009'), 1,
          'a ring reaches the participant only, not a stranger or the caller');

SELECT tests.clear_authentication();
SELECT is(
    (SELECT event || ',' || (payload->>'type') || ',' || (payload->>'callerId') || ','
            || (payload->>'callType') || ',' || (payload->>'systemMessageId') || ',' || private::text
       FROM realtime.messages WHERE topic = 'dm-calls:22222222-0000-0000-0000-000000000002'),
    'incoming-call,initiate,11111111-0000-0000-0000-000000000001,video,99999999-0000-0000-0000-000000000009,true',
    'the ring names the caller''s own profile and the conversation''s call message, privately');
SELECT is_empty(
    $q$SELECT 1 FROM realtime.messages WHERE topic IN ('dm-calls:33333333-0000-0000-0000-000000000003',
                                                       'dm-calls:11111111-0000-0000-0000-000000000001')$q$,
    'nothing goes to a stranger''s or the caller''s ring topic');

DELETE FROM realtime.messages WHERE topic LIKE 'dm-calls:%';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.ring_dm_call('77777777-0000-0000-0000-000000000007',
                              ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
                              'timeout', 'voice', '88888888-0000-0000-0000-000000000008'), 1,
          'a timeout rings the receiver');
SELECT tests.clear_authentication();
SELECT is(
    (SELECT (payload ? 'systemMessageId')::text || ',' || (payload->>'reason')
       FROM realtime.messages WHERE topic = 'dm-calls:22222222-0000-0000-0000-000000000002'),
    'false,timeout',
    'a message outside the conversation is dropped; a timeout carries its reason');

INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.ring_dm_call('77777777-0000-0000-0000-000000000007',
                              ARRAY['22222222-0000-0000-0000-000000000002']::uuid[], 'initiate', 'voice'), 0,
          'a receiver who blocked the caller is not rung');
SELECT tests.clear_authentication();
UPDATE public.user_blocks SET expires_at = now() - interval '1 minute'
 WHERE blocker_id = '22222222-0000-0000-0000-000000000002'
   AND blocked_user_id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.ring_dm_call('77777777-0000-0000-0000-000000000007',
                              ARRAY['22222222-0000-0000-0000-000000000002']::uuid[], 'initiate', 'voice'), 1,
          'an expired block does not stop the ring');

SELECT throws_ok(
    $q$SELECT public.ring_dm_call('77777777-0000-0000-0000-000000000007',
                                  ARRAY['22222222-0000-0000-0000-000000000002']::uuid[], 'accept', 'voice')$q$,
    '22023'::char(5), NULL, 'a signal other than initiate, end or timeout is refused');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.ring_dm_call('77777777-0000-0000-0000-000000000007',
                                  ARRAY['22222222-0000-0000-0000-000000000002']::uuid[], 'initiate', 'voice')$q$,
    '42501'::char(5), NULL, 'a non-participant cannot ring into the conversation');

SELECT tests.clear_authentication();
SELECT ok(NOT has_function_privilege('anon', 'public.ring_dm_call(uuid,uuid[],text,text,uuid)', 'EXECUTE'),
          'anon cannot ring');

-- REALTIME POLICY ----------------------------------------------------------------------------
SELECT is(
    (SELECT with_check FROM pg_policies
      WHERE schemaname = 'realtime' AND tablename = 'messages' AND policyname = 'authenticated_users_can_send'),
    'can_send_to_topic(topic)',
    'realtime.messages INSERT reads the send gate');

-- Realtime enables RLS on realtime.messages at start; the pgTAP image's stub table has it off
-- and belongs to supabase_admin, so these two run only where RLS is on.
CREATE TEMP TABLE rt70 ON COMMIT DROP AS
SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'realtime.messages'::regclass;
GRANT SELECT ON rt70 TO authenticated;

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT CASE WHEN (SELECT rls FROM rt70) THEN lives_ok(
    $q$INSERT INTO realtime.messages (topic, extension, event, payload, private)
       VALUES ('dm-call:77777777-0000-0000-0000-000000000007', 'presence', 'track', '{}', true)$q$,
    'a participant tracks presence on the DM call topic')
  ELSE skip('realtime.messages has RLS off here', 1) END;
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT CASE WHEN (SELECT rls FROM rt70) THEN throws_ok(
    $q$INSERT INTO realtime.messages (topic, extension, event, payload, private)
       VALUES ('dm-call:77777777-0000-0000-0000-000000000007', 'broadcast', 'call-signal', '{}', true)$q$,
    '42501'::char(5), NULL, 'a non-participant cannot send on the DM call topic')
  ELSE skip('realtime.messages has RLS off here', 1) END;
SELECT tests.clear_authentication();

-- FEDERATED_VOICE_CALLS ----------------------------------------------------------------------
INSERT INTO public.federated_voice_calls
    (ap_id, caller_id, caller_federated_id, recipient_id, call_type, livekit_url, room_name)
VALUES ('https://remote.example/activities/70-inbound', NULL, 'https://remote.example/users/x',
        '22222222-0000-0000-0000-000000000002', 'voice', 'wss://lk.remote.example',
        'federated-dm-77777777-0000-0000-0000-000000000007-1');
SELECT is((SELECT direction FROM public.federated_voice_calls
            WHERE ap_id = 'https://remote.example/activities/70-inbound'),
          'inbound', 'a row without a direction is inbound');
SELECT throws_ok(
    $q$INSERT INTO public.federated_voice_calls
          (ap_id, caller_federated_id, recipient_id, call_type, livekit_url, room_name, direction)
       VALUES ('https://remote.example/activities/70-sideways', 'https://remote.example/users/x',
               '22222222-0000-0000-0000-000000000002', 'voice', 'wss://x', 'r', 'sideways')$q$,
    '23514'::char(5), NULL, 'direction is inbound or outbound');
SELECT ok(NOT has_table_privilege('authenticated', 'public.federated_voice_calls', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.federated_voice_calls', 'INSERT'),
          'clients cannot write federated_voice_calls');


-- RESTRICTED VOICE CHANNELS ------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.can_subscribe_to_topic('voice-channel:70000000-0000-0000-0000-0000000000c2'), false,
          'a member who cannot view a voice channel cannot read its topic');
SELECT is(public.can_send_to_topic('voice-channel:70000000-0000-0000-0000-0000000000c1'), true,
          'a member who can view a voice channel sends on its topic');
SELECT is_empty(
    $q$SELECT * FROM public.get_restricted_voice_channels('55555555-0000-0000-0000-000000000005')$q$,
    'a member is given no restricted voice channel it cannot view');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.can_subscribe_to_topic('voice-channel:70000000-0000-0000-0000-0000000000c2'), true,
          'the owner reads the restricted voice channel topic');
SELECT results_eq(
    $q$SELECT * FROM public.get_restricted_voice_channels('55555555-0000-0000-0000-000000000005')$q$,
    $q$VALUES ('70000000-0000-0000-0000-0000000000c2'::uuid)$q$,
    'the owner is given the voice channel hidden from @everyone, not the CONNECT-denied one');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.can_subscribe_to_topic('voice-channel:70000000-0000-0000-0000-0000000000c1'), false,
          'a non-member cannot read a voice channel topic');
SELECT tests.clear_authentication();
SELECT ok(NOT has_function_privilege('authenticated', 'public.topic_readable_by(uuid,text)', 'EXECUTE'),
          'clients cannot evaluate topic rules for another profile');

-- PRESENCE -----------------------------------------------------------------------------------
-- One transaction: now() stands still, so the once-a-second publish limit is reset by hand.
CREATE OR REPLACE FUNCTION pg_temp.unthrottle() RETURNS void LANGUAGE sql AS
$$ UPDATE public.user_presence SET published_at = published_at - interval '2 seconds' $$;
DELETE FROM realtime.messages;

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.presence_heartbeat('dev', 1::smallint, false)$q$,
    '42501'::char(5), NULL, 'anon cannot heartbeat');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.presence_heartbeat('dev-b', 1::smallint, false)$q$, 'bob heartbeats');
SELECT throws_ok($q$SELECT public.presence_heartbeat('dev-b', 0::smallint, false)$q$,
    '22023'::char(5), NULL, 'status 0 is not a choice');

SELECT tests.clear_authentication();
SELECT is(
    (SELECT event || ',' || (payload->>'type') || ',' || (payload->>'online') || ',' || (payload->>'status')
       FROM realtime.messages
      WHERE topic = 'server-presence:55555555-0000-0000-0000-000000000005'
        AND payload->>'user_id' = '22222222-0000-0000-0000-000000000002'),
    'presence_event,presence:update,true,1',
    'bob coming online is told to his server, privately');
SELECT isnt_empty(
    $q$SELECT 1 FROM realtime.messages WHERE topic = 'user:11111111-0000-0000-0000-000000000001'
         AND payload->>'type' = 'presence:update' AND private$q$,
    'and to his DM partner alice');
SELECT is_empty(
    $q$SELECT 1 FROM realtime.messages WHERE topic = 'user:33333333-0000-0000-0000-000000000003'$q$,
    'and to no one else');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT results_eq(
    $q$SELECT profile_id, status, online FROM public.get_presence(ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
    $q$VALUES ('22222222-0000-0000-0000-000000000002'::uuid, 1::smallint, true)$q$,
    'a co-member sees bob online');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$SELECT * FROM public.get_presence(ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
    'a stranger sees nothing of bob');

-- Invisible: online to himself, offline to others.
SELECT tests.clear_authentication();
SELECT pg_temp.unthrottle();
DELETE FROM realtime.messages;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.presence_heartbeat('dev-b', 4::smallint, false)$q$, 'bob goes invisible');
SELECT results_eq(
    $q$SELECT status, online FROM public.get_presence(ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
    $q$VALUES (4::smallint, true)$q$,
    'bob reads his own chosen status');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is_empty(
    $q$SELECT * FROM public.get_presence(ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
    'a co-member sees invisible bob as absent');
SELECT tests.clear_authentication();
SELECT is(
    (SELECT (payload->>'online') || ',' || (payload->>'status') FROM realtime.messages
      WHERE topic = 'server-presence:55555555-0000-0000-0000-000000000005'),
    'false,0',
    'going invisible is told as going offline');

-- Follow: mallory follows bob; then bob blocks mallory.
SELECT pg_temp.unthrottle();
INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', 'accepted');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.presence_heartbeat('dev-b', 3::smallint, true);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT results_eq(
    $q$SELECT status, is_mobile FROM public.get_presence(ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
    $q$VALUES (3::smallint, true)$q$,
    'a follower sees bob busy on mobile');
SELECT tests.clear_authentication();
INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ('22222222-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$SELECT * FROM public.get_presence(ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
    'a follower bob blocked sees nothing');

-- Offline and sweep.
SELECT tests.clear_authentication();
SELECT pg_temp.unthrottle();
DELETE FROM realtime.messages;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.presence_offline('dev-b');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is_empty(
    $q$SELECT * FROM public.get_presence(ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
    'bob closing his last tab is offline at once');
SELECT tests.clear_authentication();
SELECT is(
    (SELECT payload->>'online' FROM realtime.messages
      WHERE topic = 'user:11111111-0000-0000-0000-000000000001' AND payload->>'type' = 'presence:update'),
    'false',
    'and alice is told');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.presence_heartbeat('dev-a', 1::smallint, false);
SELECT tests.clear_authentication();
UPDATE public.presence_devices SET last_seen_at = now() - interval '5 minutes'
 WHERE profile_id = '11111111-0000-0000-0000-000000000001';
SELECT pg_temp.unthrottle();
SELECT ok(public.presence_sweep() >= 1, 'the sweep finds alice''s dead tab');
SELECT is(
    (SELECT online::text || ',' || published_status FROM public.user_presence
      WHERE profile_id = '11111111-0000-0000-0000-000000000001'),
    'false,0',
    'and publishes her offline');

-- Device cap.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT count(*) FROM (SELECT public.presence_heartbeat('cap-' || g, 1::smallint, false) FROM generate_series(1, 25) g) s;
SELECT tests.clear_authentication();
SELECT ok((SELECT count(*) FROM public.presence_devices WHERE profile_id = '22222222-0000-0000-0000-000000000002') <= 20,
          'a profile keeps at most 20 devices');

SELECT ok(NOT has_table_privilege('authenticated', 'public.user_presence', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.presence_devices', 'SELECT'),
          'clients cannot read presence tables');
SELECT ok(NOT has_function_privilege('authenticated', 'public.presence_related_ids(uuid,uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.presence_sweep()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_presence(uuid[])', 'EXECUTE'),
          'presence internals stay internal');

-- SERVERS.IS_LOCAL_SERVER ----------------------------------------------------------------------
SELECT col_not_null('public', 'servers', 'is_local_server', 'servers.is_local_server is NOT NULL');
SELECT col_default_is('public', 'servers', 'is_local_server', 'true', 'and defaults to true');

SELECT * FROM finish();
ROLLBACK;
