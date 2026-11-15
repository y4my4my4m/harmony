-- 20261112500001_bridge_sync_guards.sql: the Discord bridge bot deletes, removes and retires only
-- what it imported, restores only emoji it removed, and its removals keep a bounded number of rows.
--
--   server_1 (55555555-...05)  bridged by bot b1; alice owns it, bob is a member
--   bot b2                     bridge bot of no server
--
-- Every statement of this file shares one now(); a removal "earlier" or "later" is written
-- into deleted_at by hand.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(66);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('27900000-0000-0000-0000-0000000000b1', 'discord-bridge-279', 'Discord Bridge', '11111111-0000-0000-0000-000000000001', 'bridge'),
  ('27900000-0000-0000-0000-0000000000b2', 'other-bot-279', 'Other', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', '27900000-0000-0000-0000-0000000000b1', 'instance',
        '900000000000000279', '11111111-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.stored(p_discord_id text, p_ext text DEFAULT 'png') RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'https://db.test/storage/v1/object/public/emojis/55555555-0000-0000-0000-000000000005/discord/'
            || p_discord_id || '.' || p_ext $$;
CREATE FUNCTION pg_temp.imp(p_did text, p_name text, p_url text DEFAULT NULL, p_update boolean DEFAULT false)
RETURNS TABLE(status text, id uuid, name text, url text, discord_emoji_id text, removed boolean)
LANGUAGE sql AS $$
  SELECT * FROM public.bridge_import_server_emoji('27900000-0000-0000-0000-0000000000b1',
    '55555555-0000-0000-0000-000000000005', p_did, p_name, p_url, p_update) $$;
CREATE FUNCTION pg_temp.remove(p_id uuid) RETURNS text LANGUAGE sql AS $$
  SELECT public.bridge_remove_server_emoji('27900000-0000-0000-0000-0000000000b1',
    '55555555-0000-0000-0000-000000000005', p_id) $$;

-- Grants. -----------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('service_role', 'public.bridge_require_server_bot(uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.bridge_require_server_bot(uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.bridge_require_server_bot(uuid, uuid)', 'EXECUTE'),
  'no API role executes bridge_require_server_bot');
SELECT lives_ok($$SELECT public.bridge_require_server_bot('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005')$$, 'the bridge bot of the server passes');
SELECT throws_ok($$SELECT public.bridge_require_server_bot('27900000-0000-0000-0000-0000000000b2',
  '55555555-0000-0000-0000-000000000005')$$,
  '42501', 'bot is not the Discord bridge of this server', 'a bridge bot of no server is refused');
SELECT is((SELECT count(*)::int FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.prosrc LIKE '%FROM public.discord_bridges b WHERE b.server_id = p_server_id AND b.bot_id = p_bot_id%'),
          1, 'one function holds the check; the sync functions call it');
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_evict_removed_emojis(uuid, uuid, uuid[])', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.bridge_evict_removed_emojis(uuid, uuid, uuid[])', 'EXECUTE'),
  'clients cannot evict emoji');
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_evict_retired_stickers(uuid, uuid, uuid[])', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.bridge_evict_retired_stickers(uuid, uuid, uuid[])', 'EXECUTE'),
  'clients cannot evict stickers');
SELECT ok(NOT has_function_privilege('authenticated', 'public.emoji_is_bridge_import(public.emojis)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.emoji_is_bridge_import(public.emojis)', 'EXECUTE'),
  'clients cannot call emoji_is_bridge_import');
