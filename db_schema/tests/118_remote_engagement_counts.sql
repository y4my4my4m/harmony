-- Origin figures of remote accounts and remote posts (migration 20261011500001).
--
-- Fixture: remote118 is an account on remote.test, booster118 another remote account.
-- Post 01 is remote118's, read from the origin at 12:00 with 764 likes and 82 boosts.
-- Post 02 is remote118's with a figure of 5 replies. Post 03 is remote118's without
-- figures. alice and bob are local. Row timestamps are explicit: now() is the
-- transaction's start throughout the file.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(31);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1180000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fresh118@test.local');

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
  ('f1180000-0000-0000-0000-000000000001', 'remote118', 'Remote', false, 'remote.test',
   'https://remote.test/users/remote118'),
  ('f1180000-0000-0000-0000-000000000002', 'booster118', 'Booster', false, 'other.test',
   'https://other.test/users/booster118');

CREATE OR REPLACE FUNCTION pg_temp.counts118(p_id uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT format('%s/%s/%s', replies_count, favorites_count, reblogs_count)
    FROM public.posts WHERE id = p_id;
$fn$;

-- Columns and privileges -----------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'profiles'
              AND column_name IN ('remote_posts_count', 'remote_followers_count',
                                  'remote_following_count', 'remote_counts_fetched_at')),
          4, 'profiles carries the three remote totals and their read time');
SELECT is((SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'posts'
              AND column_name IN ('remote_replies_count', 'remote_favorites_count',
                                  'remote_reblogs_count', 'remote_counts_fetched_at')),
          4, 'posts carries the three remote figures and their read time');
SELECT ok(NOT has_function_privilege('authenticated',
              'public.remote_engagement_figure(uuid, text, integer, timestamp with time zone)', 'EXECUTE')
          AND NOT has_function_privilege('anon',
              'public.remote_engagement_figure(uuid, text, integer, timestamp with time zone)', 'EXECUTE')
          AND has_function_privilege('service_role',
              'public.remote_engagement_figure(uuid, text, integer, timestamp with time zone)', 'EXECUTE'),
          'remote_engagement_figure is internal');

-- Profiles: client writes -----------------------------------------------------------------
UPDATE public.profiles
   SET remote_followers_count = 120, remote_following_count = 30, remote_posts_count = 4000,
       remote_counts_fetched_at = '2026-10-01 12:00+00'
 WHERE id = 'f1180000-0000-0000-0000-000000000001';
SELECT is((SELECT row(remote_posts_count, remote_followers_count, remote_following_count)::text
             FROM public.profiles WHERE id = 'f1180000-0000-0000-0000-000000000001'),
          row(4000, 120, 30)::text,
          'the federation backend stores a remote account''s totals');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.profiles
   SET remote_followers_count = 999999, remote_posts_count = 1,
       remote_counts_fetched_at = '2030-01-01 00:00+00', display_name = 'Alice Edited'
 WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('f1180000-0000-0000-0000-0000000000a1');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local,
                             remote_posts_count, remote_followers_count, remote_following_count,
                             remote_counts_fetched_at)
VALUES ('f1180000-0000-0000-0000-000000000005', 'f1180000-0000-0000-0000-0000000000a1', 'fresh118',
        'Fresh', true, 10, 20, 30, '2030-01-01 00:00+00');
SELECT tests.clear_authentication();

SELECT is((SELECT row(display_name, remote_posts_count, remote_followers_count, remote_counts_fetched_at)::text
             FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'),
          row('Alice Edited', NULL::int, NULL::int, NULL::timestamptz)::text,
          'a client update keeps the remote totals as they were');
SELECT is((SELECT row(remote_posts_count, remote_followers_count, remote_following_count, remote_counts_fetched_at)::text
             FROM public.profiles WHERE id = 'f1180000-0000-0000-0000-000000000005'),
          row(NULL::int, NULL::int, NULL::int, NULL::timestamptz)::text,
          'a client insert starts without remote totals');

INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('11111111-0000-0000-0000-000000000001', 'f1180000-0000-0000-0000-000000000001', 'accepted');
SELECT is((SELECT row(followers_count, remote_followers_count)::text
             FROM public.profiles WHERE id = 'f1180000-0000-0000-0000-000000000001'),
          row(1, 120)::text,
          'a local follow moves the local counter and leaves the origin total');

-- Posts: client writes --------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.posts (id, author_id, content, visibility, remote_reblogs_count,
                          remote_favorites_count, remote_replies_count, remote_counts_fetched_at)
VALUES ('f1181000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"local"}]', 'public', 50, 60, 70, '2030-01-01 00:00+00');
UPDATE public.posts SET remote_reblogs_count = 9, remote_counts_fetched_at = '2030-01-01 00:00+00'
 WHERE id = 'f1181000-0000-0000-0000-0000000000a1';
SELECT tests.clear_authentication();
SELECT is((SELECT row(reblogs_count, remote_replies_count, remote_favorites_count,
                      remote_reblogs_count, remote_counts_fetched_at)::text
             FROM public.posts WHERE id = 'f1181000-0000-0000-0000-0000000000a1'),
          row(0, NULL::int, NULL::int, NULL::int, NULL::timestamptz)::text,
          'clients set no remote figure on insert or update');

-- Boosts ----------------------------------------------------------------------------------
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id, created_at,
                          remote_favorites_count, remote_reblogs_count, remote_counts_fetched_at)
