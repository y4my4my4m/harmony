-- Ending and replacing voice activities from 20261016100001_voice_activity_end_rights.sql:
-- the host, an instance moderator, a member with MOVE_MEMBERS (the owner included), or anyone
-- once the host has left the call. Playback stays with the activity's controls setting.
--
--   alice    owns server_1; in the call
--   bob      member; in the call; starts the activity
--   mallory  member for this file; in the call
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted')
ON CONFLICT DO NOTHING;
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f1470000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'stage', 1);
INSERT INTO public.voice_channel_participants (channel_id, user_id, server_id) VALUES
  ('f1470000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('f1470000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005'),
  ('f1470000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005');
-- 536870912 = 1 << 29, MOVE_MEMBERS in permission_bit_names().
INSERT INTO public.server_roles (id, server_id, name, position, permissions)
VALUES ('f1471000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'voice mods', 2, 536870912);

CREATE FUNCTION tests.host147() RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT host_id FROM public.voice_activities WHERE channel_id = 'f1470000-0000-0000-0000-000000000001'
$fn$;
GRANT EXECUTE ON FUNCTION tests.host147() TO authenticated;

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.voice_activity_start('f1470000-0000-0000-0000-000000000001', 'youtube', '{"video_id":"dQw4w9WgXcQ"}');

-- A plain member. -------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.voice_activity_stop('f1470000-0000-0000-0000-000000000001')$q$,
  '42501', 'Only the host or a moderator ends this activity', 'a member in the call cannot end the host''s activity');
SELECT throws_ok(
    $q$SELECT public.voice_activity_start('f1470000-0000-0000-0000-000000000001', 'youtube', '{"video_id":"9bZkp7q19f0"}')$q$,
    '42501', 'Only the host or a moderator ends this activity', 'nor replace it with one of their own');
SELECT ok(NOT ((public.voice_activity_control('f1470000-0000-0000-0000-000000000001', 'pause') -> 'activity' ->> 'playing')::boolean),
  'but still pauses it while the controls are everyone''s');
SELECT throws_ok($q$SELECT public.voice_activity_may_end(NULL::public.voice_activities, NULL::uuid)$q$,
  '42501', NULL, 'the rule itself is not callable by clients');

-- Instance moderator. ---------------------------------------------------------------------
SELECT tests.clear_authentication();
UPDATE public.profiles SET is_moderator = true WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT ok(public.voice_activity_stop('f1470000-0000-0000-0000-000000000001'), 'an instance moderator ends it');
SELECT tests.clear_authentication();
UPDATE public.profiles SET is_moderator = false WHERE id = '33333333-0000-0000-0000-000000000003';

-- MOVE_MEMBERS. ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.voice_activity_start('f1470000-0000-0000-0000-000000000001', 'youtube', '{"video_id":"dQw4w9WgXcQ"}');
SELECT tests.clear_authentication();
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1471000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((public.voice_activity_start('f1470000-0000-0000-0000-000000000001', 'youtube', '{"video_id":"9bZkp7q19f0"}')
          -> 'activity' ->> 'source'), 'youtube', 'a member with Move Members replaces it');
SELECT is(tests.host147(), '33333333-0000-0000-0000-000000000003'::uuid, 'and hosts the new one');
SELECT tests.clear_authentication();
DELETE FROM public.user_roles WHERE role_id = 'f1471000-0000-0000-0000-000000000001';

-- The former host is a plain member of the new run. ---------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.voice_activity_stop('f1470000-0000-0000-0000-000000000001')$q$,
  '42501', 'Only the host or a moderator ends this activity', 'the former host cannot end the new run');

-- The server owner holds every permission. -------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(public.voice_activity_stop('f1470000-0000-0000-0000-000000000001'), 'the server owner ends it');

-- Host gone. ------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.voice_activity_start('f1470000-0000-0000-0000-000000000001', 'youtube', '{"video_id":"dQw4w9WgXcQ"}');
SELECT tests.clear_authentication();
DELETE FROM public.voice_channel_participants
 WHERE channel_id = 'f1470000-0000-0000-0000-000000000001' AND user_id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT ok(public.voice_activity_stop('f1470000-0000-0000-0000-000000000001'), 'once the host has left the call anyone in it ends it');

-- The host. -------------------------------------------------------------------------------
SELECT public.voice_activity_start('f1470000-0000-0000-0000-000000000001', 'youtube', '{"video_id":"dQw4w9WgXcQ"}');
SELECT ok(public.voice_activity_stop('f1470000-0000-0000-0000-000000000001'), 'the host ends their own activity');
SELECT is(tests.host147(), NULL, 'and the row is gone');

SELECT * FROM finish();
ROLLBACK;
