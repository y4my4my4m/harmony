-- 20261110100001_room_and_broadcast_boundaries.sql: a message names one room, a reaction's room
-- is its message's, Drive names rooms the caller reads, a row that is not accepted reads no
-- roster, and server topics take no client's send.
--
--   alice    owns server_1 and is in the DM
--   bob      member of server_1 and in the DM
--   mallory  member of nothing here; owns server M and is alone in a group conversation
--   banned   status banned on server P; pending on server Q
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(42);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2540000-0000-0000-0000-000000000001', 'Mallory''s', '33333333-0000-0000-0000-000000000003'),
  ('f2540000-0000-0000-0000-00000000000a', 'Private P', '11111111-0000-0000-0000-000000000001'),
  ('f2540000-0000-0000-0000-00000000000b', 'Private Q', '11111111-0000-0000-0000-000000000001');
UPDATE public.servers SET public = false WHERE id IN
  ('f2540000-0000-0000-0000-00000000000a', 'f2540000-0000-0000-0000-00000000000b');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('33333333-0000-0000-0000-000000000003', 'f2540000-0000-0000-0000-000000000001', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', 'f2540000-0000-0000-0000-00000000000a', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', 'f2540000-0000-0000-0000-00000000000b', 'accepted'),
  ('44444444-0000-0000-0000-000000000004', 'f2540000-0000-0000-0000-00000000000a', 'banned'),
  ('44444444-0000-0000-0000-000000000004', 'f2540000-0000-0000-0000-00000000000b', 'pending');
INSERT INTO public.server_roles (server_id, name, position)
VALUES ('f2540000-0000-0000-0000-00000000000b', 'q-role254', 5);
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2540000-0000-0000-0000-000000000002', 'f2540000-0000-0000-0000-000000000001', 'hers', 0),
  ('f2540000-0000-0000-0000-00000000000c', 'f2540000-0000-0000-0000-00000000000a', 'p-secret', 0);
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f2540000-0000-0000-0000-000000000003', 'f2540000-0000-0000-0000-000000000002',
   '33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"hers"}]');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by) VALUES
  ('f2541000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006',
   '88888888-0000-0000-0000-000000000008', 'general thread', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.conversations (id, type) VALUES ('f2542000-0000-0000-0000-000000000001', 'group');
INSERT INTO public.conversation_participants (conversation_id, user_id)
VALUES ('f2542000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003');

-- One room per message. ----------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, conversation_id, user_id, content)
                    VALUES ('66666666-0000-0000-0000-000000000006', 'f2542000-0000-0000-0000-000000000001',
                            '33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"x"}]')$q$,
  '42501', NULL, 'a stranger naming her own conversation writes nothing into a channel');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, conversation_id, user_id, content)
                    VALUES ('f2540000-0000-0000-0000-000000000002', '77777777-0000-0000-0000-000000000007',
                            '33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"x"}]')$q$,
  '42501', NULL, 'naming her own channel writes nothing into another''s DM');
SELECT throws_ok($q$INSERT INTO public.messages (conversation_id, thread_id, user_id, content)
                    VALUES ('f2542000-0000-0000-0000-000000000001', 'f2541000-0000-0000-0000-000000000001',
                            '33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"x"}]')$q$,
  '42501', NULL, 'naming her own conversation writes nothing into a thread');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, thread_id, user_id, content)
                    VALUES ('f2540000-0000-0000-0000-000000000002', 'f2541000-0000-0000-0000-000000000001',
                            '33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"x"}]')$q$,
  '42501', NULL, 'nor does naming her own channel');
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                   VALUES ('f2540000-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003',
                           '[{"type":"text","text":"in her channel"}]')$q$,
  'a message in her own channel is taken');
SELECT lives_ok($q$INSERT INTO public.messages (conversation_id, user_id, content)
                   VALUES ('f2542000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003',
                           '[{"type":"text","text":"in her conversation"}]')$q$,
  'and in her own conversation');
