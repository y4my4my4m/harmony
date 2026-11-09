-- 20261110300001_thread_departures.sql: leaving a thread is recorded, and joining or posting ends it.
--
--   alice  owns S and thread T, a member    bob  a member    carol  never joined
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(15);

INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('f2561000-0000-0000-0000-000000000001', 'Threads', '11111111-0000-0000-0000-000000000001', true);
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2563000-0000-0000-0000-000000000001', 'f2561000-0000-0000-0000-000000000001', 'general', 0);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2561000-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f2561000-0000-0000-0000-000000000001', 'accepted'),
  ('33333333-0000-0000-0000-000000000003', 'f2561000-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT DO NOTHING;
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f2565000-0000-0000-0000-000000000001', 'f2563000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"starter"}]'::jsonb);
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by) VALUES
  ('f2564000-0000-0000-0000-000000000001', 'f2563000-0000-0000-0000-000000000001', 'f2565000-0000-0000-0000-000000000001', 'T', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.thread_members (thread_id, user_id) VALUES
  ('f2564000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'),
  ('f2564000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002');

CREATE FUNCTION pg_temp.count_of() RETURNS int LANGUAGE sql AS $fn$
  SELECT member_count FROM public.threads WHERE id = 'f2564000-0000-0000-0000-000000000001';
$fn$;
CREATE FUNCTION pg_temp.departed(p_user uuid) RETURNS int LANGUAGE sql AS $fn$
  SELECT count(*)::int FROM public.thread_departures
   WHERE thread_id = 'f2564000-0000-0000-0000-000000000001' AND user_id = p_user;
$fn$;

SELECT is(pg_temp.count_of(), 2, 'a membership recounts the thread');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.leave_thread('f2564000-0000-0000-0000-000000000001')$q$, 'a member leaves');
SELECT is((SELECT count(*)::int FROM public.thread_departures), 1, 'and reads their departure');
SELECT throws_ok($q$INSERT INTO public.thread_departures (thread_id, user_id) VALUES ('f2564000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001')$q$,
    '42501', NULL, 'a client statement writes no departure');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.thread_departures), 0, 'another account reads none of it');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok($q$SELECT public.leave_thread('f2564000-0000-0000-0000-000000000001')$q$, 'leaving a thread never joined does nothing');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM public.thread_members WHERE thread_id = 'f2564000-0000-0000-0000-000000000001' AND user_id = '22222222-0000-0000-0000-000000000002'), 0, 'the membership is gone');
SELECT is(pg_temp.departed('22222222-0000-0000-0000-000000000002'), 1, 'the departure is recorded');
SELECT is(pg_temp.departed('33333333-0000-0000-0000-000000000003'), 0, 'no departure without a membership');
SELECT is(pg_temp.count_of(), 1, 'and the count falls');

-- Posting makes a member (thread_message_handler), which ends the departure.
INSERT INTO public.messages (channel_id, thread_id, user_id, content) VALUES
  ('f2563000-0000-0000-0000-000000000001', 'f2564000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"back"}]');
SELECT is(pg_temp.departed('22222222-0000-0000-0000-000000000002'), 0, 'posting ends the departure');
SELECT is(pg_temp.count_of(), 2, 'and the count rises');

-- Joining too.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.leave_thread('f2564000-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.thread_members (thread_id, user_id) VALUES ('f2564000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002')$q$, 'a member joins again');
SELECT tests.clear_authentication();
SELECT is(pg_temp.departed('22222222-0000-0000-0000-000000000002'), 0, 'joining ends the departure');

-- threads embed profiles by created_by only: no public table may hold keys to both inside its
-- primary key (a PostgREST junction), or threads?select=...,profiles(...) fails with PGRST201.
SELECT is((
  SELECT count(*)::int FROM pg_constraint pk
   WHERE pk.contype = 'p'
     AND pk.connamespace = 'public'::regnamespace
     AND EXISTS (SELECT 1 FROM pg_constraint f WHERE f.conrelid = pk.conrelid AND f.contype = 'f'
                  AND f.confrelid = 'public.threads'::regclass AND f.conkey <@ pk.conkey)
     AND EXISTS (SELECT 1 FROM pg_constraint f WHERE f.conrelid = pk.conrelid AND f.contype = 'f'
                  AND f.confrelid = 'public.profiles'::regclass AND f.conkey <@ pk.conkey)
), 0, 'no table is a threads-profiles junction');

SELECT * FROM finish();
ROLLBACK;
