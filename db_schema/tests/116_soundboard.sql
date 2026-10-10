-- Soundboard after 20261011300001_soundboard.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Added:
--   carol   member holding role sounds (MANAGE_EMOJIS)
--   dave    member without roles
--   #voice  voice channel; @everyone denies USE_SOUNDBOARD there, role sounds allows it
--   remote  a remote server copy owned by alice

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(47);
-- Newer storage schemas refuse direct DELETE unless this is set, as storage-api does;
-- RLS still applies.
SELECT set_config('storage.allow_delete_query', 'true', true);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1160000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol116@test.local'),
  ('f1160000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave116@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1160000-0000-0000-0000-0000000000c1', 'f1160000-0000-0000-0000-0000000000a1', 'carol116', 'Carol', true),
  ('f1160000-0000-0000-0000-0000000000c2', 'f1160000-0000-0000-0000-0000000000a2', 'dave116', 'Dave', true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1160000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1160000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1161000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'sounds', 3, 16);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f1160000-0000-0000-0000-0000000000c1', 'f1161000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1162000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'voice116', 2);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('f1162000-0000-0000-0000-000000000001', 'role',
   (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default),
   0, 1073741824),
  ('f1162000-0000-0000-0000-000000000001', 'role', 'f1161000-0000-0000-0000-000000000001', 1073741824, 0);
INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('f1163000-0000-0000-0000-000000000001', 'Remote116', '11111111-0000-0000-0000-000000000001', false);

-- Schema-only clones of live instances carry no bucket rows.
INSERT INTO storage.buckets (id, name, public) VALUES ('soundboard', 'soundboard', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('soundboard', '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000001.mp3', '{"size": 20000}'),
  ('soundboard', '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000002.ogg', '{"size": 30000}'),
  ('soundboard', '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000003.wav', '{"size": 600000}'),
  ('soundboard', '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000004.wav', '{"size": 1000}');

CREATE TEMP TABLE audit_seen ON COMMIT DROP AS
SELECT id FROM public.server_audit_log;

-- Permission bits -----------------------------------------------------------------------------
SELECT is(array_length(public.permission_bit_names(), 1), 31, 'the bit map names 31 permissions');
SELECT is((public.permission_bit_names())[31], 'USE_SOUNDBOARD', 'USE_SOUNDBOARD is bit 30');

INSERT INTO public.servers (id, name, owner) VALUES
  ('f1163000-0000-0000-0000-000000000002', 'Fresh116', '22222222-0000-0000-0000-000000000002');
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f1163000-0000-0000-0000-000000000002' AND is_default),
          1196388610::bigint, 'a new server''s @everyone holds the defaults and USE_SOUNDBOARD');
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default) & 1073741824,
          1073741824::bigint, 'the fixture server''s @everyone holds USE_SOUNDBOARD');

SELECT is(public.get_user_permissions('f1160000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005') ->> 'USE_SOUNDBOARD',
          'true', 'a member holds USE_SOUNDBOARD through @everyone');
SELECT is(public.get_user_permissions('f1160000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005',
                                      'f1162000-0000-0000-0000-000000000001') ->> 'USE_SOUNDBOARD',
          'false', 'an @everyone channel deny removes it in that channel');
SELECT is(public.get_user_permissions('f1160000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005',
                                      'f1162000-0000-0000-0000-000000000001') ->> 'USE_SOUNDBOARD',
          'true', 'a role channel allow restores it');
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005',
                                      'f1162000-0000-0000-0000-000000000001') ->> 'USE_SOUNDBOARD',
          'true', 'the owner holds it everywhere');
SELECT is((SELECT count(*) FROM jsonb_object_keys(
              public.get_user_permissions('f1160000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005'))),
          31::bigint, 'get_user_permissions answers every named bit');
