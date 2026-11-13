-- 20261112600001_bridge_server_profile_sync.sql: the Discord bridge bot of a server reads and
-- updates its Harmony server's name, description, icon and banner (bridge_get_server_profile,
-- bridge_update_server_profile); name and description go through the rules update_server shares
-- (server_profile_name, server_profile_description); the sync is attributed to the bot in the
-- server audit log.
--
--   server_1 (55555555-...05)  bridged by bot b1; alice owns it
--   bot b2                     bridge bot of no server
--   server f2800000-...02      a remote server (is_local_server = false) bridged by bot b3
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(39);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('28000000-0000-0000-0000-0000000000b1', 'discord-bridge-280', 'Discord Bridge', '11111111-0000-0000-0000-000000000001', 'bridge'),
  ('28000000-0000-0000-0000-0000000000b2', 'other-bot-280', 'Other', '11111111-0000-0000-0000-000000000001', 'bridge'),
  ('28000000-0000-0000-0000-0000000000b3', 'remote-bot-280', 'Remote', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.servers (id, name, owner, is_local_server)
VALUES ('f2800000-0000-0000-0000-000000000002', 'Remote 280', '22222222-0000-0000-0000-000000000002', false);
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by) VALUES
  ('55555555-0000-0000-0000-000000000005', '28000000-0000-0000-0000-0000000000b1', 'instance',
   '900000000000000280', '11111111-0000-0000-0000-000000000001'),
  ('f2800000-0000-0000-0000-000000000002', '28000000-0000-0000-0000-0000000000b3', 'instance',
   '900000000000000281', '11111111-0000-0000-0000-000000000001');

-- The bridge call, as bot p_bot on server p_server.
CREATE FUNCTION pg_temp.upd(p_changes jsonb, p_bot uuid DEFAULT '28000000-0000-0000-0000-0000000000b1',
                            p_server uuid DEFAULT '55555555-0000-0000-0000-000000000005')
RETURNS TABLE(changed boolean, previous_icon text, previous_banner text, name text, description text,
              icon text, banner text)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.bridge_update_server_profile(p_bot, p_server, p_changes);
END;
$$;
-- Server audit rows of kind server.update for server_1.
CREATE FUNCTION pg_temp.updates() RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.server_audit_log
   WHERE action = 'server.update' AND target_id = '55555555-0000-0000-0000-000000000005' $$;

CREATE TEMP TABLE r (changed boolean, previous_icon text, previous_banner text, name text, description text,
                     icon text, banner text);
GRANT ALL ON r TO PUBLIC;

-- Grants. -----------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated',
  'public.bridge_get_server_profile(uuid, uuid)', 'EXECUTE'), 'authenticated cannot read the profile');
SELECT ok(NOT has_function_privilege('anon',
  'public.bridge_get_server_profile(uuid, uuid)', 'EXECUTE'), 'anon cannot read the profile');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.bridge_update_server_profile(uuid, uuid, jsonb)', 'EXECUTE'), 'authenticated cannot update the profile');
SELECT ok(NOT has_function_privilege('anon',
  'public.bridge_update_server_profile(uuid, uuid, jsonb)', 'EXECUTE'), 'anon cannot update the profile');
SELECT ok(NOT has_function_privilege('authenticated', 'public.server_profile_name(text)', 'EXECUTE'),
  'authenticated cannot call server_profile_name');
SELECT ok(NOT has_function_privilege('authenticated', 'public.server_profile_description(text)', 'EXECUTE'),
  'authenticated cannot call server_profile_description');

-- Authority. --------------------------------------------------------------------------------------
SELECT throws_ok($$SELECT * FROM public.bridge_get_server_profile('28000000-0000-0000-0000-0000000000b2',
  '55555555-0000-0000-0000-000000000005')$$, '42501', 'bot does not bridge this server',
  'a bot that does not bridge the server cannot read it');