VALUES ('f1181000-0000-0000-0000-000000000001', 'f1180000-0000-0000-0000-000000000001',
        '[{"type":"text","text":"heavily boosted"}]', 'public', false,
        'https://remote.test/users/remote118/statuses/1', '2026-10-01 10:00+00',
        764, 82, '2026-10-01 12:00+00');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/764/82',
          'an imported post shows the origin''s likes and boosts');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id, ap_type, created_at,
                          reblog, metadata)
VALUES ('f1181000-0000-0000-0000-000000000011', 'f1180000-0000-0000-0000-000000000002',
        '[]', 'public', false, 'https://other.test/users/booster118/statuses/9/activity', 'Announce',
        '2026-10-01 12:30+00', '{"id":"f1181000-0000-0000-0000-000000000001"}',
        '{"reblog_of":"f1181000-0000-0000-0000-000000000001"}');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/764/82',
          'a followee''s Announce arriving here keeps the origin figure');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, created_at, metadata)
VALUES ('f1181000-0000-0000-0000-000000000012', '22222222-0000-0000-0000-000000000002',
        '[{"type":"text","text":"heavily boosted"}]', 'public', true, '2026-10-01 11:00+00',
        '{"reblog_of":"f1181000-0000-0000-0000-000000000001"}');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/764/82',
          'a local boost older than the read is already in the figure');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, created_at, metadata)
VALUES ('f1181000-0000-0000-0000-000000000013', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"heavily boosted"}]', 'public', true, '2026-10-01 12:05+00',
        '{"reblog_of":"f1181000-0000-0000-0000-000000000001"}');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/764/83',
          'a local boost after the read adds one');

UPDATE public.posts SET remote_reblogs_count = 83, remote_counts_fetched_at = '2026-10-01 13:00+00'
 WHERE id = 'f1181000-0000-0000-0000-000000000001';
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/764/83',
          'a later read that includes the local boost does not count it twice');

UPDATE public.posts SET is_deleted = true, deleted_at = now()
 WHERE id = 'f1181000-0000-0000-0000-000000000013';
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/764/83',
          'an undone boost stays in the figure until the next read');

UPDATE public.posts SET remote_reblogs_count = 82, remote_counts_fetched_at = '2026-10-01 14:00+00'
 WHERE id = 'f1181000-0000-0000-0000-000000000001';
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/764/82',
          'the next read takes it out');

DELETE FROM public.posts WHERE id IN ('f1181000-0000-0000-0000-000000000011',
                                      'f1181000-0000-0000-0000-000000000012',
                                      'f1181000-0000-0000-0000-000000000013');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/764/82',
          'removing boosts never takes the count below the figure');

-- Favourites ------------------------------------------------------------------------------
INSERT INTO public.post_interactions (user_id, post_id, interaction_type, is_local, created_at)
VALUES ('f1180000-0000-0000-0000-000000000002', 'f1181000-0000-0000-0000-000000000001',
        'favorite', false, '2026-10-01 14:10+00');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/764/82',
          'a remote favourite read from the likes collection is already in the figure');

INSERT INTO public.post_interactions (id, user_id, post_id, interaction_type, is_local, created_at)
VALUES ('f1182000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
        'f1181000-0000-0000-0000-000000000001', 'favorite', true, '2026-10-01 14:20+00');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/765/82',
          'a local favourite after the read adds one');

DELETE FROM public.post_interactions WHERE id = 'f1182000-0000-0000-0000-000000000001';
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000001'), '0/764/82',
          'removing it takes the one back');

-- Replies ---------------------------------------------------------------------------------
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id, created_at,
                          remote_replies_count, remote_counts_fetched_at)
VALUES ('f1181000-0000-0000-0000-000000000002', 'f1180000-0000-0000-0000-000000000001',
        '[{"type":"text","text":"discussed"}]', 'public', false,
        'https://remote.test/users/remote118/statuses/2', '2026-10-01 10:00+00',
        5, '2026-10-01 12:00+00');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000002'), '5/0/0',
          'an imported post shows the origin''s reply total');

