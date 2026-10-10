-- Inbound federated posts (migration 20261012100001).
--
-- Fixture: remote124 posts on remote.test, booster124 on other.test. alice and bob are
-- local. max_post_length is the default 500. pg_temp.text124(n) is a content array of one
-- text part n characters long.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(18);

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
  ('f1240000-0000-0000-0000-000000000001', 'remote124', 'Remote', false, 'remote.test',
   'https://remote.test/users/remote124'),
  ('f1240000-0000-0000-0000-000000000002', 'booster124', 'Booster', false, 'other.test',
   'https://other.test/users/booster124');

CREATE FUNCTION pg_temp.text124(n integer) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('type', 'text', 'text', repeat('a', n)));
$fn$;

-- Post length ------------------------------------------------------------------------------
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id)
VALUES ('f1241000-0000-0000-0000-000000000001', 'f1240000-0000-0000-0000-000000000001',
        pg_temp.text124(3000), 'public', false, 'https://remote.test/notes/1');
SELECT is((SELECT public.jsonb_text_content_length(content) FROM public.posts
            WHERE id = 'f1241000-0000-0000-0000-000000000001'),
          3000, 'a remote post longer than max_post_length is stored intact');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id)
VALUES ('f1241000-0000-0000-0000-000000000002', 'f1240000-0000-0000-0000-000000000001',
        pg_temp.text124(100), 'public', false, 'https://remote.test/notes/2');
UPDATE public.posts SET content = pg_temp.text124(4000)
 WHERE id = 'f1241000-0000-0000-0000-000000000002';
SELECT is((SELECT public.jsonb_text_content_length(content) FROM public.posts
            WHERE id = 'f1241000-0000-0000-0000-000000000002'),
          4000, 'a remote edit growing past max_post_length applies');

SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content, visibility, is_local, ap_id)
       VALUES ('f1240000-0000-0000-0000-000000000001', pg_temp.text124(50001), 'public', false,
               'https://remote.test/notes/3')$q$,
    '23514', NULL, 'posts_text_length_check caps a remote post at 50000');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content, visibility)
       VALUES ('11111111-0000-0000-0000-000000000001', pg_temp.text124(501), 'public')$q$,
    '23514', NULL, 'a local post past max_post_length is refused');
INSERT INTO public.posts (id, author_id, content, visibility)
VALUES ('f1241000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001',
        pg_temp.text124(500), 'public');
SELECT ok(EXISTS (SELECT 1 FROM public.posts WHERE id = 'f1241000-0000-0000-0000-0000000000a1'),
          'a local post at max_post_length is stored');
SELECT throws_ok(
    $q$UPDATE public.posts SET content = pg_temp.text124(501)
        WHERE id = 'f1241000-0000-0000-0000-0000000000a1'$q$,
    '23514', NULL, 'a local edit past max_post_length is refused');
SELECT throws_ok(
    $q$UPDATE public.posts SET is_local = false, content = pg_temp.text124(501)
        WHERE id = 'f1241000-0000-0000-0000-0000000000a1'$q$,
    '23514', NULL, 'a client claiming is_local = false is still held to max_post_length');
SELECT tests.clear_authentication();

-- Deleting an original: boosts follow it, quotes stay ---------------------------------------
INSERT INTO public.posts (id, author_id, content, visibility)
VALUES ('f1242000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"original"}]', 'public');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO public.posts (id, author_id, content, visibility, metadata)
VALUES ('f1242000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', '[]', 'public',
        '{"reblog_of": "f1242000-0000-0000-0000-000000000001"}');
INSERT INTO public.posts (id, author_id, content, visibility, metadata)
VALUES ('f1242000-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002',
        '[{"type":"text","text":"my take"}]', 'public',
        '{"reblog_of": "f1242000-0000-0000-0000-000000000001", "is_quote": true}');
SELECT tests.clear_authentication();

-- Federated rows, shaped as processAnnounce and processCreate store them.
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id, ap_type, reblog, metadata)
VALUES
  ('f1242000-0000-0000-0000-000000000004', 'f1240000-0000-0000-0000-000000000002', '[]', 'public', false,
   'https://other.test/announces/1', 'Announce',
   '{"id": "f1242000-0000-0000-0000-000000000001", "content": []}',
   '{"reblog_of": "f1242000-0000-0000-0000-000000000001"}'),
  ('f1242000-0000-0000-0000-000000000005', 'f1240000-0000-0000-0000-000000000002',
   '[{"type":"text","text":"remote take"}]', 'public', false,
   'https://other.test/notes/q1', 'Note',
   '{"id": "f1242000-0000-0000-0000-000000000001", "content": []}',
   '{"reblog_of": "f1242000-0000-0000-0000-000000000001", "is_quote": true}');