SELECT ok(has_function_privilege('service_role', 'public.bridge_evict_removed_emojis(uuid, uuid, uuid[])', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.bridge_evict_retired_stickers(uuid, uuid, uuid[])', 'EXECUTE'),
  'service_role evicts');

-- Sounds. -----------------------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('soundboard', 'soundboard', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  ('soundboard', '55555555-0000-0000-0000-000000000005/a2790000-0000-0000-0000-000000000001.mp3', '{"size": 20000}'),
  ('soundboard', '55555555-0000-0000-0000-000000000005/a2790000-0000-0000-0000-000000000002.mp3', '{"size": 20000}');
INSERT INTO public.server_sounds (id, server_id, name, volume, duration_ms, storage_path, discord_sound_id) VALUES
  ('279b0000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'imported', 1, 1000,
   '55555555-0000-0000-0000-000000000005/279a0000-0000-0000-0000-0000000000f1.mp3', '9001'),
  ('279b0000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'uploaded', 1, 1000,
   '55555555-0000-0000-0000-000000000005/279a0000-0000-0000-0000-0000000000f2.mp3', NULL);

SELECT throws_ok($$SELECT public.bridge_delete_server_sound('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '279b0000-0000-0000-0000-000000000002')$$,
  '42501', 'SOUND_NOT_LINKED: the bridge deletes only sounds it imported',
  'the bridge cannot delete a sound a member uploaded');
SELECT ok(EXISTS (SELECT 1 FROM public.server_sounds WHERE id = '279b0000-0000-0000-0000-000000000002'),
  'the uploaded sound stays');
SELECT is(public.bridge_delete_server_sound('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '279b0000-0000-0000-0000-000000000001'),
  '55555555-0000-0000-0000-000000000005/279a0000-0000-0000-0000-0000000000f1.mp3',
  'deleting an imported sound answers its storage path');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.server_sounds WHERE id = '279b0000-0000-0000-0000-000000000001'),
  'the imported sound is gone');
SELECT is(public.bridge_delete_server_sound('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '279b0000-0000-0000-0000-0000000000ff'), NULL,
  'an unknown sound answers NULL');
SELECT throws_ok($$SELECT public.bridge_delete_server_sound('27900000-0000-0000-0000-0000000000b2',
  '55555555-0000-0000-0000-000000000005', '279b0000-0000-0000-0000-000000000002')$$,
  '42501', 'bot is not the Discord bridge of this server', 'a bot that does not bridge the server deletes nothing');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
  $q$INSERT INTO public.server_sounds (server_id, name, duration_ms, storage_path, discord_sound_id)
     VALUES ('55555555-0000-0000-0000-000000000005', 'Squat', 1000,
             '55555555-0000-0000-0000-000000000005/a2790000-0000-0000-0000-000000000001.mp3', '9002')$q$,
  '42501', 'SOUND_DISCORD_LINK: discord_sound_id is set by the Discord bridge only',
  'a client insert cannot carry discord_sound_id');
SELECT lives_ok(
  $q$INSERT INTO public.server_sounds (server_id, name, duration_ms, storage_path)
     VALUES ('55555555-0000-0000-0000-000000000005', 'Plain', 1000,
             '55555555-0000-0000-0000-000000000005/a2790000-0000-0000-0000-000000000002.mp3')$q$,
  'the same insert without it passes');
SELECT throws_ok(
  $q$UPDATE public.server_sounds SET discord_sound_id = '9003' WHERE name = 'Plain'$q$,
  '42501', NULL, 'a client update cannot set discord_sound_id');
SELECT tests.clear_authentication();

-- Emoji: what is a bridge import. ------------------------------------------------------------------
INSERT INTO public.emojis (id, name, url, server_id, scope, discord_emoji_id, uploader) VALUES
  ('279e0000-0000-0000-0000-000000000001', 'Imported', pg_temp.stored('3001'),
   '55555555-0000-0000-0000-000000000005', 'server', '3001', NULL),
  ('279e0000-0000-0000-0000-000000000002', 'Linked',
   'https://db.test/storage/v1/object/public/emojis/55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001/own.png',
   '55555555-0000-0000-0000-000000000005', 'server', '3002', '11111111-0000-0000-0000-000000000001'),
  ('279e0000-0000-0000-0000-000000000003', 'Plain',
   'https://db.test/storage/v1/object/public/emojis/55555555-0000-0000-0000-000000000005/11111111-0000-0000-0000-000000000001/plain.png',
   '55555555-0000-0000-0000-000000000005', 'server', NULL, '11111111-0000-0000-0000-000000000001'),
  -- The image of another Discord emoji, and of another server's import.
  ('279e0000-0000-0000-0000-000000000004', 'OtherImage', pg_temp.stored('3001', 'gif'),
   '55555555-0000-0000-0000-000000000005', 'server', '3009', NULL),
  ('279e0000-0000-0000-0000-000000000005', 'OtherServer',
   'https://db.test/storage/v1/object/public/emojis/f2790000-0000-0000-0000-000000000002/discord/3010.png',
   '55555555-0000-0000-0000-000000000005', 'server', '3010', NULL);
-- Imports that are removed: by a person, by the bridge, and by a person after an earlier bridge removal.
INSERT INTO public.emojis (id, name, url, server_id, scope, discord_emoji_id, deleted_at, deleted_by, bridge_removed_at) VALUES
  ('279e0000-0000-0000-0000-00000000000a', 'ByPerson', pg_temp.stored('3003'),
   '55555555-0000-0000-0000-000000000005', 'server', '3003', now() - interval '1 hour',
   '11111111-0000-0000-0000-000000000001', NULL),
  ('279e0000-0000-0000-0000-00000000000b', 'ByBridge', pg_temp.stored('3004', 'gif'),
   '55555555-0000-0000-0000-000000000005', 'server', '3004', now() - interval '2 hours', NULL, now() - interval '2 hours'),
  ('279e0000-0000-0000-0000-00000000000c', 'ByPersonLater', pg_temp.stored('3005'),
   '55555555-0000-0000-0000-000000000005', 'server', '3005', now() - interval '1 hour', NULL, now() - interval '3 hours');

SELECT is(
  (SELECT string_agg(e.name::text, ',' ORDER BY e.name::text) FROM public.emojis e
    WHERE e.id::text LIKE '279e0000-%' AND public.emoji_is_bridge_import(e)),
  'ByBridge,ByPerson,ByPersonLater,Imported',
  'a bridge import is linked and holds the image stored for its own Discord emoji in its own server');

-- Emoji: removal. -----------------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.remove('279e0000-0000-0000-0000-000000000003')$$,
  '42501', 'EMOJI_NOT_LINKED: the bridge removes only emoji it imported',
  'the bridge cannot remove a member''s emoji');
SELECT throws_ok($$SELECT pg_temp.remove('279e0000-0000-0000-0000-000000000002')$$,
  '42501', 'EMOJI_NOT_LINKED: the bridge removes only emoji it imported',
  'nor a member''s emoji it linked by name');
SELECT is((SELECT count(*)::int FROM public.emojis
            WHERE id IN ('279e0000-0000-0000-0000-000000000002', '279e0000-0000-0000-0000-000000000003')
              AND deleted_at IS NULL), 2, 'both stay active');
SELECT throws_ok($$SELECT pg_temp.remove('279e0000-0000-0000-0000-0000000000ff')$$,
  'P0002', NULL, 'an unknown emoji is P0002');

INSERT INTO public.emoji_favorites (user_id, emoji_id, emoji_name) VALUES
  ('22222222-0000-0000-0000-000000000002', '279e0000-0000-0000-0000-000000000001', 'Imported'),
  ('22222222-0000-0000-0000-000000000002', '279e0000-0000-0000-0000-000000000003', 'Plain');
SELECT is(pg_temp.remove('279e0000-0000-0000-0000-000000000001'), 'removed', 'the bridge removes an emoji it imported');
SELECT ok((SELECT deleted_at IS NOT NULL AND bridge_removed_at = deleted_at AND deleted_by IS NULL
             FROM public.emojis WHERE id = '279e0000-0000-0000-0000-000000000001'),
  'bridge_removed_at equals deleted_at');
SELECT is((SELECT string_agg(emoji_name, ',') FROM public.emoji_favorites
            WHERE user_id = '22222222-0000-0000-0000-000000000002'), 'Plain',
  'the removed emoji leaves members'' favorites; others stay');
SELECT is(pg_temp.remove('279e0000-0000-0000-0000-000000000001'), 'existing', 'a second removal is existing');

-- Emoji: restore. -----------------------------------------------------------------------------------
SELECT is((SELECT status FROM pg_temp.imp('3001', 'Imported', NULL, true)), 'updated',
  'the bridge restores an emoji it removed');
SELECT ok((SELECT deleted_at IS NULL AND bridge_removed_at IS NULL FROM public.emojis
            WHERE id = '279e0000-0000-0000-0000-000000000001'), 'the restore clears both timestamps');
SELECT is((SELECT status FROM pg_temp.imp('3004', 'ByBridge', NULL, true)), 'updated',
  'also one it removed earlier');

SELECT throws_ok($$SELECT * FROM pg_temp.imp('3003', 'ByPerson', NULL, true)$$,
  '42501', 'EMOJI_REMOVED: the bridge restores only emoji it removed',
  'the bridge cannot restore an emoji a person removed');
SELECT throws_ok($$SELECT * FROM pg_temp.imp('3003', 'Renamed', NULL, true)$$,
  '42501', 'EMOJI_REMOVED: the bridge restores only emoji it removed', 'nor rename it');
SELECT throws_ok($$SELECT * FROM pg_temp.imp('3005', 'ByPersonLater', NULL, true)$$,
  '42501', 'EMOJI_REMOVED: the bridge restores only emoji it removed',
  'a mark from an earlier bridge removal does not match a later removal');
SELECT is((SELECT count(*)::int FROM public.emojis
            WHERE id IN ('279e0000-0000-0000-0000-00000000000a', '279e0000-0000-0000-0000-00000000000c')
              AND deleted_at IS NOT NULL), 2, 'both stay removed');
SELECT is((SELECT status || ' ' || removed::text FROM pg_temp.imp('3003', 'ByPerson')), 'existing true',
  'without p_update the row is answered as removed');

-- A person removes what the bridge once removed and restored: remove_emoji and restore_emoji.
SELECT is(pg_temp.remove('279e0000-0000-0000-0000-000000000001'), 'removed', 'the bridge removes Imported again');
UPDATE public.emojis SET deleted_at = now() - interval '4 hours', bridge_removed_at = now() - interval '4 hours'
 WHERE id = '279e0000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$SELECT public.restore_emoji('279e0000-0000-0000-0000-000000000001')$$, 'the owner restores it');
SELECT lives_ok($$SELECT public.remove_emoji('279e0000-0000-0000-0000-000000000001')$$, 'and removes it');
SELECT tests.clear_authentication();
SELECT throws_ok($$SELECT * FROM pg_temp.imp('3001', 'Imported', NULL, true)$$,
  '42501', 'EMOJI_REMOVED: the bridge restores only emoji it removed',
  'the bridge cannot restore it after the owner''s removal');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$SELECT public.restore_emoji('279e0000-0000-0000-0000-000000000001')$$, 'the owner restores it again');