SELECT throws_ok($$SELECT * FROM pg_temp.upd('{"name":"X"}', '28000000-0000-0000-0000-0000000000b2')$$,
  '42501', 'bot does not bridge this server', 'a bot that does not bridge the server cannot update it');
SELECT throws_ok($$SELECT * FROM public.bridge_get_server_profile('28000000-0000-0000-0000-0000000000b3',
  'f2800000-0000-0000-0000-000000000002')$$, '42501', NULL, 'a remote server cannot be read');
SELECT throws_ok($$SELECT * FROM pg_temp.upd('{"name":"X"}', '28000000-0000-0000-0000-0000000000b3',
  'f2800000-0000-0000-0000-000000000002')$$, '42501', NULL, 'a remote server cannot be updated');

-- Validation. -------------------------------------------------------------------------------------
SELECT throws_ok($$SELECT * FROM pg_temp.upd('[]')$$, '22023', NULL, 'changes must be an object');
SELECT throws_ok($$SELECT * FROM pg_temp.upd('{"public":true}')$$, '22023', NULL, 'an unknown key is refused');
SELECT throws_ok($$SELECT * FROM pg_temp.upd('{"name":null}')$$, '22023', NULL, 'a null name is refused');
SELECT throws_ok($$SELECT * FROM pg_temp.upd('{"icon":"s/icon-1.png"}')$$, '22023', NULL,
  'an icon without its hash is refused');
SELECT throws_ok($$SELECT * FROM pg_temp.upd('{"banner_discord_hash":null}')$$, '22023', NULL,
  'a banner hash without its banner is refused');
SELECT throws_ok($$SELECT * FROM pg_temp.upd('{"icon":"s/icon-1.png","icon_discord_hash":"xyz"}')$$,
  '22023', NULL, 'a malformed hash is refused');
SELECT throws_ok($$SELECT * FROM pg_temp.upd('{"name":"   "}')$$, '23514', 'server name must not be blank',
  'a blank name is refused');
SELECT throws_ok($$SELECT * FROM pg_temp.upd(jsonb_build_object('name', repeat('a', 101)))$$, '23514',
  'server name exceeds 100 characters', 'a 101-character name is refused');
SELECT throws_ok($$SELECT * FROM pg_temp.upd(jsonb_build_object('description', repeat('a', 501)))$$, '23514',
  'server description exceeds 500 characters', 'a 501-character description is refused');

-- Shared rules. -----------------------------------------------------------------------------------
SELECT is(public.server_profile_name('  Hello  '), 'Hello', 'server_profile_name trims');
SELECT ok(public.server_profile_description('') IS NULL, 'server_profile_description turns empty into NULL');
SELECT throws_ok($$SELECT public.server_profile_name('   ')$$, '23514', 'server name must not be blank',
  'server_profile_name refuses a blank name');
SELECT throws_ok($$SELECT public.server_profile_name(repeat('a', 101))$$, '23514',
  'server name exceeds 100 characters', 'server_profile_name refuses 101 characters');
SELECT throws_ok($$SELECT public.server_profile_description(repeat('a', 501))$$, '23514',
  'server description exceeds 500 characters', 'server_profile_description refuses 501 characters');

