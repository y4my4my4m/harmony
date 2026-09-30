-- get_profile_media and count_profile_media (20261003100001_profile_media.sql).
--
-- Local roles:
--   author      posts one row per media shape and visibility below
--   follower    follows author (accepted)
--   pendfollow  follows author (pending)
--   stranger    no relationship
--   rblocked    blocked by author, follows author (accepted)
--   rblocker    has blocked author, follows author (accepted)
--
-- Author posts, newest first (T = 2026-09-01 12:00 UTC):
--   13  T-30m  public reply, composer image                     listed
--   01  T-1h   public, composer image                           listed
--   02  T-2h   unlisted, Mastodon-shaped video with preview      listed
--   03  T-3h   followers, content file part (image)              follower and author only
--   04  T-4h   direct, composer image                           never
--   05  T-5h   public, text only                                never
--   06  T-6h   public, audio attachment only                    never
--   07  T-7h   public image, soft-deleted                       never
--   08  T-8h   reblog row whose copied content holds an image    never
--   09  T-9h   public, composer GIF                             listed
--   10  T-10h  public, Document octet-stream with a .jpg URL     listed
--   11  T-11h  public, sensitive with a CW; audio + image        listed, image only
--   12  T-12h  public, outbox import: attachment + file part     listed
--   15  T-13h  public image, same instant as 14                  listed before 14 (id DESC)
--   14  T-13h  public image                                      listed

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(28);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT ('f4400000-0000-0000-0000-0000000000' || k)::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'media44-' || k || '@test.local'
  FROM unnest(ARRAY['a1','a2','a3','a4','a5','a6']) k;

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
SELECT ('f4410000-0000-0000-0000-0000000000' || k)::uuid,
       ('f4400000-0000-0000-0000-0000000000' || k)::uuid, n, n, true
  FROM (VALUES ('a1', 'm44author'), ('a2', 'm44follower'), ('a3', 'm44pendfollow'),
               ('a4', 'm44stranger'), ('a5', 'm44rblocked'), ('a6', 'm44rblocker')) v(k, n);

INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('f4410000-0000-0000-0000-0000000000a2', 'f4410000-0000-0000-0000-0000000000a1', 'accepted'),
  ('f4410000-0000-0000-0000-0000000000a3', 'f4410000-0000-0000-0000-0000000000a1', 'pending'),
  ('f4410000-0000-0000-0000-0000000000a5', 'f4410000-0000-0000-0000-0000000000a1', 'accepted'),
  ('f4410000-0000-0000-0000-0000000000a6', 'f4410000-0000-0000-0000-0000000000a1', 'accepted');

INSERT INTO public.user_blocks (blocker_id, blocked_user_id, block_type) VALUES
  ('f4410000-0000-0000-0000-0000000000a1', 'f4410000-0000-0000-0000-0000000000a5', 'full'),
  ('f4410000-0000-0000-0000-0000000000a6', 'f4410000-0000-0000-0000-0000000000a1', 'full');

CREATE TEMP TABLE m44 (n text PRIMARY KEY, at timestamptz, visibility text, content jsonb,
                       media jsonb, extra jsonb);
