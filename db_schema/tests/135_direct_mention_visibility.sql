-- "Mentioned people only" posts after 20261013200001_direct_mention_visibility.sql.
--
--   author135     local, writes the posts
--   mention135    local, mentioned in them
--   other135      local, mentioned nowhere; a remote mention shares the username
--   fan135        local follower of author135
--   blocked135    local, mentioned, blocked by author135

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(10);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1350000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'author135@test.local'),
  ('f1350000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mention135@test.local'),
  ('f1350000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other135@test.local'),
  ('f1350000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fan135@test.local'),
  ('f1350000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'blocked135@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1350000-0000-0000-0000-0000000000c1', 'f1350000-0000-0000-0000-0000000000a1', 'author135', 'Author', true),
  ('f1350000-0000-0000-0000-0000000000c2', 'f1350000-0000-0000-0000-0000000000a2', 'mention135', 'Mentioned', true),
  ('f1350000-0000-0000-0000-0000000000c3', 'f1350000-0000-0000-0000-0000000000a3', 'other135', 'Other', true),
  ('f1350000-0000-0000-0000-0000000000c4', 'f1350000-0000-0000-0000-0000000000a4', 'fan135', 'Fan', true),
  ('f1350000-0000-0000-0000-0000000000c5', 'f1350000-0000-0000-0000-0000000000a5', 'blocked135', 'Blocked', true);
INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('f1350000-0000-0000-0000-0000000000c4', 'f1350000-0000-0000-0000-0000000000c1', 'accepted');
INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('f1350000-0000-0000-0000-0000000000c1', 'f1350000-0000-0000-0000-0000000000c5');

-- 1: direct to mention135 and blocked135. 2: direct to a remote other135. 3: followers-only to
-- mention135.
INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('f1353000-0000-0000-0000-000000000001', 'f1350000-0000-0000-0000-0000000000c1',
   '[{"type":"mention","userId":"f1350000-0000-0000-0000-0000000000c2","username":"mention135","domain":"localhost","isLocal":true},{"type":"text","text":" "},{"type":"mention","userId":"f1350000-0000-0000-0000-0000000000c5","username":"blocked135","domain":"localhost","isLocal":true},{"type":"text","text":" psst"}]',
   'direct'),
  ('f1353000-0000-0000-0000-000000000002', 'f1350000-0000-0000-0000-0000000000c1',
   '[{"type":"mention","userId":"https://elsewhere.test/users/other135","username":"other135","domain":"elsewhere.test","isLocal":false},{"type":"text","text":" psst"}]',
   'direct'),
  ('f1353000-0000-0000-0000-000000000003', 'f1350000-0000-0000-0000-0000000000c1',
   '[{"type":"mention","userId":"f1350000-0000-0000-0000-0000000000c2","username":"mention135","domain":"localhost","isLocal":true},{"type":"text","text":" hi"}]',
   'followers');

CREATE TEMP TABLE seen135 (who text, post uuid);
GRANT INSERT, SELECT ON seen135 TO authenticated, anon;

SELECT tests.authenticate_as('f1350000-0000-0000-0000-0000000000a1');
INSERT INTO seen135 SELECT 'author', id FROM public.posts WHERE id::text LIKE 'f1353000%';
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('f1350000-0000-0000-0000-0000000000a2');
INSERT INTO seen135 SELECT 'mention', id FROM public.posts WHERE id::text LIKE 'f1353000%';
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('f1350000-0000-0000-0000-0000000000a3');
INSERT INTO seen135 SELECT 'other', id FROM public.posts WHERE id::text LIKE 'f1353000%';
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('f1350000-0000-0000-0000-0000000000a4');
INSERT INTO seen135 SELECT 'fan', id FROM public.posts WHERE id::text LIKE 'f1353000%';
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('f1350000-0000-0000-0000-0000000000a5');
INSERT INTO seen135 SELECT 'blocked', id FROM public.posts WHERE id::text LIKE 'f1353000%';
SELECT tests.clear_authentication();
SET LOCAL ROLE anon;
INSERT INTO seen135 SELECT 'anon', id FROM public.posts WHERE id::text LIKE 'f1353000%';
RESET ROLE;

SELECT is((SELECT count(*)::int FROM seen135 WHERE who = 'author'), 3,
    'the author reads all three posts');
SELECT ok(EXISTS (SELECT 1 FROM seen135 WHERE who = 'mention' AND post = 'f1353000-0000-0000-0000-000000000001'),
    'a local account mentioned in a direct post reads it');
SELECT ok(EXISTS (SELECT 1 FROM seen135 WHERE who = 'mention' AND post = 'f1353000-0000-0000-0000-000000000003'),
    'a local account mentioned in a followers-only post still reads it');
SELECT ok(NOT EXISTS (SELECT 1 FROM seen135 WHERE who = 'mention' AND post = 'f1353000-0000-0000-0000-000000000002'),
    'a direct post addressed to someone else stays hidden');
SELECT is((SELECT count(*)::int FROM seen135 WHERE who = 'other'), 0,
    'a remote mention sharing a local username does not open the post to the local account');
SELECT ok(EXISTS (SELECT 1 FROM seen135 WHERE who = 'fan' AND post = 'f1353000-0000-0000-0000-000000000003'),
    'a follower reads the followers-only post');
SELECT ok(NOT EXISTS (SELECT 1 FROM seen135 WHERE who = 'fan' AND post IN ('f1353000-0000-0000-0000-000000000001', 'f1353000-0000-0000-0000-000000000002')),
    'following the author does not open a direct post');
SELECT is((SELECT count(*)::int FROM seen135 WHERE who = 'blocked'), 0,
    'a mentioned account the author blocked reads nothing');
SELECT is((SELECT count(*)::int FROM seen135 WHERE who = 'anon'), 0,
    'anon reads no direct or followers-only post');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE tablename = 'posts' AND policyname = 'posts_select_public'), 1,
    'posts_select_public is the single read policy it replaces in place');

SELECT * FROM finish();
ROLLBACK;