SELECT is((SELECT reblog->>'id' FROM public.posts WHERE id = 'f1242000-0000-0000-0000-000000000003'),
          'f1242000-0000-0000-0000-000000000001', 'the local quote carries the original''s snapshot');

UPDATE public.posts SET is_deleted = true, deleted_at = now()
 WHERE id = 'f1242000-0000-0000-0000-000000000001';

SELECT is((SELECT is_deleted FROM public.posts WHERE id = 'f1242000-0000-0000-0000-000000000002'),
          true, 'a local boost is deleted with its original');
SELECT is((SELECT is_deleted FROM public.posts WHERE id = 'f1242000-0000-0000-0000-000000000004'),
          true, 'a federated boost is deleted with its original');
SELECT is((SELECT is_deleted FROM public.posts WHERE id = 'f1242000-0000-0000-0000-000000000003'),
          false, 'a local quote outlives its original');
SELECT is((SELECT is_deleted FROM public.posts WHERE id = 'f1242000-0000-0000-0000-000000000005'),
          false, 'a federated quote outlives its original');

-- Interaction notifications --------------------------------------------------------------
INSERT INTO public.posts (id, author_id, content, visibility)
VALUES ('f1243000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"alice"}]', 'public');

INSERT INTO public.post_interactions (user_id, post_id, interaction_type, ap_id, is_local) VALUES
  ('f1240000-0000-0000-0000-000000000002', 'f1241000-0000-0000-0000-000000000001', 'reblog',
   'https://other.test/announces/2', false),
  ('f1240000-0000-0000-0000-000000000002', 'f1241000-0000-0000-0000-000000000001', 'favorite',
   'https://other.test/likes/1', false),
  ('f1240000-0000-0000-0000-000000000002', 'f1243000-0000-0000-0000-000000000001', 'reblog',
   'https://other.test/announces/3', false);

SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f1240000-0000-0000-0000-000000000001'),
          0, 'a remote author receives no boost or favourite notification');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND type = 'activitypub_reblog'
              AND data->>'post_id' = 'f1243000-0000-0000-0000-000000000001'),
          1, 'a local author is notified of a remote boost');

-- ap_activities retention -----------------------------------------------------------------
INSERT INTO public.ap_activities (ap_id, ap_type, actor_ap_id, status, attempts, is_local, created_at) VALUES
  ('https://remote.test/a/1', 'Create', 'https://remote.test/users/remote124', 'completed', 1, false, now() - interval '31 days'),
  ('https://remote.test/a/2', 'Create', 'https://remote.test/users/remote124', 'processed', 0, false, now() - interval '31 days'),
  ('https://remote.test/a/3', 'Create', 'https://remote.test/users/remote124', 'completed', 4, false, now() - interval '31 days'),
  ('https://remote.test/a/4', 'Create', 'https://remote.test/users/remote124', 'completed', 1, false, now() - interval '29 days'),
  ('https://remote.test/a/5', 'Create', 'https://remote.test/users/remote124', 'failed',    3, false, now() - interval '31 days'),
  ('https://remote.test/a/6', 'Create', 'https://remote.test/users/remote124', 'received',  0, false, now() - interval '31 days');

SELECT is(public.purge_processed_ap_activities(), 3,
          'the purge deletes completed and processed rows over 30 days old');
SELECT is((SELECT array_agg(ap_id ORDER BY ap_id) FROM public.ap_activities
            WHERE ap_id LIKE 'https://remote.test/a/%'),
          ARRAY['https://remote.test/a/4', 'https://remote.test/a/5', 'https://remote.test/a/6'],
          'recent, failed and unprocessed rows stay');
SELECT ok(NOT has_function_privilege('authenticated', 'public.purge_processed_ap_activities()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.purge_processed_ap_activities()', 'EXECUTE'),
          'clients cannot run the purge');
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
  THEN ok(EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'activitypub-cleanup-old-activities'
                    AND schedule = '0 3 * * *'
                    AND command = 'SELECT public.purge_processed_ap_activities()'),
          'the cleanup job runs the purge daily')
  ELSE pass('pg_cron absent; the purge is not scheduled')
END;

SELECT * FROM finish();
ROLLBACK;