SELECT ok(public.has_permission('f1160000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'MANAGE_EMOJIS'),
          'unchanged bits still resolve');
SELECT is(public.server_template_bits('"1073741824"'::jsonb, 'p'), 1073741824::bigint,
          'templates carry USE_SOUNDBOARD');
SELECT throws_ok($$SELECT public.server_template_bits('"2147483648"'::jsonb, 'p')$$,
                 '22023', NULL, 'templates refuse the bit past it');

-- Helpers -------------------------------------------------------------------------------------
SELECT is(public.soundboard_object_server('55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000001.mp3'),
          '55555555-0000-0000-0000-000000000005'::uuid, 'the server folder of a sound object');
SELECT is(public.soundboard_object_server('55555555-0000-0000-0000-000000000005/../x.mp3'), NULL::uuid,
          'any other name names no server');
SELECT is(public.soundboard_object_server('not-a-uuid/a1160000-0000-0000-0000-000000000001.mp3'), NULL::uuid,
          'nor does a non-uuid folder');

-- Table writes --------------------------------------------------------------------------------
SELECT tests.authenticate_as('f1160000-0000-0000-0000-0000000000a1');
SELECT ok(public.can_manage_server_sounds('55555555-0000-0000-0000-000000000005'), 'MANAGE_EMOJIS manages sounds');

SELECT lives_ok(
    $q$INSERT INTO public.server_sounds (id, server_id, name, emoji, volume, duration_ms, storage_path, created_by)
       VALUES ('b1160000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'Airhorn', '📯', 0.8, 2100,
               '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000001.mp3',
               '11111111-0000-0000-0000-000000000001')$q$,
    'a sound manager adds a sound');
SELECT tests.clear_authentication();
SELECT is((SELECT created_by FROM public.server_sounds WHERE id = 'b1160000-0000-0000-0000-000000000001'),
          'f1160000-0000-0000-0000-0000000000c1'::uuid, 'created_by is the caller');
SELECT is((SELECT count(*) FROM public.server_audit_log
            WHERE action = 'sound.create' AND target_id = 'b1160000-0000-0000-0000-000000000001'
              AND actor_id = 'f1160000-0000-0000-0000-0000000000c1'
              AND id NOT IN (SELECT id FROM audit_seen)), 1::bigint, 'the add is audited');

SELECT tests.authenticate_as('f1160000-0000-0000-0000-0000000000a1');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Ghost', 1000,
               '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-0000000000ff.mp3')$q$,
    '22023', NULL, 'a sound must name an uploaded file');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Huge', 1000,
               '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000003.wav')$q$,
    '22023', NULL, 'a file over 512 KB is refused');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Long', 5201,
               '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000004.wav')$q$,
    '23514', NULL, 'a clip over 5.2 s is refused');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'A sound name that runs far too long', 1000,
               '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000004.wav')$q$,
    '23514', NULL, 'a name over 32 characters is refused');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, volume, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Loud', 1.5, 1000,
               '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000004.wav')$q$,
    '23514', NULL, 'a volume over 1 is refused');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, duration_ms, storage_path)
       VALUES ('f1163000-0000-0000-0000-000000000002', 'Elsewhere', 1000,
               '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000004.wav')$q$,
    '42501', NULL, 'not for a server they cannot manage');

SELECT lives_ok(
    $q$UPDATE public.server_sounds SET name = 'Air horn', emoji = NULL, volume = 0.5
        WHERE id = 'b1160000-0000-0000-0000-000000000001'$q$,
    'a sound manager renames a sound and changes its volume');
SELECT throws_ok(
    $q$UPDATE public.server_sounds
          SET storage_path = '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000002.ogg'
        WHERE id = 'b1160000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'the file of a sound is fixed');
SELECT tests.clear_authentication();
SELECT is((SELECT changes FROM public.server_audit_log
            WHERE action = 'sound.update' AND target_id = 'b1160000-0000-0000-0000-000000000001'
              AND id NOT IN (SELECT id FROM audit_seen)),
          '{"name": {"new": "Air horn", "old": "Airhorn"}, "emoji": {"old": "📯"}, "volume": {"new": 0.50, "old": 0.80}}'::jsonb,
          'the edit is audited with its changes');

-- dave: plain member.
SELECT tests.authenticate_as('f1160000-0000-0000-0000-0000000000a2');
SELECT ok(NOT public.can_manage_server_sounds('55555555-0000-0000-0000-000000000005'), 'a plain member manages nothing');
SELECT is((SELECT name FROM public.server_sounds WHERE id = 'b1160000-0000-0000-0000-000000000001'),
          'Air horn', 'members read the server''s sounds');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Mine', 1000,
               '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000004.wav')$q$,
    '42501', NULL, 'a plain member cannot add sounds');
