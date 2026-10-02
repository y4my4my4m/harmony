-- get_trending_posts and get_trending_hashtags (20261004000001_trending.sql; the posts
-- signature is the keyset one from 20261005300001_trending_keyset.sql).
--
-- Profiles:
--   viewer   local, has an auth user; blocks blocked, favourites 02, bookmarks 01
--   author   local
--   remote   r48.test
--   silenced, suspended, hidden (federation_discoverable false), blocked
--
-- Posts for get_trending_posts, as_of T = 2026-09-01 12:00 UTC, all public and at T-1h
-- unless noted. Favourites give the engagement; 02 gains the viewer's favourite (11).
--   01  author   composer image, 5 favs                               media, local
--   02  remote   inbox note, image as a content file part, 10 favs    media
--   03  author   text, 20 favs                                        local
--   04  remote   audio attachment, 3 favs                             not media
--   05  author   text, no engagement                                  never
--   06  author   reply to 21, 50 favs                                 never
--   07  remote   reply to an unfetched remote post, 50 favs           never
--   08  viewer   boost row carrying 02's content, 50 favs              never
--   09  author   deleted image, 50 favs                               never
--   10  author   unlisted, 50 favs                                    never
--   11  author   followers-only, 50 favs                              never
--   12  author   image at T-25h, 40 favs                              7-day window only
--   13-15        silenced, suspended, undiscoverable authors, 50 favs never
--   16  blocked  text, 7 favs                                         anon only
--   17  remote   Mastodon-shaped video, 2 favs                        media
--   18  remote   link preview only, 4 favs                            not media
--   19  author   NULL media_attachments, 1 fav                        listed
--   20  author   text at T-13h, 20 favs                               half of 03's score
--   21  author   text at T+1h, 50 favs                                after as_of, never
--
-- Scores in the 24-hour window: 03 7.69, 02 5.06, 20 3.84, 16 3.69, 01 2.91, 18 2.49,
-- 04 2.04, 17 1.53, 19 0.94.
--
-- Hashtag posts sit at now(); see the section below.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(26);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('f4800000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'trend48-viewer@test.local');

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain,
                             is_silenced, is_suspended, federation_discoverable)
VALUES
  ('f4810000-0000-0000-0000-0000000000a1', 'f4800000-0000-0000-0000-0000000000a1',
   't48viewer', 't48viewer', true, 'localhost', false, false, true),
  ('f4810000-0000-0000-0000-0000000000a2', NULL, 't48author', 't48author', true, 'localhost', false, false, true),
  ('f4810000-0000-0000-0000-0000000000a3', NULL, 't48remote', 't48remote', false, 'r48.test', false, false, true),
  ('f4810000-0000-0000-0000-0000000000a4', NULL, 't48silenced', 't48silenced', false, 'r48.test', true, false, true),
  ('f4810000-0000-0000-0000-0000000000a5', NULL, 't48suspended', 't48suspended', false, 'r48.test', false, true, true),
  ('f4810000-0000-0000-0000-0000000000a6', NULL, 't48hidden', 't48hidden', false, 'r48.test', false, false, false),
  ('f4810000-0000-0000-0000-0000000000a7', NULL, 't48blocked', 't48blocked', true, 'localhost', false, false, true);

INSERT INTO public.user_blocks (blocker_id, blocked_user_id, block_type) VALUES
  ('f4810000-0000-0000-0000-0000000000a1', 'f4810000-0000-0000-0000-0000000000a7', 'full');

CREATE TEMP TABLE t48 (n text PRIMARY KEY, who text, at timestamptz, visibility text,
                       content jsonb, media jsonb, favs int, extra jsonb);
