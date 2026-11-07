-- 20261107300001_voice_roster_liveness.sql: every deleted voice_channel_participants row is
-- announced once as user-left on its channel's voice topic, with the deleting function's
-- reason or 'left'; touch_voice_participant and the P2P sweep.
--
--   alice  owns server_1
--   bob    member of server_1
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(27);

-- server_1 voice channels: open, and hidden from @everyone (bit 1 VIEW_CHANNEL).
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('23800000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'voice238', 1),
  ('23800000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'staff238', 1),
  ('23800000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'p2p238', 1);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT '23800000-0000-0000-0000-0000000000c2', 'role', r.id, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, joined_at) VALUES
  ('23800000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005',
   '22222222-0000-0000-0000-000000000002', now() - interval '10 minutes'),
  ('23800000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005',
   '22222222-0000-0000-0000-000000000002', now() - interval '10 minutes'),
  ('23800000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005',
   '11111111-0000-0000-0000-000000000001', now() - interval '10 minutes');

DELETE FROM realtime.messages WHERE topic LIKE 'voice-channel%';
GRANT USAGE ON SCHEMA tests TO service_role;

CREATE TEMP VIEW voice238_sent AS
SELECT topic, payload ->> 'event' AS event, payload ->> 'userId' AS user_id,
       payload ->> 'channelId' AS channel_id, payload ->> 'reason' AS reason
  FROM realtime.messages
 WHERE topic LIKE 'voice-channel%' AND event = 'voice-channel-event' AND private;

-- Privileges. ------------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.touch_voice_participant(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.touch_voice_participant(uuid)', 'EXECUTE'),
  'touch_voice_participant: authenticated only');
SELECT ok(NOT has_function_privilege('anon', 'public.sweep_stale_voice_participants()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.sweep_stale_voice_participants()', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.sweep_stale_voice_participants()', 'EXECUTE'),
  'sweep_stale_voice_participants: service_role only');
SELECT is((SELECT array_agg(p.proname::text || ':' || p.prosecdef::text || ':' || array_to_string(p.proconfig, ',')
                            ORDER BY p.proname)
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('touch_voice_participant', 'sweep_stale_voice_participants',
                                'voice_participant_left_announce')),
  ARRAY['sweep_stale_voice_participants:true:search_path=public, pg_temp',
        'touch_voice_participant:true:search_path=public, pg_temp',
        'voice_participant_left_announce:true:search_path=public, pg_temp'],
  'the new functions are SECURITY DEFINER with a pinned search_path');
SELECT ok(NOT has_function_privilege('authenticated', 'public.voice_participant_left_announce()', 'EXECUTE'),
  'the trigger function is not client-callable');

-- A client deletes its own row. ----------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
DELETE FROM public.voice_channel_participants
 WHERE channel_id = '23800000-0000-0000-0000-0000000000c1' AND user_id = '22222222-0000-0000-0000-000000000002';
DELETE FROM public.voice_channel_participants
 WHERE channel_id = '23800000-0000-0000-0000-0000000000c2' AND user_id = '22222222-0000-0000-0000-000000000002';
-- Another member's row is out of reach under voice_participants_delete_self.
DELETE FROM public.voice_channel_participants
 WHERE channel_id = '23800000-0000-0000-0000-0000000000c1' AND user_id = '11111111-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM voice238_sent), 2, 'one user-left per row the client deleted');
SELECT is((SELECT row(event, user_id, channel_id, reason)::text FROM voice238_sent
            WHERE topic = 'voice-channels:55555555-0000-0000-0000-000000000005'),
  '(user-left,22222222-0000-0000-0000-000000000002,23800000-0000-0000-0000-0000000000c1,left)',
  'an open channel announces the leave on the server voice topic, reason left');
SELECT is((SELECT row(event, user_id, reason)::text FROM voice238_sent
            WHERE topic = 'voice-channel:23800000-0000-0000-0000-0000000000c2'),
  '(user-left,22222222-0000-0000-0000-000000000002,left)',
  'a restricted channel announces the leave on its own topic');
SELECT ok(EXISTS (SELECT 1 FROM public.voice_channel_participants
                   WHERE channel_id = '23800000-0000-0000-0000-0000000000c1'
                     AND user_id = '11111111-0000-0000-0000-000000000001'),
  'the other member''s row stays');

-- The server's removals announce once, with their reason. ---------------------------------
DELETE FROM realtime.messages WHERE topic LIKE 'voice-channel%';
SELECT set_config('role', 'service_role', true);
SELECT is(public.remove_voice_participant('23800000-0000-0000-0000-0000000000c1',
                                          '11111111-0000-0000-0000-000000000001', now()),
  true, 'remove_voice_participant removes the row');
SELECT tests.clear_authentication();
SELECT is((SELECT array_agg(row(topic, user_id, reason)::text) FROM voice238_sent),
  ARRAY['(voice-channels:55555555-0000-0000-0000-000000000005,11111111-0000-0000-0000-000000000001,reconciled)'],
  'remove_voice_participant: one user-left, reason reconciled');
SELECT is(current_setting('harmony.voice_left_reason', true), '', 'the reason does not outlive the removal');

INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, joined_at)
VALUES ('23800000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005',
        '22222222-0000-0000-0000-000000000002', now() - interval '1 minute');
DELETE FROM realtime.messages WHERE topic LIKE 'voice-channel%';
SELECT set_config('role', 'service_role', true);
SELECT is(public.voice_remove_member('55555555-0000-0000-0000-000000000005',
                                     '22222222-0000-0000-0000-000000000002', 'disconnected'),
  '23800000-0000-0000-0000-0000000000c2'::uuid, 'voice_remove_member returns the channel left');
SELECT tests.clear_authentication();
SELECT is((SELECT array_agg(row(topic, user_id, reason)::text) FROM voice238_sent),
  ARRAY['(voice-channel:23800000-0000-0000-0000-0000000000c2,22222222-0000-0000-0000-000000000002,disconnected)'],
  'voice_remove_member: one user-left with its reason');

-- A delete outside these functions reads no stale reason. ---------------------------------
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, joined_at)
VALUES ('23800000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005',
        '22222222-0000-0000-0000-000000000002', now() - interval '1 minute');
DELETE FROM realtime.messages WHERE topic LIKE 'voice-channel%';
DELETE FROM public.voice_channel_participants
 WHERE channel_id = '23800000-0000-0000-0000-0000000000c1' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT is((SELECT array_agg(reason) FROM voice238_sent), ARRAY['left'], 'a service delete announces reason left');

-- touch_voice_participant. ----------------------------------------------------------------
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, joined_at, last_seen_at) VALUES
  ('23800000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005',
   '22222222-0000-0000-0000-000000000002', now() - interval '10 minutes', now() - interval '10 minutes'),
  ('23800000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005',
   '11111111-0000-0000-0000-000000000001', now() - interval '10 minutes', now() - interval '10 minutes');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.touch_voice_participant('23800000-0000-0000-0000-0000000000c3'), true,
  'touch answers true for the caller''s row');
