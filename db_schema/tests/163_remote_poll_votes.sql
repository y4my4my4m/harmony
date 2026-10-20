-- 20261022100001_remote_poll_votes.sql: votes on remote polls.
--
--   rp163       remote account, author of every poll
--   single      public, one answer, 3 voters reported
--   multi       public, multiple choice, nobody voted yet
--   closed      public, closed by its origin
--   ended       public, end time past
--   followers   followers-only; bob follows rp163 (accepted), alice does not
--   localq      a local Question
--   note        a remote post without a poll
--
-- queue_federation_job is replaced for the transaction so queued jobs can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(31);

CREATE TABLE tests.jobs163 (name text, data jsonb);
GRANT INSERT, SELECT, DELETE ON tests.jobs163 TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs163 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, inbox_url) VALUES
  ('f1630000-0000-0000-0000-0000000000d1', 'rp163', 'Remote', false, 'remote163.test',
   'https://remote163.test/users/rp163', 'https://remote163.test/users/rp163/inbox');

CREATE FUNCTION tests.poll163(p_id uuid, p_visibility text, p_meta jsonb, p_local boolean DEFAULT false) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id, ap_type, metadata)
  VALUES (p_id,
          CASE WHEN p_local THEN '11111111-0000-0000-0000-000000000001'::uuid ELSE 'f1630000-0000-0000-0000-0000000000d1'::uuid END,
          '[{"type": "text", "text": "poll"}]'::jsonb, p_visibility, p_local,
          'https://remote163.test/notes/' || p_id, 'Question', p_meta)
$$;

SELECT tests.poll163('f1630000-0000-0000-0000-000000000001', 'public',
  '{"is_poll": true, "poll_options": [{"name": "Red", "votes": 2}, {"name": "Blue", "votes": 1}, {"name": "Green", "votes": 0}],
    "poll_multiple_choice": false, "poll_end_time": "2999-01-01T00:00:00Z", "poll_voters_count": 3, "poll_closed": false, "kept": "yes"}');
SELECT tests.poll163('f1630000-0000-0000-0000-000000000002', 'public',
  '{"is_poll": true, "poll_options": [{"name": "A", "votes": 0}, {"name": "B", "votes": 0}, {"name": "C", "votes": 0}],
    "poll_multiple_choice": true, "poll_end_time": null, "poll_voters_count": 0, "poll_closed": false}');
SELECT tests.poll163('f1630000-0000-0000-0000-000000000003', 'public',
  '{"is_poll": true, "poll_options": [{"name": "A", "votes": 1}, {"name": "B", "votes": 0}],
    "poll_multiple_choice": false, "poll_end_time": null, "poll_voters_count": 1, "poll_closed": true}');
SELECT tests.poll163('f1630000-0000-0000-0000-000000000004', 'public',
  '{"is_poll": true, "poll_options": [{"name": "A", "votes": 0}, {"name": "B", "votes": 0}],
    "poll_multiple_choice": false, "poll_end_time": "2000-01-01T00:00:00Z", "poll_voters_count": 0, "poll_closed": false}');
SELECT tests.poll163('f1630000-0000-0000-0000-000000000005', 'followers',
  '{"is_poll": true, "poll_options": [{"name": "A", "votes": 0}, {"name": "B", "votes": 0}],
    "poll_multiple_choice": false, "poll_voters_count": 0, "poll_closed": false}');
SELECT tests.poll163('f1630000-0000-0000-0000-000000000006', 'public',
  '{"is_poll": true, "poll_options": [{"name": "A", "votes": 0}, {"name": "B", "votes": 0}],
    "poll_multiple_choice": false, "poll_voters_count": 0, "poll_closed": false}', true);
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id)
VALUES ('f1630000-0000-0000-0000-000000000007', 'f1630000-0000-0000-0000-0000000000d1',
        '[{"type": "text", "text": "no poll"}]', 'public', false, 'https://remote163.test/notes/plain');
INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1630000-0000-0000-0000-0000000000d1', 'accepted');
DELETE FROM tests.jobs163;

-- Grants -----------------------------------------------------------------------------------
SELECT ok(has_table_privilege('authenticated', 'public.post_poll_votes', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.post_poll_votes', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.post_poll_votes', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.post_poll_votes', 'DELETE')
          AND NOT has_table_privilege('anon', 'public.post_poll_votes', 'SELECT'),
          'clients read votes and write none; anon reads none');
SELECT ok(has_function_privilege('authenticated', 'public.vote_remote_poll(uuid, integer[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.vote_remote_poll(uuid, integer[])', 'EXECUTE'),
          'authenticated votes through vote_remote_poll; anon cannot call it');

-- A vote -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(
    (SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000001', ARRAY[1]) - 'kept'),
    '{"is_poll": true, "poll_options": [{"name": "Red", "votes": 2}, {"name": "Blue", "votes": 2}, {"name": "Green", "votes": 0}],
      "poll_multiple_choice": false, "poll_end_time": "2999-01-01T00:00:00Z", "poll_voters_count": 4, "poll_closed": false}'::jsonb,
    'the vote returns the counts with the chosen answer and the voters one higher');
SELECT is((SELECT array_agg(choice ORDER BY choice) FROM public.post_poll_votes
            WHERE post_id = 'f1630000-0000-0000-0000-000000000001'),
          ARRAY[1]::smallint[], 'the caller reads its answer');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000001', ARRAY[0])$q$,
    '23505', 'POLL_ALREADY_VOTED: a vote is final', 'a second vote is refused');