SELECT tests.clear_authentication();

SELECT throws_ok($q$INSERT INTO public.messages (channel_id, conversation_id, user_id, content)
                    VALUES ('66666666-0000-0000-0000-000000000006', '77777777-0000-0000-0000-000000000007',
                            '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"x"}]')$q$,
  '42501', NULL, 'the service role names one room too');
SELECT throws_ok($q$UPDATE public.messages SET conversation_id = '77777777-0000-0000-0000-000000000007'
                     WHERE id = 'f2540000-0000-0000-0000-000000000003'$q$,
  '42501', NULL, 'and adds no second room to a row');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, thread_id, user_id, content)
                    VALUES ('f2540000-0000-0000-0000-000000000002', 'f2541000-0000-0000-0000-000000000001',
                            '33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"x"}]')$q$,
  '42501', NULL, 'and a thread message is in its thread''s channel');

ALTER TABLE public.messages DISABLE TRIGGER a_messages_room_guard;
INSERT INTO public.messages (id, channel_id, conversation_id, user_id, content)
VALUES ('f2540000-0000-0000-0000-000000000004', 'f2540000-0000-0000-0000-000000000002',
        'f2542000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003',
        '[{"type":"text","text":"stored before"}]');
ALTER TABLE public.messages ENABLE TRIGGER a_messages_room_guard;
SELECT lives_ok($q$UPDATE public.messages SET content = '[{"type":"text","text":"edited"}]'
                    WHERE id = 'f2540000-0000-0000-0000-000000000004'$q$,
  'a row stored with both rooms stays editable');
DELETE FROM public.messages WHERE id = 'f2540000-0000-0000-0000-000000000004';

-- A reaction's room is its message's. ---------------------------------------------------------
DELETE FROM realtime.messages WHERE event = 'reaction_event';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
INSERT INTO public.reactions (id, message_id, user_id, custom_emoji_content, channel_id, conversation_id,
                              metadata, bot_id, federation_status)
VALUES ('f2543000-0000-0000-0000-000000000001', 'f2540000-0000-0000-0000-000000000003',
        '33333333-0000-0000-0000-000000000003', '👍',
        '66666666-0000-0000-0000-000000000006', '77777777-0000-0000-0000-000000000007',
        '{"federated":true,"remote_emoji_url":"https://evil.example/x.png","discord_user":{"id":"1","username":"Alice","display_name":"Alice"}}',
        'f2543000-0000-0000-0000-0000000000b0', 'completed');
SELECT tests.clear_authentication();
SELECT is((SELECT channel_id FROM public.reactions WHERE id = 'f2543000-0000-0000-0000-000000000001'),
  'f2540000-0000-0000-0000-000000000002'::uuid, 'a client''s reaction takes the channel of its message');
SELECT is((SELECT conversation_id FROM public.reactions WHERE id = 'f2543000-0000-0000-0000-000000000001'),
  NULL, 'and no conversation');
SELECT is((SELECT metadata FROM public.reactions WHERE id = 'f2543000-0000-0000-0000-000000000001'),
  '{}'::jsonb, 'and no metadata');
SELECT is((SELECT bot_id FROM public.reactions WHERE id = 'f2543000-0000-0000-0000-000000000001'),
  NULL, 'no bot');
SELECT isnt((SELECT federation_status FROM public.reactions WHERE id = 'f2543000-0000-0000-0000-000000000001'),
  'completed', 'and no federation status of its choosing');
SELECT is((SELECT array_agg(topic) FROM realtime.messages WHERE event = 'reaction_event'
            AND payload ->> 'reaction_id' = 'f2543000-0000-0000-0000-000000000001'),
  ARRAY['channel-messages-f2540000-0000-0000-0000-000000000002'], 'it is announced on the message''s room only');
SELECT is((SELECT payload ->> 'display_name' FROM realtime.messages WHERE event = 'reaction_event'
            AND payload ->> 'reaction_id' = 'f2543000-0000-0000-0000-000000000001'),
  'Mallory', 'under the reactor''s own name');