SELECT tests.clear_authentication();

-- Emoji: a new import asks name and cap before the image. -------------------------------------------
SELECT throws_ok($$SELECT * FROM pg_temp.imp('3020', 'imported')$$,
  '23505', 'An emoji named imported exists', 'a taken name is refused before any image is asked for');
SELECT throws_ok($$SELECT * FROM pg_temp.imp('3020', 'Fresh')$$,
  '22023', 'invalid emoji url', 'a free name under the cap asks for the image');
INSERT INTO public.instance_config (config_key, config_value) VALUES ('max_custom_emojis_per_server', '1'::jsonb)
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
SELECT throws_ok($$SELECT * FROM pg_temp.imp('3020', 'Fresh')$$,
  '23514', NULL, 'a full server is refused before any image is asked for');
SELECT throws_ok($$SELECT * FROM pg_temp.imp('3020', 'Fresh', pg_temp.stored('3020'))$$,
  '23514', NULL, 'and with the image');
INSERT INTO public.instance_config (config_key, config_value) VALUES ('max_custom_emojis_per_server', '0'::jsonb)
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
SELECT is((SELECT status FROM pg_temp.imp('3020', 'Fresh', pg_temp.stored('3020'))), 'created', 'the import creates the row');
SELECT is((SELECT status FROM pg_temp.imp('3020', 'Fresh', pg_temp.stored('3020'))), 'existing',
  'the same import again answers existing');
