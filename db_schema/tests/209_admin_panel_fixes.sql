-- 20261031400001_admin_panel_fixes.sql: paged admin_drive_usage, create_instance_emoji and the
-- instance emoji folder in bucket emojis; create_instance_emoji takes only the storage_origin
-- origin once it is set.
--
--   alice    instance admin for this file
--   bob      not an admin
--   drv_01..drv_07  Drive holders; drv_03 and drv_04 tie on used bytes
--   drv_quota       no files, a quota override
--   drv_none        no files, no override
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(42);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO public.profiles (id, username, display_name, is_local) VALUES
  ('20900000-0000-0000-0000-000000000001', 'drv_01', 'Ann Drive', true),
  ('20900000-0000-0000-0000-000000000002', 'drv_02', 'Ben Drive', true),
  ('20900000-0000-0000-0000-000000000003', 'drv_03', 'Cid :blob: Drive', true),
  ('20900000-0000-0000-0000-000000000004', 'drv_04', 'Dee Drive', true),
  ('20900000-0000-0000-0000-000000000005', 'drv_05', 'Eve Drive', true),
  ('20900000-0000-0000-0000-000000000006', 'drv_06', 'Fay Drive', true),
  ('20900000-0000-0000-0000-000000000007', 'drv_07', 'Gus Drive', true),
  ('20900000-0000-0000-0000-000000000008', 'drv_quota', 'Quota Only', true),
  ('20900000-0000-0000-0000-000000000009', 'drv_none', 'Nothing Stored', true);

INSERT INTO public.drive_files (owner_id, bucket, path, name, size_bytes)
SELECT p.id, 'user_media', p.id || '/f.bin', 'f.bin', p.size
  FROM (VALUES
    ('20900000-0000-0000-0000-000000000001'::uuid, 7000),
    ('20900000-0000-0000-0000-000000000002'::uuid, 6000),
    ('20900000-0000-0000-0000-000000000003'::uuid, 5000),
    ('20900000-0000-0000-0000-000000000004'::uuid, 5000),
    ('20900000-0000-0000-0000-000000000005'::uuid, 3000),
    ('20900000-0000-0000-0000-000000000006'::uuid, 2000),
    ('20900000-0000-0000-0000-000000000007'::uuid, 1000)) AS p(id, size);

INSERT INTO public.drive_quota_overrides (profile_id, quota_bytes)
VALUES ('20900000-0000-0000-0000-000000000008', 1048576);

-- Emojis 209e0000-0000-0000-0000-0000000000NN; emoji files 209e0000-0000-4000-8000-0000000000NN.
INSERT INTO public.emojis (id, name, url, scope, domain, server_id) VALUES
  ('209e0000-0000-0000-0000-000000000001', 'blob', 'https://cdn.test/blob.png', 'instance', NULL, NULL),
  ('209e0000-0000-0000-0000-000000000002', 'remote_blob', 'https://remote.example/rb.png', 'instance', 'remote.example', NULL);

INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('emojis', '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000001.png', '{"size": "4321"}'),
  ('emojis', '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000002.gif', '{"size": "99"}'),
  ('emojis', '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000004.png', '{"size": "12"}'),
  ('emojis', '11111111-0000-0000-0000-000000000001/209e0000-0000-4000-8000-000000000003.png', '{"size": "10"}');

CREATE FUNCTION pg_temp.drive_page(p_search text, p_limit int, p_offset int)
RETURNS text[] LANGUAGE sql AS
  $$ SELECT COALESCE(array_agg(username ORDER BY o), '{}')
       FROM public.admin_drive_usage(p_search, p_limit, p_offset)
            WITH ORDINALITY t(profile_id, username, display_name, used_bytes, quota_bytes, ephemeral_bytes,
                              file_count, quota_override, total_count, o)
      WHERE username LIKE 'drv_%' $$;

-- Grants. ----------------------------------------------------------------------------
SELECT ok(to_regprocedure('public.admin_drive_usage(integer, uuid)') IS NULL,
          'the two-argument admin_drive_usage overload is gone');
SELECT ok(has_function_privilege('authenticated', 'public.admin_drive_usage(text, integer, integer, uuid)', 'EXECUTE'),
          'authenticated executes admin_drive_usage');
SELECT ok(NOT has_function_privilege('anon', 'public.admin_drive_usage(text, integer, integer, uuid)', 'EXECUTE'),
          'anon does not execute admin_drive_usage');