INSERT INTO public.posts (author_id, content, visibility, is_local, ap_id, created_at, in_reply_to)
SELECT 'f1180000-0000-0000-0000-000000000002', '[{"type":"text","text":"crawled"}]', 'public', false,
       'https://other.test/users/booster118/statuses/r' || g, '2026-10-01 11:00+00',
       'f1181000-0000-0000-0000-000000000002'
  FROM generate_series(1, 4) g;
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000002'), '5/0/0',
          'crawled replies within the figure are not added to it');

INSERT INTO public.posts (author_id, content, visibility, is_local, ap_id, created_at, in_reply_to)
SELECT 'f1180000-0000-0000-0000-000000000002', '[{"type":"text","text":"crawled"}]', 'public', false,
       'https://other.test/users/booster118/statuses/s' || g, '2026-10-01 11:00+00',
       'f1181000-0000-0000-0000-000000000002'
  FROM generate_series(1, 2) g;
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000002'), '6/0/0',
          'more replies held here than the figure counts every one');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, created_at, in_reply_to)
VALUES ('f1181000-0000-0000-0000-000000000021', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"local reply"}]', 'public', true, '2026-10-01 12:30+00',
        'f1181000-0000-0000-0000-000000000002');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000002'), '7/0/0',
          'a local reply counts once');

UPDATE public.posts SET remote_replies_count = 10, remote_counts_fetched_at = '2026-10-01 13:00+00'
 WHERE id = 'f1181000-0000-0000-0000-000000000002';
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000002'), '10/0/0',
          'a new read replaces the figure');

UPDATE public.posts SET is_deleted = true, deleted_at = now()
 WHERE id = 'f1181000-0000-0000-0000-000000000021';
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000002'), '10/0/0',
          'a deleted reply older than the read leaves the figure');

-- Without figures -------------------------------------------------------------------------
INSERT INTO public.posts (id, author_id, content, visibility, is_local, ap_id, created_at,
                          replies_count, favorites_count, reblogs_count)
VALUES ('f1181000-0000-0000-0000-000000000003', 'f1180000-0000-0000-0000-000000000001',
        '[{"type":"text","text":"no figures"}]', 'public', false,
        'https://remote.test/users/remote118/statuses/3', '2026-10-01 10:00+00', 3, 2, 0);
INSERT INTO public.posts (author_id, content, visibility, is_local, created_at, in_reply_to)
VALUES ('22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"reply"}]', 'public', true,
        '2026-10-01 12:30+00', 'f1181000-0000-0000-0000-000000000003');
INSERT INTO public.post_interactions (user_id, post_id, interaction_type, is_local)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1181000-0000-0000-0000-000000000003', 'favorite', true);
INSERT INTO public.posts (author_id, content, visibility, is_local, created_at, metadata)
VALUES ('22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"no figures"}]', 'public', true,
        '2026-10-01 12:30+00', '{"reblog_of":"f1181000-0000-0000-0000-000000000003"}');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000003'), '4/3/1',
          'without a figure replies and favourites move by one and boosts recount');

UPDATE public.posts SET remote_reblogs_count = 40, remote_counts_fetched_at = '2026-10-01 13:00+00'
 WHERE id = 'f1181000-0000-0000-0000-000000000003';
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000003'), '4/3/40',
          'a figure written later takes over its own counter only');

-- Local posts -----------------------------------------------------------------------------
INSERT INTO public.posts (id, author_id, content, visibility, is_local, created_at)
VALUES ('f1181000-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"mine"}]', 'public', true, '2026-10-01 10:00+00');
UPDATE public.posts SET remote_reblogs_count = 500, remote_counts_fetched_at = '2026-10-01 13:00+00'
 WHERE id = 'f1181000-0000-0000-0000-000000000004';
INSERT INTO public.posts (author_id, content, visibility, is_local, created_at, metadata)
VALUES ('22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"mine"}]', 'public', true,
        '2026-10-01 12:30+00', '{"reblog_of":"f1181000-0000-0000-0000-000000000004"}');
SELECT is(pg_temp.counts118('f1181000-0000-0000-0000-000000000004'), '0/0/1',
          'a local post counts its own rows whatever its remote columns hold');

-- remote_engagement_figure ----------------------------------------------------------------
SELECT is(public.remote_engagement_figure('f1181000-0000-0000-0000-000000000001', 'reblogs', 2147483647,
                                          '2026-10-01 12:00+00'),
          2147483647, 'the figure is capped at the column''s range');
SELECT throws_ok(
    $q$SELECT public.remote_engagement_figure('f1181000-0000-0000-0000-000000000001', 'quotes', 1, now())$q$,
    '22023', NULL, 'an unknown kind is refused');
SELECT is(public.remote_engagement_figure('f1181000-0000-0000-0000-000000000002', 'replies', NULL, NULL),
          6, 'without a figure the rows held here are the count');

SELECT * FROM finish();
ROLLBACK;