INSERT INTO t48 VALUES
  ('01', 'a2', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"one"}]',
   '[{"type":"Image","url":"https://h.test/01.jpg","mediaType":"image/jpeg"}]', 5, '{}'),
  ('02', 'a3', '2026-09-01 11:00+00', 'public',
   '[{"type":"text","text":"two"},{"type":"file","fileType":"image","url":"https://r.test/02.jpg","mimeType":"image/jpeg"}]',
   '[]', 10, '{}'),
  ('03', 'a2', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"three"}]', '[]', 20, '{}'),
  ('04', 'a3', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"four"}]',
   '[{"type":"Audio","url":"https://r.test/04.mp3","mediaType":"audio/mpeg"}]', 3, '{}'),
  ('05', 'a2', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"five"}]', '[]', 0, '{}'),
  ('06', 'a2', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"six"}]', '[]', 50,
   '{"in_reply_to":"f4820000-0000-0000-0000-000000000021"}'),
  ('07', 'a3', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"seven"}]', '[]', 50,
   '{"metadata":{"in_reply_to_ap_url":"https://r48.test/notes/1"}}'),
  ('08', 'a1', '2026-09-01 11:00+00', 'public',
   '[{"type":"text","text":"two"},{"type":"file","fileType":"image","url":"https://r.test/02.jpg","mimeType":"image/jpeg"}]',
   '[]', 50, '{"reblog":{"id":"f4820000-0000-0000-0000-000000000002"}}'),
  ('09', 'a2', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"nine"}]',
   '[{"type":"Image","url":"https://h.test/09.jpg","mediaType":"image/jpeg"}]', 50, '{"is_deleted":true}'),
  ('10', 'a2', '2026-09-01 11:00+00', 'unlisted', '[{"type":"text","text":"ten"}]', '[]', 50, '{}'),
  ('11', 'a2', '2026-09-01 11:00+00', 'followers', '[{"type":"text","text":"eleven"}]', '[]', 50, '{}'),
  ('12', 'a2', '2026-08-31 11:00+00', 'public', '[{"type":"text","text":"twelve"}]',
   '[{"type":"Image","url":"https://h.test/12.jpg","mediaType":"image/jpeg"}]', 40, '{}'),
  ('13', 'a4', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"thirteen"}]', '[]', 50, '{}'),
  ('14', 'a5', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"fourteen"}]', '[]', 50, '{}'),
  ('15', 'a6', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"fifteen"}]', '[]', 50, '{}'),
  ('16', 'a7', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"sixteen"}]', '[]', 7, '{}'),
  ('17', 'a3', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"seventeen"}]',
   '[{"type":"video","url":"https://r.test/17.mp4","preview_url":"https://r.test/17.jpg"}]', 2, '{}'),
  ('18', 'a3', '2026-09-01 11:00+00', 'public',
   '[{"type":"text","text":"eighteen "},{"type":"url","url":"https://example.test/a","preview":true}]',
   '[]', 4, '{"metadata":{"embeds":[{"url":"https://example.test/a","image":"https://example.test/a.png"}]}}'),
  ('19', 'a2', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"nineteen"}]', NULL, 1, '{}'),
  ('20', 'a2', '2026-08-31 23:00+00', 'public', '[{"type":"text","text":"twenty"}]', '[]', 20, '{}'),
  ('21', 'a2', '2026-09-01 13:00+00', 'public', '[{"type":"text","text":"twenty-one"}]', '[]', 50, '{}');

-- 21 first: 06 replies to it.
INSERT INTO public.posts (id, author_id, created_at, content, visibility, is_local, media_attachments,
                          favorites_count, is_deleted, reblog, in_reply_to, metadata)
SELECT ('f4820000-0000-0000-0000-0000000000' || t.n)::uuid,
       ('f4810000-0000-0000-0000-0000000000' || t.who)::uuid,
       t.at, t.content, t.visibility, pr.is_local, t.media, t.favs,
       COALESCE((t.extra->>'is_deleted')::boolean, false), t.extra->'reblog',
       (t.extra->>'in_reply_to')::uuid, COALESCE(t.extra->'metadata', '{}'::jsonb)
  FROM t48 t
  JOIN public.profiles pr ON pr.id = ('f4810000-0000-0000-0000-0000000000' || t.who)::uuid
 ORDER BY t.n = '21' DESC, t.n;

