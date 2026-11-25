-- 20261123300002_bridge_removed_assets.sql: a sound or sticker a manager deletes and an emoji an
-- instance admin purges are not copied again by the bridge sync.
--
--   server_1 (55555555-...05)  bridged by bot b1; alice owns it
-- Each import below is called without a file first, as bot-gateway does: 'invalid ... file' (or
-- 'invalid emoji url') is the answer that makes the gateway download the item from Discord.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(19);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('32600000-0000-0000-0000-0000000000b1', 'discord-bridge-326', 'Discord Bridge', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', '32600000-0000-0000-0000-0000000000b1', 'instance',
        '900000000000000326', '11111111-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.sound(p_did text, p_path text DEFAULT NULL)
RETURNS TABLE(status text, id uuid, name text, emoji text, emoji_id uuid, volume numeric, discord_sound_id text)
LANGUAGE sql AS $$
  SELECT * FROM public.bridge_import_server_sound('32600000-0000-0000-0000-0000000000b1',
    '55555555-0000-0000-0000-000000000005', p_did, 'horn', NULL, NULL, 1, false, p_path,
    CASE WHEN p_path IS NULL THEN NULL ELSE 1000 END) $$;
CREATE FUNCTION pg_temp.sticker(p_did text, p_update boolean DEFAULT false)
RETURNS TABLE(status text, id uuid, name text, description text, url text, discord_sticker_id text, removed boolean)
LANGUAGE sql AS $$
  SELECT * FROM public.bridge_import_server_sticker('32600000-0000-0000-0000-0000000000b1',
    '55555555-0000-0000-0000-000000000005', p_did, 'wave326', 'A wave', p_update) $$;
CREATE FUNCTION pg_temp.emoji(p_did text, p_name text, p_update boolean DEFAULT false)
RETURNS TABLE(status text, id uuid, name text, url text, discord_emoji_id text, removed boolean)
LANGUAGE sql AS $$
  SELECT * FROM public.bridge_import_server_emoji('32600000-0000-0000-0000-0000000000b1',
    '55555555-0000-0000-0000-000000000005', p_did, p_name, NULL, p_update) $$;

SELECT ok(NOT has_table_privilege('authenticated', 'public.bridge_removed_assets', 'SELECT')
      AND NOT has_table_privilege('anon', 'public.bridge_removed_assets', 'SELECT')
      AND has_table_privilege('service_role', 'public.bridge_removed_assets', 'SELECT'),
  'only the service role reads the records');

-- Sounds -----------------------------------------------------------------------------------------------
INSERT INTO public.server_sounds (id, server_id, name, volume, duration_ms, storage_path, discord_sound_id) VALUES
  ('326b0000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'horn', 1, 1000,
   '55555555-0000-0000-0000-000000000005/326a0000-0000-0000-0000-0000000000f1.mp3', '3260001'),
  ('326b0000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'bell', 1, 1000,
   '55555555-0000-0000-0000-000000000005/326a0000-0000-0000-0000-0000000000f2.mp3', '3260002');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
DELETE FROM public.server_sounds WHERE id = '326b0000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is((SELECT (kind, platform, name)::text FROM public.bridge_removed_assets
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND remote_id = '3260001'),
          '(sound,discord,horn)', 'a manager''s delete of a bridged sound is recorded');
SELECT throws_ok($$SELECT * FROM pg_temp.sound('3260001')$$,
  '42501', 'SOUND_REMOVED: a person deleted this sound on Harmony; the bridge does not copy it again',
  'the bridge is refused before it downloads the sound again');
SELECT throws_ok($$SELECT * FROM pg_temp.sound('3260001',
                     '55555555-0000-0000-0000-000000000005/326a0000-0000-0000-0000-0000000000f9.mp3')$$,
  '42501', 'SOUND_REMOVED: a person deleted this sound on Harmony; the bridge does not copy it again',
  'and with a stored clip');

SELECT is(public.bridge_delete_server_sound('32600000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '326b0000-0000-0000-0000-000000000002'),
  '55555555-0000-0000-0000-000000000005/326a0000-0000-0000-0000-0000000000f2.mp3', 'the bridge deletes its own sound');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.bridge_removed_assets WHERE remote_id = '3260002'),
  'which leaves no record');