SELECT ok(has_function_privilege('authenticated', 'public.create_instance_emoji(text, text, text)', 'EXECUTE'),
          'authenticated executes create_instance_emoji');
SELECT ok(NOT has_function_privilege('anon', 'public.create_instance_emoji(text, text, text)', 'EXECUTE'),
          'anon does not execute create_instance_emoji');
SELECT ok(has_function_privilege('service_role', 'public.create_instance_emoji(text, text, text)', 'EXECUTE'),
          'service_role executes create_instance_emoji');

-- Non-admin. -------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT * FROM public.admin_drive_usage()$q$, '42501', NULL,
                 'a non-admin cannot list Drive usage');
SELECT throws_ok($q$SELECT public.create_instance_emoji('hijack',
                      '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000001.png',
                      'http://localhost:54321/storage/v1/object/public/emojis/00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000001.png')$q$,
                 '42501', NULL, 'a non-admin cannot create an instance emoji');
SELECT throws_ok($q$INSERT INTO storage.objects (bucket_id, name)
                    VALUES ('emojis', '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000009.png')$q$,
                 '42501', NULL, 'a non-admin cannot upload into the instance emoji folder');
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'emojis'
             AND name = '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000002.gif' RETURNING 1)
SELECT is(count(*)::int, 0, 'a non-admin cannot delete an instance emoji object') FROM d;
SELECT ok(EXISTS (SELECT 1 FROM public.emojis WHERE id = '209e0000-0000-0000-0000-000000000001'),
          'a regular user reads local instance emojis, as the picker does');
RESET ROLE;
SELECT tests.clear_authentication();

-- Drive usage as the admin. ------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT is(pg_temp.drive_page('drv_', 50, 0),
          ARRAY['drv_01', 'drv_02', 'drv_03', 'drv_04', 'drv_05', 'drv_06', 'drv_07', 'drv_quota'],
          'holders order by used bytes descending, ties by profile id; an override without files is listed');
SELECT ok(NOT ('drv_none' = ANY (pg_temp.drive_page('drv_', 50, 0))),
          'an account with no files and no override is not listed');
SELECT is(pg_temp.drive_page('drv_', 3, 0), ARRAY['drv_01', 'drv_02', 'drv_03'], 'page 1 of 3');
SELECT is(pg_temp.drive_page('drv_', 3, 3), ARRAY['drv_04', 'drv_05', 'drv_06'], 'page 2 continues past the tie');
SELECT is(pg_temp.drive_page('drv_', 3, 6), ARRAY['drv_07', 'drv_quota'], 'the last page is partial');
SELECT is(pg_temp.drive_page('drv_', 3, 9), '{}'::text[], 'past the end is empty');
SELECT is((SELECT DISTINCT total_count FROM public.admin_drive_usage('drv_', 3, 3)), 8::bigint,
          'total_count is the match count before paging');
SELECT is((SELECT count(DISTINCT total_count)::int FROM (
             SELECT total_count FROM public.admin_drive_usage('drv_', 3, 0)
             UNION ALL SELECT total_count FROM public.admin_drive_usage('drv_', 3, 6)) t), 1,
          'total_count is the same on every page');
SELECT is(pg_temp.drive_page('@DRV_0', 50, 0),
          ARRAY['drv_01', 'drv_02', 'drv_03', 'drv_04', 'drv_05', 'drv_06', 'drv_07'],
          'search ignores a leading @ and case');
SELECT is(pg_temp.drive_page(':blob:', 50, 0), ARRAY['drv_03'], 'search matches the display name');
SELECT is(pg_temp.drive_page('Drive', 2, 2), ARRAY['drv_03', 'drv_04'], 'search combines with paging');
SELECT is((SELECT DISTINCT total_count FROM public.admin_drive_usage('Drive', 2, 2)), 7::bigint,
          'total_count counts the searched matches');
SELECT is(pg_temp.drive_page('%', 50, 0), '{}'::text[], 'search treats % literally');
SELECT is((SELECT count(*)::int FROM public.admin_drive_usage('drv_', 0, 0)), 1, 'limit is at least 1');
SELECT is((SELECT used_bytes FROM public.admin_drive_usage('drv_01')), 7000::bigint,
          'used_bytes is drive_used_bytes');
SELECT is((SELECT quota_override FROM public.admin_drive_usage('drv_quota')), 1048576::bigint,
          'quota_override is the override');
