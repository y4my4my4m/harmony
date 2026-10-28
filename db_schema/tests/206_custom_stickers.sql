-- 20261031200001_custom_stickers.sql: caps, create/update/delete_sticker, bucket stickers and
-- its policies, the storage origin, row visibility, message sticker parts bound to their row,
-- sticker reports and the server audit log.
--
--   alice     owns server_1
--   bob       member of server_1 without MANAGE_EMOJIS; personal stickers
--   carol206  member of server_1 holding role stickers206 (MANAGE_EMOJIS)
--   mallory   no server; instance moderator from the moderation section on
--   dave206   instance admin
--
-- Objects in bucket stickers (2060e000-0000-4000-8000-0000000000NN):
--   server/<server_1>/01.png  1000 B png      02.gif  600000 B gif     03.webp  image/png
--   server/<server_1>/04.png  png             08.png  png
--   instance/05.webp  webp                   user/<bob>/06.apng  apng   user/<bob>/07.gif  gif
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(122);
SELECT set_config('storage.allow_delete_query', 'true', true);
GRANT USAGE ON SCHEMA tests TO service_role;

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2060000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol206@test.local'),
  ('f2060000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave206@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin) VALUES
  ('f2060000-0000-0000-0000-0000000000c1', 'f2060000-0000-0000-0000-0000000000a1', 'carol206', 'Carol', true, false),
  ('f2060000-0000-0000-0000-0000000000d1', 'f2060000-0000-0000-0000-0000000000a2', 'dave206', 'Dave', true, true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f2060000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f2061000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'stickers206', 3, 16);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f2060000-0000-0000-0000-0000000000c1', 'f2061000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');

INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'stickers', p.name, jsonb_build_object('size', p.size, 'mimetype', p.mime)
  FROM (VALUES
    ('server/55555555-0000-0000-0000-000000000005/2060e000-0000-4000-8000-000000000001.png', 1000, 'image/png'),
    ('server/55555555-0000-0000-0000-000000000005/2060e000-0000-4000-8000-000000000002.gif', 600000, 'image/gif'),
    ('server/55555555-0000-0000-0000-000000000005/2060e000-0000-4000-8000-000000000003.webp', 1000, 'image/png'),
    ('server/55555555-0000-0000-0000-000000000005/2060e000-0000-4000-8000-000000000004.png', 1000, 'image/png'),
    ('server/55555555-0000-0000-0000-000000000005/2060e000-0000-4000-8000-000000000008.png', 1000, 'image/png'),
    ('instance/2060e000-0000-4000-8000-000000000005.webp', 2000, 'image/webp'),
    ('user/22222222-0000-0000-0000-000000000002/2060e000-0000-4000-8000-000000000006.apng', 3000, 'image/apng'),
    ('user/22222222-0000-0000-0000-000000000002/2060e000-0000-4000-8000-000000000007.gif', 3000, 'image/gif')
  ) p(name, size, mime);

INSERT INTO public.instance_config (config_key, config_value) VALUES ('storage_origin', '"https://db.test/"')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

CREATE FUNCTION pg_temp.url(p_path text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'https://db.test/storage/v1/object/public/stickers/' || p_path $$;
CREATE FUNCTION pg_temp.srv(p_n text, p_ext text DEFAULT 'png') RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'server/55555555-0000-0000-0000-000000000005/2060e000-0000-4000-8000-0000000000' || p_n || '.' || p_ext $$;
CREATE FUNCTION pg_temp.bob(p_n text, p_ext text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'user/22222222-0000-0000-0000-000000000002/2060e000-0000-4000-8000-0000000000' || p_n || '.' || p_ext $$;
CREATE FUNCTION pg_temp.set_cap(p_key text, p_value jsonb) RETURNS void LANGUAGE sql AS
  $$ UPDATE public.instance_config SET config_value = p_value WHERE config_key = p_key $$;
CREATE FUNCTION pg_temp.server_sticker(p_n text, p_name text, p_ext text DEFAULT 'png') RETURNS text LANGUAGE sql AS $$
  SELECT name FROM public.create_sticker('server', '55555555-0000-0000-0000-000000000005',
      pg_temp.srv(p_n, p_ext), pg_temp.url(pg_temp.srv(p_n, p_ext)), p_name, 'A cat waving', 128, 128)
$$;

-- Config keys. --------------------------------------------------------------------------
SELECT ok(ARRAY['max_stickers_per_server', 'max_instance_stickers', 'max_personal_stickers_per_user']
          <@ public.public_instance_config_keys(), 'the three sticker caps are public config keys');
SELECT is(public.sticker_limit('server'), 15, 'server stickers default to 15');
SELECT is(public.sticker_limit('instance'), 50, 'instance stickers default to 50');
SELECT is(public.sticker_limit('user'), 0, 'personal stickers default to 0, off');
SELECT pg_temp.set_cap('max_stickers_per_server', '0');
SELECT is(public.sticker_limit('server'), 0, '0 stays 0: server stickers off');
SELECT pg_temp.set_cap('max_stickers_per_server', '"500"');
SELECT is(public.sticker_limit('server'), 100, 'above 100 reads as 100');
SELECT pg_temp.set_cap('max_stickers_per_server', '"many"');
SELECT is(public.sticker_limit('server'), 15, 'an unparseable value reads as 15');
SELECT pg_temp.set_cap('max_stickers_per_server', '15');
SELECT is(public.sticker_limit('other'), 0, 'an unknown scope reads 0');

-- Grants and bucket. --------------------------------------------------------------------
SELECT ok(has_column_privilege('anon', 'public.stickers', 'url', 'SELECT')
          AND has_column_privilege('authenticated', 'public.stickers', 'server_id', 'SELECT')
          AND has_column_privilege('authenticated', 'public.stickers', 'owner_id', 'SELECT'),
          'anon and authenticated read sticker columns');
SELECT ok(NOT has_column_privilege('anon', 'public.stickers', 'uploader', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.stickers', 'uploader', 'SELECT'),
          'no client reads who uploaded a sticker');
SELECT ok(has_function_privilege('anon', 'public.existing_sticker_ids(uuid[])', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.existing_sticker_ids(uuid[])', 'EXECUTE'),
          'anon and authenticated look sticker ids up');
SELECT ok(NOT has_table_privilege('authenticated', 'public.stickers', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.stickers', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.stickers', 'DELETE'),
          'authenticated writes stickers through the RPCs only');
SELECT ok(has_function_privilege('authenticated',
              'public.create_sticker(text, uuid, text, text, text, text, integer, integer, integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon',
              'public.create_sticker(text, uuid, text, text, text, text, integer, integer, integer)', 'EXECUTE'),
          'authenticated executes create_sticker, anon does not');
SELECT ok(NOT has_function_privilege('authenticated', 'public.enforce_sticker_limit()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.check_message_sticker_parts()', 'EXECUTE'),
          'clients do not execute the trigger functions');
SELECT is((SELECT (b.public, b.file_size_limit, b.allowed_mime_types)::text FROM storage.buckets b WHERE b.id = 'stickers'),
          '(t,524288,"{image/png,image/apng,image/webp,image/gif}")',
          'bucket stickers is public, 512 KB, PNG/APNG/WebP/GIF');

-- Storage origin. -----------------------------------------------------------------------
SELECT ok(public.is_storage_public_url('https://DB.test/storage/v1/object/public/stickers/a/b.png', 'stickers', 'a/b.png'),
          'the pinned origin is accepted, host case-insensitively');
SELECT ok(NOT public.is_storage_public_url('https://evil.test/storage/v1/object/public/stickers/a/b.png', 'stickers', 'a/b.png'),
          'another origin is refused while storage_origin is set');
SELECT ok(NOT public.is_storage_public_url('https://db.test/storage/v1/object/public/stickers/a/c.png', 'stickers', 'a/b.png'),
          'a url of another object is refused');
UPDATE public.instance_config SET config_value = '""' WHERE config_key = 'storage_origin';
SELECT ok(public.is_storage_public_url('https://evil.test/storage/v1/object/public/stickers/a/b.png', 'stickers', 'a/b.png')
          AND NOT public.is_storage_public_url('https://u@evil.test/storage/v1/object/public/stickers/a/b.png', 'stickers', 'a/b.png'),
          'with storage_origin empty, an origin is checked for shape only');
UPDATE public.instance_config SET config_value = '"https://db.test/"' WHERE config_key = 'storage_origin';

-- create_sticker refusals. --------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT pg_temp.server_sticker('01', 'wave')$q$, '42501', NULL, 'anon cannot create a sticker');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT pg_temp.server_sticker('01', 'wave')$q$, '42501', NULL,
                 'a member without MANAGE_EMOJIS cannot create a server sticker');
SELECT throws_ok($q$SELECT public.create_sticker('instance', NULL, 'instance/2060e000-0000-4000-8000-000000000005.webp',
                     pg_temp.url('instance/2060e000-0000-4000-8000-000000000005.webp'), 'inst', 'x', 64, 64)$q$,
                 '42501', NULL, 'a non-admin cannot create an instance sticker');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$SELECT public.create_sticker('server', '55555555-0000-0000-0000-000000000005',
                     'instance/2060e000-0000-4000-8000-000000000005.webp',
                     pg_temp.url('instance/2060e000-0000-4000-8000-000000000005.webp'), 'wave', 'x', 64, 64)$q$,
                 '22023', NULL, 'a file outside the server''s folder is refused');
SELECT throws_ok($q$SELECT public.create_sticker('server', '55555555-0000-0000-0000-000000000005',
                     pg_temp.srv('01'), pg_temp.url(pg_temp.srv('04')), 'wave', 'x', 64, 64)$q$,
                 '22023', NULL, 'a url of another object is refused');
SELECT throws_ok($q$SELECT public.create_sticker('server', '55555555-0000-0000-0000-000000000005',
                     pg_temp.srv('01'), 'https://evil.test/storage/v1/object/public/stickers/' || pg_temp.srv('01'),
                     'wave', 'x', 64, 64)$q$,
                 '22023', 'STICKER_URL: the url is not the public URL of ' || pg_temp.srv('01'),
                 'a url on another origin than storage_origin is refused');
SELECT throws_ok($q$SELECT public.create_sticker('server', '55555555-0000-0000-0000-000000000005',
                     pg_temp.srv('01', 'svg'), pg_temp.url(pg_temp.srv('01', 'svg')), 'wave', 'x', 64, 64)$q$,
                 '22023', NULL, 'an SVG name is refused');
SELECT throws_ok($q$SELECT pg_temp.server_sticker('09', 'wave')$q$, '22023',
                 'STICKER_FILE_MISSING: ' || pg_temp.srv('09') || ' is not in the stickers bucket',
                 'a file missing from the bucket is refused');
SELECT throws_ok($q$SELECT pg_temp.server_sticker('02', 'wave', 'gif')$q$, '22023',
                 'STICKER_FILE_SIZE: a sticker file is at most 512 KB', 'a file over 512 KB is refused');
SELECT throws_ok($q$SELECT pg_temp.server_sticker('03', 'wave', 'webp')$q$, '22023',
                 'STICKER_FILE_TYPE: a sticker is PNG, APNG, WebP or GIF',
                 'a type that does not match the extension is refused');
SELECT throws_ok($q$SELECT public.create_sticker('server', '55555555-0000-0000-0000-000000000005',
                     pg_temp.srv('01'), pg_temp.url(pg_temp.srv('01')), 'wave', 'x', 321, 64)$q$,
                 '22023', 'STICKER_DIMENSIONS: a sticker is at most 320x320 pixels', 'a 321 px wide sticker is refused');
SELECT throws_ok($q$SELECT public.create_sticker('server', '55555555-0000-0000-0000-000000000005',
                     pg_temp.srv('01'), pg_temp.url(pg_temp.srv('01')), 'wave', 'x', 64, 64, 5001)$q$,
                 '22023', 'STICKER_DURATION: an animated sticker runs at most 5 seconds',
                 'an animation over 5 s is refused');
SELECT throws_ok($q$SELECT public.create_sticker('server', '55555555-0000-0000-0000-000000000005',
                     pg_temp.srv('01'), pg_temp.url(pg_temp.srv('01')), ' w ', 'x', 64, 64)$q$,
                 '22023', 'STICKER_NAME: a sticker name is 2 to 30 characters', 'a 1-character name is refused');
SELECT throws_ok($q$SELECT public.create_sticker('server', '55555555-0000-0000-0000-000000000005',
                     pg_temp.srv('01'), pg_temp.url(pg_temp.srv('01')), repeat('w', 31), 'x', 64, 64)$q$,
                 '22023', 'STICKER_NAME: a sticker name is 2 to 30 characters', 'a 31-character name is refused');
SELECT throws_ok($q$SELECT public.create_sticker('server', '55555555-0000-0000-0000-000000000005',
                     pg_temp.srv('01'), pg_temp.url(pg_temp.srv('01')), 'wave', '   ', 64, 64)$q$,
                 '22023', 'STICKER_DESCRIPTION: a sticker description is 1 to 300 characters',
                 'a blank description is refused');
SELECT is((SELECT count(*)::int FROM public.stickers), 0, 'refusals create nothing');

-- create_sticker. -----------------------------------------------------------------------
SELECT is((SELECT (s.scope, s.server_id, s.owner_id, s.uploader, s.name, s.description, s.file_size,
                   s.mime_type, s.width, s.height, s.duration_ms)::text
             FROM public.create_sticker('server', '55555555-0000-0000-0000-000000000005', pg_temp.srv('01'),
                                        pg_temp.url(pg_temp.srv('01')), '  Cat wave ', ' A cat waving ', 160, 120) s),
          '(server,55555555-0000-0000-0000-000000000005,,f2060000-0000-0000-0000-0000000000c1,"Cat wave","A cat waving",1000,image/png,160,120,)',
          'a manager creates a server sticker, trimmed, sized and typed from the object');
SELECT throws_ok($q$SELECT pg_temp.server_sticker('04', 'CAT WAVE')$q$, '23505', 'STICKER_NAME_TAKEN: CAT WAVE is taken',
                 'a name the server holds, case-insensitively, is refused');
SELECT throws_ok($q$SELECT pg_temp.server_sticker('01', 'other')$q$, '23505', NULL,
                 'a file already behind a sticker is refused');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND action = 'sticker.create'
              AND target_type = 'sticker' AND target_name = 'Cat wave'),
          1, 'a server sticker writes sticker.create to the server audit log');