SELECT is((SELECT status FROM pg_temp.imp('3021', 'plain')), 'linked', 'a member''s emoji of that name is linked, not replaced');
SELECT throws_ok($$SELECT pg_temp.remove('279e0000-0000-0000-0000-000000000003')$$,
  '42501', 'EMOJI_NOT_LINKED: the bridge removes only emoji it imported', 'and stays the member''s: the bridge cannot remove it');

-- Emoji: eviction. ----------------------------------------------------------------------------------
-- 502 bridge-removed imports, n = 1 the oldest; with ByBridge restored and nothing else
-- bridge-removed, 2 are past the 500 kept.
INSERT INTO public.emojis (id, name, url, server_id, scope, discord_emoji_id, deleted_at, bridge_removed_at)
SELECT ('279f0000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'Old' || n, pg_temp.stored((500000 + n)::text),
       '55555555-0000-0000-0000-000000000005', 'server', (500000 + n)::text,
       now() - interval '10 days' + n * interval '1 minute', now() - interval '10 days' + n * interval '1 minute'
  FROM generate_series(1, 502) n;
-- Older than all of them, removed by a person: never evicted.
UPDATE public.emojis SET deleted_at = now() - interval '30 days' WHERE id = '279e0000-0000-0000-0000-00000000000a';
INSERT INTO public.emoji_favorites (user_id, emoji_id, emoji_name) VALUES
  ('22222222-0000-0000-0000-000000000002', '279f0000-0000-0000-0000-000000000001', 'Old1');

CREATE TEMP TABLE past (id uuid, path text);
GRANT ALL ON past TO PUBLIC;
INSERT INTO past SELECT * FROM public.bridge_evict_removed_emojis('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005');
SELECT is((SELECT string_agg(path, ' ' ORDER BY path) FROM past),
  '55555555-0000-0000-0000-000000000005/discord/500001.png 55555555-0000-0000-0000-000000000005/discord/500002.png',
  'the listing names the bridge-removed imports past the 500 kept, by object path');
SELECT is((SELECT count(*)::int FROM public.emojis WHERE id::text LIKE '279f0000-%'), 502, 'listing deletes nothing');

TRUNCATE past;
INSERT INTO past SELECT * FROM public.bridge_evict_removed_emojis('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005',
  ARRAY['279f0000-0000-0000-0000-000000000001',   -- past the bound
        '279f0000-0000-0000-0000-000000000400',   -- kept
        '279e0000-0000-0000-0000-00000000000a',   -- removed by a person
        '279e0000-0000-0000-0000-000000000003']::uuid[]);  -- a member's, active
SELECT is((SELECT string_agg(id::text, ',') FROM past), '279f0000-0000-0000-0000-000000000001',
  'only a named row past the bound is deleted');
SELECT is((SELECT count(*)::int FROM public.emojis
            WHERE id IN ('279f0000-0000-0000-0000-000000000400', '279e0000-0000-0000-0000-00000000000a',
                         '279e0000-0000-0000-0000-000000000003')), 3, 'the other named rows stay');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.emoji_favorites WHERE emoji_id = '279f0000-0000-0000-0000-000000000001'),
  'the deleted emoji leaves favorites');