SELECT is_empty(
    $q$UPDATE public.server_sounds SET name = 'Mine' WHERE id = 'b1160000-0000-0000-0000-000000000001' RETURNING id$q$,
    'nor rename them');
SELECT is_empty(
    $q$DELETE FROM public.server_sounds WHERE id = 'b1160000-0000-0000-0000-000000000001' RETURNING id$q$,
    'nor delete them');

-- mallory: not a member.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty($q$SELECT id FROM public.server_sounds WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
                'a non-member reads no sounds');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT id FROM public.server_sounds$q$, '42501', NULL, 'anon reads nothing');

-- alice: owner. A remote server copy has no sounds.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(NOT public.can_manage_server_sounds('f1163000-0000-0000-0000-000000000001'),
          'a remote server copy''s owner manages no sounds');
SELECT isnt_empty(
    $q$DELETE FROM public.server_sounds WHERE id = 'b1160000-0000-0000-0000-000000000001' RETURNING id$q$,
    'the owner deletes a sound');

-- Storage -------------------------------------------------------------------------------------
SELECT tests.authenticate_as('f1160000-0000-0000-0000-0000000000a1');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('soundboard', '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000010.ogg')$q$,
    'a sound manager uploads under the server folder');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('soundboard', 'f1163000-0000-0000-0000-000000000002/a1160000-0000-0000-0000-000000000011.ogg')$q$,
    '42501', NULL, 'not under another server''s folder');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('soundboard', '55555555-0000-0000-0000-000000000005/clip.exe')$q$,
    '42501', NULL, 'a name of another shape is refused, not an error');
SELECT isnt_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'soundboard'
        AND name = '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000010.ogg' RETURNING id$q$,
    'a sound manager deletes a sound file');

SELECT tests.authenticate_as('f1160000-0000-0000-0000-0000000000a2');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('soundboard', '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000012.ogg')$q$,
    '42501', NULL, 'a plain member cannot upload sound files');
SELECT is_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'soundboard'
        AND name = '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000002.ogg' RETURNING id$q$,
    'nor delete them');
SELECT isnt_empty(
    $q$SELECT id FROM storage.objects WHERE bucket_id = 'soundboard'
        AND name = '55555555-0000-0000-0000-000000000005/a1160000-0000-0000-0000-000000000002.ogg'$q$,
    'sound files are readable');

SELECT tests.clear_authentication();
SELECT is((SELECT file_size_limit FROM storage.buckets WHERE id = 'soundboard'), 524288::bigint,
          'the bucket holds files up to 512 KB');

-- Cap -----------------------------------------------------------------------------------------
INSERT INTO public.server_sounds (server_id, name, duration_ms, storage_path)
SELECT '55555555-0000-0000-0000-000000000005', 'Clip ' || g, 1000,
       '55555555-0000-0000-0000-000000000005/' || lpad(to_hex(g), 8, '0') || '-0000-0000-0000-000000000000.mp3'
  FROM generate_series(1, 48) g;
SELECT is((SELECT count(*) FROM public.server_sounds WHERE server_id = '55555555-0000-0000-0000-000000000005'),
          48::bigint, 'a server holds 48 sounds');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'One more', 1000,
               '55555555-0000-0000-0000-000000000005/000000ff-0000-0000-0000-000000000000.mp3')$q$,
    '23514', NULL, 'and no 49th');

SELECT * FROM finish();
ROLLBACK;