-- Caps. ---------------------------------------------------------------------------------
SELECT pg_temp.set_cap('max_stickers_per_server', '1');
SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$SELECT pg_temp.server_sticker('04', 'second')$q$, '23514',
                 'STICKER_LIMIT: at most 1 server stickers', 'a sticker past the server cap is refused');
SELECT tests.clear_authentication();
SELECT set_config('role', 'service_role', true);
SELECT throws_ok($q$INSERT INTO public.stickers (scope, server_id, name, description, path, url, mime_type, file_size, width, height)
                    VALUES ('server', '55555555-0000-0000-0000-000000000005', 'direct', 'd', pg_temp.srv('04'),
                            pg_temp.url(pg_temp.srv('04')), 'image/png', 1000, 10, 10)$q$,
                 '23514', NULL, 'the cap holds for the service role');
SELECT tests.clear_authentication();
SELECT pg_temp.set_cap('max_stickers_per_server', '0');
SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('stickers', pg_temp.srv('20'))$q$,
                 '42501', NULL, 'with server stickers off, a manager cannot upload a server sticker file');
SELECT tests.clear_authentication();
SELECT pg_temp.set_cap('max_stickers_per_server', '3');
SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('stickers', pg_temp.srv('27'))$q$,
                 '42501', NULL, 'a server folder holding cap + 2 files takes no more uploads');