TRUNCATE past;
INSERT INTO past SELECT * FROM public.bridge_evict_removed_emojis('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005');
SELECT is((SELECT string_agg(id::text, ',') FROM past), '279f0000-0000-0000-0000-000000000002',
  'the row not named is listed again');
SELECT throws_ok($$SELECT * FROM public.bridge_evict_removed_emojis('27900000-0000-0000-0000-0000000000b2',
  '55555555-0000-0000-0000-000000000005')$$,
  '42501', 'bot is not the Discord bridge of this server', 'a bot that does not bridge the server evicts nothing');

-- Stickers. -----------------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.sticker(p_id uuid, p_name text, p_discord_id text, p_removed_at timestamptz, p_uploader uuid DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.stickers (id, scope, server_id, uploader, name, description, path, url, mime_type, file_size,
                               width, height, discord_sticker_id, removed_at)
  VALUES (p_id, 'server', '55555555-0000-0000-0000-000000000005', p_uploader, p_name, 'A sticker',
          'server/55555555-0000-0000-0000-000000000005/' || p_id::text || '.png',
          'https://db.test/storage/v1/object/public/stickers/server/55555555-0000-0000-0000-000000000005/' || p_id::text || '.png',
          'image/png', 1000, 64, 64, p_discord_id, p_removed_at) $$;
SELECT pg_temp.sticker('279c0000-0000-4000-8000-000000000001', 'hand279', NULL, NULL, '11111111-0000-0000-0000-000000000001');
SELECT pg_temp.sticker('279c0000-0000-4000-8000-000000000002', 'imported279', '4001', NULL);
SELECT pg_temp.sticker('279c0000-0000-4000-8000-000000000003', 'plain279', NULL, NULL, '11111111-0000-0000-0000-000000000001');

SELECT throws_ok($$SELECT public.bridge_retire_server_sticker('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '279c0000-0000-4000-8000-000000000001')$$,
  '42501', 'STICKER_NOT_LINKED: the bridge retires only stickers it imported',
  'the bridge cannot retire a sticker a member uploaded');
SELECT ok((SELECT removed_at IS NULL FROM public.stickers WHERE id = '279c0000-0000-4000-8000-000000000001'),
  'the uploaded sticker stays active');
SELECT is(public.bridge_retire_server_sticker('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '279c0000-0000-4000-8000-000000000002'), 'removed',
  'the bridge retires a sticker it imported');
SELECT is(public.bridge_retire_server_sticker('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '279c0000-0000-4000-8000-000000000002'), 'existing',
  'a second retirement is existing');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'sticker.delete' AND target_id = '279c0000-0000-4000-8000-000000000002'), 1,
  'the retirement writes one sticker.delete');

-- 61 older retired imports, n = 1 the oldest; with imported279 retired now, 2 are past the 60 kept.
SELECT pg_temp.sticker(('279d0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'old279_' || n,
                       (600000 + n)::text, now() - interval '10 days' + n * interval '1 minute')
  FROM generate_series(1, 61) n;

TRUNCATE past;
INSERT INTO past SELECT * FROM public.bridge_evict_retired_stickers('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005');
SELECT is((SELECT string_agg(path, ' ' ORDER BY path) FROM past),
  'server/55555555-0000-0000-0000-000000000005/279d0000-0000-4000-8000-000000000001.png '
  || 'server/55555555-0000-0000-0000-000000000005/279d0000-0000-4000-8000-000000000002.png',
  'the listing names the retired imports past the 60 kept, by object path');
TRUNCATE past;
INSERT INTO past SELECT * FROM public.bridge_evict_retired_stickers('27900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005',
  ARRAY['279d0000-0000-4000-8000-000000000001',   -- past the bound
        '279d0000-0000-4000-8000-000000000030',   -- kept
        '279c0000-0000-4000-8000-000000000001']::uuid[]);  -- a member's, active
SELECT is((SELECT string_agg(id::text, ',') FROM past), '279d0000-0000-4000-8000-000000000001',
  'only a named sticker past the bound is deleted');
SELECT is((SELECT count(*)::int FROM public.stickers
            WHERE id IN ('279d0000-0000-4000-8000-000000000030', '279c0000-0000-4000-8000-000000000001')), 2,
  'the other named stickers stay');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'sticker.delete' AND target_id = '279d0000-0000-4000-8000-000000000001'), 0,
  'deleting a retired sticker writes no sticker.delete');
SELECT throws_ok($$SELECT * FROM public.bridge_evict_retired_stickers('27900000-0000-0000-0000-0000000000b2',
  '55555555-0000-0000-0000-000000000005')$$,
  '42501', 'bot is not the Discord bridge of this server', 'a bot that does not bridge the server evicts nothing');

-- delete_sticker of an active sticker still writes sticker.delete.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$SELECT public.delete_sticker('279c0000-0000-4000-8000-000000000003')$$, 'the owner deletes an active sticker');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'sticker.delete' AND target_id = '279c0000-0000-4000-8000-000000000003'), 1,
  'which writes sticker.delete');

SELECT * FROM finish();
ROLLBACK;
