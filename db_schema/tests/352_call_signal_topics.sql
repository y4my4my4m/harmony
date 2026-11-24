-- 20261124100001_call_signal_relay.sql, DM calls and easter eggs: dm-call:<conversation> takes
-- presence but no client broadcast, easter-egg:<room> takes neither; send_signal names the sender.
--
-- Fixtures: alice owns server_1, bob is a member, mallory belongs to nothing; alice and bob share
-- DM 7777.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(25);

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('35200000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'egg-voice', 1);

-- Client writes -----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$INSERT INTO realtime.messages (topic, extension, event, private, payload)
       VALUES ('dm-call:77777777-0000-0000-0000-000000000007', 'broadcast', 'call-signal', true,
               '{"type":"accept","callerId":"11111111-0000-0000-0000-000000000001","conversationId":"77777777-0000-0000-0000-000000000007"}'::jsonb)$q$,
    '42501', NULL,
    'a participant cannot broadcast a call answer claiming the other participant');
SELECT lives_ok(
    $q$INSERT INTO realtime.messages (topic, extension, event, private, payload)
       VALUES ('dm-call:77777777-0000-0000-0000-000000000007', 'presence', 'presence', true, '{}'::jsonb)$q$,
    'a participant tracks presence on the DM call topic');
SELECT throws_ok(
    $q$INSERT INTO realtime.messages (topic, extension, event, private, payload)
       VALUES ('easter-egg:35200000-0000-0000-0000-0000000000c1', 'broadcast', 'activate', true,
               '{"type":"rainbow-party","userId":"11111111-0000-0000-0000-000000000001"}'::jsonb)$q$,
    '42501', NULL,
    'a member cannot broadcast an easter egg in another member''s name');
SELECT lives_ok(
    $q$INSERT INTO realtime.messages (topic, extension, event, private, payload)
       VALUES ('typing:channel:66666666-0000-0000-0000-000000000006', 'presence', 'presence', true, '{}'::jsonb)$q$,
    'a member tracks typing');
SELECT is(public.can_track_on_topic('harmony-voice-35200000-0000-0000-0000-0000000000c1'), false,
          'a voice room takes no presence');
SELECT is(public.can_track_on_topic('user:22222222-0000-0000-0000-000000000002'), false,
          'a user topic takes no presence');

-- The relay ---------------------------------------------------------------------------------
SELECT lives_ok(
    $q$SELECT public.send_signal('dm-call:77777777-0000-0000-0000-000000000007', 'call-signal',
         '{"type":"accept","callerId":"11111111-0000-0000-0000-000000000001","callType":"video","conversationId":"00000000-0000-0000-0000-000000000000"}'::jsonb)$q$,
    'a participant answers through the relay');
SELECT lives_ok(
    $q$SELECT public.send_signal('easter-egg:35200000-0000-0000-0000-0000000000c1', 'activate',
         '{"type":"rainbow-party","userId":"11111111-0000-0000-0000-000000000001"}'::jsonb)$q$,
    'a member starts an easter egg through the relay');
SELECT lives_ok(
    $q$SELECT public.send_signal('easter-egg:35200000-0000-0000-0000-0000000000c1', 'deactivate', '{}'::jsonb)$q$,
    'and ends it');
SELECT tests.clear_authentication();

SELECT is((SELECT payload - 'timestamp' - 'id' FROM realtime.messages
            WHERE topic = 'dm-call:77777777-0000-0000-0000-000000000007' AND event = 'call-signal'),
          '{"type": "accept", "callerId": "22222222-0000-0000-0000-000000000002", "callType": "video",
            "conversationId": "77777777-0000-0000-0000-000000000007"}'::jsonb,
          'the answer names its sender and the topic''s conversation, whatever the payload claims');
SELECT ok((SELECT (payload->>'timestamp')::bigint > 0 FROM realtime.messages
            WHERE topic = 'dm-call:77777777-0000-0000-0000-000000000007' AND event = 'call-signal'),
          'and carries the database''s time');