SELECT tests.clear_authentication();
SELECT pg_temp.set_cap('max_stickers_per_server', '15');
SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a1');
SELECT is(pg_temp.server_sticker('04', 'second'), 'second', 'a raised cap makes room');
SELECT tests.clear_authentication();

-- Instance stickers. --------------------------------------------------------------------
SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a2');
SELECT is((SELECT (s.scope, s.server_id, s.owner_id, s.mime_type, s.duration_ms)::text
             FROM public.create_sticker('instance', NULL, 'instance/2060e000-0000-4000-8000-000000000005.webp',
                     pg_temp.url('instance/2060e000-0000-4000-8000-000000000005.webp'), 'Party', 'Confetti', 300, 300, 4200) s),
          '(instance,,,image/webp,4200)', 'an instance admin creates an animated instance sticker');
SELECT throws_ok($q$SELECT public.create_sticker('instance', '55555555-0000-0000-0000-000000000005',
                     'instance/2060e000-0000-4000-8000-000000000005.webp',
                     pg_temp.url('instance/2060e000-0000-4000-8000-000000000005.webp'), 'Party2', 'x', 30, 30)$q$,
                 '42501', NULL, 'an instance sticker names no server');
SELECT lives_ok($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('stickers', 'instance/2060e000-0000-4000-8000-000000000021.png')$q$,
                'an instance admin uploads an instance sticker file');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('stickers', 'instance/2060e000-0000-4000-8000-000000000022.png')$q$,
                 '42501', NULL, 'a server manager cannot upload an instance sticker file');