SELECT is(public.touch_voice_participant('23800000-0000-0000-0000-0000000000c1'), false,
  'touch answers false where the caller has no row');
SELECT tests.clear_authentication();
SELECT is((SELECT last_seen_at FROM public.voice_channel_participants
            WHERE channel_id = '23800000-0000-0000-0000-0000000000c3'
              AND user_id = '22222222-0000-0000-0000-000000000002'),
  now(), 'touch stamps the database clock');
SELECT is((SELECT last_seen_at FROM public.voice_channel_participants
            WHERE channel_id = '23800000-0000-0000-0000-0000000000c3'
              AND user_id = '11111111-0000-0000-0000-000000000001'),
  now() - interval '10 minutes', 'touch leaves other members'' rows alone');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.touch_voice_participant('23800000-0000-0000-0000-0000000000c3')$q$,
  '42501', NULL, 'anon cannot touch');
SELECT tests.clear_authentication();

-- sweep_stale_voice_participants. ----------------------------------------------------------
DELETE FROM public.voice_channel_participants
 WHERE channel_id IN ('23800000-0000-0000-0000-0000000000c1', '23800000-0000-0000-0000-0000000000c2',
                      '23800000-0000-0000-0000-0000000000c3');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('23800000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005', 'p2p238b', 1),
  ('23800000-0000-0000-0000-0000000000c5', '55555555-0000-0000-0000-000000000005', 'p2p238c', 1);
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, joined_at, last_seen_at, metadata) VALUES
  -- P2P, last seen 4 minutes ago: swept.
  ('23800000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005',
   '11111111-0000-0000-0000-000000000001', now() - interval '1 hour', now() - interval '4 minutes', '{"transport":"p2p"}'),
  -- P2P, last seen a minute ago: kept.
  ('23800000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005',
   '22222222-0000-0000-0000-000000000002', now() - interval '1 hour', now() - interval '1 minute', '{"transport":"p2p"}'),
  -- P2P, rejoined a minute ago over an older stamp: kept.
  ('23800000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005',
   '11111111-0000-0000-0000-000000000001', now() - interval '1 minute', now() - interval '2 hours', '{"transport":"p2p"}'),
  -- P2P, never touched, joined 13 hours ago: swept.
  ('23800000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005',
   '22222222-0000-0000-0000-000000000002', now() - interval '13 hours', NULL, '{"transport":"p2p"}'),
  -- P2P, never touched, joined an hour ago: kept.
  ('23800000-0000-0000-0000-0000000000c5', '55555555-0000-0000-0000-000000000005',
   '11111111-0000-0000-0000-000000000001', now() - interval '1 hour', NULL, '{"transport":"p2p"}'),
  -- LiveKit row with an old stamp: left to the LiveKit reconciliation.
  ('23800000-0000-0000-0000-0000000000c5', '55555555-0000-0000-0000-000000000005',
   '22222222-0000-0000-0000-000000000002', now() - interval '13 hours', now() - interval '13 hours', '{}');