SELECT throws_ok($$SELECT * FROM pg_temp.sound('3260002')$$, '22023', 'invalid sound file',
  'so the sync may copy it again');

-- Stickers ---------------------------------------------------------------------------------------------
INSERT INTO public.stickers (id, scope, server_id, name, description, path, url, mime_type, file_size,
                             width, height, discord_sticker_id) VALUES
  ('326c0000-0000-4000-8000-000000000001', 'server', '55555555-0000-0000-0000-000000000005', 'wave326', 'A wave',
   'server/55555555-0000-0000-0000-000000000005/326c0000-0000-4000-8000-000000000001.png',
   'https://db.test/storage/v1/object/public/stickers/server/55555555-0000-0000-0000-000000000005/326c0000-0000-4000-8000-000000000001.png',
   'image/png', 1000, 64, 64, '3260011');
SELECT is((SELECT status FROM pg_temp.sticker('3260011')), 'existing', 'an imported sticker answers existing');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.delete_sticker('326c0000-0000-4000-8000-000000000001'),
  'server/55555555-0000-0000-0000-000000000005/326c0000-0000-4000-8000-000000000001.png', 'the owner deletes it');
SELECT tests.clear_authentication();
SELECT is((SELECT (kind, name)::text FROM public.bridge_removed_assets WHERE remote_id = '3260011'),
          '(sticker,wave326)', 'the delete is recorded');
SELECT throws_ok($$SELECT * FROM pg_temp.sticker('3260011')$$,
  '42501', 'STICKER_REMOVED: a person deleted this sticker on Harmony; the bridge does not copy it again',
  'the bridge is refused before it downloads the sticker again');
SELECT throws_ok($$SELECT * FROM pg_temp.sticker('3260011', true)$$,
  '42501', 'STICKER_REMOVED: a person deleted this sticker on Harmony; the bridge does not copy it again',
  'and when it asks to restore it');

-- Emoji ------------------------------------------------------------------------------------------------
INSERT INTO public.emojis (id, name, url, server_id, scope, discord_emoji_id) VALUES
  ('326e0000-0000-0000-0000-000000000001', 'rude326',
   'https://db.test/storage/v1/object/public/emojis/55555555-0000-0000-0000-000000000005/discord/3260021.png',
   '55555555-0000-0000-0000-000000000005', 'server', '3260021');
SELECT public.admin_purge_emoji('326e0000-0000-0000-0000-000000000001');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.emojis WHERE id = '326e0000-0000-0000-0000-000000000001'),
  'an instance admin purges a bridged emoji');
SELECT is((SELECT (kind, name)::text FROM public.bridge_removed_assets WHERE remote_id = '3260021'),
          '(emoji,rude326)', 'the purge is recorded');
SELECT throws_ok($$SELECT * FROM pg_temp.emoji('3260021', 'rude326')$$,
  '42501', 'EMOJI_REMOVED: an instance admin purged this emoji; the bridge does not copy it again',
  'the bridge is refused before it downloads the emoji again');
SELECT throws_ok($$SELECT * FROM pg_temp.emoji('3260021', 'rude326', true)$$,
  '42501', 'EMOJI_REMOVED: an instance admin purged this emoji; the bridge does not copy it again',
  'and when it asks to restore it');
INSERT INTO public.emojis (id, name, url, server_id, scope, uploader) VALUES
  ('326e0000-0000-0000-0000-000000000002', 'rude326',
   'https://db.test/storage/v1/object/public/emojis/55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001/r.png',
   '55555555-0000-0000-0000-000000000005', 'server', '11111111-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT * FROM pg_temp.emoji('3260021', 'rude326')$$,
  '42501', 'EMOJI_REMOVED: an instance admin purged this emoji; the bridge does not copy it again',
  'nor links a member''s emoji of the same name to it');
SELECT is((SELECT discord_emoji_id FROM public.emojis WHERE id = '326e0000-0000-0000-0000-000000000002'), NULL,
  'which keeps no Discord link');

-- A server's deletion removes its records --------------------------------------------------------------
DELETE FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT count(*)::int FROM public.bridge_removed_assets), 0, 'records go with their server');

SELECT * FROM finish();
ROLLBACK;