SELECT tests.clear_authentication();

-- Personal stickers. --------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('stickers', pg_temp.bob('23', 'png'))$q$,
                 '42501', NULL, 'with personal stickers off (the default), an upload is refused');
SELECT throws_ok($q$SELECT public.create_sticker('user', NULL, pg_temp.bob('06', 'apng'), pg_temp.url(pg_temp.bob('06', 'apng')),
                     'mine', 'My sticker', 64, 64, 1200)$q$,
                 '23514', 'STICKER_LIMIT: at most 0 user stickers', 'with personal stickers off, create_sticker is refused');
SELECT tests.clear_authentication();

SELECT pg_temp.set_cap('max_personal_stickers_per_user', '1');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT (s.scope, s.owner_id, s.uploader, s.mime_type)::text
             FROM public.create_sticker('user', NULL, pg_temp.bob('06', 'apng'), pg_temp.url(pg_temp.bob('06', 'apng')),
                                        'mine', 'My sticker', 64, 64, 1200) s),
          '(user,22222222-0000-0000-0000-000000000002,22222222-0000-0000-0000-000000000002,image/apng)',
          'once an admin allows one, a member creates a personal sticker');
SELECT throws_ok($q$SELECT public.create_sticker('user', NULL, pg_temp.bob('07', 'gif'), pg_temp.url(pg_temp.bob('07', 'gif')),
                     'mine2', 'Second', 64, 64)$q$,
                 '23514', 'STICKER_LIMIT: at most 1 user stickers', 'a personal sticker past the cap is refused');