INSERT INTO public.post_interactions (user_id, post_id, interaction_type) VALUES
  ('f4810000-0000-0000-0000-0000000000a1', 'f4820000-0000-0000-0000-000000000002', 'favorite'),
  ('f4810000-0000-0000-0000-0000000000a1', 'f4820000-0000-0000-0000-000000000001', 'bookmark');

-- Hashtag posts, relative to now().
--   h1 author  now-1h  #t48alpha, 1 fav      h2 remote  now-1h  #t48alpha
--   h3-h5 remote now-1h..3h #t48beta          h6 remote  now-30h #t48beta (previous window)
--   h7 viewer  boost row carrying #t48alpha  h8 author  deleted #t48gamma
--   h9 author  now-3d #t48delta, fetched now
INSERT INTO public.posts (id, author_id, created_at, content, visibility, is_local, favorites_count,
                          is_deleted, reblog)
VALUES
  ('f4830000-0000-0000-0000-000000000001', 'f4810000-0000-0000-0000-0000000000a2', now() - interval '1 hour',
   '[{"type":"text","text":"h1 #t48alpha"}]', 'public', true, 1, false, NULL),
  ('f4830000-0000-0000-0000-000000000002', 'f4810000-0000-0000-0000-0000000000a3', now() - interval '1 hour',
   '[{"type":"text","text":"h2 #t48alpha"}]', 'public', false, 0, false, NULL),
  ('f4830000-0000-0000-0000-000000000003', 'f4810000-0000-0000-0000-0000000000a3', now() - interval '1 hour',
   '[{"type":"text","text":"h3 #t48beta"}]', 'public', false, 0, false, NULL),
  ('f4830000-0000-0000-0000-000000000004', 'f4810000-0000-0000-0000-0000000000a3', now() - interval '2 hours',
   '[{"type":"text","text":"h4 #t48beta"}]', 'public', false, 0, false, NULL),
  ('f4830000-0000-0000-0000-000000000005', 'f4810000-0000-0000-0000-0000000000a3', now() - interval '3 hours',
   '[{"type":"text","text":"h5 #t48beta"}]', 'public', false, 0, false, NULL),
  ('f4830000-0000-0000-0000-000000000006', 'f4810000-0000-0000-0000-0000000000a3', now() - interval '30 hours',
   '[{"type":"text","text":"h6 #t48beta"}]', 'public', false, 0, false, NULL),
  ('f4830000-0000-0000-0000-000000000007', 'f4810000-0000-0000-0000-0000000000a1', now() - interval '30 minutes',
   '[{"type":"text","text":"h1 #t48alpha"}]', 'public', true, 0, false,
   '{"id":"f4830000-0000-0000-0000-000000000001"}'),
  ('f4830000-0000-0000-0000-000000000008', 'f4810000-0000-0000-0000-0000000000a2', now() - interval '1 hour',
   '[{"type":"text","text":"h8 #t48gamma"}]', 'public', true, 0, true, NULL),
  ('f4830000-0000-0000-0000-000000000009', 'f4810000-0000-0000-0000-0000000000a2', now() - interval '3 days',
   '[{"type":"text","text":"h9 #t48delta"}]', 'public', true, 0, false, NULL);

GRANT SELECT ON t48 TO anon, authenticated;

-- Catalog -------------------------------------------------------------------------------
SELECT ok(NOT (SELECT prosecdef FROM pg_proc
                WHERE oid = 'public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid)'::regprocedure)
          AND NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_trending_hashtags(integer, integer)'::regprocedure),
          'both functions run SECURITY INVOKER, so posts RLS applies');
SELECT ok(has_function_privilege('anon', 'public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid)', 'EXECUTE')
          AND has_function_privilege('anon', 'public.get_trending_hashtags(integer, integer)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.get_trending_hashtags(integer, integer)', 'EXECUTE'),
          'anon and authenticated may call both functions');
