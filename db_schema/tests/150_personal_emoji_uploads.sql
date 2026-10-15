-- 20261016100004_personal_emoji_uploads.sql: create_my_emoji, the per-user limit
-- (max_personal_emojis_per_user, AI-generated emojis included) and the personal storage
-- policies of bucket emojis.
--
--   alice    owns server_1
--   bob      member of server_1 without MANAGE_EMOJIS; uploads personal emojis
--   mallory  no server
--
-- Objects in bucket emojis (150e0000-0000-4000-8000-0000000000NN):
--   bob/01.png  1234 bytes    bob/02.png    bob/03.gif    bob/04.webp    bob/05.png
--   bob/06.png  bob/07.png    mallory/09.png    server_1/alice/10.png
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(55);
-- Newer storage schemas refuse direct DELETE unless this is set, as storage-api does;
-- RLS still applies.
SELECT set_config('storage.allow_delete_query', 'true', true);
-- pgTAP runs as the service role below; its functions live in schema tests.
GRANT USAGE ON SCHEMA tests TO service_role;

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('emojis', 'emojis', true) ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'emojis', p.name, jsonb_build_object('size', p.size)
  FROM (VALUES
    ('22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000001.png', 1234),
    ('22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000002.png', 2000),
    ('22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000003.gif', 3000),
    ('22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000004.webp', 4000),
    ('22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000005.png', 5000),
    ('22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000006.png', 6000),
    ('22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000007.png', 7000),
    ('33333333-0000-0000-0000-000000000003/150e0000-0000-4000-8000-000000000009.png', 9000),
    ('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001/150e0000-0000-4000-8000-000000000010.png', 10)
  ) p(name, size);

CREATE FUNCTION pg_temp.url(p_path text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'https://db.test/storage/v1/object/public/emojis/' || p_path $$;
CREATE FUNCTION pg_temp.bob(p_n text, p_ext text DEFAULT 'png') RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT '22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-0000000000' || p_n || '.' || p_ext $$;
CREATE FUNCTION pg_temp.set_limit(p_value jsonb) RETURNS void LANGUAGE sql AS
  $$ UPDATE public.instance_config SET config_value = p_value WHERE config_key = 'max_personal_emojis_per_user' $$;
CREATE FUNCTION pg_temp.held() RETURNS integer LANGUAGE sql AS
  $$ SELECT count(*)::int FROM public.emojis WHERE scope = 'user' AND uploader = '22222222-0000-0000-0000-000000000002' $$;
-- The advisory lock 'user_emojis:<bob>' is held by this backend; a bigint key is classid (high
-- 32 bits) and objid (low 32 bits), objsubid 1.
CREATE FUNCTION pg_temp.holds_bob_lock() RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_locks l,
           (SELECT hashtextextended('user_emojis:22222222-0000-0000-0000-000000000002', 0) AS k) key
     WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted AND l.objsubid = 1
       AND l.classid = oid((key.k >> 32) & 4294967295)
       AND l.objid = oid(key.k & 4294967295))
$$;

-- Config key. ---------------------------------------------------------------------------
SELECT ok('max_personal_emojis_per_user' = ANY (public.public_instance_config_keys()),
          'max_personal_emojis_per_user is a public config key');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'max_personal_emojis_per_user'),
          '50'::jsonb, 'the limit is seeded at 50');
SELECT is(public.personal_emoji_limit(), 50, 'personal_emoji_limit reads 50');
SELECT pg_temp.set_limit('0');
SELECT is(public.personal_emoji_limit(), 0, '0 stays 0: personal emojis off');
SELECT pg_temp.set_limit('"7"');
SELECT is(public.personal_emoji_limit(), 7, 'a numeric string is read');
SELECT pg_temp.set_limit('5000');
SELECT is(public.personal_emoji_limit(), 1000, 'above 1000 reads as 1000');
SELECT pg_temp.set_limit('-2');
SELECT is(public.personal_emoji_limit(), 50, 'a negative value reads as 50');
SELECT pg_temp.set_limit('"many"');
SELECT is(public.personal_emoji_limit(), 50, 'an unparseable value reads as 50');
SELECT pg_temp.set_limit('50');

