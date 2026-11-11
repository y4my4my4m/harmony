-- 20261112000001_bridge_emoji_sync.sql: the Discord bridge bot of a server renames and restores
-- the emoji it imported (bridge_import_server_emoji with p_update) and removes them softly
-- (bridge_remove_server_emoji).
--
--   server_1 (55555555-...05)  bridged by bot b1
--   bot b2                     bridge bot of no server
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(29);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('26900000-0000-0000-0000-0000000000b1', 'discord-bridge-269', 'Discord Bridge', '11111111-0000-0000-0000-000000000001', 'bridge'),
  ('26900000-0000-0000-0000-0000000000b2', 'other-bot-269', 'Other', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', '26900000-0000-0000-0000-0000000000b1', 'instance',
        '900000000000000269', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.servers (id, name, owner)
VALUES ('f2690000-0000-0000-0000-000000000002', 'Server 269', '22222222-0000-0000-0000-000000000002');

-- Removed, linked.
INSERT INTO public.emojis (id, name, url, server_id, scope, discord_emoji_id, deleted_at, deleted_by) VALUES
  ('269e0000-0000-0000-0000-00000000000a', 'Honk', 'https://cdn.test/honk.png',
   '55555555-0000-0000-0000-000000000005', 'server', '2001', now(), '11111111-0000-0000-0000-000000000001'),
  ('269e0000-0000-0000-0000-00000000000c', 'Taken', 'https://cdn.test/taken.png',
   '55555555-0000-0000-0000-000000000005', 'server', '2003', now(), NULL),
  ('269e0000-0000-0000-0000-00000000000f', 'Capped', 'https://cdn.test/capped.png',
   '55555555-0000-0000-0000-000000000005', 'server', '2004', now(), NULL);
-- Removed, unlinked.
INSERT INTO public.emojis (id, name, url, server_id, scope, discord_emoji_id, deleted_at) VALUES
  ('269e0000-0000-0000-0000-000000000010', 'Ghost', 'https://cdn.test/ghost.png',
   '55555555-0000-0000-0000-000000000005', 'server', NULL, now());
-- Active: linked, unlinked (two), another server's.
INSERT INTO public.emojis (id, name, url, server_id, scope, discord_emoji_id) VALUES
  ('269e0000-0000-0000-0000-00000000000b', 'Honk2', 'https://cdn.test/honk2.png',
   '55555555-0000-0000-0000-000000000005', 'server', '2002'),
  ('269e0000-0000-0000-0000-00000000000d', 'taken', 'https://cdn.test/taken2.png',
   '55555555-0000-0000-0000-000000000005', 'server', NULL),
  ('269e0000-0000-0000-0000-000000000011', 'Linkme', 'https://cdn.test/linkme.png',
   '55555555-0000-0000-0000-000000000005', 'server', NULL),
  ('269e0000-0000-0000-0000-000000000099', 'foreign', 'https://cdn.test/foreign.png',
   'f2690000-0000-0000-0000-000000000002', 'server', '2999');

CREATE TEMP TABLE r (status text, id uuid, name text, url text, discord_emoji_id text, removed boolean);
GRANT ALL ON r TO PUBLIC;

-- Grants. -----------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated',
  'public.bridge_import_server_emoji(uuid, uuid, text, text, text, boolean)', 'EXECUTE'),
  'authenticated cannot import');
SELECT ok(NOT has_function_privilege('anon',
  'public.bridge_import_server_emoji(uuid, uuid, text, text, text, boolean)', 'EXECUTE'),
  'anon cannot import');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.bridge_remove_server_emoji(uuid, uuid, uuid)', 'EXECUTE'), 'authenticated cannot remove');
SELECT ok(NOT has_function_privilege('anon',
  'public.bridge_remove_server_emoji(uuid, uuid, uuid)', 'EXECUTE'), 'anon cannot remove');

-- Authority and input. ----------------------------------------------------------------------------
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b2',
  '55555555-0000-0000-0000-000000000005', '2001', 'Honk', NULL, true)$$,
  '42501', NULL, 'a bot that does not bridge the server cannot import');
SELECT throws_ok($$SELECT public.bridge_remove_server_emoji('26900000-0000-0000-0000-0000000000b2',
  '55555555-0000-0000-0000-000000000005', '269e0000-0000-0000-0000-00000000000b')$$,
  '42501', NULL, 'a bot that does not bridge the server cannot remove');
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '2001', 'bad name', NULL, true)$$,
  '22023', NULL, 'a name outside [A-Za-z0-9_] is refused');

