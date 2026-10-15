-- Custom emoji on soundboard sounds after 20261016100002_soundboard_custom_emoji.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Added:
--   carol      member of server_1 holding role sounds (MANAGE_EMOJIS)
--   Elsewhere  server owned by mallory; carol is not a member
--   emojis     party (server_1), far (Elsewhere), wave (instance), mine (carol's own),
--              bobs (bob's own)
--   sounds     Far (server_1, emoji far, inserted as service role), Plain (server_1, no emoji)

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(38);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1480000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol148@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1480000-0000-0000-0000-0000000000c1', 'f1480000-0000-0000-0000-0000000000a1', 'carol148', 'Carol', true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1480000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1481000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'sounds148', 3, 16);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f1480000-0000-0000-0000-0000000000c1', 'f1481000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.servers (id, name, owner) VALUES
  ('f1483000-0000-0000-0000-000000000001', 'Elsewhere148', '33333333-0000-0000-0000-000000000003');

INSERT INTO public.emojis (id, name, url, server_id, scope, uploader) VALUES
  ('e1480000-0000-0000-0000-000000000001', 'party', 'https://cdn.test/emojis/party.png',
   '55555555-0000-0000-0000-000000000005', 'server', '11111111-0000-0000-0000-000000000001'),
  ('e1480000-0000-0000-0000-000000000002', 'far', 'https://cdn.test/emojis/far.png',
   'f1483000-0000-0000-0000-000000000001', 'server', '33333333-0000-0000-0000-000000000003'),
  ('e1480000-0000-0000-0000-000000000003', 'wave', 'https://cdn.test/emojis/wave.png', NULL, 'instance', NULL),
  ('e1480000-0000-0000-0000-000000000004', 'mine', 'https://cdn.test/emojis/mine.png', NULL, 'user',
   'f1480000-0000-0000-0000-0000000000c1'),
  ('e1480000-0000-0000-0000-000000000005', 'bobs', 'https://cdn.test/emojis/bobs.png', NULL, 'user',
   '22222222-0000-0000-0000-000000000002');

-- Schema-only clones of live instances carry no bucket rows.
INSERT INTO storage.buckets (id, name, public) VALUES ('soundboard', 'soundboard', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'soundboard', '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-00000000000' || n || '.mp3', '{"size": 1000}'
  FROM generate_series(1, 9) n;

INSERT INTO public.server_sounds (id, server_id, name, emoji, emoji_id, volume, duration_ms, storage_path) VALUES
  ('b1480000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'Far', NULL,
   'e1480000-0000-0000-0000-000000000002', 1, 600,
   '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000001.mp3'),
  ('b1480000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'Plain', NULL, NULL, 0.5, 700,
   '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000002.mp3');

CREATE TEMP TABLE audit_seen ON COMMIT DROP AS
SELECT id FROM public.server_audit_log;

-- Column ----------------------------------------------------------------------------------------
SELECT col_type_is('public', 'server_sounds', 'emoji_id', 'uuid', 'server_sounds.emoji_id is a uuid');
SELECT col_is_null('public', 'server_sounds', 'emoji_id', 'and optional');
SELECT fk_ok('public', 'server_sounds', 'emoji_id', 'public', 'emojis', 'id', 'it references emojis');
SELECT is((SELECT confdeltype::text FROM pg_constraint WHERE conname = 'server_sounds_emoji_id_fkey'),
          'n', 'ON DELETE SET NULL');

SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, emoji, emoji_id, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Both', '🎉', 'e1480000-0000-0000-0000-000000000001', 600,
               '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000003.mp3')$q$,
    '23514', NULL, 'a sound has a unicode emoji or a custom one, not both');

-- Grants ----------------------------------------------------------------------------------------
SELECT ok(has_column_privilege('authenticated', 'public.server_sounds', 'emoji_id', 'UPDATE'),
          'clients update emoji_id');
SELECT ok(has_column_privilege('authenticated', 'public.server_sounds', 'emoji_id', 'INSERT'),
          'and insert it');
SELECT ok(NOT has_column_privilege('authenticated', 'public.server_sounds', 'storage_path', 'UPDATE'),
          'the file stays fixed');
SELECT ok(NOT has_column_privilege('anon', 'public.server_sounds', 'emoji_id', 'UPDATE'),
          'anon updates nothing');

-- Client inserts --------------------------------------------------------------------------------
SELECT tests.authenticate_as('f1480000-0000-0000-0000-0000000000a1');
SELECT lives_ok(
    $q$INSERT INTO public.server_sounds (id, server_id, name, emoji, emoji_id, volume, duration_ms, storage_path)
       VALUES ('b1480000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'Party', NULL,
               'e1480000-0000-0000-0000-000000000001', 0.8, 900,
               '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000003.mp3')$q$,
    'a sound manager adds a sound with an emoji of the server');
SELECT lives_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, emoji_id, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Wave', 'e1480000-0000-0000-0000-000000000003', 900,
               '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000004.mp3')$q$,
    'with an instance emoji');
