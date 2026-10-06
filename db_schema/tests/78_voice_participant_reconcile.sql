-- remove_voice_participant from 20261007400001_voice_participant_reconcile.sql: privileges,
-- the role-GUC caller check, the joined_before guard and the user-left broadcast on the
-- channel's voice topic; joined_at of a client write is the database clock.
--
--   alice  owns server_1
--   bob    member of server_1
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(18);

-- server_1 voice channels: open, and hidden from @everyone (bit 1 VIEW_CHANNEL).
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('78000000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'voice78', 1),
  ('78000000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'staff78', 1);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT '78000000-0000-0000-0000-0000000000c2', 'role', r.id, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, joined_at) VALUES
  ('78000000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005',
   '11111111-0000-0000-0000-000000000001', now() - interval '10 minutes'),
  ('78000000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005',
   '22222222-0000-0000-0000-000000000002', now() - interval '30 seconds'),
  ('78000000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005',
   '22222222-0000-0000-0000-000000000002', now() - interval '10 minutes');

DELETE FROM realtime.messages WHERE topic LIKE 'voice-channel%';
GRANT USAGE ON SCHEMA tests TO service_role;

-- Privileges. ------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.remove_voice_participant(uuid, uuid, timestamptz)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.remove_voice_participant(uuid, uuid, timestamptz)', 'EXECUTE'),
  'clients hold no EXECUTE');
SELECT ok(has_function_privilege('service_role', 'public.remove_voice_participant(uuid, uuid, timestamptz)', 'EXECUTE'),
  'service_role holds EXECUTE');
SELECT is((SELECT prosecdef FROM pg_proc
            WHERE oid = 'public.remove_voice_participant(uuid, uuid, timestamptz)'::regprocedure),
  true, 'remove_voice_participant is SECURITY DEFINER');
SELECT is((SELECT proconfig FROM pg_proc
            WHERE oid = 'public.remove_voice_participant(uuid, uuid, timestamptz)'::regprocedure),
  ARRAY['search_path=public, pg_temp'], 'search_path is pinned');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
  $q$SELECT public.remove_voice_participant('78000000-0000-0000-0000-0000000000c1',
                                            '22222222-0000-0000-0000-000000000002', now())$q$,
  '42501', NULL, 'an authenticated client cannot remove a participant');
SELECT tests.authenticate_as_anon();
SELECT throws_ok(
  $q$SELECT public.remove_voice_participant('78000000-0000-0000-0000-0000000000c1',
                                            '22222222-0000-0000-0000-000000000002', now())$q$,
  '42501', NULL, 'anon cannot remove a participant');
SELECT tests.clear_authentication();

-- Drifted grant: the body still refuses a client role.
GRANT EXECUTE ON FUNCTION public.remove_voice_participant(uuid, uuid, timestamptz) TO authenticated;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
-- A clone whose function owner differs from the test role keeps the grant from applying.
SELECT CASE WHEN has_function_privilege('authenticated',
                  'public.remove_voice_participant(uuid, uuid, timestamptz)', 'EXECUTE')
  THEN throws_ok(
    $q$SELECT public.remove_voice_participant('78000000-0000-0000-0000-0000000000c1',
                                              '22222222-0000-0000-0000-000000000002', now())$q$,
    '42501', 'remove_voice_participant is internal', 'the caller check refuses a client despite a drifted grant')
  ELSE skip('drifted grant not applied: function owner differs from the test role', 1) END;
SELECT tests.clear_authentication();
REVOKE EXECUTE ON FUNCTION public.remove_voice_participant(uuid, uuid, timestamptz) FROM authenticated;

-- Removal as service_role. -----------------------------------------------------------------
SELECT set_config('role', 'service_role', true);
SELECT throws_ok(
  $q$SELECT public.remove_voice_participant('78000000-0000-0000-0000-0000000000c1',
                                            '11111111-0000-0000-0000-000000000001', NULL)$q$,
  '22004', NULL, 'joined_before is required');
SELECT is(public.remove_voice_participant('78000000-0000-0000-0000-0000000000c1',
                                          '22222222-0000-0000-0000-000000000002',
                                          now() - interval '2 minutes'),
  false, 'a row joined after joined_before is kept');
SELECT is(public.remove_voice_participant('78000000-0000-0000-0000-0000000000c1',
                                          '11111111-0000-0000-0000-000000000001',
                                          now() - interval '2 minutes'),
  true, 'a row joined before joined_before is removed');
SELECT is(public.remove_voice_participant('78000000-0000-0000-0000-0000000000c1',
                                          '11111111-0000-0000-0000-000000000001',
                                          now() - interval '2 minutes'),
  false, 'a missing row reports false');
SELECT is(public.remove_voice_participant('78000000-0000-0000-0000-0000000000c2',
                                          '22222222-0000-0000-0000-000000000002',
                                          now() - interval '2 minutes'),
  true, 'a row of a restricted channel is removed');
SELECT tests.clear_authentication();

SELECT is((SELECT array_agg(user_id::text ORDER BY channel_id, user_id)
             FROM public.voice_channel_participants
            WHERE channel_id IN ('78000000-0000-0000-0000-0000000000c1', '78000000-0000-0000-0000-0000000000c2')),
  ARRAY['22222222-0000-0000-0000-000000000002'], 'only the recent row remains');

SELECT is((SELECT count(*)::int FROM realtime.messages WHERE topic LIKE 'voice-channel%'),
  2, 'one broadcast per removed row');
SELECT is((SELECT row(event, private, payload ->> 'event', payload ->> 'userId',
                      payload ->> 'channelId', payload ->> 'reason')::text
             FROM realtime.messages
            WHERE topic = 'voice-channels:55555555-0000-0000-0000-000000000005'),
  '(voice-channel-event,t,user-left,11111111-0000-0000-0000-000000000001,78000000-0000-0000-0000-0000000000c1,reconciled)',
  'an open channel announces user-left on the server voice topic');
SELECT is((SELECT payload ->> 'userId' FROM realtime.messages
            WHERE topic = 'voice-channel:78000000-0000-0000-0000-0000000000c2'),
  '22222222-0000-0000-0000-000000000002',
  'a restricted channel announces user-left on its own topic');

-- Client writes take the database clock. ----------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, joined_at)
VALUES ('78000000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005',
        '11111111-0000-0000-0000-000000000001', '2000-01-01T00:00:00Z');
SELECT is((SELECT joined_at FROM public.voice_channel_participants
            WHERE channel_id = '78000000-0000-0000-0000-0000000000c1'
              AND user_id = '11111111-0000-0000-0000-000000000001'),
  now(), 'a client insert stores the database clock');
UPDATE public.voice_channel_participants SET joined_at = '2000-01-01T00:00:00Z'
 WHERE channel_id = '78000000-0000-0000-0000-0000000000c1'
   AND user_id = '11111111-0000-0000-0000-000000000001';
SELECT is((SELECT joined_at FROM public.voice_channel_participants
            WHERE channel_id = '78000000-0000-0000-0000-0000000000c1'
              AND user_id = '11111111-0000-0000-0000-000000000001'),
  now(), 'a client update of joined_at stores the database clock');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
