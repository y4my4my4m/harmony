-- 20261124100001_call_signal_relay.sql, voice rooms: harmony-voice-<room> takes no client broadcast;
-- send_signal relays a member's P2P messages with the caller's profile as the sender.
--
-- Fixtures: alice owns server_1, bob is a member, mallory belongs to nothing; alice and bob share
-- DM 7777.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(24);

-- Open voice channel, and one whose CONNECT is denied to @everyone (bit 24).
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('35000000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'p2p-voice', 1),
  ('35000000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'p2p-listen', 1);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT '35000000-0000-0000-0000-0000000000c3', 'role', r.id, 0, 16777216
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

CREATE TEMP TABLE relayed AS
SELECT topic, event, payload, private FROM realtime.messages WHERE false;
GRANT ALL ON relayed TO authenticated;

-- A member's own broadcast ------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$INSERT INTO realtime.messages (topic, extension, event, private, payload)
       VALUES ('harmony-voice-35000000-0000-0000-0000-0000000000c1', 'broadcast', 'signal', true,
               '{"type":"offer","from":"11111111-0000-0000-0000-000000000001","data":{}}'::jsonb)$q$,
    '42501', NULL,
    'a member cannot broadcast an offer on the voice room claiming another member');
SELECT is(public.can_send_to_topic('harmony-voice-35000000-0000-0000-0000-0000000000c1'), false,
          'a member who can join the voice room does not send on it');
SELECT is(public.can_send_to_topic('harmony-voice-dm-77777777-0000-0000-0000-000000000007'), false,
          'a participant does not send on the DM voice room');
SELECT is(public.can_subscribe_to_topic('harmony-voice-35000000-0000-0000-0000-0000000000c1'), true,
          'the member still reads the voice room');
SELECT is(public.can_send_to_topic('typing:channel:66666666-0000-0000-0000-000000000006'), true,
          'a member still sends channel typing');
SELECT is(public.can_send_to_topic('user:22222222-0000-0000-0000-000000000002'), true,
          'a user still sends on their own user topic');

-- The relay ---------------------------------------------------------------------------------
SELECT lives_ok(
    $q$SELECT public.send_signal('harmony-voice-35000000-0000-0000-0000-0000000000c1', 'signals', '{"messages":
         [{"type":"offer","from":"11111111-0000-0000-0000-000000000001","to":"11111111-0000-0000-0000-000000000001","data":{"sdp":"v=0"},"timestamp":1},
          {"type":"ice-candidate","to":"11111111-0000-0000-0000-000000000001","data":{"candidate":"c"},"timestamp":2}]}'::jsonb)$q$,
    'a member relays signals on the voice room');
INSERT INTO relayed SELECT topic, event, payload, private FROM realtime.messages
 WHERE topic = 'harmony-voice-35000000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM relayed), 1, 'one call is one broadcast');
SELECT is((SELECT event FROM relayed), 'signals', 'the broadcast event is signals');
SELECT is((SELECT payload->>'from' FROM relayed), '22222222-0000-0000-0000-000000000002',
          'the sender is the caller''s profile, whatever a message claims');
SELECT is((SELECT jsonb_path_query_array(payload->'messages', '$[*].type') FROM relayed),
          '["offer", "ice-candidate"]'::jsonb, 'messages keep their order');
SELECT is((SELECT payload->'messages'->0->'data'->>'sdp' FROM relayed), 'v=0', 'a message is relayed as sent');
SELECT ok((SELECT private FROM relayed), 'the relay broadcasts privately');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$SELECT public.send_signal('harmony-voice-dm-77777777-0000-0000-0000-000000000007', 'signals',
         '{"messages":[{"type":"user-joined","data":{}}]}'::jsonb)$q$,
    'a participant relays signals on the DM voice room');
SELECT tests.clear_authentication();
SELECT is((SELECT payload->>'from' FROM realtime.messages
            WHERE topic = 'harmony-voice-dm-77777777-0000-0000-0000-000000000007' AND event = 'signals'),
          '11111111-0000-0000-0000-000000000001', 'the DM relay names its caller');

-- Refusals ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.send_signal('harmony-voice-35000000-0000-0000-0000-0000000000c3', 'signals', '{"messages":[{"type":"user-joined"}]}'::jsonb)$q$,
    '42501', NULL, 'a member without CONNECT cannot relay on the voice room');
SELECT throws_ok(
    $q$SELECT public.send_signal('harmony-voice-35000000-0000-0000-0000-0000000000c1', 'signals', '{"messages":[]}'::jsonb)$q$,
    '22023', NULL, 'an empty batch is refused');
SELECT throws_ok(
    $q$SELECT public.send_signal('harmony-voice-35000000-0000-0000-0000-0000000000c1', 'signals',
         jsonb_build_object('messages', (SELECT jsonb_agg(jsonb_build_object('type', 'ice-candidate')) FROM generate_series(1, 65))))$q$,
    '22023', NULL, 'a batch of 65 messages is refused');
SELECT throws_ok(
    $q$SELECT public.send_signal('harmony-voice-35000000-0000-0000-0000-0000000000c1', 'signals', '{"messages":["offer"]}'::jsonb)$q$,
    '22023', NULL, 'a message that is no object is refused');
SELECT throws_ok(
    $q$SELECT public.send_signal('harmony-voice-35000000-0000-0000-0000-0000000000c1', 'signals',
         jsonb_build_object('messages', jsonb_build_array(jsonb_build_object('type', 'offer', 'data', repeat('x', 65536)))))$q$,
    '22023', NULL, 'a payload over 64 KiB is refused');
SELECT throws_ok(
    $q$SELECT public.send_signal('harmony-voice-35000000-0000-0000-0000-0000000000c1', 'signal', '{"messages":[{"type":"offer"}]}'::jsonb)$q$,
    '22023', NULL, 'a voice room takes the signals event only');
SELECT throws_ok(
    $q$SELECT public.send_signal('server-structure:55555555-0000-0000-0000-000000000005', 'signals', '{"messages":[{"type":"offer"}]}'::jsonb)$q$,
    '22023', NULL, 'a topic without a relay is refused');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.send_signal('harmony-voice-dm-77777777-0000-0000-0000-000000000007', 'signals', '{"messages":[{"type":"user-joined"}]}'::jsonb)$q$,
    '42501', NULL, 'a non-participant cannot relay on the DM voice room');
SELECT tests.clear_authentication();

SELECT ok(NOT has_function_privilege('anon', 'public.send_signal(text, text, jsonb)', 'EXECUTE'),
          'anon cannot call send_signal');

SELECT * FROM finish();
ROLLBACK;
