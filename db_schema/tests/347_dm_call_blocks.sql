-- DM calls across a block, after 20261123500005_ring_count_hides_blocks.sql and
-- 20261123500007_check_dm_call.sql.
--
--   alice, bob  fixture DM 77...07; bob blocks alice
--   mallory     in no conversation
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(10);

DELETE FROM realtime.messages WHERE topic LIKE 'dm-calls:%';
INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.ring_dm_call('77777777-0000-0000-0000-000000000007',
                              ARRAY['22222222-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003']::uuid[],
                              'initiate', 'voice'), 1,
          'the ring answers one participant receiver, the one who blocks the caller included');
SELECT tests.clear_authentication();
SELECT is_empty($q$SELECT 1 FROM realtime.messages WHERE topic = 'dm-calls:22222222-0000-0000-0000-000000000002'$q$,
                'and does not ring them');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.check_dm_call('77777777-0000-0000-0000-000000000007')$q$,
                 'P0001', 'DM_UNDELIVERABLE', 'the pre-check refuses the blocked caller');
SELECT throws_ok($q$SELECT public.start_dm_call_message('77777777-0000-0000-0000-000000000007', 'voice')$q$,
                 'P0001', 'DM_UNDELIVERABLE', 'with the answer placing the call gives');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.check_dm_call('77777777-0000-0000-0000-000000000007')$q$,
                 'P0001', 'DM_UNDELIVERABLE', 'and the blocker');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.check_dm_call('77777777-0000-0000-0000-000000000007')$q$,
                 'P0002', 'Conversation not found', 'a non-participant learns nothing of the conversation');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE conversation_id = '77777777-0000-0000-0000-000000000007' AND metadata ->> 'type' = 'call_started'),
          0, 'the pre-check posts no call notice');

DELETE FROM public.user_blocks WHERE blocker_id = '22222222-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.check_dm_call('77777777-0000-0000-0000-000000000007')$q$,
                'unblocked, the pre-check passes');
SELECT is(public.ring_dm_call('77777777-0000-0000-0000-000000000007',
                              ARRAY['22222222-0000-0000-0000-000000000002']::uuid[], 'initiate', 'voice'), 1,
          'and the ring answers the same count');
SELECT tests.clear_authentication();
SELECT ok(has_function_privilege('authenticated', 'public.check_dm_call(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.check_dm_call(uuid)', 'EXECUTE'),
          'members may ask, anon may not');

SELECT * FROM finish();
ROLLBACK;