-- update_server keeps working on the shared rules. ------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.update_server('55555555-0000-0000-0000-000000000005', '{"name":"  Hi  ","description":""}');
SELECT tests.clear_authentication();
SELECT is((SELECT name FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'), 'Hi',
  'update_server stores the trimmed name');
SELECT ok((SELECT description IS NULL FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'),
  'update_server stores an empty description as NULL');

-- Writes. -----------------------------------------------------------------------------------------
UPDATE public.servers SET icon = 's/old-icon.png' WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT set_config('t280.updates', pg_temp.updates()::text, true);
INSERT INTO r SELECT * FROM pg_temp.upd('{"name":"  Synced ","description":"From Discord"}');
SELECT is((SELECT (changed, name, description)::text FROM r), '(t,Synced,"From Discord")',
  'a new name and description are changed and returned trimmed');
SELECT is((SELECT (name, description)::text FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'),
  '(Synced,"From Discord")', 'the server row is updated');
SELECT is(pg_temp.updates(), current_setting('t280.updates')::int + 1, 'one server.update audit row is written');

UPDATE public.servers SET updated_at = '2000-01-01' WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT set_config('t280.updates', pg_temp.updates()::text, true);
TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.upd('{"name":"Synced","description":"From Discord"}');
SELECT is((SELECT changed FROM r), false, 'the same values again are not changed');
SELECT is((SELECT updated_at FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'),
  '2000-01-01'::timestamptz, 'and updated_at stays');
SELECT is(pg_temp.updates(), current_setting('t280.updates')::int, 'and no audit row is written');

TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.upd(jsonb_build_object('icon', 's/icon-1.png',
  'icon_discord_hash', 'a_' || repeat('0', 32)));
SELECT is((SELECT (changed, previous_icon, icon)::text FROM r), '(t,s/old-icon.png,s/icon-1.png)',
  'an icon is changed and the old one returned');
SELECT is((SELECT (s.icon, b.profile_icon_discord_hash, b.profile_icon_path)::text
             FROM public.servers s JOIN public.discord_bridges b ON b.server_id = s.id
            WHERE s.id = '55555555-0000-0000-0000-000000000005'),
  '(s/icon-1.png,a_00000000000000000000000000000000,s/icon-1.png)',
  'the icon and its source columns are stored');
TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.upd('{"icon":null,"icon_discord_hash":null}');
SELECT is((SELECT (s.icon IS NULL, b.profile_icon_discord_hash IS NULL, b.profile_icon_path IS NULL)::text
             FROM public.servers s JOIN public.discord_bridges b ON b.server_id = s.id
            WHERE s.id = '55555555-0000-0000-0000-000000000005'),
  '(t,t,t)', 'a null icon clears the icon and its source columns');

TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.upd(jsonb_build_object('banner', 's/banner-1.png',
  'banner_discord_hash', repeat('b', 32)));
SELECT is((SELECT (s.banner, b.profile_banner_discord_hash, b.profile_banner_path)::text
             FROM public.servers s JOIN public.discord_bridges b ON b.server_id = s.id
            WHERE s.id = '55555555-0000-0000-0000-000000000005'),
  '(s/banner-1.png,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,s/banner-1.png)',
  'a banner and its source columns are stored');

-- Bot attribution. --------------------------------------------------------------------------------
INSERT INTO public.bot_audit_log (bot_id, action_type, success, metadata)
VALUES ('28000000-0000-0000-0000-0000000000b1', 'server_profile_synced', true,
        '{"serverId":"55555555-0000-0000-0000-000000000005"}');
SELECT ok(EXISTS (SELECT 1 FROM public.server_audit_log
                   WHERE action = 'server.update' AND target_id = '55555555-0000-0000-0000-000000000005'
                     AND source = 'bot' AND actor_bot_id = '28000000-0000-0000-0000-0000000000b1'),
  'server_profile_synced attributes a server.update row to the bot');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'server.update' AND target_id = '55555555-0000-0000-0000-000000000005'
              AND source = 'system' AND actor_id IS NULL),
  0, 'and no unattributed server.update row is left');

-- Get. --------------------------------------------------------------------------------------------
SELECT is((SELECT (g.name, g.description, g.icon, g.banner, g.icon_discord_hash, g.icon_path,
                   g.banner_discord_hash, g.banner_path)::text
             FROM public.bridge_get_server_profile('28000000-0000-0000-0000-0000000000b1',
               '55555555-0000-0000-0000-000000000005') g),
  '(Synced,"From Discord",,s/banner-1.png,,,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,s/banner-1.png)',
  'the profile and its source columns are read');

SELECT * FROM finish();
