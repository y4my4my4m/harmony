-- 20261111900001_bridge_server_sounds.sql: the Discord bridge bot of a server imports, updates
-- and deletes Discord soundboard sounds.
--
--   server_1 (55555555-...05)  bridged by bot b1
--   bot b2                     bridge bot of no server
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(31);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('25000000-0000-0000-0000-0000000000b1', 'discord-bridge-250', 'Discord Bridge', '11111111-0000-0000-0000-000000000001', 'bridge'),
  ('25000000-0000-0000-0000-0000000000b2', 'other-bot-250', 'Other', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', '25000000-0000-0000-0000-0000000000b1', 'instance',
        '900000000000000250', '11111111-0000-0000-0000-000000000001');

INSERT INTO public.emojis (id, name, url, server_id, scope) VALUES
  ('25e00000-0000-0000-0000-000000000001', 'Honk250', 'https://cdn.test/honk.png',
   '55555555-0000-0000-0000-000000000005', 'server');
INSERT INTO public.servers (id, name, owner)
VALUES ('f2680000-0000-0000-0000-000000000002', 'Server 268', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.server_sounds (id, server_id, name, volume, duration_ms, storage_path, discord_sound_id) VALUES
  ('268b0000-0000-0000-0000-000000000001', 'f2680000-0000-0000-0000-000000000002', 'foreign', 1, 1000,
   'f2680000-0000-0000-0000-000000000002/268a0000-0000-0000-0000-0000000000f1.mp3', '7001');

CREATE TEMP TABLE r (status text, id uuid, name text, emoji text, emoji_id uuid, volume numeric, discord_sound_id text);
GRANT ALL ON r TO PUBLIC;

-- Grants. -----------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated',
  'public.bridge_import_server_sound(uuid, uuid, text, text, text, uuid, numeric, boolean, text, integer)', 'EXECUTE'),
  'authenticated cannot import');
SELECT ok(NOT has_function_privilege('anon',
  'public.bridge_import_server_sound(uuid, uuid, text, text, text, uuid, numeric, boolean, text, integer)', 'EXECUTE'),
  'anon cannot import');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.bridge_delete_server_sound(uuid, uuid, uuid)', 'EXECUTE'), 'authenticated cannot delete');
SELECT ok(NOT has_function_privilege('anon',
  'public.bridge_delete_server_sound(uuid, uuid, uuid)', 'EXECUTE'), 'anon cannot delete');

-- Authority. --------------------------------------------------------------------------------------
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b2',
  '55555555-0000-0000-0000-000000000005', '1001', 'airhorn', NULL, NULL, 1, false,
  '55555555-0000-0000-0000-000000000005/268a0000-0000-0000-0000-000000000001.mp3', 1200)$$,
  '42501', NULL, 'a bot that does not bridge the server cannot import');
SELECT throws_ok($$SELECT public.bridge_delete_server_sound('25000000-0000-0000-0000-0000000000b2',
  '55555555-0000-0000-0000-000000000005', gen_random_uuid())$$,
  '42501', NULL, 'a bot that does not bridge the server cannot delete');

-- A new Discord sound needs a stored clip. -------------------------------------------------------
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1001', 'airhorn', NULL, NULL, 1, false, NULL, NULL)$$,
  '22023', 'invalid sound file', 'a new Discord sound without a stored clip asks for the file');

-- Create, then rerun. -----------------------------------------------------------------------------
INSERT INTO r SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1001', 'airhorn', NULL, NULL, 0.5, false,
  '55555555-0000-0000-0000-000000000005/268a0000-0000-0000-0000-000000000001.mp3', 1200);
SELECT is((SELECT status FROM r), 'created', 'a new Discord sound is created');
SELECT ok((SELECT created_by IS NULL FROM public.server_sounds WHERE id = (SELECT id FROM r)),
  'created_by stays NULL');
SELECT is((SELECT discord_sound_id FROM public.server_sounds WHERE id = (SELECT id FROM r)), '1001',
  'the Discord sound id is stored');

TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1001', 'airhorn', NULL, NULL, 0.5, false, NULL, NULL);
SELECT is((SELECT status FROM r), 'existing', 'importing the same Discord sound again returns the row');

TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1001', 'honk', NULL, NULL, 0.5, true, NULL, NULL);
SELECT is((SELECT status FROM r), 'updated', 'a changed name with p_update is updated');
SELECT is((SELECT name FROM public.server_sounds WHERE discord_sound_id = '1001'), 'honk', 'the name changed');

TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1001', 'beep', NULL, NULL, 0.5, false, NULL, NULL);
SELECT is((SELECT status FROM r), 'existing', 'a changed name without p_update is left alone');
SELECT is((SELECT name FROM public.server_sounds WHERE discord_sound_id = '1001'), 'honk', 'the name is unchanged');

-- Custom emoji, volume-only updates, no-op updates. -----------------------------------------------
TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1003', 'withemoji', NULL, '25e00000-0000-0000-0000-000000000001', 0.5, false,
  '55555555-0000-0000-0000-000000000005/268a0000-0000-0000-0000-000000000003.mp3', 1200);
SELECT is((SELECT status FROM r), 'created', 'a sound with a server custom emoji is created');
SELECT is((SELECT emoji_id FROM public.server_sounds WHERE discord_sound_id = '1003'),
  '25e00000-0000-0000-0000-000000000001'::uuid, 'the emoji id is stored');

TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1003', 'withemoji', NULL, '25e00000-0000-0000-0000-000000000001', 0.5, true, NULL, NULL);
SELECT is((SELECT status FROM r), 'existing', 'identical values with p_update (volume 0.5 vs stored 0.50) are existing');

TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1003', 'withemoji', NULL, '25e00000-0000-0000-0000-000000000001', 0.75, true, NULL, NULL);
SELECT is((SELECT status FROM r), 'updated', 'a volume-only change with p_update is updated');
SELECT is((SELECT volume FROM public.server_sounds WHERE discord_sound_id = '1003'), 0.75::numeric, 'the volume changed');

-- Validation. -------------------------------------------------------------------------------------
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1002', 'both', 'x', gen_random_uuid(), 1, false,
  '55555555-0000-0000-0000-000000000005/268a0000-0000-0000-0000-000000000002.mp3', 1200)$$,
  '22023', 'invalid sound emoji', 'emoji and emoji_id together are refused');
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1002', 'loud', NULL, NULL, 1.5, false,
  '55555555-0000-0000-0000-000000000005/268a0000-0000-0000-0000-000000000002.mp3', 1200)$$,
  '22023', 'invalid sound volume', 'a volume above 1 is refused');
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1002', '  ', NULL, NULL, 1, false,
  '55555555-0000-0000-0000-000000000005/268a0000-0000-0000-0000-000000000002.mp3', 1200)$$,
  '22023', 'invalid sound name', 'a blank name is refused');
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1002', 'long', NULL, NULL, 1, false,
  '55555555-0000-0000-0000-000000000005/268a0000-0000-0000-0000-000000000002.mp3', 6000)$$,
  '22023', 'invalid sound file', 'a clip longer than 5.2 s is refused');
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1002', 'ghost', NULL, gen_random_uuid(), 1, false,
  '55555555-0000-0000-0000-000000000005/268a0000-0000-0000-0000-000000000002.mp3', 1200)$$,
  '22023', 'invalid sound emoji', 'an unknown custom emoji is refused');

SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '1002', 'dashes', NULL, NULL, 1, false,
  '55555555-0000-0000-0000-000000000005/------------------------------------.mp3', 1200)$$,
  '22023', 'invalid sound file', 'a malformed storage path is refused');

-- Delete. -----------------------------------------------------------------------------------------
SELECT is((SELECT public.bridge_delete_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', (SELECT id FROM public.server_sounds WHERE discord_sound_id = '1001'))),
  '55555555-0000-0000-0000-000000000005/268a0000-0000-0000-0000-000000000001.mp3',
  'delete returns the storage path');
SELECT is((SELECT count(*)::int FROM public.server_sounds WHERE discord_sound_id = '1001'), 0, 'the row is gone');
SELECT is((SELECT public.bridge_delete_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', gen_random_uuid())), NULL,
  'deleting an unknown sound returns NULL');

-- A bridge bot cannot delete a sound of another server. ------------------------------------------
SELECT is((SELECT public.bridge_delete_server_sound('25000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '268b0000-0000-0000-0000-000000000001')), NULL,
  'deleting a sound of another server returns NULL');
SELECT is((SELECT count(*)::int FROM public.server_sounds WHERE id = '268b0000-0000-0000-0000-000000000001'), 1,
  'the other server''s sound still exists');

SELECT * FROM finish();
ROLLBACK;