SELECT throws_ok($q$SELECT public.create_sticker('user', '55555555-0000-0000-0000-000000000005', pg_temp.bob('07', 'gif'),
                     pg_temp.url(pg_temp.bob('07', 'gif')), 'mine2', 'Second', 64, 64)$q$,
                 '22023', NULL, 'a personal sticker names no server');
SELECT lives_ok($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('stickers', pg_temp.bob('24', 'png'))$q$,
                'a member uploads into their own sticker folder');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('stickers', pg_temp.bob('28', 'png'))$q$,
                 '42501', NULL, 'a personal folder holding cap + 2 files takes no more uploads');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name)
                    VALUES ('stickers', 'user/33333333-0000-0000-0000-000000000003/2060e000-0000-4000-8000-000000000025.png')$q$,
                 '42501', NULL, 'an upload into another account''s sticker folder is refused');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('stickers', pg_temp.srv('26'))$q$,
                 '42501', NULL, 'a member without MANAGE_EMOJIS cannot upload a server sticker file');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('stickers', 'user/22222222-0000-0000-0000-000000000002/x.svg')$q$,
                 '42501', NULL, 'an object name outside the sticker shapes is refused');

-- Direct writes. ------------------------------------------------------------------------
SELECT throws_ok($q$INSERT INTO public.stickers (scope, owner_id, name, description, path, url, mime_type, file_size, width, height)
                    VALUES ('user', '22222222-0000-0000-0000-000000000002', 'direct', 'd', pg_temp.bob('07', 'gif'),
                            pg_temp.url(pg_temp.bob('07', 'gif')), 'image/gif', 10, 10, 10)$q$,
                 '42501', NULL, 'a sticker is not inserted directly');
SELECT throws_ok($q$UPDATE public.stickers SET name = 'hijack'$q$, '42501', NULL, 'a sticker is not updated directly');
SELECT throws_ok($q$DELETE FROM public.stickers$q$, '42501', NULL, 'a sticker is not deleted directly');
SELECT tests.clear_authentication();

-- update_sticker. -----------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.update_sticker((SELECT id FROM public.stickers WHERE name = 'Cat wave'), 'mine now')$q$,
                 'P0002', NULL, 'a member without MANAGE_EMOJIS cannot rename a server sticker');
SELECT is((SELECT (s.name, s.description)::text
             FROM public.update_sticker((SELECT id FROM public.stickers WHERE name = 'mine'), NULL, 'Me, waving') s),
          '(mine,"Me, waving")', 'the owner describes a personal sticker; NULL keeps the name');
SELECT throws_ok($q$SELECT public.update_sticker((SELECT id FROM public.stickers WHERE name = 'mine'), NULL, '')$q$,
                 '22023', NULL, 'a description cannot be emptied');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a1');
SELECT is((SELECT name FROM public.update_sticker((SELECT id FROM public.stickers WHERE name = 'second'), 'Second wave')),
          'Second wave', 'a manager renames a server sticker');
SELECT throws_ok($q$SELECT public.update_sticker((SELECT id FROM public.stickers WHERE name = 'Second wave'), 'cat WAVE')$q$,
                 '23505', 'STICKER_NAME_TAKEN: cat WAVE is taken', 'a rename onto a held name is refused');
SELECT throws_ok($q$SELECT public.update_sticker((SELECT id FROM public.stickers WHERE name = 'mine'), 'stolen')$q$,
                 'P0002', NULL, 'a manager cannot rename someone''s personal sticker');
SELECT tests.clear_authentication();
SELECT is((SELECT (changes -> 'name')::text FROM public.server_audit_log
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND action = 'sticker.update'),
          '{"new": "Second wave", "old": "second"}', 'a rename writes sticker.update with the change');

-- Message parts. ------------------------------------------------------------------------
SELECT set_config('t206.cat', (SELECT id::text FROM public.stickers WHERE name = 'Cat wave'), true);
SELECT set_config('t206.mine', (SELECT id::text FROM public.stickers WHERE name = 'mine'), true);
CREATE FUNCTION pg_temp.sticker_msg(p_text text, p_parts jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.messages (channel_id, user_id, content)
  VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
          jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text)) || p_parts)
