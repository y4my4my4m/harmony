-- Play together in a blocked direct conversation, after 20261123500004_activity_refusal_hides_blocks.sql.
--
--   alice, bob  fixture DM 77...07 with a running session alice started; bob blocks alice
--   mallory     in no conversation
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(9);

INSERT INTO public.activity_sessions (id, app_id, context, conversation_id, started_by, host_id) VALUES
  ('34600000-0000-0000-0000-000000000001', 'drawinphone', 'direct', '77777777-0000-0000-0000-000000000007',
   '11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001');

SELECT is(public.activity_join_refusal('11111111-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000007', NULL),
          'NOT_FOUND', 'the blocked account is refused as a non-participant is');
SELECT is(public.activity_join_refusal('22222222-0000-0000-0000-000000000002', '77777777-0000-0000-0000-000000000007', NULL),
          'NOT_FOUND', 'and so is the blocker');
SELECT is(public.activity_session_admit('34600000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001') ->> 'refusal',
          'NOT_FOUND', 'the relay refuses the blocked account with the same code');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.start_activity_session('drawinphone', '77777777-0000-0000-0000-000000000007', NULL)$q$,
                 '42501', 'NOT_FOUND', 'starting answers as for a conversation out of reach');
SELECT is(public.get_activity_sessions('77777777-0000-0000-0000-000000000007', NULL), '[]'::jsonb,
          'the blocked account lists no session');
SELECT is(public.get_activity_session('34600000-0000-0000-0000-000000000001'), NULL,
          'nor reads it by id');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(jsonb_build_array(public.get_activity_sessions('77777777-0000-0000-0000-000000000007', NULL),
                            public.get_activity_session('34600000-0000-0000-0000-000000000001')),
          '[[], null]'::jsonb, 'which is what a non-participant gets');
SELECT tests.clear_authentication();

DELETE FROM public.user_blocks WHERE blocker_id = '22222222-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(jsonb_array_length(public.get_activity_sessions('77777777-0000-0000-0000-000000000007', NULL)), 1,
          'unblocked, the session is listed again');
SELECT is(public.get_activity_session('34600000-0000-0000-0000-000000000001') ->> 'refusal', NULL,
          'with no refusal');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