INSERT INTO m44 VALUES
  ('13', '2026-09-01 11:30+00', 'public', '[{"type":"text","text":"reply"}]',
   '[{"type":"Image","url":"https://h.test/13.png","mediaType":"image/png","name":"13.png"}]', '{}'),
  ('01', '2026-09-01 11:00+00', 'public', '[{"type":"text","text":"one"}]',
   '[{"type":"Image","url":"https://h.test/01.jpg","mediaType":"image/jpeg","name":"01.jpg","description":"alt one"}]', '{}'),
  ('02', '2026-09-01 10:00+00', 'unlisted', '[{"type":"text","text":"two"}]',
   '[{"type":"video","url":"https://m.test/02.mp4","preview_url":"https://m.test/02.jpg"}]', '{}'),
  ('03', '2026-09-01 09:00+00', 'followers',
   '[{"type":"text","text":"three"},{"type":"file","fileType":"image","url":"https://r.test/03.png","mimeType":"image/png","altText":"alt three"}]',
   '[]', '{}'),
  ('04', '2026-09-01 08:00+00', 'direct', '[{"type":"text","text":"four"}]',
   '[{"type":"Image","url":"https://h.test/04.jpg","mediaType":"image/jpeg"}]', '{}'),
  ('05', '2026-09-01 07:00+00', 'public', '[{"type":"text","text":"five"}]', '[]', '{}'),
  ('06', '2026-09-01 06:00+00', 'public', '[{"type":"text","text":"six"}]',
   '[{"type":"Audio","url":"https://h.test/06.mp3","mediaType":"audio/mpeg"}]', '{}'),
  ('07', '2026-09-01 05:00+00', 'public', '[{"type":"text","text":"seven"}]',
   '[{"type":"Image","url":"https://h.test/07.jpg","mediaType":"image/jpeg"}]', '{"is_deleted":true}'),
  ('08', '2026-09-01 04:00+00', 'public',
   '[{"type":"file","fileType":"image","url":"https://r.test/08.png"}]',
   '[]', '{"reblog":{"id":"f4420000-0000-0000-0000-000000000099"}}'),
  ('09', '2026-09-01 03:00+00', 'public', '[{"type":"text","text":"nine"}]',
   '[{"type":"Image","url":"https://h.test/09.gif","mediaType":"image/gif"}]', '{}'),
  ('10', '2026-09-01 02:00+00', 'public', '[{"type":"text","text":"ten"}]',
   '[{"type":"Document","url":"https://r.test/10.JPG?x=1","mediaType":"application/octet-stream"}]', '{}'),
  ('11', '2026-09-01 01:00+00', 'public',
   '[{"type":"text","text":"eleven"},{"type":"file","fileType":"audio","url":"https://h.test/11.mp3"}]',
   '[{"type":"Audio","url":"https://h.test/11.mp3","mediaType":"audio/mpeg"},{"type":"Image","url":"https://h.test/11.png","mediaType":"image/png"}]',
   '{"is_sensitive":true,"content_warning":"spiders"}'),
  ('12', '2026-09-01 00:00+00', 'public',
   '[{"type":"text","text":"twelve"},{"type":"file","fileType":"video","url":"https://r.test/12.mp4","mimeType":"video/mp4"}]',
   '[{"type":"Document","url":"https://r.test/12.mp4","mediaType":"video/mp4","name":"alt twelve"}]', '{}'),
  ('14', '2026-08-31 23:00+00', 'public', '[{"type":"text","text":"fourteen"}]',
   '[{"type":"Image","url":"https://h.test/14.jpg","mediaType":"image/jpeg"}]', '{}'),
  ('15', '2026-08-31 23:00+00', 'public', '[{"type":"text","text":"fifteen"}]',
   '[{"type":"Image","url":"https://h.test/15.jpg","mediaType":"image/jpeg"}]', '{}');

INSERT INTO public.posts (id, author_id, created_at, content, visibility, media_attachments,
                          is_deleted, reblog, is_sensitive, content_warning, in_reply_to)
SELECT ('f4420000-0000-0000-0000-0000000000' || n)::uuid,
       'f4410000-0000-0000-0000-0000000000a1', at, content, visibility, media,
       COALESCE((extra->>'is_deleted')::boolean, false), extra->'reblog',
       COALESCE((extra->>'is_sensitive')::boolean, false), extra->>'content_warning',
       CASE WHEN n = '13' THEN 'f4420000-0000-0000-0000-000000000001'::uuid END
  FROM m44
 ORDER BY n;

GRANT SELECT ON m44 TO anon, authenticated;

-- Catalog -------------------------------------------------------------------------------
SELECT ok(NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_profile_media(uuid, integer, timestamptz, uuid)'::regprocedure)
          AND NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.count_profile_media(uuid)'::regprocedure),
          'both functions run SECURITY INVOKER, so posts RLS applies');
SELECT ok(has_function_privilege('anon', 'public.get_profile_media(uuid, integer, timestamptz, uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.get_profile_media(uuid, integer, timestamptz, uuid)', 'EXECUTE')
          AND has_function_privilege('anon', 'public.count_profile_media(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.count_profile_media(uuid)', 'EXECUTE'),
          'anon and authenticated may call both functions');