SELECT tests.authenticate_as_anon();
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'max_personal_emojis_per_user'),
          '50'::jsonb, 'anon reads the limit');
SELECT tests.clear_authentication();

-- Grants and policies. ------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.create_my_emoji(text, text, text)', 'EXECUTE'),
          'authenticated executes create_my_emoji');
SELECT ok(NOT has_function_privilege('anon', 'public.create_my_emoji(text, text, text)', 'EXECUTE'),
          'anon does not execute create_my_emoji');
SELECT ok(NOT has_function_privilege('authenticated', 'public.enforce_personal_emoji_limit()', 'EXECUTE'),
          'clients do not execute the limit trigger function');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = 'emojis' AND cmd IN ('INSERT', 'ALL')
                         AND (with_check LIKE '%''user''%' OR policyname = 'emojis_insert_user_scope')),
          'no INSERT policy reaches user-scope emojis');

-- create_my_emoji refusals. -------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.create_my_emoji('anon', pg_temp.bob('01'), pg_temp.url(pg_temp.bob('01')))$q$,
                 '42501', NULL, 'anon cannot create a personal emoji');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_my_emoji('x', '33333333-0000-0000-0000-000000000003/150e0000-0000-4000-8000-000000000009.png',
                     pg_temp.url('33333333-0000-0000-0000-000000000003/150e0000-0000-4000-8000-000000000009.png'))$q$,
                 '22023', NULL, 'a file in another user''s folder is refused');
SELECT throws_ok($q$SELECT public.create_my_emoji('x', '55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001/150e0000-0000-4000-8000-000000000010.png',
                     pg_temp.url('55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001/150e0000-0000-4000-8000-000000000010.png'))$q$,
                 '22023', NULL, 'a server emoji file is refused');
SELECT throws_ok($q$SELECT public.create_my_emoji('x', '22222222-0000-0000-0000-000000000002/sub/150e0000-0000-4000-8000-000000000001.png',
                     pg_temp.url('22222222-0000-0000-0000-000000000002/sub/150e0000-0000-4000-8000-000000000001.png'))$q$,
                 '22023', NULL, 'a nested path is refused');
SELECT throws_ok($q$SELECT public.create_my_emoji('x', pg_temp.bob('01', 'svg'), pg_temp.url(pg_temp.bob('01', 'svg')))$q$,
                 '22023', NULL, 'an SVG name is refused');
SELECT throws_ok($q$SELECT public.create_my_emoji('x', pg_temp.bob('01'), pg_temp.url(pg_temp.bob('02')))$q$,
                 '22023', NULL, 'a url of another object is refused');
SELECT throws_ok($q$SELECT public.create_my_emoji('x', pg_temp.bob('01'), pg_temp.url(pg_temp.bob('01')) || '?x=1')$q$,
                 '22023', NULL, 'a url with a query is refused');
SELECT throws_ok($q$SELECT public.create_my_emoji('x', pg_temp.bob('01'),
                     'https://user@db.test/storage/v1/object/public/emojis/' || pg_temp.bob('01'))$q$,
                 '22023', NULL, 'a url with userinfo is refused');
SELECT throws_ok($q$SELECT public.create_my_emoji('x', pg_temp.bob('01'),
                     'javascript:alert(1)//x/storage/v1/object/public/emojis/' || pg_temp.bob('01'))$q$,
                 '22023', NULL, 'a url that is not http or https is refused');
SELECT throws_ok($q$SELECT public.create_my_emoji('x', pg_temp.bob('08'), pg_temp.url(pg_temp.bob('08')))$q$,
                 '22023', 'EMOJI_FILE_MISSING: ' || pg_temp.bob('08') || ' is not in the emojis bucket',
                 'a file missing from the bucket is refused');
SELECT is(pg_temp.held(), 0, 'refusals create nothing');

-- create_my_emoji. ----------------------------------------------------------------------
SELECT is((SELECT (e.name::text, e.scope, e.uploader, e.server_id, e.domain, e.is_ai_generated, e.file_size, e.url::text)::text
             FROM public.create_my_emoji('party-cat!', pg_temp.bob('01'), pg_temp.url(pg_temp.bob('01'))) e),
          '(party-cat,user,22222222-0000-0000-0000-000000000002,,,f,1234,' || pg_temp.url(pg_temp.bob('01')) || ')',
          'the row is the caller''s user-scope emoji, not AI-generated, sized from the object');
