-- 20261009400001_bridge_server_emojis.sql: the Discord bridge bot of a server imports Discord
-- emoji as server emoji, once per Discord emoji.
--
--   server_1 (55555555-...05)  bridged by bot b1
--   bot b2                     bridge bot of no server
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(17);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('97000000-0000-0000-0000-0000000000b1', 'discord-bridge-97', 'Discord Bridge', '11111111-0000-0000-0000-000000000001', 'bridge'),
  ('97000000-0000-0000-0000-0000000000b2', 'other-bot-97', 'Other', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', '97000000-0000-0000-0000-0000000000b1', 'instance',
        '900000000000000001', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.emojis (id, name, url, server_id, scope) VALUES
  ('97e00000-0000-0000-0000-000000000001', 'PartyBlob', 'https://cdn.test/party.png',
   '55555555-0000-0000-0000-000000000005', 'server');

CREATE TEMP TABLE r (status text, id uuid, name text, url text, discord_emoji_id text);
GRANT ALL ON r TO PUBLIC;

-- Grants. -----------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated',
  'public.bridge_import_server_emoji(uuid, uuid, text, text, text)', 'EXECUTE'), 'authenticated cannot import');
SELECT ok(NOT has_function_privilege('anon',
  'public.bridge_import_server_emoji(uuid, uuid, text, text, text)', 'EXECUTE'), 'anon cannot import');

-- Authority. --------------------------------------------------------------------------------------
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('97000000-0000-0000-0000-0000000000b2',
  '55555555-0000-0000-0000-000000000005', '123', 'blob', 'https://cdn.test/x.png')$$,
  '42501', NULL, 'a bot that does not bridge the server is refused');
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('97000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', 'abc', 'blob', 'https://cdn.test/x.png')$$,
  '22023', NULL, 'a non-numeric Discord id is refused');
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('97000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '123', 'bad name', 'https://cdn.test/x.png')$$,
  '22023', NULL, 'a name outside [A-Za-z0-9_] is refused');

-- Create, then rerun. -----------------------------------------------------------------------------
INSERT INTO r SELECT * FROM public.bridge_import_server_emoji('97000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '111', 'catjam', 'https://cdn.test/catjam.gif');
SELECT is((SELECT status FROM r), 'created', 'a new Discord emoji is created');
SELECT is((SELECT scope FROM public.emojis WHERE discord_emoji_id = '111'), 'server', 'as a server emoji');

TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_emoji('97000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '111', 'catjam', 'https://cdn.test/catjam-again.gif');
SELECT is((SELECT status FROM r), 'existing', 'importing the same Discord emoji again returns the row');
SELECT is((SELECT url FROM r), 'https://cdn.test/catjam.gif', 'with its first image');
SELECT is((SELECT count(*)::int FROM public.emojis WHERE discord_emoji_id = '111'), 1, 'no second row');

-- Same name already on the server. ----------------------------------------------------------------
TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_emoji('97000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '222', 'partyblob', NULL);
SELECT is((SELECT status FROM r), 'linked', 'a same-name server emoji is linked, case-insensitive');
SELECT is((SELECT id FROM r), '97e00000-0000-0000-0000-000000000001'::uuid, 'the existing row');
SELECT is((SELECT count(*)::int FROM public.emojis WHERE server_id = '55555555-0000-0000-0000-000000000005'
             AND lower(name) = 'partyblob'), 1, 'no duplicate name');

TRUNCATE r;
INSERT INTO r SELECT * FROM public.bridge_import_server_emoji('97000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '333', 'PartyBlob', 'https://cdn.test/other.png');
SELECT is((SELECT status FROM r), 'created',
  'a second Discord emoji with a linked name gets its own row');

SELECT throws_ok($$SELECT * FROM public.bridge_import_server_emoji('97000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '444', 'fresh', NULL)$$,
  '22023', NULL, 'a new emoji without an image URL is refused');

-- Constraints. ------------------------------------------------------------------------------------
SELECT throws_ok($$INSERT INTO public.emojis (name, url, server_id, scope, discord_emoji_id)
  VALUES ('dup', 'https://cdn.test/d.png', '55555555-0000-0000-0000-000000000005', 'server', '111')$$,
  '23505', NULL, 'one row per server and Discord emoji');
SELECT throws_ok($$INSERT INTO public.emojis (name, url, scope, discord_emoji_id)
  VALUES ('inst', 'https://cdn.test/i.png', 'instance', '555')$$,
  '23514', NULL, 'a Discord link needs a server');

SELECT * FROM finish();
ROLLBACK;
