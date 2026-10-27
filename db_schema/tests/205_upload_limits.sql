-- Upload limits from 20261031100001_upload_limits.sql.
--
--   alice    (aaaaaaaa / 11111111) no instance role: upload_limit_user_mb
--   bob      (bbbbbbbb / 22222222) instance moderator: upload_limit_moderator_mb
--   mallory  (cccccccc / 33333333) instance admin: upload_limit_admin_mb
--
-- storage.objects rows are written as storage-api writes them: completion with owner and
-- metadata.size; the permission test of a TUS creation with metadata NULL and the request's
-- upload-length in request.headers.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(51);

SELECT set_config('storage.allow_delete_query', 'true', true);
-- The fixtures' first profile is an instance admin.
UPDATE public.profiles SET is_admin = false, is_moderator = false WHERE id = '11111111-0000-0000-0000-000000000001';
UPDATE public.profiles SET is_admin = false, is_moderator = true WHERE id = '22222222-0000-0000-0000-000000000002';
UPDATE public.profiles SET is_admin = true, is_moderator = false WHERE id = '33333333-0000-0000-0000-000000000003';

-- Install. ------------------------------------------------------------------------------
SELECT results_eq(
    $$SELECT config_key, config_value FROM public.instance_config
       WHERE config_key IN ('upload_limit_user_mb', 'upload_limit_moderator_mb', 'upload_limit_admin_mb', 'upload_ceiling_bytes')
       ORDER BY config_key$$,
    $$VALUES ('upload_ceiling_bytes', '52428800'::jsonb), ('upload_limit_admin_mb', '50'::jsonb),
             ('upload_limit_moderator_mb', '50'::jsonb), ('upload_limit_user_mb', '50'::jsonb)$$,
    'every tier starts at the 50 MB the buckets held, the ceiling at 52428800 bytes');
SELECT results_eq(
    $$SELECT id, file_size_limit FROM storage.buckets WHERE id IN ('message_media', 'user_media', 'avatars') ORDER BY id$$,
    $$VALUES ('avatars', 5242880::bigint), ('message_media', NULL::bigint), ('user_media', NULL::bigint)$$,
    'message_media and user_media lose their bucket limit; avatars keep theirs');
SELECT has_trigger('storage', 'objects', 'storage_upload_limit', 'storage.objects carries the upload limit trigger');
SELECT ok(NOT has_function_privilege('anon', 'public.get_my_upload_limit()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.get_my_upload_limit()', 'EXECUTE'),
          'get_my_upload_limit: authenticated, not anon');
SELECT ok(NOT has_function_privilege('authenticated', 'public.upload_limit_bytes(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.storage_upload_limit()', 'EXECUTE'),
          'internal limit functions are not callable by clients');
SELECT ok(has_function_privilege('authenticated', 'public.admin_set_upload_limits(numeric, numeric, numeric)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.admin_set_upload_limit(uuid, bigint)', 'EXECUTE'),
          'admin RPCs: authenticated (checked inside), not anon');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_my_upload_limit(), 52428800::bigint, 'an account reads its effective limit');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT public.get_my_upload_limit()$$, '42501'::char(5), NULL, 'anon reads no limit');
SELECT tests.clear_authentication();
SELECT is(public.upload_limit_bytes(NULL), 52428800::bigint, 'an unknown profile has the default tier');

-- Tiers. --------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.admin_set_upload_limits(1, 10, 40)$$, '42501'::char(5), NULL,
                 'an account without a role cannot set the tiers');
SELECT throws_ok($$SELECT public.admin_upload_limits()$$, '42501'::char(5), NULL,
                 'nor read them');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.admin_set_upload_limits(1, 10, 40)$$, '42501'::char(5), NULL,
                 'a moderator cannot set the tiers');
SELECT is(public.admin_upload_limits() ->> 'can_edit', 'false', 'a moderator reads them, read-only');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$SELECT public.admin_set_upload_limits(1, 10, 60)$$, '22023'::char(5), NULL,
                 'an admin cannot set a tier above the ceiling');
SELECT throws_ok($$SELECT public.admin_set_upload_limits(-1, 10, 40)$$, '22023'::char(5), NULL,
                 'nor a negative one');
SELECT is(public.admin_set_upload_limits(1, 10, 40),
          jsonb_build_object('user_mb', 1, 'moderator_mb', 10, 'admin_mb', 40, 'ceiling_bytes', 52428800, 'can_edit', true),
          'an admin sets the three tiers');