DELETE FROM realtime.messages WHERE topic LIKE 'voice-channel%';

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.sweep_stale_voice_participants()$q$, '42501', NULL,
  'an authenticated client cannot sweep');
SELECT tests.clear_authentication();
-- Drifted grant: the body still refuses a client role.
GRANT EXECUTE ON FUNCTION public.sweep_stale_voice_participants() TO authenticated;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT CASE WHEN has_function_privilege('authenticated', 'public.sweep_stale_voice_participants()', 'EXECUTE')
  THEN throws_ok($q$SELECT public.sweep_stale_voice_participants()$q$, '42501',
                 'sweep_stale_voice_participants is internal', 'the caller check refuses a client despite a drifted grant')
  ELSE skip('drifted grant not applied: function owner differs from the test role', 1) END;
SELECT tests.clear_authentication();
REVOKE EXECUTE ON FUNCTION public.sweep_stale_voice_participants() FROM authenticated;

SELECT set_config('role', 'service_role', true);
SELECT is(public.sweep_stale_voice_participants(), 2, 'the sweep removes two rows');
SELECT tests.clear_authentication();
SELECT is((SELECT array_agg(right(channel_id::text, 2) || ':' || left(user_id::text, 1) ORDER BY channel_id, user_id)
             FROM public.voice_channel_participants
            WHERE channel_id IN ('23800000-0000-0000-0000-0000000000c3', '23800000-0000-0000-0000-0000000000c4',
                                 '23800000-0000-0000-0000-0000000000c5')),
  ARRAY['c3:2', 'c4:1', 'c5:1', 'c5:2'],
  'live P2P rows, recent untouched rows and LiveKit rows stay');
SELECT is((SELECT array_agg(right(channel_id, 2) || ':' || left(user_id, 1) || ':' || reason ORDER BY channel_id) FROM voice238_sent),
  ARRAY['c3:1:reconciled', 'c4:2:reconciled'],
  'each swept row is announced, reason reconciled');
SELECT is(public.sweep_stale_voice_participants(), 0, 'a second sweep finds nothing');

SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
  THEN is((SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'voice-participant-sweep'),
          '* * * * * SELECT public.sweep_stale_voice_participants()', 'the sweep runs every minute')
  ELSE skip('pg_cron not installed', 1) END;

SELECT has_column('public', 'voice_channel_participants', 'last_seen_at', 'last_seen_at exists');

SELECT * FROM finish();
ROLLBACK;