SELECT ok(pg_temp.holds_bob_lock(), 'the insert holds the user_emojis:<owner> advisory lock until commit');
SELECT is((SELECT name::text FROM public.create_my_emoji('PARTY-CAT', pg_temp.bob('02'), pg_temp.url(pg_temp.bob('02')))),
          'PARTY-CAT_1', 'a name the owner holds, case-insensitively, takes _1');
SELECT is((SELECT name::text FROM public.create_my_emoji('party-cat', pg_temp.bob('03', 'gif'), pg_temp.url(pg_temp.bob('03', 'gif')))),
          'party-cat_2', 'the next free suffix is taken');
SELECT is((SELECT name::text FROM public.create_my_emoji('é', pg_temp.bob('04', 'webp'),
                                                         'http://localhost:54500/storage/v1/object/public/emojis/' || pg_temp.bob('04', 'webp'))),
          'emoji', 'a name with fewer than 2 usable characters becomes emoji; an http origin with a port is accepted');
SELECT throws_ok($q$SELECT public.create_my_emoji('again', pg_temp.bob('01'),
                     'https://other.test/storage/v1/object/public/emojis/' || pg_temp.bob('01'))$q$,
                 '23505', NULL, 'a file already behind one of the caller''s emojis is refused');
SELECT is(pg_temp.held(), 4, 'four personal emojis');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT name::text FROM public.create_my_emoji('party-cat',
                     '33333333-0000-0000-0000-000000000003/150e0000-0000-4000-8000-000000000009.png',
                     pg_temp.url('33333333-0000-0000-0000-000000000003/150e0000-0000-4000-8000-000000000009.png'))),
          'party-cat', 'names are unique per owner only');
SELECT tests.clear_authentication();

-- Limit. --------------------------------------------------------------------------------
SELECT pg_temp.set_limit('4');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_my_emoji('fifth', pg_temp.bob('05'), pg_temp.url(pg_temp.bob('05')))$q$,
                 '23514', 'PERSONAL_EMOJI_LIMIT: at most 4 personal emojis per user',
                 'an upload past the limit is refused');
SELECT tests.clear_authentication();

-- gifs.ts hostAndCreateEmoji writes AI emojis as the service role.
SELECT set_config('role', 'service_role', true);
SELECT throws_ok($q$INSERT INTO public.emojis (name, url, server_id, uploader, domain, scope, is_ai_generated)
                    VALUES ('ai_cat', 'https://db.test/storage/v1/object/public/emojis/ai/x.png', NULL,
                            '22222222-0000-0000-0000-000000000002', NULL, 'user', true)$q$,
                 '23514', 'PERSONAL_EMOJI_LIMIT: at most 4 personal emojis per user',
                 'an AI-generated emoji past the limit is refused');
SELECT tests.clear_authentication();
SELECT pg_temp.set_limit('5');
SELECT set_config('role', 'service_role', true);
SELECT lives_ok($q$INSERT INTO public.emojis (name, url, server_id, uploader, domain, scope, is_ai_generated)
                   VALUES ('ai_cat', 'https://db.test/storage/v1/object/public/emojis/ai/x.png', NULL,
                           '22222222-0000-0000-0000-000000000002', NULL, 'user', true)$q$,
                'an AI-generated emoji under the limit is inserted');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_my_emoji('fifth', pg_temp.bob('05'), pg_temp.url(pg_temp.bob('05')))$q$,
                 '23514', NULL, 'AI-generated emojis count toward the limit');
SELECT tests.clear_authentication();

SELECT lives_ok($q$INSERT INTO public.emojis (name, url, server_id, uploader, scope)
                   VALUES ('srv_150', 'https://db.test/storage/v1/object/public/emojis/s.png',
                           '55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', 'server')$q$,
                'server emojis are outside the limit');
SELECT lives_ok($q$INSERT INTO public.emojis (name, url, uploader, scope) VALUES ('orphan', 'https://db.test/o.png', NULL, 'user')$q$,
                'a user-scope row without an owner is outside the limit');

