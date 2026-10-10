-- Reply crawls of remote posts (migration 20261011800001).
--
-- Fixture: remote121 is an account on remote.test, replier121 one on other.test. Posts 01 and
-- 03 are remote121's without figures, post 02 remote121's with a figure written by the
-- federation backend. alice and bob are local. The lock modes are checked by definition: a
-- second session would see none of this file's uncommitted rows.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(18);

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
  ('f1210000-0000-0000-0000-000000000001', 'remote121', 'Remote', false, 'remote.test',
   'https://remote.test/users/remote121'),
  ('f1210000-0000-0000-0000-000000000002', 'replier121', 'Replier', false, 'other.test',
   'https://other.test/users/replier121');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id, created_at) VALUES
  ('f1211000-0000-0000-0000-000000000001', 'f1210000-0000-0000-0000-000000000001',
   '[{"type":"text","text":"one"}]', 'public', false,
   'https://remote.test/users/remote121/statuses/1', '2026-10-11 08:00+00'),
  ('f1211000-0000-0000-0000-000000000002', 'f1210000-0000-0000-0000-000000000001',
   '[{"type":"text","text":"two"}]', 'public', false,
   'https://remote.test/users/remote121/statuses/2', '2026-10-11 08:00+00'),
  ('f1211000-0000-0000-0000-000000000003', 'f1210000-0000-0000-0000-000000000001',
   '[{"type":"text","text":"three"}]', 'public', false,
   'https://remote.test/users/remote121/statuses/3', '2026-10-11 08:00+00');

CREATE OR REPLACE FUNCTION pg_temp.replies121(p_id uuid) RETURNS integer LANGUAGE sql AS $fn$
  SELECT replies_count FROM public.posts WHERE id = p_id;
$fn$;

-- Schema ----------------------------------------------------------------------------------
SELECT has_column('public', 'posts', 'replies_fetched_at', 'posts carries the last reply crawl time');
SELECT ok(pg_get_functiondef('public.update_post_reply_count()'::regprocedure) ~ 'FOR NO KEY UPDATE'
          AND pg_get_functiondef('public.update_post_reply_count()'::regprocedure) !~* '\mFOR\s+UPDATE\M',
          'the reply counter locks the parent FOR NO KEY UPDATE');
SELECT ok(pg_get_functiondef('public.update_profile_posts_count()'::regprocedure) ~ 'FOR NO KEY UPDATE'
          AND pg_get_functiondef('public.update_profile_posts_count()'::regprocedure) !~* '\mFOR\s+UPDATE\M',
          'the posts counter locks the author FOR NO KEY UPDATE');

-- Counting under the new lock -------------------------------------------------------------
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id, created_at, in_reply_to)
SELECT ('f1212000-0000-0000-0000-00000000000' || g)::uuid, 'f1210000-0000-0000-0000-000000000002',
       '[{"type":"text","text":"crawled"}]', 'public', false,
       'https://other.test/users/replier121/statuses/' || g, '2026-10-11 08:30+00',
       'f1211000-0000-0000-0000-000000000001'
  FROM generate_series(1, 3) g;
SELECT is(pg_temp.replies121('f1211000-0000-0000-0000-000000000001'), 3,
          'sibling replies stored in one statement count one each');

UPDATE public.posts SET is_deleted = true, deleted_at = now()
 WHERE id = 'f1212000-0000-0000-0000-000000000001';
SELECT is(pg_temp.replies121('f1211000-0000-0000-0000-000000000001'), 2,
          'a deleted reply leaves the count');

UPDATE public.posts SET in_reply_to = 'f1211000-0000-0000-0000-000000000003'
 WHERE id = 'f1212000-0000-0000-0000-000000000002';
SELECT is(format('%s/%s', pg_temp.replies121('f1211000-0000-0000-0000-000000000001'),
                          pg_temp.replies121('f1211000-0000-0000-0000-000000000003')),
          '1/1', 'a re-parented reply moves between the two parents');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, created_at)
VALUES ('f1211000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"local"}]', 'public', true, '2026-10-11 08:00+00');
INSERT INTO public.posts (id, author_id, content, visibility, is_local, created_at, in_reply_to) VALUES
  ('f1212000-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"r1"}]', 'public', true, '2026-10-11 08:10+00', 'f1211000-0000-0000-0000-0000000000a1'),
  ('f1212000-0000-0000-0000-0000000000b2', '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"r2"}]', 'public', true, '2026-10-11 08:11+00', 'f1211000-0000-0000-0000-0000000000a1');
DELETE FROM public.posts WHERE id = 'f1212000-0000-0000-0000-0000000000b2';
SELECT is(pg_temp.replies121('f1211000-0000-0000-0000-0000000000a1'), 1,
          'a local parent recounts its replies');
