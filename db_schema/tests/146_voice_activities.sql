-- Voice activities from 20261015100004_voice_activities.sql: start, control, queue, host mode,
-- file shares, the end of the call and the broadcasts.
--
--   alice  owns server_1; in the voice channel
--   bob    member of server_1; in the voice channel
--   carol  (cccccccc) in no server
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(28);

CREATE FUNCTION tests.sent146(p_source text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT count(*)::int FROM realtime.messages
   WHERE event = 'voice-channel-event'
     AND topic = 'voice-channels:55555555-0000-0000-0000-000000000005'
     AND payload ->> 'channelId' = 'f1460000-0000-0000-0000-000000000001'
     AND payload ->> 'event' = 'activity'
     AND CASE WHEN p_source IS NULL THEN payload -> 'activity' = 'null'::jsonb
              ELSE payload -> 'activity' ->> 'source' = p_source END
$fn$;
GRANT EXECUTE ON FUNCTION tests.sent146(text) TO authenticated;

INSERT INTO storage.buckets (id, name, public)
VALUES ('message_media', 'message_media', false) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f1460000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'lounge', 1);
INSERT INTO public.voice_channel_participants (channel_id, user_id, server_id) VALUES
  ('f1460000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('f1460000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/movie.webm', '{"size": 100, "mimetype": "video/webm"}'),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/notes.txt', '{"size": 10, "mimetype": "text/plain"}');

CREATE FUNCTION tests.state146() RETURNS public.voice_activities
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT * FROM public.voice_activities WHERE channel_id = 'f1460000-0000-0000-0000-000000000001'
$fn$;
GRANT EXECUTE ON FUNCTION tests.state146() TO authenticated;
CREATE FUNCTION tests.shared146() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT count(*)::int FROM public.drive_shares WHERE scope = 'channel' AND target_id = 'f1460000-0000-0000-0000-000000000001'
$fn$;
GRANT EXECUTE ON FUNCTION tests.shared146() TO authenticated;

-- Start. ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.voice_activity_start('f1460000-0000-0000-0000-000000000001', 'youtube', '{"video_id":"dQw4w9WgXcQ"}')$q$,
    '42501', 'Join the voice channel first', 'someone outside the call cannot start an activity');
SELECT throws_ok($q$SELECT public.get_voice_activity('f1460000-0000-0000-0000-000000000001')$q$, 'P0002', NULL,
  'nor read the activity of a channel it cannot view');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.voice_activity_start('f1460000-0000-0000-0000-000000000001', 'youtube', '{"video_id":"bad id!"}')$q$,
    '22023', NULL, 'a YouTube item needs a video id');
SELECT throws_ok(
    $q$SELECT public.voice_activity_start('f1460000-0000-0000-0000-000000000001', 'file',
         '{"bucket":"message_media","path":"u/aaaaaaaa-0000-0000-0000-000000000001/movie.webm"}')$q$,
    '42501', NULL, 'a file activity plays the starter''s own Drive file only');
SELECT is((public.voice_activity_start('f1460000-0000-0000-0000-000000000001', 'youtube',
            '{"video_id":"dQw4w9WgXcQ","title":"Song"}') -> 'activity' ->> 'source'), 'youtube',
  'a participant starts a YouTube activity');
SELECT ok((tests.state146()).playing AND (tests.state146()).position_ms = 0 AND (tests.state146()).host_id = '22222222-0000-0000-0000-000000000002',
  'it plays from the start with the starter as host');
SELECT is(tests.sent146('youtube'), 1, 'the start is announced on the server''s voice topic, with the activity');

-- Control. -------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok((SELECT NOT ((public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'pause',
            '{"position_ms": 4200}')) -> 'activity' -> 'playing')::boolean),
  'another participant pauses it');
SELECT is((tests.state146()).position_ms, 4200::bigint, 'at the position it names');
SELECT is((public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'seek', '{"position_ms": 60000}')
          -> 'activity' ->> 'position_ms')::bigint, 60000::bigint, 'a seek moves the position');
SELECT ok((public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'play') -> 'activity' ->> 'playing')::boolean,
  'play resumes');
SELECT throws_ok($q$SELECT public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'rate', '{"rate": 9}')$q$,
  '22023', NULL, 'the rate stays between 0.25 and 4');

-- Queue. ---------------------------------------------------------------------------------
SELECT lives_ok(
    $q$SELECT public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'enqueue',
         '{"source":"file","item":{"bucket":"message_media","path":"u/aaaaaaaa-0000-0000-0000-000000000001/movie.webm"}}')$q$,
    'the file''s owner queues her video');
SELECT throws_ok(
    $q$SELECT public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'enqueue',
         '{"source":"file","item":{"bucket":"message_media","path":"u/aaaaaaaa-0000-0000-0000-000000000001/notes.txt"}}')$q$,
    '22023', NULL, 'a text file does not play');
SELECT is(jsonb_array_length((tests.state146()).queue), 1, 'one item is queued');
SELECT is((public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'next',
            jsonb_build_object('revision', (tests.state146()).revision)) -> 'activity' ->> 'source'), 'file',
  'next plays the queued file');
SELECT is(tests.shared146(), 1, 'while a file plays it is shared with the voice channel');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE name = 'u/aaaaaaaa-0000-0000-0000-000000000001/movie.webm'), 1,
  'so the other participants read it');
SELECT is((public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'next', '{"revision": 1}')
          -> 'activity' ->> 'source'), 'file',
  'a next naming an old revision changes nothing');

-- Host mode. -----------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'controls', '{"mode":"host"}')$q$,
  '42501', 'Only the host controls this activity', 'only the host switches to host controls');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'controls', '{"mode":"host"}')
          -> 'activity' ->> 'controls'), 'host', 'the host takes host controls');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'pause')$q$,
  '42501', 'Only the host controls this activity', 'then only the host controls it');
SELECT tests.clear_authentication();
DELETE FROM public.voice_channel_participants
 WHERE channel_id = 'f1460000-0000-0000-0000-000000000001' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'pause')$q$,
  'once the host leaves the call anyone controls it');

-- The end. -------------------------------------------------------------------------------
SELECT ok(public.voice_activity_control('f1460000-0000-0000-0000-000000000001', 'next') -> 'activity' = 'null'::jsonb,
  'next with an empty queue ends the activity');
SELECT is(tests.shared146(), 0, 'and drops the file''s share');
SELECT lives_ok(
    $q$SELECT public.voice_activity_start('f1460000-0000-0000-0000-000000000001', 'url', '{"url":"https://example.com/a.mp4"}')$q$,
    'a direct media URL starts an activity');
SELECT tests.clear_authentication();
DELETE FROM public.voice_channel_participants WHERE channel_id = 'f1460000-0000-0000-0000-000000000001';
SELECT is((tests.state146()).channel_id, NULL, 'the activity ends when the last participant leaves');
SELECT is(tests.sent146(NULL), 2, 'and each end is announced');

SELECT * FROM finish();
ROLLBACK;