SELECT ok(NOT EXISTS (
            SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
             WHERE p.oid IN ('public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid)'::regprocedure,
                             'public.get_trending_hashtags(integer, integer)'::regprocedure)
               AND a.grantee = 0),
          'PUBLIC holds no grant on either function');

-- Ranking and exclusions ------------------------------------------------------------------
SELECT tests.authenticate_as('f4800000-0000-0000-0000-0000000000a1');

SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00')$q$,
    $q$SELECT ('f4820000-0000-0000-0000-0000000000' || n)::uuid
         FROM unnest(ARRAY['03','02','20','01','18','04','17','19']) WITH ORDINALITY u(n, i)
        ORDER BY i$q$,
    'the viewer sees engaged top-level public posts in the window, best score first');

SELECT ok(abs((SELECT score FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00')
                WHERE id = 'f4820000-0000-0000-0000-000000000020')
              / (SELECT score FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00')
                  WHERE id = 'f4820000-0000-0000-0000-000000000003') - 0.5) < 1e-9,
          'equal engagement twelve hours older scores half in a 24-hour window');

SELECT is_empty(
    $q$SELECT id FROM public.get_trending_posts(168, false, false, NULL, 40, 0, '2026-09-01 12:00+00')
        WHERE id IN (SELECT ('f4820000-0000-0000-0000-0000000000' || n)::uuid
                       FROM unnest(ARRAY['05','06','07','08','09','10','11','13','14','15','16','21']) n)$q$,
    'no engagement, replies, pending remote replies, boosts, deleted, unlisted, followers-only, '
    'silenced, suspended, undiscoverable, blocked and later posts are never listed');

SELECT set_eq(
    $q$SELECT id FROM public.get_trending_posts(NULL, NULL, NULL, NULL, 40, NULL, '2026-09-01 12:00+00')$q$,
    $q$SELECT ('f4820000-0000-0000-0000-0000000000' || n)::uuid
         FROM unnest(ARRAY['03','02','20','01','18','04','17','19']) n$q$,
    'NULL arguments mean a 24-hour window over all posts');

-- Media -------------------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, true, false, NULL, 40, 0, '2026-09-01 12:00+00')$q$,
    $q$VALUES ('f4820000-0000-0000-0000-000000000002'::uuid),
              ('f4820000-0000-0000-0000-000000000001'::uuid),
              ('f4820000-0000-0000-0000-000000000017'::uuid)$q$,
    'media keeps the content file part, the composer image and the Mastodon video; '
    'audio, link previews and the boost are left out');

SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(168, true, false, NULL, 40, 0, '2026-09-01 12:00+00')$q$,
    $q$VALUES ('f4820000-0000-0000-0000-000000000012'::uuid),
              ('f4820000-0000-0000-0000-000000000002'::uuid),
              ('f4820000-0000-0000-0000-000000000001'::uuid),
              ('f4820000-0000-0000-0000-000000000017'::uuid)$q$,
    'a 7-day window reaches the day-old image');

-- Scope -------------------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, true, NULL, 40, 0, '2026-09-01 12:00+00')$q$,
    $q$VALUES ('f4820000-0000-0000-0000-000000000003'::uuid),
              ('f4820000-0000-0000-0000-000000000020'::uuid),
              ('f4820000-0000-0000-0000-000000000001'::uuid),
              ('f4820000-0000-0000-0000-000000000019'::uuid)$q$,
    'local only keeps posts made on this instance');

SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, ' R48.TEST ', 40, 0, '2026-09-01 12:00+00')$q$,
    $q$VALUES ('f4820000-0000-0000-0000-000000000002'::uuid),
              ('f4820000-0000-0000-0000-000000000018'::uuid),
              ('f4820000-0000-0000-0000-000000000004'::uuid),
              ('f4820000-0000-0000-0000-000000000017'::uuid)$q$,
    'a domain keeps its authors, compared trimmed and case-insensitively');

-- Paging ------------------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 3, 0, '2026-09-01 12:00+00')$q$,
    $q$VALUES ('f4820000-0000-0000-0000-000000000003'::uuid),
              ('f4820000-0000-0000-0000-000000000002'::uuid),
              ('f4820000-0000-0000-0000-000000000020'::uuid)$q$,
    'the first page holds the three best');
SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 3, 3, '2026-09-01 12:00+00')$q$,
    $q$VALUES ('f4820000-0000-0000-0000-000000000001'::uuid),
              ('f4820000-0000-0000-0000-000000000018'::uuid),
              ('f4820000-0000-0000-0000-000000000004'::uuid)$q$,
    'the second page continues at the offset');
SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 3, 6, '2026-09-01 12:00+00')$q$,
    $q$VALUES ('f4820000-0000-0000-0000-000000000017'::uuid),
              ('f4820000-0000-0000-0000-000000000019'::uuid)$q$,
    'the last page is short');
SELECT is((SELECT count(*)::int FROM public.get_trending_posts(24, false, false, NULL, 0, 0, '2026-09-01 12:00+00')), 1,
          'a non-positive limit returns one row');

SELECT is((SELECT array_agg(DISTINCT as_of) FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00')),
          ARRAY['2026-09-01 12:00+00'::timestamptz],
          'every row carries the as_of it was ranked at');
SELECT is((SELECT array_agg(DISTINCT as_of) FROM public.get_trending_posts(24)),
          ARRAY[now()],
          'a NULL as_of ranks at now()');
SELECT is((SELECT array_agg(DISTINCT as_of) FROM public.get_trending_posts(24, false, false, NULL, 20, 0, now() + interval '1 day')),
          ARRAY[now()],
          'an as_of in the future is clamped to now()');

-- Row shape ----------------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT id, is_favorited, is_bookmarked, is_reblogged
         FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00')
        WHERE is_favorited OR is_bookmarked OR is_reblogged
        ORDER BY id$q$,
    $q$VALUES ('f4820000-0000-0000-0000-000000000001'::uuid, false, true, false),
              ('f4820000-0000-0000-0000-000000000002'::uuid, true, false, false)$q$,
    'interaction flags are the caller''s own');
SELECT is((SELECT author->>'username' || '@' || (author->>'domain') || ' ' || favorites_count
             FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00')
            WHERE id = 'f4820000-0000-0000-0000-000000000002'),
          't48remote@r48.test 11',
          'the author object and counts are returned');
SELECT is((SELECT media_attachments FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00')
            WHERE id = 'f4820000-0000-0000-0000-000000000019'),
          '[]'::jsonb,
          'NULL media_attachments come back as an empty array');

-- Anon ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00')$q$,
    $q$SELECT ('f4820000-0000-0000-0000-0000000000' || n)::uuid
         FROM unnest(ARRAY['03','02','20','16','01','18','04','17','19']) WITH ORDINALITY u(n, i)
        ORDER BY i$q$,
    'anon also sees the post the viewer''s block hides');

-- Hashtags -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('f4800000-0000-0000-0000-0000000000a1');
SELECT results_eq(
    $q$SELECT tag, uses_count, unique_users FROM public.get_trending_hashtags(24, 50) WHERE tag LIKE 't48%'$q$,
    $q$VALUES ('t48alpha'::text, 2::bigint, 2::bigint), ('t48beta'::text, 3::bigint, 1::bigint)$q$,
    'two authors outrank three posts by one; the boost is not a use');
SELECT results_eq(
    $q$SELECT change_percent, trend FROM public.get_trending_hashtags(24, 50) WHERE tag = 't48beta'$q$,
    $q$VALUES (200.0::numeric, 'rising'::text)$q$,
    'change is measured against the previous window of equal length');
SELECT is_empty(
    $q$SELECT 1 FROM public.get_trending_hashtags(24, 50) WHERE tag IN ('t48gamma', 't48delta')$q$,
    'deleted posts and old posts fetched late are not uses');
SELECT is((SELECT count(*)::int FROM public.get_trending_hashtags(24, 0)), 1,
          'a non-positive limit returns one tag');

SELECT * FROM finish();
ROLLBACK;