SELECT is((SELECT array_agg(event || ' ' || (payload - 'id')::text ORDER BY event) FROM realtime.messages
            WHERE topic = 'easter-egg:35200000-0000-0000-0000-0000000000c1'),
          ARRAY['activate {"type": "rainbow-party", "userId": "22222222-0000-0000-0000-000000000002"}',
                'deactivate {"userId": "22222222-0000-0000-0000-000000000002"}'],
          'easter eggs name their member');

-- Refusals ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.send_signal('dm-call:77777777-0000-0000-0000-000000000007', 'call-signal', '{"type":"initiate"}'::jsonb)$q$,
    '22023', NULL, 'a ring is not a call signal: ring_dm_call rings');
SELECT throws_ok(
    $q$SELECT public.send_signal('dm-call:77777777-0000-0000-0000-000000000007', 'call-signal', '{"type":"accept","callType":"fax"}'::jsonb)$q$,
    '22023', NULL, 'an unknown call type is refused');
SELECT throws_ok(
    $q$SELECT public.send_signal('dm-call:77777777-0000-0000-0000-000000000007', 'call-signal', '{"type":"decline","reason":"bored"}'::jsonb)$q$,
    '22023', NULL, 'an unknown decline reason is refused');
SELECT throws_ok(
    $q$SELECT public.send_signal('dm-call:77777777-0000-0000-0000-000000000007', 'signals', '{"type":"accept"}'::jsonb)$q$,
    '22023', NULL, 'a DM call takes the call-signal event only');
SELECT throws_ok(
    $q$SELECT public.send_signal('easter-egg:35200000-0000-0000-0000-0000000000c1', 'activate', '{"type":"<script>"}'::jsonb)$q$,
    '22023', NULL, 'an easter egg names a plain type');
SELECT lives_ok(
    $q$SELECT public.send_signal('dm-call:77777777-0000-0000-0000-000000000007', 'call-signal', '{"type":"decline","reason":"dnd"}'::jsonb)$q$,
    'a decline names its reason');
SELECT lives_ok(
    $q$SELECT public.send_signal('dm-call:77777777-0000-0000-0000-000000000007', 'call-signal', '{"type":"leave"}'::jsonb)$q$,
    'a participant leaves the call');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.send_signal('dm-call:77777777-0000-0000-0000-000000000007', 'call-signal', '{"type":"end"}'::jsonb)$q$,
    '42501', NULL, 'a non-participant cannot end the call');
SELECT throws_ok(
    $q$SELECT public.send_signal('easter-egg:35200000-0000-0000-0000-0000000000c1', 'activate', '{"type":"megaman"}'::jsonb)$q$,
    '42501', NULL, 'a non-member cannot start an easter egg');
SELECT throws_ok(
    $q$INSERT INTO realtime.messages (topic, extension, event, private, payload)
       VALUES ('dm-call:77777777-0000-0000-0000-000000000007', 'presence', 'presence', true, '{}'::jsonb)$q$,
    '42501', NULL,
    'a non-participant tracks no presence on the DM call topic');
SELECT tests.clear_authentication();

-- The sender's other devices hear its answers on its own ring topic, which only the database writes.
SELECT is((SELECT array_agg(payload->>'type' ORDER BY inserted_at, payload->>'type') FROM realtime.messages
            WHERE topic = 'dm-calls:22222222-0000-0000-0000-000000000002' AND event = 'call-signal'),
          ARRAY['accept', 'decline'], 'answers reach the sender''s own ring topic; a leave does not');
SELECT is((SELECT count(DISTINCT payload->>'callerId')::int FROM realtime.messages
            WHERE topic = 'dm-calls:22222222-0000-0000-0000-000000000002' AND event = 'call-signal'
              AND payload->>'callerId' = '22222222-0000-0000-0000-000000000002'), 1,
          'named by the database');

SELECT ok(has_function_privilege('authenticated', 'public.can_track_on_topic(text)', 'EXECUTE'),
          'authenticated may evaluate the presence gate');

SELECT * FROM finish();
ROLLBACK;