INSERT INTO public.reactions (id, message_id, user_id, custom_emoji_content, metadata)
VALUES ('f2543000-0000-0000-0000-000000000002', 'f2540000-0000-0000-0000-000000000003',
        '11111111-0000-0000-0000-000000000001', '🎉', '{"federated":true}');
SELECT is((SELECT metadata ->> 'federated' FROM public.reactions WHERE id = 'f2543000-0000-0000-0000-000000000002'),
  'true', 'the service role keeps its metadata');

-- Drive names rooms the caller reads. ---------------------------------------------------------
INSERT INTO public.drive_files (owner_id, bucket, path, name, mime_type, size_bytes, state)
VALUES ('33333333-0000-0000-0000-000000000003', 'message_media', 'u/cccccccc-0000-0000-0000-000000000003/f254.png',
        'f254.png', 'image/png', 1, 'drive');
INSERT INTO public.messages (channel_id, user_id, content) VALUES
  ('f2540000-0000-0000-0000-00000000000c', '33333333-0000-0000-0000-000000000003',
   '[{"type":"file","path":"u/cccccccc-0000-0000-0000-000000000003/f254.png","mimeType":"image/png","url":"x"}]'),
  ('f2540000-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003',
   '[{"type":"file","path":"u/cccccccc-0000-0000-0000-000000000003/f254.png","mimeType":"image/png","url":"x"}]');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT jsonb_agg(s ->> 'name') FROM jsonb_array_elements(public.drive_context_tree() -> 'servers') s),
  '["Mallory''s"]'::jsonb, 'Drive names the room the owner reads, not one a row of theirs points at');
SELECT tests.clear_authentication();

-- A row that is not accepted. -----------------------------------------------------------------
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is((SELECT count(*)::int FROM public.servers WHERE id = 'f2540000-0000-0000-0000-00000000000a'), 0,
  'a banned row reads no private server');
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE server_id = 'f2540000-0000-0000-0000-00000000000a'
            AND user_id <> '44444444-0000-0000-0000-000000000004'), 0, 'nor its roster');
SELECT is((SELECT count(*)::int FROM public.server_roles WHERE server_id = 'f2540000-0000-0000-0000-00000000000a'), 0,
  'nor its roles');
SELECT is((SELECT count(*)::int FROM public.servers WHERE id = 'f2540000-0000-0000-0000-00000000000b'), 1,
  'a pending row reads the server it asked to join');
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE server_id = 'f2540000-0000-0000-0000-00000000000b'
            AND user_id <> '44444444-0000-0000-0000-000000000004'), 0, 'not its roster');
SELECT is((SELECT count(*)::int FROM public.server_roles WHERE server_id = 'f2540000-0000-0000-0000-00000000000b'), 0,
  'nor its roles');
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE user_id = '44444444-0000-0000-0000-000000000004'
            AND server_id = 'f2540000-0000-0000-0000-00000000000b'), 1, 'and reads its own row');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok((SELECT count(*) FROM public.server_roles WHERE server_id = 'f2540000-0000-0000-0000-00000000000b') >= 1,
  'an accepted member reads the roles');
SELECT tests.clear_authentication();
SELECT ok(has_function_privilege('authenticated', 'public.current_user_requested_server_ids()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.current_user_requested_server_ids()', 'EXECUTE'),
  'current_user_requested_server_ids: authenticated, no anon');

-- Server topics take no client's send. --------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.can_send_to_topic('server-presence:55555555-0000-0000-0000-000000000005'), false,
  'a member sends nothing on server-presence');
SELECT is(public.can_send_to_topic('voice-channels:55555555-0000-0000-0000-000000000005'), false,
  'nor on voice-channels');
SELECT is(public.can_send_to_topic('voice-channel:66666666-0000-0000-0000-000000000006'), false,
  'nor on voice-channel');