SELECT has_index('public', 'posts', 'idx_posts_author_media', 'the partial media index exists');

-- Predicate -----------------------------------------------------------------------------
SELECT ok(post_has_profile_media('[{"type":"gifv","url":"https://x.test/a"}]', '[]')
          AND post_has_profile_media('[{"type":"Document","mediaType":"video/webm","url":"https://x.test/a"}]', '[]')
          AND post_has_profile_media('[{"type":"image","mime_type":"image/png","url":"https://x.test/a"}]', NULL)
          AND post_has_profile_media(NULL, '[{"type":"file","fileType":"video","url":"https://x.test/a.mp4"}]'),
          'gifv, video MIME types, Mastodon-shaped rows and video file parts count as media');
SELECT ok(NOT post_has_profile_media('[{"type":"Audio","mediaType":"audio/ogg","url":"https://x.test/a.ogg"}]', '[]')
          AND NOT post_has_profile_media('[{"type":"Audio","mediaType":"video/mp4","url":"https://x.test/a.mp4"}]', '[]')
          AND NOT post_has_profile_media('[]', '[{"type":"file","fileType":"file","url":"https://x.test/a.pdf"}]')
          AND NOT post_has_profile_media('[]', '[{"type":"url","url":"https://x.test/a.png"}]')
          AND NOT post_has_profile_media('{}', '[]')
          AND NOT post_has_profile_media(NULL, NULL),
          'audio, plain files, pasted image links and empty values are not media');

-- Visibility ----------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT results_eq(
    $q$SELECT id FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1')$q$,
    $q$SELECT ('f4420000-0000-0000-0000-0000000000' || n)::uuid
         FROM unnest(ARRAY['13','01','02','09','10','11','12','15','14']) WITH ORDINALITY u(n, i)
        ORDER BY i$q$,
    'anon lists public and unlisted media posts newest first, id breaking created_at ties');
SELECT is(public.count_profile_media('f4410000-0000-0000-0000-0000000000a1'), 9,
          'anon counts the same nine posts');

SELECT tests.authenticate_as('f4400000-0000-0000-0000-0000000000a4');
SELECT set_eq(
    $q$SELECT id FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1')$q$,
    $q$SELECT ('f4420000-0000-0000-0000-0000000000' || n)::uuid
         FROM unnest(ARRAY['13','01','02','09','10','11','12','15','14']) n$q$,
    'a stranger sees no followers-only media');

SELECT tests.authenticate_as('f4400000-0000-0000-0000-0000000000a3');
SELECT is(public.count_profile_media('f4410000-0000-0000-0000-0000000000a1'), 9,
          'a pending follower sees no followers-only media');

SELECT tests.authenticate_as('f4400000-0000-0000-0000-0000000000a2');
SELECT set_eq(
    $q$SELECT id FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1')$q$,
    $q$SELECT ('f4420000-0000-0000-0000-0000000000' || n)::uuid
         FROM unnest(ARRAY['13','01','02','03','09','10','11','12','15','14']) n$q$,
    'an accepted follower also sees followers-only media');
SELECT is(public.count_profile_media('f4410000-0000-0000-0000-0000000000a1'), 10,
          'an accepted follower counts ten posts');

SELECT tests.authenticate_as('f4400000-0000-0000-0000-0000000000a1');
SELECT set_eq(
    $q$SELECT id FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1')$q$,
    $q$SELECT ('f4420000-0000-0000-0000-0000000000' || n)::uuid
         FROM unnest(ARRAY['13','01','02','03','09','10','11','12','15','14']) n$q$,
    'the author sees her followers-only media, never her direct posts');

SELECT tests.authenticate_as('f4400000-0000-0000-0000-0000000000a5');
SELECT is_empty(
    $q$SELECT 1 FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1')$q$,
    'a reader the author blocked sees no media despite an accepted follow');
SELECT is(public.count_profile_media('f4410000-0000-0000-0000-0000000000a1'), 0,
          'a reader the author blocked counts zero');