SELECT lives_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, emoji_id, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Mine', 'e1480000-0000-0000-0000-000000000004', 900,
               '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000005.mp3')$q$,
    'with their own personal emoji');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, emoji_id, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Bobs', 'e1480000-0000-0000-0000-000000000005', 900,
               '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000006.mp3')$q$,
    '22023', NULL, 'not with another user''s personal emoji');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, emoji_id, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Far2', 'e1480000-0000-0000-0000-000000000002', 900,
               '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000006.mp3')$q$,
    '22023', NULL, 'nor with an emoji of a server they are not in');
SELECT throws_ok(
    $q$INSERT INTO public.server_sounds (server_id, name, emoji_id, duration_ms, storage_path)
       VALUES ('55555555-0000-0000-0000-000000000005', 'Ghost', 'e1480000-0000-0000-0000-0000000000ff', 900,
               '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000006.mp3')$q$,
    '22023', NULL, 'nor with an emoji that does not exist');
SELECT tests.clear_authentication();
SELECT is((SELECT changes FROM public.server_audit_log
            WHERE action = 'sound.create' AND target_id = 'b1480000-0000-0000-0000-000000000003'
              AND id NOT IN (SELECT id FROM audit_seen)),
          '{"name": {"new": "Party"}, "emoji_id": {"new": "e1480000-0000-0000-0000-000000000001"}, "volume": {"new": 0.80}}'::jsonb,
          'the add is audited with its emoji');

-- Client updates --------------------------------------------------------------------------------
SELECT tests.authenticate_as('f1480000-0000-0000-0000-0000000000a1');
SELECT lives_ok(
    $q$UPDATE public.server_sounds SET name = 'Far away' WHERE id = 'b1480000-0000-0000-0000-000000000001'$q$,
    'a manager edits a sound whose emoji is of a server they are not in');
SELECT throws_ok(
    $q$UPDATE public.server_sounds SET emoji_id = 'e1480000-0000-0000-0000-000000000002'
        WHERE id = 'b1480000-0000-0000-0000-000000000003'$q$,
    '22023', NULL, 'but cannot set that emoji on another sound');
SELECT lives_ok(
    $q$UPDATE public.server_sounds SET emoji = '🎉' WHERE id = 'b1480000-0000-0000-0000-000000000002'$q$,
    'a manager sets a unicode emoji');
SELECT throws_ok(
    $q$UPDATE public.server_sounds SET emoji_id = 'e1480000-0000-0000-0000-000000000001'
        WHERE id = 'b1480000-0000-0000-0000-000000000002'$q$,
    '23514', NULL, 'a custom emoji alongside it is refused');
SELECT lives_ok(
    $q$UPDATE public.server_sounds SET emoji = NULL, emoji_id = 'e1480000-0000-0000-0000-000000000001'
        WHERE id = 'b1480000-0000-0000-0000-000000000002'$q$,
    'replacing it with a custom emoji is not');
SELECT tests.clear_authentication();
SELECT is((SELECT changes FROM public.server_audit_log
            WHERE action = 'sound.update' AND target_id = 'b1480000-0000-0000-0000-000000000002'
              AND changes ? 'emoji_id'
              AND id NOT IN (SELECT id FROM audit_seen)),
          '{"emoji": {"old": "🎉"}, "emoji_id": {"new": "e1480000-0000-0000-0000-000000000001"}}'::jsonb,
          'the swap is audited');

-- bob: plain member.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is_empty(
    $q$UPDATE public.server_sounds SET emoji_id = NULL WHERE id = 'b1480000-0000-0000-0000-000000000002' RETURNING id$q$,
    'a plain member cannot change a sound''s emoji');
SELECT is((SELECT emoji_id FROM public.server_sounds WHERE id = 'b1480000-0000-0000-0000-000000000002'),
          'e1480000-0000-0000-0000-000000000001'::uuid, 'members read emoji_id');

