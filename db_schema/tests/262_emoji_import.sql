-- 20261111200001_emoji_import.sql: licence and origin on imports, upsert_remote_emoji with a
-- licence and its cap of 10000 rows an origin, admin_list_remote_emojis,
-- admin_remote_emoji_sources, admin_preview_emoji_imports.
--
--   dave262   instance admin
--   bob       no admin
--
-- Instance emojis: taken262 (active), gone262 (removed).
-- Cache rows (2620c000-0000-0000-0000-0000000000NN):
--   01 blob262                 misskey.test   licence set
--   02 taken262                misskey.test   name held by an instance emoji
--   03 Taken262                other.test     held, and the name of 02
--   04 we!rd.name262@old.test  old.test       reduces to werdname262
--   05 gone262                 other.test     the instance emoji of that name is removed
--   06 done262                 misskey.test   imported
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(46);
GRANT USAGE ON SCHEMA tests TO service_role;

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2620000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave262@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin) VALUES
  ('f2620000-0000-0000-0000-0000000000d1', 'f2620000-0000-0000-0000-0000000000a1', 'dave262', 'Dave', true, true);

INSERT INTO public.instance_config (config_key, config_value) VALUES ('storage_origin', '"https://db.test"')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

CREATE FUNCTION pg_temp.url(p_path text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'https://db.test/storage/v1/object/public/emojis/' || p_path $$;
CREATE FUNCTION pg_temp.p(p_n text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT '00000000-0000-0000-0000-000000000000/2620f000-0000-4000-8000-0000000000' || p_n || '.png' $$;
CREATE FUNCTION pg_temp.c(p_n text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT ('2620c000-0000-0000-0000-0000000000' || p_n)::uuid $$;
CREATE FUNCTION pg_temp.as_user(p_auth uuid) RETURNS void LANGUAGE sql AS $$ SELECT tests.authenticate_as(p_auth) $$;

INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'emojis', n, '{"size": 1000, "mimetype": "image/png"}'::jsonb
  FROM unnest(ARRAY[pg_temp.p('01'), pg_temp.p('02'), pg_temp.p('03'), pg_temp.p('04'), pg_temp.p('05')]) n;

INSERT INTO public.emojis (id, name, url, scope, deleted_at) VALUES
  ('2620e000-0000-0000-0000-000000000001', 'taken262', pg_temp.url(pg_temp.p('01')), 'instance', NULL),
  ('2620e000-0000-0000-0000-000000000002', 'gone262', pg_temp.url(pg_temp.p('02')), 'instance', now()),
  ('2620e000-0000-0000-0000-000000000003', 'done262', pg_temp.url(pg_temp.p('03')), 'instance', NULL);

INSERT INTO public.remote_emojis_cache (id, shortcode, origin_domain, full_code, url, usage_count, first_seen_at, imported_as) VALUES
  (pg_temp.c('01'), 'blob262', 'misskey.test', ':blob262@misskey.test:', 'https://media.misskey.test/blob.png', 9, now() - interval '5 days', NULL),
  (pg_temp.c('02'), 'taken262', 'misskey.test', ':taken262@misskey.test:', 'https://media.misskey.test/taken.png', 3, now() - interval '4 days', NULL),
  (pg_temp.c('03'), 'Taken262', 'Other.Test', ':Taken262@other.test:', 'https://other.test/taken.png', 2, now() - interval '3 days', NULL),
  (pg_temp.c('04'), 'we!rd.name262@old.test', 'old.test', ':we!rd.name262@old.test:', 'https://old.test/weird.png', 1, now() - interval '2 days', NULL),
  (pg_temp.c('05'), 'gone262', 'other.test', ':gone262@other.test:', 'https://other.test/gone.png', 1, now() - interval '1 day', NULL),
  (pg_temp.c('06'), 'done262', 'misskey.test', ':done262@misskey.test:', 'https://media.misskey.test/done.png', 1, now(),
   '2620e000-0000-0000-0000-000000000003');

-- Shape and grants. ---------------------------------------------------------------------
SELECT has_column('public', 'emojis', 'license', 'emojis.license exists');
SELECT has_column('public', 'emojis', 'source_domain', 'emojis.source_domain exists');
SELECT has_column('public', 'remote_emojis_cache', 'license', 'remote_emojis_cache.license exists');
SELECT ok(to_regprocedure('public.upsert_remote_emoji(text, text, text, text, text, text, boolean)') IS NULL,
          'upsert_remote_emoji without a licence is gone');
SELECT ok(NOT has_function_privilege('authenticated', 'public.upsert_remote_emoji(text, text, text, text, text, text, boolean, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.upsert_remote_emoji(text, text, text, text, text, text, boolean, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.upsert_remote_emoji(text, text, text, text, text, text, boolean, text)', 'EXECUTE'),
          'upsert_remote_emoji is for service_role');
SELECT ok(has_function_privilege('authenticated', 'public.admin_list_remote_emojis(text, text, text, integer, integer)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.admin_remote_emoji_sources()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.admin_preview_emoji_imports(uuid[])', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.admin_list_emojis(text, text, text, text, integer, integer)', 'EXECUTE'),
          'authenticated executes the admin listings');
SELECT ok(NOT has_function_privilege('anon', 'public.admin_list_remote_emojis(text, text, text, integer, integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.admin_remote_emoji_sources()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.admin_preview_emoji_imports(uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.admin_list_emojis(text, text, text, text, integer, integer)', 'EXECUTE'),
          'anon executes none of them');
SELECT ok(NOT has_function_privilege('authenticated', 'public.instance_emoji_name_held(text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.instance_emoji_import_name(text)', 'EXECUTE'),
          'the name helpers are not client RPCs');

-- Import names. -------------------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT is(public.instance_emoji_import_name('blob262'), 'blob262', 'a plain shortcode keeps its name');
SELECT is(public.instance_emoji_import_name('we!rd.name262@old.test'), 'werdname262',
          'the part before @host is reduced to letters, digits, _ and -');
SELECT is(public.instance_emoji_import_name('!'), 'emoji', 'below two characters the name is emoji');
SELECT is(char_length(public.instance_emoji_import_name(repeat('a', 40))), 32, 'at most 32 characters');
SELECT ok(public.instance_emoji_name_held('TAKEN262'), 'an active instance emoji holds its name in any case');
SELECT ok(NOT public.instance_emoji_name_held('gone262'), 'a removed instance emoji holds none');

-- upsert_remote_emoji. ------------------------------------------------------------------
SELECT is(public.upsert_remote_emoji('blob262', 'misskey.test', ':blob262@misskey.test:',
                                     'https://media.misskey.test/blob.png', p_license => '  CC BY 4.0, Artist  '),
          pg_temp.c('01'), 'a sighting with a licence updates the row');
RESET ROLE;
SELECT is((SELECT license || '|' || usage_count FROM public.remote_emojis_cache WHERE id = pg_temp.c('01')),
          'CC BY 4.0, Artist|10', 'the licence is stored trimmed and the sighting counted');
SET LOCAL ROLE service_role;
SELECT lives_ok($q$SELECT public.upsert_remote_emoji('blob262', 'misskey.test', ':blob262@misskey.test:',
                                                     'https://media.misskey.test/blob.png')$q$,
                'a sighting without a licence is accepted');
SELECT lives_ok($q$SELECT public.upsert_remote_emoji('long262', 'misskey.test', ':long262@misskey.test:',
                                                     'https://media.misskey.test/long.png', p_license => repeat('x', 3000))$q$,
                'an overlong licence is accepted');
SELECT lives_ok($q$SELECT public.upsert_remote_emoji('blank262', 'misskey.test', ':blank262@misskey.test:',
                                                     'https://media.misskey.test/blank.png', p_license => '   ')$q$,
                'a blank licence is accepted');
RESET ROLE;
SELECT is((SELECT license FROM public.remote_emojis_cache WHERE id = pg_temp.c('01')), 'CC BY 4.0, Artist',
          'a sighting without a licence keeps the stored one');
SELECT is((SELECT char_length(license) FROM public.remote_emojis_cache WHERE shortcode = 'long262'), 1024,
          'a licence is cut to 1024 characters');
SELECT ok((SELECT license IS NULL FROM public.remote_emojis_cache WHERE shortcode = 'blank262'),
          'a blank licence is stored as none');
DELETE FROM public.remote_emojis_cache WHERE shortcode IN ('long262', 'blank262');

-- 10000 rows an origin.
INSERT INTO public.remote_emojis_cache (shortcode, origin_domain, full_code, url)
SELECT 'f' || n, 'flood262.test', ':f' || n || '@flood262.test:', 'https://flood262.test/' || n || '.png'
  FROM generate_series(1, 10000) n;
SET LOCAL ROLE service_role;
SELECT is(public.upsert_remote_emoji('more262', 'flood262.test', ':more262@flood262.test:', 'https://flood262.test/more.png'),
          NULL, 'an origin holding 10000 emoji records no new one');
SELECT isnt(public.upsert_remote_emoji('f7', 'flood262.test', ':f7@flood262.test:', 'https://flood262.test/7.png'),
            NULL, 'a sighting of one it holds is still counted');
RESET ROLE;
SELECT is((SELECT count(*)::int || '|' || max(usage_count) FROM public.remote_emojis_cache WHERE origin_domain = 'flood262.test'),
          '10000|2', 'the origin stays at 10000 rows');
DELETE FROM public.remote_emojis_cache WHERE origin_domain = 'flood262.test';

-- admin_list_remote_emojis. -------------------------------------------------------------
SELECT pg_temp.as_user('f2620000-0000-0000-0000-0000000000a1');
SELECT results_eq($$SELECT name, domain, import_name, name_taken, total_count
                      FROM public.admin_list_remote_emojis('262', NULL, 'name')$$,
                  $$VALUES ('blob262', 'misskey.test', 'blob262', false, 5::bigint),
                           ('gone262', 'other.test', 'gone262', false, 5::bigint),
                           ('Taken262', 'other.test', 'Taken262', true, 5::bigint),
                           ('taken262', 'misskey.test', 'taken262', true, 5::bigint),
                           ('we!rd.name262@old.test', 'old.test', 'werdname262', false, 5::bigint)$$,
                  'rows not imported, each with the name an import takes and whether it is held');
SELECT is((SELECT array_agg(name ORDER BY name) FROM public.admin_list_remote_emojis('262', 'MISSKEY.test')),
          ARRAY['blob262', 'taken262'], 'the domain filter is exact and case-insensitive');
SELECT is((SELECT array_agg(name) FROM public.admin_list_remote_emojis('misskey')), NULL,
          'search matches the shortcode, not the domain');
SELECT is((SELECT array_agg(name) FROM public.admin_list_remote_emojis('BLOB262')), ARRAY['blob262'],
          'search is case-insensitive');
SELECT is((SELECT license FROM public.admin_list_remote_emojis('blob262')), 'CC BY 4.0, Artist', 'with the licence');
SELECT is((SELECT array_agg(name) FROM public.admin_list_remote_emojis('262', NULL, 'usage', 2, 0)),
          ARRAY['blob262', 'taken262'], 'most seen first, paged');
SELECT throws_ok($q$SELECT * FROM public.admin_list_remote_emojis(NULL, NULL, 'random')$q$, '22023', NULL,
                 'an unknown sort is refused');

-- admin_remote_emoji_sources. -----------------------------------------------------------
SELECT results_eq($$SELECT domain, emoji_count FROM public.admin_remote_emoji_sources()
                     WHERE domain IN ('misskey.test', 'other.test', 'old.test')$$,
                  $$VALUES ('misskey.test', 2::bigint), ('other.test', 2::bigint), ('old.test', 1::bigint)$$,
                  'origins of rows not imported, most emoji first, domains folded to lower case');

-- admin_preview_emoji_imports. ----------------------------------------------------------
SELECT results_eq($$SELECT id, name, taken, suggested FROM public.admin_preview_emoji_imports(ARRAY[
                        pg_temp.c('01'), pg_temp.c('02'), pg_temp.c('03'), pg_temp.c('02'), pg_temp.c('06'),
                        '2620c000-0000-0000-0000-0000000000ff'::uuid, pg_temp.c('04'), pg_temp.c('05')])$$,
                  $$VALUES (pg_temp.c('01'), 'blob262', false, 'blob262'),
                           (pg_temp.c('02'), 'taken262', true, 'taken262_1'),
                           (pg_temp.c('03'), 'Taken262', true, 'Taken262_2'),
                           (pg_temp.c('04'), 'werdname262', false, 'werdname262'),
                           (pg_temp.c('05'), 'gone262', false, 'gone262')$$,
                  'names in the order given; a held name and a name an earlier id took get a free one; repeated, imported and absent ids give no row');
SELECT is((SELECT count(*)::int FROM public.admin_preview_emoji_imports(NULL)), 0, 'no ids, no rows');

SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT * FROM public.admin_list_remote_emojis()$q$, '42501', NULL, 'admin_list_remote_emojis is for admins');
SELECT throws_ok($q$SELECT * FROM public.admin_remote_emoji_sources()$q$, '42501', NULL, 'admin_remote_emoji_sources is for admins');
SELECT throws_ok($q$SELECT * FROM public.admin_preview_emoji_imports(ARRAY[pg_temp.c('01')])$q$, '42501', NULL,
                 'admin_preview_emoji_imports is for admins');
SELECT tests.clear_authentication();

-- import_remote_emoji. ------------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT is((SELECT row(name, license, source_domain, imported_from, scope, domain)::text FROM public.import_remote_emoji(
             pg_temp.c('01'), 'blob262', pg_temp.p('04'), pg_temp.url(pg_temp.p('04')), 'f2620000-0000-0000-0000-0000000000d1')),
          row('blob262', 'CC BY 4.0, Artist', 'misskey.test', 'https://media.misskey.test/blob.png', 'instance', NULL)::text,
          'an import keeps the licence, the origin instance and the image url');
SELECT throws_ok($q$SELECT public.import_remote_emoji(pg_temp.c('03'), 'Taken262', pg_temp.p('05'),
                                                     pg_temp.url(pg_temp.p('05')), NULL)$q$,
                 '23505', NULL, 'an import under a held name is refused');
SELECT is((SELECT row(name, license, source_domain)::text FROM public.import_remote_emoji(
             pg_temp.c('03'), 'Taken262_2', pg_temp.p('05'), pg_temp.url(pg_temp.p('05')), NULL)),
          row('Taken262_2', NULL, 'other.test')::text,
          'under the free name it lands, origin folded to lower case, no licence known');
RESET ROLE;
SELECT ok((SELECT name = 'taken262' AND deleted_at IS NULL FROM public.emojis WHERE id = '2620e000-0000-0000-0000-000000000001'),
          'the emoji that held the name is untouched');

-- admin_list_emojis. --------------------------------------------------------------------
SELECT pg_temp.as_user('f2620000-0000-0000-0000-0000000000a1');
SELECT is((SELECT kind || '|' || license || '|' || source_domain FROM public.admin_list_emojis('blob262')),
          'imported|CC BY 4.0, Artist|misskey.test', 'admin_list_emojis carries licence and origin');
SELECT is((SELECT array_agg(name ORDER BY name) FROM public.admin_list_emojis('other.test', 'imported')),
          ARRAY['Taken262_2'], 'search matches the origin instance of an import');
SELECT is((SELECT array_agg(name ORDER BY name) FROM public.admin_list_emojis('262', 'not_imported')),
          ARRAY['gone262', 'taken262', 'we!rd.name262@old.test'], 'not_imported still lists what is left');
SELECT is((SELECT array_agg(name ORDER BY name) FROM public.admin_list_remote_emojis('262')),
          ARRAY['gone262', 'taken262', 'we!rd.name262@old.test'], 'imported rows leave admin_list_remote_emojis');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