$$;
CREATE FUNCTION pg_temp.cat(p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('type', 'sticker', 'id', current_setting('t206.cat'), 'url', pg_temp.url(pg_temp.srv('01')),
                            'name', 'Cat wave', 'description', 'A cat waving') || p_over
$$;
CREATE FUNCTION pg_temp.cat_file(p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('type', 'file', 'fileType', 'image', 'url', pg_temp.url(pg_temp.srv('01')),
                            'stickerId', current_setting('t206.cat'), 'altText', 'A cat waving') || p_over
$$;

SELECT lives_ok($q$SELECT pg_temp.sticker_msg('sticker 206',
                     jsonb_build_array(pg_temp.cat('{"name": "Forged", "description": "forged", "width": 4000}'), pg_temp.cat_file()))$q$,
                'a message holds one sticker of this instance beside text and its image fallback');
SELECT is((SELECT (e ->> 'name', e ->> 'description', e ->> 'width', e ->> 'height', e ->> 'mimeType')::text
             FROM public.messages m, jsonb_array_elements(m.content) e
            WHERE m.content @> '[{"text": "sticker 206"}]' AND e ->> 'type' = 'sticker'),
          '("Cat wave","A cat waving",160,120,image/png)',
          'the part takes its name, description, size and type from the row');
SELECT set_config('t206.msg', (SELECT id::text FROM public.messages WHERE content @> '[{"text": "sticker 206"}]'), true);
SELECT throws_ok($q$SELECT pg_temp.sticker_msg('forged url',
                     jsonb_build_array(pg_temp.cat('{"url": "https://evil.test/cat.png"}'),
                                       pg_temp.cat_file('{"url": "https://evil.test/cat.png"}')))$q$,
                 '22023', 'STICKER_UNKNOWN: a sticker part names a sticker of this instance by id and url',
                 'a sticker part with a real id and another url is refused');
SELECT throws_ok($q$SELECT pg_temp.sticker_msg('unknown id',
                     jsonb_build_array(pg_temp.cat('{"id": "2060f000-0000-4000-8000-000000000099"}')))$q$,
                 '22023', 'STICKER_UNKNOWN: a sticker part names a sticker of this instance by id and url',
                 'a sticker part naming no stickers row is refused');
SELECT throws_ok($q$SELECT pg_temp.sticker_msg('not a uuid', jsonb_build_array(pg_temp.cat('{"id": "x1"}')))$q$,
                 '22023', 'STICKER_UNKNOWN: a sticker part names a sticker of this instance by id and url',
                 'a sticker part of this instance with a non-uuid id is refused');
SELECT throws_ok($q$SELECT pg_temp.sticker_msg('hidden image',
                     jsonb_build_array(pg_temp.cat(), pg_temp.cat_file('{"url": "https://evil.test/other.png"}')))$q$,
                 '22023', 'STICKER_FALLBACK: the file part of a sticker is an image at its url',
                 'a fallback at another url than its sticker is refused');
SELECT throws_ok($q$SELECT pg_temp.sticker_msg('video fallback',
                     jsonb_build_array(pg_temp.cat(), pg_temp.cat_file('{"fileType": "video"}')))$q$,
                 '22023', 'STICKER_FALLBACK: the file part of a sticker is an image at its url',
                 'a fallback that is not an image is refused');
SELECT throws_ok($q$SELECT pg_temp.sticker_msg('two',
                     jsonb_build_array(pg_temp.cat(), pg_temp.cat('{"id": "x2"}')))$q$,
                 '23514', 'STICKER_PARTS: a message holds at most one sticker', 'a second sticker part is refused');
SELECT throws_ok($q$SELECT pg_temp.sticker_msg('no description', jsonb_build_array(pg_temp.cat() - 'description'))$q$,
                 '22023', NULL, 'a sticker part without a description is refused');
SELECT throws_ok($q$SELECT pg_temp.sticker_msg('js', jsonb_build_array(pg_temp.cat('{"url": "javascript:alert(1)"}')))$q$,
                 '22023', NULL, 'a sticker part with a non-http url is refused');
SELECT lives_ok($q$SELECT pg_temp.sticker_msg('remote 206', jsonb_build_array(
                     '{"type":"sticker","id":"peer-1","url":"HTTPS://peer.test/s.png","name":"Peer","description":"d","domain":"peer.test"}'::jsonb,
                     '{"type":"file","fileType":"image","url":"HTTPS://peer.test/s.png","stickerId":"peer-1"}'::jsonb))$q$,
                'another instance''s sticker, its url scheme in capitals, is stored as federation writes it');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT pg_temp.sticker_msg('client remote', jsonb_build_array(pg_temp.cat('{"domain": "peer.test"}')))$q$,
                 '42501', 'STICKER_DOMAIN: a sticker of another instance arrives by federation only',
                 'a client cannot mark a sticker as another instance''s');
SELECT tests.clear_authentication();
SELECT throws_ok($q$UPDATE public.messages SET content = content || jsonb_build_array(pg_temp.cat('{"id": "x2"}'))
                    WHERE id = current_setting('t206.msg')::uuid$q$,
                 '23514', NULL, 'an edit cannot add a second sticker');
SELECT throws_ok($q$UPDATE public.messages
                       SET content = jsonb_build_array(pg_temp.cat('{"url": "https://evil.test/cat.png"}'),
                                                       pg_temp.cat_file('{"url": "https://evil.test/cat.png"}'))
                     WHERE id = current_setting('t206.msg')::uuid$q$,
                 '22023', NULL, 'an edit cannot point the sticker at another url');
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content) VALUES (
                     '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                     '[{"type":"text","text":"no stickers here"}]')$q$,
                'a message without stickers is untouched');