SELECT throws_ok(
    $q$INSERT INTO public.post_poll_votes (post_id, user_id, choice)
       VALUES ('f1630000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 0)$q$,
    '42501', NULL, 'a client cannot insert a vote directly');
SELECT tests.clear_authentication();

SELECT is((SELECT metadata FROM public.posts WHERE id = 'f1630000-0000-0000-0000-000000000001') ->> 'kept',
          'yes', 'other metadata keys are kept');
SELECT is((SELECT metadata -> 'poll_options' -> 1 ->> 'votes' FROM public.posts WHERE id = 'f1630000-0000-0000-0000-000000000001'),
          '2', 'the stored counts take the vote');
SELECT is((SELECT jsonb_agg(jsonb_build_object('name', name, 'data', data)) FROM tests.jobs163),
          jsonb_build_array(jsonb_build_object('name', 'federate-poll-vote', 'data', jsonb_build_object(
            'type', 'create', 'post_id', 'f1630000-0000-0000-0000-000000000001',
            'user_id', '11111111-0000-0000-0000-000000000001'))),
          'one federate-poll-vote job names the post and the voter');
SELECT ok((SELECT delivered_at IS NULL AND created_at = now() FROM public.post_poll_votes
            WHERE post_id = 'f1630000-0000-0000-0000-000000000001'), 'the vote is undelivered until the job sends it');

-- Answers ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000001', ARRAY[0, 1])$q$,
    '22023', 'POLL_SINGLE_CHOICE: the poll takes one answer', 'two answers on a single-choice poll are refused');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000001', ARRAY[3])$q$,
    '22023', 'POLL_CHOICE_INVALID: answers must name options of the poll', 'an answer past the options is refused');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000001', ARRAY[-1])$q$,
    '22023', 'POLL_CHOICE_INVALID: answers must name options of the poll', 'a negative answer is refused');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000001', ARRAY[]::integer[])$q$,
    '22023', 'POLL_CHOICE_INVALID: answers must name options of the poll', 'no answer is refused');
SELECT is((SELECT count(*)::int FROM public.post_poll_votes), 0, 'refused votes store nothing; bob reads no vote of alice');

SELECT is(
    (SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000002', ARRAY[2, 0, 2]) -> 'poll_options'),
    '[{"name": "A", "votes": 1}, {"name": "B", "votes": 0}, {"name": "C", "votes": 1}]'::jsonb,
    'a multiple-choice vote counts each distinct answer once');
SELECT is((SELECT metadata ->> 'poll_voters_count' FROM public.posts WHERE id = 'f1630000-0000-0000-0000-000000000002'),
          '1', 'the first voter of a poll nobody voted on makes one voter');
SELECT is((SELECT array_agg(choice ORDER BY choice) FROM public.post_poll_votes
            WHERE post_id = 'f1630000-0000-0000-0000-000000000002'),
          ARRAY[0, 2]::smallint[], 'one row per answer');

-- Closed polls -----------------------------------------------------------------------------
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000003', ARRAY[0])$q$,
    '22023', 'POLL_CLOSED: the poll has ended', 'a poll its origin closed takes no vote');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000004', ARRAY[0])$q$,
    '22023', 'POLL_CLOSED: the poll has ended', 'a poll past its end time takes no vote');

-- Visibility -------------------------------------------------------------------------------
SELECT lives_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000005', ARRAY[1])$q$,
    'a follower votes on a followers-only poll');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000005', ARRAY[1])$q$,
    'P0002', NULL, 'a non-follower cannot vote on a followers-only poll');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000006', ARRAY[0])$q$,
    'P0002', NULL, 'a local Question is not a remote poll');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000007', ARRAY[0])$q$,
    'P0002', NULL, 'a post without a poll takes no vote');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-0000000000ff', ARRAY[0])$q$,
    'P0002', NULL, 'an unknown post takes no vote');
SELECT is((SELECT count(*)::int FROM public.post_poll_votes), 1, 'alice reads her own vote only');
SELECT tests.clear_authentication();

INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1630000-0000-0000-0000-0000000000d1');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000002', ARRAY[0])$q$,
    'P0002', NULL, 'a poll by a blocked account takes no vote');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$SELECT public.vote_remote_poll('f1630000-0000-0000-0000-000000000002', ARRAY[0])$q$,
    '42501', NULL, 'anon cannot vote');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM public.post_poll_votes), 4, 'four answers stored in all');
SELECT is((SELECT count(*)::int FROM tests.jobs163 WHERE name = 'federate-poll-vote'), 3, 'one job per accepted vote');

-- PostgREST embeds profiles from posts by one path only: no public table may hold keys to both
-- inside its primary key (a junction), or posts?select=...,profiles(...) fails with PGRST201.
SELECT is((
  SELECT count(*)::int FROM pg_constraint pk
   WHERE pk.contype = 'p'
     AND pk.connamespace = 'public'::regnamespace
     AND EXISTS (SELECT 1 FROM pg_constraint f WHERE f.conrelid = pk.conrelid AND f.contype = 'f'
                  AND f.confrelid = 'public.posts'::regclass AND f.conkey <@ pk.conkey)
     AND EXISTS (SELECT 1 FROM pg_constraint f WHERE f.conrelid = pk.conrelid AND f.contype = 'f'
                  AND f.confrelid = 'public.profiles'::regclass AND f.conkey <@ pk.conkey)
), 0, 'no table is a posts-profiles junction');

SELECT * FROM finish();
ROLLBACK;