SELECT is((SELECT count(*)::int FROM public.admin_audit_log
            WHERE action_type = 'config_change' AND target_id LIKE 'upload_limit_%'), 3,
          'each changed tier is logged');
SELECT tests.clear_authentication();
SELECT is(public.upload_limit_bytes('11111111-0000-0000-0000-000000000001'), 1048576::bigint, 'alice: the user tier');
SELECT is(public.upload_limit_bytes('22222222-0000-0000-0000-000000000002'), 10485760::bigint, 'bob: the moderator tier');
SELECT is(public.upload_limit_bytes('33333333-0000-0000-0000-000000000003'), 41943040::bigint, 'mallory: the admin tier');

-- Overrides. ----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.admin_set_upload_limit('11111111-0000-0000-0000-000000000001', 5242880)$$,
                 '42501'::char(5), NULL, 'a moderator cannot set an account''s limit');
SELECT is(public.admin_get_upload_limit('11111111-0000-0000-0000-000000000001') ->> 'effective_bytes', '1048576',
          'a moderator reads it');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.admin_set_upload_limit('11111111-0000-0000-0000-000000000001', 5242880)$$,
                 '42501'::char(5), NULL, 'an account cannot raise its own limit');
SELECT throws_ok($$SELECT public.admin_get_upload_limit('22222222-0000-0000-0000-000000000002')$$,
                 '42501'::char(5), NULL, 'nor read another''s');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.admin_set_upload_limit('11111111-0000-0000-0000-000000000001', 5242880),
          jsonb_build_object('override_bytes', 5242880, 'tier', 'user', 'tier_bytes', 1048576,
                             'effective_bytes', 5242880, 'ceiling_bytes', 52428800, 'can_edit', true),
          'an admin overrides one account''s limit');
SELECT throws_ok($$SELECT public.admin_set_upload_limit('11111111-0000-0000-0000-000000000001', 52428801)$$,
                 '22023'::char(5), NULL, 'not above the ceiling');
SELECT throws_ok($$SELECT public.admin_set_upload_limit('11111111-0000-0000-0000-000000000001', -1)$$,
                 '22023'::char(5), NULL, 'nor negative');
SELECT is((SELECT count(*)::int FROM public.admin_audit_log
            WHERE action_type = 'upload_limit' AND target_id = '11111111-0000-0000-0000-000000000001'), 1,
          'the override is logged');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_my_upload_limit(), 5242880::bigint, 'the override applies to the account');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.admin_set_upload_limit('11111111-0000-0000-0000-000000000001', NULL) ->> 'effective_bytes', '1048576',
          'clearing it returns the account to its tier');
SELECT is((SELECT count(*)::int FROM public.upload_limit_overrides), 0, 'and removes the row');

-- Ceiling. ------------------------------------------------------------------------------
SELECT throws_ok($$SELECT public.set_instance_config('upload_ceiling_bytes', '1073741824'::jsonb)$$,
                 '42501'::char(5), NULL, 'an admin cannot raise the ceiling through set_instance_config');
SELECT throws_ok($$SELECT public.batch_set_instance_config(ARRAY['upload_ceiling_bytes'], ARRAY['1073741824'::jsonb])$$,
                 '42501'::char(5), NULL, 'nor through batch_set_instance_config');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '20971520' WHERE config_key = 'upload_ceiling_bytes';
SELECT is(public.upload_ceiling_bytes(), 20971520::bigint, 'the operator, without a JWT, sets the ceiling');
SELECT is(public.upload_limit_bytes('33333333-0000-0000-0000-000000000003'), 20971520::bigint,
          'a tier above a lowered ceiling is clamped to it');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.admin_get_upload_limit('33333333-0000-0000-0000-000000000003') ->> 'tier_bytes', '41943040',
          'the admin panel still reads the configured tier');
SELECT tests.clear_authentication();

-- storage.objects. ----------------------------------------------------------------------
-- 2 MB: over alice's 1 MB, under bob's 10 MB and mallory's 20 MB (clamped).
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_like(
    $q$INSERT INTO storage.objects (bucket_id, name, owner, metadata)
       VALUES ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/big.bin',
               'aaaaaaaa-0000-0000-0000-000000000001', '{"size": 2097152}')$q$,
    'upload_limit_exceeded: 2097152 bytes, limit 1048576 bytes',
    'a stored object over the owner''s limit is refused');