-- A linked row without p_update. ------------------------------------------------------------------
INSERT INTO r SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '2001', 'Other', NULL);
SELECT is((SELECT status FROM r), 'existing', 'a linked row without p_update is returned as is');
SELECT ok((SELECT removed FROM r), 'and reported as removed');
SELECT ok((SELECT deleted_at IS NOT NULL FROM public.emojis WHERE id = '269e0000-0000-0000-0000-00000000000a'),
  'it stays removed');

-- Rename. -----------------------------------------------------------------------------------------
TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '2002', 'honk2', NULL, true);
SELECT is((SELECT status FROM r), 'updated', 'a case-only rename counts as a rename');
SELECT is((SELECT name::text FROM public.emojis WHERE id = '269e0000-0000-0000-0000-00000000000b'), 'honk2',
  'the new name is stored');

TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '2002', 'honk2', NULL, true);
SELECT is((SELECT status FROM r), 'existing', 'an identical row is existing');

-- Restore. ----------------------------------------------------------------------------------------
TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '2001', 'Honk', NULL, true);
SELECT is((SELECT status FROM r), 'updated', 'p_update restores a removed linked row');
SELECT ok((SELECT deleted_at IS NULL FROM public.emojis WHERE id = '269e0000-0000-0000-0000-00000000000a'),
  'deleted_at is cleared');
SELECT ok((SELECT deleted_by IS NULL FROM public.emojis WHERE id = '269e0000-0000-0000-0000-00000000000a'),
  'deleted_by is cleared');

SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '2003', 'Taken', NULL, true)$$,
  '23505', NULL, 'restoring is refused while another active emoji holds the name');

INSERT INTO public.instance_config (config_key, config_value)
SELECT 'max_custom_emojis_per_server', to_jsonb(count(*)::int) FROM public.emojis
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND deleted_at IS NULL
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '2004', 'Capped', NULL, true)$$,
  '23514', 'SERVER_EMOJI_LIMIT: at most ' || public.server_emoji_limit() || ' emojis per server',
  'restoring at the cap is refused');

SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '3004', 'newone', 'https://cdn.test/n.png')$$,
  '23514', NULL, 'creating at the cap is refused');

INSERT INTO public.instance_config (config_key, config_value) VALUES ('max_custom_emojis_per_server', '50'::jsonb)
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '2002', 'TAKEN', NULL, true)$$,
  '23505', NULL, 'renaming to a name another active emoji holds is refused');

-- Same-name link. ---------------------------------------------------------------------------------
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '3001', 'Ghost', NULL)$$,
  '22023', 'invalid emoji url', 'a removed unlinked row is not linked');

TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '3002', 'linkme', NULL);
SELECT is((SELECT status FROM r), 'linked', 'an active unlinked row with the name is linked');

-- Create. -----------------------------------------------------------------------------------------
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '3003', 'HONK2', 'https://cdn.test/h.png')$$,
  '23505', NULL, 'creating is refused while an emoji linked to another Discord id has the name');

INSERT INTO public.instance_config (config_key, config_value) VALUES ('max_custom_emojis_per_server', '0'::jsonb)
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
INSERT INTO public.emojis (name, url, server_id, scope)
SELECT 'bulk' || n, 'https://cdn.test/bulk.png', '55555555-0000-0000-0000-000000000005', 'server'
  FROM generate_series(1, 55) n;
TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '3005', 'nolimit', 'https://cdn.test/nl.png');
SELECT is((SELECT status FROM r), 'created', 'with cap 0 an emoji is created above 50 active');

-- Remove. -----------------------------------------------------------------------------------------
SELECT is(public.bridge_remove_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '269e0000-0000-0000-0000-00000000000b'), 'removed',
  'an active emoji is removed');
SELECT ok((SELECT deleted_at IS NOT NULL FROM public.emojis WHERE id = '269e0000-0000-0000-0000-00000000000b'),
  'deleted_at is set');
SELECT ok((SELECT deleted_by IS NULL FROM public.emojis WHERE id = '269e0000-0000-0000-0000-00000000000b'),
  'deleted_by stays NULL');
SELECT is(public.bridge_remove_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '269e0000-0000-0000-0000-00000000000b'), 'existing',
  'removing again is existing');
SELECT throws_ok($$SELECT public.bridge_remove_server_emoji('26900000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '269e0000-0000-0000-0000-000000000099')$$,
  'P0002', NULL, 'an emoji of another server is not found');

SELECT * FROM finish();
ROLLBACK;