SELECT tests.authenticate_as('f4400000-0000-0000-0000-0000000000a6');
SELECT is_empty(
    $q$SELECT 1 FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1')$q$,
    'a reader who blocked the author sees no media despite an accepted follow');
SELECT is(public.count_profile_media('f4410000-0000-0000-0000-0000000000a1'), 0,
          'a reader who blocked the author counts zero');

-- Excluded rows stay excluded for their own author too.
SELECT tests.authenticate_as('f4400000-0000-0000-0000-0000000000a1');
SELECT is_empty(
    $q$SELECT 1 FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 60)
        WHERE id IN ('f4420000-0000-0000-0000-000000000004', 'f4420000-0000-0000-0000-000000000005',
                     'f4420000-0000-0000-0000-000000000006', 'f4420000-0000-0000-0000-000000000007',
                     'f4420000-0000-0000-0000-000000000008')$q$,
    'direct, text-only, audio-only, deleted and reblog rows are never listed');

-- Pagination ----------------------------------------------------------------------------
SELECT tests.authenticate_as('f4400000-0000-0000-0000-0000000000a2');
SELECT results_eq(
    $q$SELECT id FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 3)$q$,
    $q$VALUES ('f4420000-0000-0000-0000-000000000013'::uuid),
              ('f4420000-0000-0000-0000-000000000001'::uuid),
              ('f4420000-0000-0000-0000-000000000002'::uuid)$q$,
    'the first page holds the three newest');
SELECT results_eq(
    $q$SELECT id FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 3,
                                               '2026-09-01 10:00+00', 'f4420000-0000-0000-0000-000000000002')$q$,
    $q$VALUES ('f4420000-0000-0000-0000-000000000003'::uuid),
              ('f4420000-0000-0000-0000-000000000009'::uuid),
              ('f4420000-0000-0000-0000-000000000010'::uuid)$q$,
    'the cursor page continues strictly after the cursor row');
SELECT results_eq(
    $q$SELECT id FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 5,
                                               '2026-08-31 23:00+00', 'f4420000-0000-0000-0000-000000000015')$q$,
    $q$VALUES ('f4420000-0000-0000-0000-000000000014'::uuid)$q$,
    'a cursor inside a created_at tie resumes at the next id');
SELECT is((SELECT count(*)::int FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 0)), 1,
          'a non-positive limit returns one row');
SELECT is((SELECT count(*)::int FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', NULL, NULL, NULL)), 10,
          'NULL arguments mean the first page at the default size');

-- Returned media ------------------------------------------------------------------------
SELECT is((SELECT media_attachments FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 60)
            WHERE id = 'f4420000-0000-0000-0000-000000000011'),
          '[{"type":"Image","url":"https://h.test/11.png","mediaType":"image/png"}]'::jsonb,
          'audio attachments are filtered out of a mixed post');
SELECT is((SELECT content_media FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 60)
            WHERE id = 'f4420000-0000-0000-0000-000000000011'),
          '[]'::jsonb,
          'audio file parts are filtered out of content_media');
SELECT ok((SELECT is_sensitive AND content_warning = 'spiders'
             FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 60)
            WHERE id = 'f4420000-0000-0000-0000-000000000011'),
          'the sensitive flag and content warning are returned');
SELECT is((SELECT content_media FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 60)
            WHERE id = 'f4420000-0000-0000-0000-000000000003'),
          '[{"type":"file","fileType":"image","url":"https://r.test/03.png","mimeType":"image/png","altText":"alt three"}]'::jsonb,
          'content file parts come back whole, alt text included');
SELECT ok((SELECT jsonb_array_length(media_attachments) = 1 AND jsonb_array_length(content_media) = 1
             FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 60)
            WHERE id = 'f4420000-0000-0000-0000-000000000012'),
          'an outbox import returns both copies; the client dedupes by URL');
SELECT is((SELECT visibility FROM public.get_profile_media('f4410000-0000-0000-0000-0000000000a1', 60)
            WHERE id = 'f4420000-0000-0000-0000-000000000003'),
          'followers', 'visibility is returned');

SELECT * FROM finish();
ROLLBACK;