-- Library and resolver --------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT name, emoji, emoji_id, emoji_name, emoji_url FROM public.list_soundboard_library()
        WHERE id IN ('b1480000-0000-0000-0000-000000000001', 'b1480000-0000-0000-0000-000000000002')
        ORDER BY name$q$,
    $q$VALUES ('Far away'::text, NULL::text, 'e1480000-0000-0000-0000-000000000002'::uuid, 'far'::text,
               'https://cdn.test/emojis/far.png'::text),
              ('Plain'::text, NULL::text, 'e1480000-0000-0000-0000-000000000001'::uuid, 'party'::text,
               'https://cdn.test/emojis/party.png'::text)$q$,
    'the library carries each sound''s custom emoji');
SELECT results_eq(
    $q$SELECT volume, duration_ms, storage_path FROM public.list_soundboard_library()
        WHERE id = 'b1480000-0000-0000-0000-000000000002'$q$,
    $q$VALUES (0.50::numeric, 700, '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000002.mp3'::text)$q$,
    'with what playing needs');

-- mallory is not a member of server_1.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT results_eq(
    $q$SELECT id, server_id, name, emoji, emoji_id, emoji_name, emoji_url, volume, duration_ms, storage_path
         FROM public.resolve_soundboard_sound('b1480000-0000-0000-0000-000000000002', 'f1483000-0000-0000-0000-000000000001')$q$,
    $q$VALUES ('b1480000-0000-0000-0000-000000000002'::uuid, '55555555-0000-0000-0000-000000000005'::uuid, 'Plain'::text,
               NULL::text, 'e1480000-0000-0000-0000-000000000001'::uuid, 'party'::text,
               'https://cdn.test/emojis/party.png'::text, 0.50::numeric, 700,
               '55555555-0000-0000-0000-000000000005/a1480000-0000-0000-0000-000000000002.mp3'::text)$q$,
    'the resolver carries the custom emoji');
SELECT tests.clear_authentication();
INSERT INTO public.server_settings (server_id, allow_cross_server_sounds)
VALUES ('55555555-0000-0000-0000-000000000005', false)
ON CONFLICT (server_id) DO UPDATE SET allow_cross_server_sounds = false;
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$SELECT id FROM public.resolve_soundboard_sound('b1480000-0000-0000-0000-000000000002', 'f1483000-0000-0000-0000-000000000001')$q$,
    'and still refuses an unshared server''s sound elsewhere');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT emoji_name FROM public.resolve_soundboard_sound('b1480000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005')),
          'party', 'which resolves for its members in its own server');
SELECT is_empty($q$SELECT id FROM public.list_soundboard_library()
                    WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
                'and leaves the library');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT * FROM public.list_soundboard_library()$$, '42501', NULL, 'anon has no library');
SELECT throws_ok(
    $$SELECT * FROM public.resolve_soundboard_sound('b1480000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005')$$,
    '42501', NULL, 'anon resolves nothing');
SELECT tests.clear_authentication();

SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'public.list_soundboard_library()'::regprocedure)
          AND (SELECT prosecdef FROM pg_proc WHERE oid = 'public.resolve_soundboard_sound(uuid, uuid)'::regprocedure),
          'both stay SECURITY DEFINER');
SELECT ok(has_function_privilege('authenticated', 'public.list_soundboard_library()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.resolve_soundboard_sound(uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.resolve_soundboard_sound(uuid, uuid)', 'EXECUTE'),
          'authenticated and service_role execute them');
SELECT ok(NOT has_function_privilege('authenticated', 'public.guard_server_sound_client_write()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.server_audit_sounds()', 'EXECUTE'),
          'the trigger functions stay internal');

-- Emoji deletion --------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$DELETE FROM public.emojis WHERE id = 'e1480000-0000-0000-0000-000000000001'$q$,
                'the server owner deletes an emoji sounds use');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*) FROM public.server_sounds
            WHERE id IN ('b1480000-0000-0000-0000-000000000002', 'b1480000-0000-0000-0000-000000000003')
              AND emoji_id IS NULL),
          2::bigint, 'the sounds lose it');
SELECT is((SELECT changes FROM public.server_audit_log
            WHERE action = 'sound.update' AND target_id = 'b1480000-0000-0000-0000-000000000003'
              AND actor_id = '11111111-0000-0000-0000-000000000001'
              AND id NOT IN (SELECT id FROM audit_seen)),
          '{"emoji_id": {"old": "e1480000-0000-0000-0000-000000000001"}}'::jsonb,
          'audited as an edit by the deleter');

SELECT * FROM finish();
ROLLBACK;