-- Reports. ------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.stickers WHERE id = current_setting('t206.mine')::uuid), 0,
          'another member does not read a personal sticker row');
SELECT ok(set_config('t206.report',
              public.create_report('sticker', p_reported_sticker_id => current_setting('t206.mine')::uuid,
                                   p_reason => 'nsfw')::text, true) IS NOT NULL,
          'a member reports a personal sticker by its id');
SELECT is(public.create_report('sticker', p_reported_sticker_id => current_setting('t206.mine')::uuid)::text,
          current_setting('t206.report'), 'a second report of the same sticker returns the open one');
SELECT ok(public.create_report('sticker', p_reported_sticker_id => current_setting('t206.cat')::uuid)
          IS NOT NULL, 'a server sticker is reported without an account');
SELECT throws_ok($q$SELECT public.create_report('sticker', p_reported_sticker_id => current_setting('t206.cat')::uuid,
                     p_reported_server_id => '55555555-0000-0000-0000-000000000005')$q$,
                 '22023', NULL, 'a sticker report names no server');
SELECT throws_ok($q$SELECT public.create_report('sticker', p_reported_sticker_id => current_setting('t206.cat')::uuid,
                     p_reported_message_id => current_setting('t206.msg')::uuid)$q$,
                 'P0002', 'Message not found', 'a sticker report names no message the reporter cannot read');
SELECT throws_ok($q$SELECT public.create_report('message', p_reported_message_id => '88888888-0000-0000-0000-000000000008',
                     p_reported_sticker_id => current_setting('t206.cat')::uuid)$q$,
                 '22023', NULL, 'a message report names no sticker');
SELECT throws_ok($q$SELECT public.create_report('sticker', p_reported_sticker_id => '2060f000-0000-4000-8000-000000000099')$q$,
                 'P0002', NULL, 'an unknown sticker is not found');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT ok(set_config('t206.msg_report',
              public.create_report('sticker', p_reported_sticker_id => current_setting('t206.cat')::uuid,
                                   p_reported_message_id => current_setting('t206.msg')::uuid)::text, true) IS NOT NULL,
          'a member reports a sticker with the message it was seen in');
SELECT throws_ok($q$SELECT public.create_report('sticker', p_reported_sticker_id => current_setting('t206.mine')::uuid,
                     p_reported_message_id => current_setting('t206.msg')::uuid)$q$,
                 'P0002', 'Message not found', 'the message must carry the reported sticker');
SELECT tests.clear_authentication();
SELECT is((SELECT (r.reported_message_id::text = current_setting('t206.msg'), r.reported_sticker_id::text = current_setting('t206.cat'),
                   r.content_snapshot -> 'message' IS NOT NULL)::text
             FROM public.reports r WHERE r.id = current_setting('t206.msg_report')::uuid),
          '(t,t,t)', 'the report keeps the message beside the sticker');
SELECT is((SELECT (r.report_type, r.reported_user_id, r.content_snapshot -> 'sticker' ->> 'name',
                   r.content_snapshot -> 'sticker' ->> 'description')::text
             FROM public.reports r WHERE r.id = current_setting('t206.report')::uuid),
          '(sticker,22222222-0000-0000-0000-000000000002,mine,"Me, waving")',
          'the report names the owner and keeps the sticker as reported');
SELECT is((SELECT (r.reported_user_id IS NULL, r.content_snapshot -> 'sticker' ->> 'scope')::text
             FROM public.reports r
            WHERE r.report_type = 'sticker' AND r.reporter_id = '33333333-0000-0000-0000-000000000003'
              AND r.id <> current_setting('t206.report')::uuid),
          '(t,server)', 'a server sticker report names no account');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_report('sticker', p_reported_sticker_id => current_setting('t206.mine')::uuid)$q$,
                 '22023', 'Cannot report yourself', 'an owner cannot report their own sticker');
SELECT tests.clear_authentication();

-- delete_sticker. -----------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.delete_sticker(current_setting('t206.mine')::uuid)$q$,
                 'P0002', NULL, 'another member cannot remove a personal sticker');