-- Completion runs as the service role, past RLS.
SELECT tests.clear_authentication();
SELECT throws_like(
    $q$INSERT INTO storage.objects (bucket_id, name, owner, metadata)
       VALUES ('user_media', 'aaaaaaaa-0000-0000-0000-000000000001/posts/big.bin',
               'aaaaaaaa-0000-0000-0000-000000000001', '{"size": 2097152}')$q$,
    'upload_limit_exceeded:%', 'in user_media too, whatever the session role');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, owner, metadata)
       VALUES ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/small.bin',
               'aaaaaaaa-0000-0000-0000-000000000001', '{"size": 1048576}')$q$,
    'an object at the limit is stored');

-- TUS creation: storage-api's permission test carries no metadata.
SELECT set_config('request.headers', '{"upload-length": "2097152", "tus-resumable": "1.0.0"}', true);
SELECT throws_like(
    $q$INSERT INTO storage.objects (bucket_id, name, owner)
       VALUES ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/declared.bin', 'aaaaaaaa-0000-0000-0000-000000000001')$q$,
    'upload_limit_exceeded: 2097152 bytes, limit 1048576 bytes',
    'a TUS creation declaring more than the limit is refused before any byte');
SELECT set_config('request.headers', '{"upload-length": "4096"}', true);
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, owner)
       VALUES ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/declared-small.bin', 'aaaaaaaa-0000-0000-0000-000000000001')$q$,
    'one declaring less passes');
SELECT set_config('request.headers', 'not json', true);
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, owner)
       VALUES ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/no-length.bin', 'aaaaaaaa-0000-0000-0000-000000000001')$q$,
    'unreadable headers declare nothing; completion still checks the size');
SELECT set_config('request.headers', '', true);

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, owner, metadata)
       VALUES ('message_media', 'u/bbbbbbbb-0000-0000-0000-000000000002/big.bin',
               'bbbbbbbb-0000-0000-0000-000000000002', '{"size": 2097152}')$q$,
    'the moderator tier stores the same file');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, owner, metadata)
       VALUES ('message_media', 'u/cccccccc-0000-0000-0000-000000000003/big.bin',
               'cccccccc-0000-0000-0000-000000000003', '{"size": 2097152}')$q$,
    'so does the admin tier');
SELECT throws_like(
    $q$INSERT INTO storage.objects (bucket_id, name, owner, metadata)
       VALUES ('message_media', 'u/cccccccc-0000-0000-0000-000000000003/huge.bin',
               'cccccccc-0000-0000-0000-000000000003', '{"size": 31457280}')$q$,
    'upload_limit_exceeded: 31457280 bytes, limit 20971520 bytes', 'but not past the ceiling');
SELECT tests.clear_authentication();

-- An override admits what the tier refuses.
INSERT INTO public.upload_limit_overrides (profile_id, limit_bytes) VALUES ('11111111-0000-0000-0000-000000000001', 3145728);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, owner, metadata)
       VALUES ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/big.bin',
               'aaaaaaaa-0000-0000-0000-000000000001', '{"size": 2097152}')$q$,
    'an account with an override stores a file over its tier');
SELECT tests.clear_authentication();
DELETE FROM public.upload_limit_overrides;

-- Rows storage-api writes without an owner, and other buckets.
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, metadata)
       VALUES ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge/mirror.bin', '{"size": 31457280}')$q$,
    'an object without an owner has no per-account limit');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, owner, metadata)
       VALUES ('emojis', 'aaaaaaaa-0000-0000-0000-000000000001/e.png', 'aaaaaaaa-0000-0000-0000-000000000001', '{"size": 2097152}')$q$,
    'buckets with fixed limits are not subject to account limits');

-- Updates: a rename keeps the size and passes; new content over the limit does not.
SELECT lives_ok(
    $q$UPDATE storage.objects SET name = 'u/aaaaaaaa-0000-0000-0000-000000000001/renamed.bin'
        WHERE bucket_id = 'message_media' AND name = 'u/aaaaaaaa-0000-0000-0000-000000000001/big.bin'$q$,
    'a rename of an object over a lowered limit passes');
SELECT lives_ok(
    $q$UPDATE storage.objects SET version = 'v2'
        WHERE bucket_id = 'message_media' AND name = 'u/aaaaaaaa-0000-0000-0000-000000000001/renamed.bin'$q$,
    'a new version keeping the size (an upsert''s conflict branch, checked as its INSERT) passes');
SELECT throws_like(
    $q$UPDATE storage.objects SET metadata = '{"size": 4194304}'
        WHERE bucket_id = 'message_media' AND name = 'u/aaaaaaaa-0000-0000-0000-000000000001/small.bin'$q$,
    'upload_limit_exceeded:%', 'an overwrite with more bytes than the limit is refused');

SELECT * FROM finish();
ROLLBACK;