SELECT is(public.can_send_to_topic('typing:channel:66666666-0000-0000-0000-000000000006'), true,
  'and still on a typing topic');
SELECT throws_ok($q$INSERT INTO realtime.messages (topic, extension, event, payload, private)
                    VALUES ('voice-channels:55555555-0000-0000-0000-000000000005', 'broadcast',
                            'voice-channel-event', '{"event":"voice-moderation"}', true)$q$,
  '42501', NULL, 'the row is refused under RLS');
SELECT tests.clear_authentication();

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2540000-0000-0000-0000-000000000010', '55555555-0000-0000-0000-000000000005', 'voice254', 1);
INSERT INTO public.servers (id, name, owner, is_local_server, ap_id) VALUES
  ('f2540000-0000-0000-0000-000000000020', 'Copy', NULL, false, 'https://host.example/servers/f2540000-0000-0000-0000-000000000020');
INSERT INTO public.channels (id, server_id, name, type, is_remote) VALUES
  ('f2540000-0000-0000-0000-000000000021', 'f2540000-0000-0000-0000-000000000020', 'copy voice', 1, true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2540000-0000-0000-0000-000000000020', 'accepted');

DELETE FROM realtime.messages WHERE event = 'voice-channel-event';
CREATE TEMP VIEW voice254_sent AS
SELECT topic, payload ->> 'event' AS event, payload ->> 'userId' AS user_id, payload ->> 'channelId' AS channel_id,
       payload ->> 'callStartTime' AS call_start
  FROM realtime.messages WHERE event = 'voice-channel-event' AND private;
GRANT SELECT ON voice254_sent TO authenticated;

INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
VALUES ('f2540000-0000-0000-0000-000000000010', '55555555-0000-0000-0000-000000000005',
        '22222222-0000-0000-0000-000000000002');
SELECT is((SELECT user_id FROM voice254_sent WHERE event = 'user-joined' AND channel_id = 'f2540000-0000-0000-0000-000000000010'),
  '22222222-0000-0000-0000-000000000002', 'a row is announced as user-joined with its user');
SELECT ok((SELECT call_start IS NOT NULL FROM voice254_sent WHERE event = 'user-joined' AND channel_id = 'f2540000-0000-0000-0000-000000000010'),
  'and the call''s start');

SELECT ok(has_function_privilege('authenticated', 'public.voice_channel_announce(uuid, uuid, text, timestamptz)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.voice_channel_announce(uuid, uuid, text, timestamptz)', 'EXECUTE'),
  'voice_channel_announce: authenticated, no anon');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.voice_channel_announce('55555555-0000-0000-0000-000000000005',
                      'f2540000-0000-0000-0000-000000000010', 'user-joined')$q$,
  '42501', NULL, 'on a local server its rows announce, not a call');
SELECT throws_ok($q$SELECT public.voice_channel_announce('f2540000-0000-0000-0000-000000000020',
                      'f2540000-0000-0000-0000-000000000021', 'voice-moderation')$q$,
  '22023', NULL, 'it carries no other event');
SELECT throws_ok($q$SELECT public.voice_channel_announce('f2540000-0000-0000-0000-000000000020',
                      '66666666-0000-0000-0000-000000000006', 'user-joined')$q$,
  '42501', NULL, 'nor a channel of another server');
SELECT lives_ok($q$SELECT public.voice_channel_announce('f2540000-0000-0000-0000-000000000020',
                     'f2540000-0000-0000-0000-000000000021', 'user-joined', now())$q$,
  'an accepted member announces on a copy');
SELECT tests.clear_authentication();
SELECT is((SELECT user_id FROM voice254_sent WHERE event = 'user-joined' AND channel_id = 'f2540000-0000-0000-0000-000000000021'),
  '22222222-0000-0000-0000-000000000002', 'as the caller');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.voice_channel_announce('f2540000-0000-0000-0000-000000000020',
                      'f2540000-0000-0000-0000-000000000021', 'user-joined')$q$,
  '42501', NULL, 'and a non-member does not');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