SELECT tests.clear_authentication();
UPDATE public.profiles SET is_moderator = true WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.delete_sticker(current_setting('t206.mine')::uuid), pg_temp.bob('06', 'apng'),
          'an instance moderator removes a reported personal sticker and gets its path');
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'stickers' AND name = pg_temp.bob('06', 'apng') RETURNING 1)
SELECT is(count(*)::int, 1, 'an instance moderator removes its file') FROM d;
SELECT tests.clear_authentication();
SELECT is((SELECT (r.reported_sticker_id IS NULL, r.content_snapshot -> 'sticker' ->> 'name')::text
             FROM public.reports r WHERE r.id = current_setting('t206.report')::uuid),
          '(t,mine)', 'the report outlives the sticker with its snapshot');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.delete_sticker(current_setting('t206.cat')::uuid)$q$,
                 'P0002', NULL, 'a member without MANAGE_EMOJIS cannot remove a server sticker');
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'stickers' AND name = pg_temp.srv('01') RETURNING 1)
SELECT is(count(*)::int, 0, 'nor its file') FROM d;
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a1');
SELECT is(public.delete_sticker(current_setting('t206.cat')::uuid), pg_temp.srv('01'),
          'a manager removes a server sticker');
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'stickers' AND name = pg_temp.srv('01') RETURNING 1)
SELECT is(count(*)::int, 1, 'and its file') FROM d;
SELECT lives_ok($q$UPDATE public.messages SET content = jsonb_set(content, '{0,text}', '"edited 206"')
                    WHERE id = current_setting('t206.msg')::uuid$q$,
                'a message whose sticker is gone is still edited');
SELECT throws_ok($q$SELECT public.delete_sticker((SELECT id FROM public.stickers WHERE name = 'Party'))$q$,
                 'P0002', NULL, 'a server manager cannot remove an instance sticker');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND action = 'sticker.delete'
              AND target_name = 'Cat wave'),
          1, 'a removal writes sticker.delete to the server audit log');
SELECT is((SELECT count(*)::int FROM public.server_audit_log WHERE action LIKE 'sticker.%' AND target_name IN ('Party', 'mine')),
          0, 'instance and personal stickers stay out of server audit logs');

SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a2');
SELECT is(public.delete_sticker((SELECT id FROM public.stickers WHERE name = 'Party')),
          'instance/2060e000-0000-4000-8000-000000000005.webp', 'an instance admin removes an instance sticker');
SELECT tests.clear_authentication();

-- Reads. --------------------------------------------------------------------------------
SELECT set_config('t206.second', (SELECT id::text FROM public.stickers WHERE name = 'Second wave'), true);
UPDATE public.profiles SET is_moderator = false WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as_anon();
SELECT is((SELECT count(*)::int FROM public.stickers), 0, 'anon reads no sticker of a private server');
SELECT is((SELECT array_agg(e.url) FROM public.existing_sticker_ids(
              ARRAY[current_setting('t206.second')::uuid, '2060f000-0000-4000-8000-000000000099'::uuid]) e),
          ARRAY[pg_temp.url(pg_temp.srv('04'))],
          'existing_sticker_ids answers the url of an existing sticker whoever reads it, nothing for an unknown id');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.stickers), 0, 'a non-member reads no sticker of a private server');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT array_agg(name) FROM public.stickers), ARRAY['Second wave'], 'a member reads the server''s stickers');
SELECT throws_ok($q$SELECT uploader FROM public.stickers$q$, '42501', NULL, 'a member does not read who uploaded a sticker');
SELECT tests.clear_authentication();
UPDATE public.servers SET public = true WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT tests.authenticate_as_anon();
SELECT is((SELECT array_agg(name) FROM public.stickers), ARRAY['Second wave'], 'anon reads the stickers of a public server');
SELECT tests.clear_authentication();
UPDATE public.servers SET public = false WHERE id = '55555555-0000-0000-0000-000000000005';

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT name FROM public.create_sticker('user', NULL, pg_temp.bob('07', 'gif'), pg_temp.url(pg_temp.bob('07', 'gif')),
                                                  'mine2', 'Second', 64, 64)),
          'mine2', 'a member creates another personal sticker');
SELECT is((SELECT count(*)::int FROM public.stickers WHERE scope = 'user'), 1, 'the owner reads a personal sticker');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.stickers WHERE scope = 'user'), 0, 'another account does not');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('f2060000-0000-0000-0000-0000000000a2');
SELECT is((SELECT count(*)::int FROM public.stickers WHERE scope = 'user'), 1, 'an instance admin does');
SELECT tests.clear_authentication();

-- Server deletion. ----------------------------------------------------------------------
SELECT lives_ok($q$DELETE FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'$q$,
                'a server with stickers is deleted');
SELECT is((SELECT count(*)::int FROM public.stickers WHERE scope = 'server'), 0, 'its stickers go with it');

SELECT * FROM finish();
ROLLBACK;