SELECT is((SELECT username FROM public.admin_drive_usage(NULL, 50, 0, '20900000-0000-0000-0000-000000000009')),
          'drv_none', 'p_profile returns that account whatever it holds');

-- create_instance_emoji. ---------------------------------------------------------------
SELECT throws_ok($q$SELECT public.create_instance_emoji('mine',
                      '11111111-0000-0000-0000-000000000001/209e0000-0000-4000-8000-000000000003.png',
                      'http://localhost:54321/storage/v1/object/public/emojis/11111111-0000-0000-0000-000000000001/209e0000-0000-4000-8000-000000000003.png')$q$,
                 '22023', NULL, 'a file outside the instance folder is refused');
SELECT throws_ok($q$SELECT public.create_instance_emoji('blob',
                      '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000001.png',
                      'http://localhost:54321/storage/v1/object/public/emojis/elsewhere.png')$q$,
                 '22023', NULL, 'a url that is not the public URL of the path is refused');
SELECT throws_ok($q$SELECT public.create_instance_emoji('ghost',
                      '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-0000000000ff.png',
                      'http://localhost:54321/storage/v1/object/public/emojis/00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-0000000000ff.png')$q$,
                 '22023', NULL, 'a path with no stored object is refused');

SELECT lives_ok($q$SELECT public.create_instance_emoji('BLOB!',
                     '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000001.png',
                     'http://localhost:54321/storage/v1/object/public/emojis/00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000001.png')$q$,
                'the admin records an uploaded file');
SELECT is((SELECT ARRAY[name::text, scope, coalesce(domain, '-'), coalesce(server_id::text, '-'), uploader::text, file_size::text]
             FROM public.emojis WHERE url LIKE '%209e0000-0000-4000-8000-000000000001.png'),
          ARRAY['BLOB_1', 'instance', '-', '-', '11111111-0000-0000-0000-000000000001', '4321'],
          'a local instance emoji, sanitised name suffixed past blob case-insensitively, uploader and size');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.emojis WHERE name = 'remote_blob_1'),
          'a remote emoji of the same name does not force a suffix');
SELECT throws_ok($q$SELECT public.create_instance_emoji('again',
                      '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000001.png',
                      'http://localhost:54321/storage/v1/object/public/emojis/00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000001.png')$q$,
                 '23505', NULL, 'the same file twice is refused');
SELECT lives_ok($q$SELECT public.create_instance_emoji('remote_blob',
                     '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000002.gif',
                     'https://har.example/storage/v1/object/public/emojis/00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000002.gif')$q$,
                'a name used only on another domain is taken as is');
SELECT is((SELECT name::text FROM public.emojis WHERE url LIKE '%209e0000-0000-4000-8000-000000000002.gif'),
          'remote_blob', 'the name is unsuffixed');
SELECT lives_ok($q$INSERT INTO storage.objects (bucket_id, name)
                   VALUES ('emojis', '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000009.png')$q$,
                'the admin uploads into the instance emoji folder');
RESET ROLE;
SELECT tests.clear_authentication();

SELECT is((SELECT array_agg(action_type ORDER BY created_at) FROM public.admin_audit_log
            WHERE admin_id = '11111111-0000-0000-0000-000000000001' AND action_type = 'instance_emoji_create'),
          ARRAY['instance_emoji_create', 'instance_emoji_create'], 'each creation is audited');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT ok(EXISTS (SELECT 1 FROM public.emojis
                   WHERE scope = 'instance' AND domain IS NULL AND name = 'BLOB_1'),
          'a regular user reads the new instance emoji');
RESET ROLE;
SELECT tests.clear_authentication();

-- storage_origin. ----------------------------------------------------------------------
INSERT INTO public.instance_config (config_key, config_value) VALUES ('storage_origin', '"http://localhost:54321"')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.create_instance_emoji('pinned',
                      '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000004.png',
                      'https://har.example/storage/v1/object/public/emojis/00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000004.png')$q$,
                 '22023', 'EMOJI_URL: the url is not the public URL of 00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000004.png',
                 'with storage_origin set, a url on another origin is refused');
SELECT lives_ok($q$SELECT public.create_instance_emoji('pinned',
                     '00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000004.png',
                     'http://localhost:54321/storage/v1/object/public/emojis/00000000-0000-0000-0000-000000000000/209e0000-0000-4000-8000-000000000004.png')$q$,
                'and a url on storage_origin is accepted');
RESET ROLE;
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