SELECT pg_temp.set_limit('1');
SELECT is(pg_temp.held(), 5, 'rows past a lowered limit stay');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.rename_my_emoji(
                     (SELECT id FROM public.emojis WHERE uploader = '22222222-0000-0000-0000-000000000002'
                         AND scope = 'user' AND name = 'emoji'), 'renamed_150')$q$,
                'an owner past the limit still renames');
SELECT tests.clear_authentication();

SELECT pg_temp.set_limit('5');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
WITH d AS (DELETE FROM public.emojis
            WHERE uploader = '22222222-0000-0000-0000-000000000002' AND scope = 'user' AND name = 'renamed_150'
           RETURNING 1)
SELECT is(count(*)::int, 1, 'the owner deletes a personal emoji') FROM d;
SELECT lives_ok($q$SELECT public.create_my_emoji('fifth', pg_temp.bob('05'), pg_temp.url(pg_temp.bob('05')))$q$,
                'a deletion makes room');
SELECT tests.clear_authentication();

SELECT pg_temp.set_limit('0');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_my_emoji('off', pg_temp.bob('06'), pg_temp.url(pg_temp.bob('06')))$q$,
                 '23514', 'PERSONAL_EMOJI_LIMIT: at most 0 personal emojis per user',
                 'a limit of 0 refuses every personal emoji');
SELECT tests.clear_authentication();
SELECT pg_temp.set_limit('50');

-- BEFORE INSERT triggers run ahead of the RLS check, so this runs under the limit.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$INSERT INTO public.emojis (name, url, uploader, scope)
                    VALUES ('direct', 'https://evil.test/x.png', '33333333-0000-0000-0000-000000000003', 'user')$q$,
                 '42501', NULL, 'a personal emoji is not inserted directly');
SELECT tests.clear_authentication();

-- Storage policies. ---------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO storage.objects (bucket_id, name)
                   VALUES ('emojis', '22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000011.png')$q$,
                'a user uploads into their own folder');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name)
                    VALUES ('emojis', '33333333-0000-0000-0000-000000000003/150e0000-0000-4000-8000-000000000012.png')$q$,
                 '42501', NULL, 'an upload into another user''s folder is refused');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name)
                    VALUES ('emojis', '22222222-0000-0000-0000-000000000002/sub/150e0000-0000-4000-8000-000000000013.png')$q$,
                 '42501', NULL, 'a nested upload under the own folder is refused');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name)
                    VALUES ('emojis', '55555555-0000-0000-0000-000000000005/22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000014.png')$q$,
                 '42501', NULL, 'a member without MANAGE_EMOJIS still cannot upload server emojis');

WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'emojis'
             AND name = '22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000007.png' RETURNING 1)
SELECT is(count(*)::int, 1, 'a user deletes an object in their own folder') FROM d;
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'emojis'
             AND name = '33333333-0000-0000-0000-000000000003/150e0000-0000-4000-8000-000000000009.png' RETURNING 1)
SELECT is(count(*)::int, 0, 'a user cannot delete another user''s object') FROM d;
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'emojis'
             AND name = '55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001/150e0000-0000-4000-8000-000000000010.png'
           RETURNING 1)
SELECT is(count(*)::int, 0, 'a member without MANAGE_EMOJIS cannot delete a server emoji object') FROM d;
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO storage.objects (bucket_id, name)
                   VALUES ('emojis', '55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001/150e0000-0000-4000-8000-000000000016.png')$q$,
                'the server owner still uploads server emojis');
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'emojis'
             AND name = '55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001/150e0000-0000-4000-8000-000000000010.png'
           RETURNING 1)
SELECT is(count(*)::int, 1, 'the server owner still deletes server emoji objects') FROM d;
SELECT tests.clear_authentication();

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name)
                    VALUES ('emojis', '22222222-0000-0000-0000-000000000002/150e0000-0000-4000-8000-000000000017.png')$q$,
                 '42501', NULL, 'anon cannot upload personal emojis');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM pg_policies
            WHERE schemaname = 'storage' AND tablename = 'objects'
              AND policyname IN ('Users can upload personal emojis', 'Users can delete personal emojis')
              AND roles = '{authenticated}'),
          2, 'both personal emoji storage policies are for authenticated');

SELECT * FROM finish();
ROLLBACK;