SELECT is((SELECT posts_count FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'),
          (SELECT count(*)::int FROM public.posts
            WHERE author_id = '22222222-0000-0000-0000-000000000002' AND is_deleted IS NOT TRUE),
          'a local author''s posts_count matches the posts held');

-- Crawl results written by the federation backend -----------------------------------------
UPDATE public.posts SET replies_fetched_at = '2026-10-11 09:00+00'
 WHERE id = 'f1211000-0000-0000-0000-000000000001';
SELECT is(pg_temp.replies121('f1211000-0000-0000-0000-000000000001'), 1,
          'recording a crawl without a figure leaves the counter');

SET LOCAL ROLE service_role;
UPDATE public.posts
   SET remote_replies_count = 7, remote_counts_fetched_at = '2026-10-11 09:59+00',
       replies_fetched_at = '2026-10-11 10:00+00'
 WHERE id = 'f1211000-0000-0000-0000-000000000002';
RESET ROLE;
SELECT is((SELECT row(replies_count, remote_replies_count, replies_fetched_at)::text
             FROM public.posts WHERE id = 'f1211000-0000-0000-0000-000000000002'),
          row(7, 7, '2026-10-11 10:00+00'::timestamptz)::text,
          'the service role records a complete walk''s total and its time');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, created_at, in_reply_to)
VALUES ('f1212000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"local reply"}]', 'public', true, '2026-10-11 10:05+00',
        'f1211000-0000-0000-0000-000000000002');
SELECT is(pg_temp.replies121('f1211000-0000-0000-0000-000000000002'), 8,
          'a local reply after the walk adds one to the figure');

INSERT INTO public.posts (author_id, content, visibility, is_local, ap_id, created_at, in_reply_to)
SELECT 'f1210000-0000-0000-0000-000000000002', '[{"type":"text","text":"crawled"}]', 'public', false,
       'https://other.test/users/replier121/statuses/x' || g, '2026-10-11 09:00+00',
       'f1211000-0000-0000-0000-000000000002'
  FROM generate_series(1, 3) g;
SELECT is(pg_temp.replies121('f1211000-0000-0000-0000-000000000002'), 8,
          'replies the walk listed and stored afterwards are within the figure');

-- Client writes ---------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.posts
   SET replies_fetched_at = '2030-01-01 00:00+00', remote_replies_count = 999, content = '[{"type":"text","text":"edited"}]'
 WHERE id = 'f1211000-0000-0000-0000-0000000000a1';
INSERT INTO public.posts (id, author_id, content, visibility, replies_fetched_at, remote_replies_count)
VALUES ('f1211000-0000-0000-0000-0000000000a2', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"forged"}]', 'public', '2030-01-01 00:00+00', 999);
SELECT tests.clear_authentication();
SELECT is((SELECT row(replies_fetched_at, remote_replies_count)::text
             FROM public.posts WHERE id = 'f1211000-0000-0000-0000-0000000000a1'),
          row(NULL::timestamptz, NULL::int)::text,
          'a client update keeps the crawl time and figure as they were');
SELECT is((SELECT content #>> '{0,text}' FROM public.posts WHERE id = 'f1211000-0000-0000-0000-0000000000a1'),
          'edited', 'the same client update still edits the content');
SELECT is((SELECT row(replies_fetched_at, remote_replies_count, replies_count)::text
             FROM public.posts WHERE id = 'f1211000-0000-0000-0000-0000000000a2'),
          row(NULL::timestamptz, NULL::int, 0)::text,
          'a client insert starts without a crawl time or figure');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
UPDATE public.posts SET replies_fetched_at = '2000-01-01 00:00+00', remote_replies_count = 0
 WHERE id = 'f1211000-0000-0000-0000-000000000002';
SELECT tests.authenticate_as_anon();
UPDATE public.posts SET replies_fetched_at = '2000-01-01 00:00+00', remote_replies_count = 0
 WHERE id = 'f1211000-0000-0000-0000-000000000002';
SELECT tests.clear_authentication();
SELECT is((SELECT row(replies_fetched_at, remote_replies_count)::text
             FROM public.posts WHERE id = 'f1211000-0000-0000-0000-000000000002'),
          row('2026-10-11 10:00+00'::timestamptz, 7)::text,
          'another account or anon cannot backdate a crawl or zero a figure');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT replies_fetched_at FROM public.posts WHERE id = 'f1211000-0000-0000-0000-000000000002'),
          '2026-10-11 10:00+00'::timestamptz, 'clients read the crawl time');
SELECT tests.clear_authentication();

SELECT is((SELECT replies_fetched_at FROM public.posts WHERE id = 'f1211000-0000-0000-0000-000000000003'),
          NULL::timestamptz, 'a post never walked has no crawl time');

SELECT * FROM finish();
ROLLBACK;
