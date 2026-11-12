-- "Migrate from Discord": schema and configuration RPCs, 20261112500001_discord_migration.sql.
--
--   alice  owner of server_1 (fixture) and of s2 and s3 below
--   bob    accepted member of server_1 without MANAGE_SERVER
--
--   server_1 (fixture)  guild 123456789012345678, source 'own'
--   s2                  hosted bridge with guild 900000000000000274, source 'bridge'
--   s3                  source 'instance_bot'
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(116);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2740000-0000-0000-0000-0000000000a2', 'S2 274', '11111111-0000-0000-0000-000000000001'),
  ('f2740000-0000-0000-0000-0000000000a3', 'S3 274', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridges (id, server_id, mode, discord_guild_id, created_by) VALUES
  ('f2740000-0000-0000-0000-0000000000b2', 'f2740000-0000-0000-0000-0000000000a2', 'hosted',
   '900000000000000274', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.server_roles (id, server_id, name, permissions) VALUES
  ('f2740000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'Role274A', 0),
  ('f2740000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'Role274B', 0);

-- Grants and RLS --------------------------------------------------------------------------------
CREATE TEMP TABLE tbls (t text) ON COMMIT DROP;
INSERT INTO tbls VALUES ('discord_migrations'), ('discord_migration_secrets'), ('discord_migration_discord_roles'),
  ('discord_migration_role_map'), ('discord_migration_links'), ('discord_migration_claims'),
  ('discord_migration_link_states');
SELECT ok((SELECT bool_and(c.relrowsecurity) FROM tbls JOIN pg_class c ON c.oid = ('public.' || tbls.t)::regclass),
  'RLS is on for every migration table');
SELECT ok(NOT EXISTS (SELECT 1 FROM tbls,
                             unnest(ARRAY['anon', 'authenticated']) r,
                             unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
                       WHERE has_table_privilege(r, 'public.' || tbls.t, p)),
  'clients hold no privilege on the migration tables');
SELECT ok((SELECT bool_and(has_table_privilege('service_role', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE')) FROM tbls),
  'service_role holds the migration tables');

CREATE TEMP TABLE client_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO client_fns VALUES
  ('public.discord_migration_get(uuid)'), ('public.discord_migration_save(uuid, text, text)'),
  ('public.discord_migration_set_own_credentials(uuid, text, text, text)'),
  ('public.discord_migration_regenerate_token(uuid)');
CREATE TEMP TABLE service_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO service_fns VALUES
  ('public.discord_migration_credentials(uuid)'), ('public.discord_migration_store_discord_roles(uuid, jsonb)'),
  ('public.discord_migration_store_warnings(uuid, jsonb)');
SELECT is_empty($q$SELECT fn FROM client_fns WHERE has_function_privilege('anon', fn, 'EXECUTE')
                                               OR NOT has_function_privilege('authenticated', fn, 'EXECUTE')$q$,
  'authenticated, not anon, executes the configuration RPCs');
SELECT is_empty($q$SELECT fn FROM service_fns WHERE has_function_privilege('anon', fn, 'EXECUTE')
                                                OR has_function_privilege('authenticated', fn, 'EXECUTE')
                                                OR NOT has_function_privilege('service_role', fn, 'EXECUTE')$q$,
  'only service_role executes the gateway functions');

-- Permission --------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.discord_migration_get('55555555-0000-0000-0000-000000000005')$q$,
  '42501', NULL, 'a member without MANAGE_SERVER cannot read the migration');
SELECT throws_ok($q$SELECT public.discord_migration_save('55555555-0000-0000-0000-000000000005', '123456789012345678', 'own')$q$,
  '42501', NULL, 'a member without MANAGE_SERVER cannot save the migration');
SELECT throws_ok($q$SELECT public.discord_migration_set_own_credentials('55555555-0000-0000-0000-000000000005', '123456789012345678', NULL, NULL)$q$,
  '42501', NULL, 'a member without MANAGE_SERVER cannot store credentials');
SELECT throws_ok($q$SELECT public.discord_migration_regenerate_token('55555555-0000-0000-0000-000000000005')$q$,
  '42501', NULL, 'a member without MANAGE_SERVER cannot regenerate the token');
SELECT tests.clear_authentication();

-- Save and get ------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('save1', public.discord_migration_save('55555555-0000-0000-0000-000000000005', '123456789012345678', 'own'));
INSERT INTO out VALUES ('get1', public.discord_migration_get('55555555-0000-0000-0000-000000000005'));
SELECT throws_ok($q$SELECT public.discord_migration_save('55555555-0000-0000-0000-000000000005', 'abc', 'own')$q$,
  '23514', NULL, 'a guild id that is not a snowflake violates the check');
SELECT throws_ok($q$SELECT public.discord_migration_save('55555555-0000-0000-0000-000000000005', '123456789012345678', 'carrier')$q$,
  '23514', NULL, 'an unknown credential source violates the check');
SELECT tests.clear_authentication();

SELECT is((SELECT v ->> 'state' FROM out WHERE k = 'get1'), 'draft', 'a saved migration starts as a draft');
SELECT is((SELECT length(v ->> 'link_token') FROM out WHERE k = 'get1'), 48, 'the link token is 48 characters');
SELECT is((SELECT v ->> 'discord_guild_id' || '/' || (v ->> 'credential_source') FROM out WHERE k = 'get1'),
  '123456789012345678/own', 'get returns the saved guild and source');
SELECT is((SELECT v ->> 'state' FROM out WHERE k = 'save1'), 'draft', 'save returns the configuration');
SELECT ok((SELECT v ->> 'caller_is_owner' = 'true' AND v ->> 'has_own_credentials' = 'false'
                  AND v ->> 'bridge_available' = 'false' AND v ->> 'instance_bot_available' = 'false'
                  AND v -> 'readiness' ->> 'ready' = 'false' AND v -> 'permission_gaps' = '[]'::jsonb
             FROM out WHERE k = 'get1'),
  'get reports owner, no own credentials, no bridge, no instance bot, readiness and no permission gaps');
SELECT is((SELECT v -> 'link_counts' FROM out WHERE k = 'get1'),
  '{"active":0,"left":0,"banned":0,"kicked_on_harmony":0}'::jsonb, 'get counts links by status');
SELECT is((SELECT v -> 'discord_roles' FROM out WHERE k = 'get1'), '[]'::jsonb, 'get lists the (empty) role snapshot');
SELECT is((SELECT v -> 'role_map' FROM out WHERE k = 'get1'), '[]'::jsonb, 'get lists the (empty) role map');

-- Own credentials ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_set_own_credentials('55555555-0000-0000-0000-000000000005',
  '300000000000000274', 'abcdefghijklmnopqrstuvwxyz274001',
  ('Bot MTAxMDEwMTAxMDEwMTAxMDEw' || '.GabcDE.' || 'abcdefghijklmnopqrstuvwxyz0123456789AB'))$q$,
  'the owner stores credentials');
SELECT throws_ok($q$SELECT * FROM public.discord_migration_secrets$q$, '42501', NULL,
  'authenticated cannot read the secrets table');
SELECT ok((public.discord_migration_get('55555555-0000-0000-0000-000000000005') ->> 'has_own_credentials') = 'true'
      AND NOT (public.discord_migration_get('55555555-0000-0000-0000-000000000005') ? 'client_secret_secret'),
  'get reports credentials without exposing the secret ids');
SELECT throws_ok($q$SELECT public.discord_migration_set_own_credentials('55555555-0000-0000-0000-000000000005', 'x', NULL, NULL)$q$,
  '22023', NULL, 'a client id that is not a snowflake is refused');
SELECT throws_ok($q$SELECT public.discord_migration_credentials('55555555-0000-0000-0000-000000000005')$q$,
  '42501', NULL, 'a client cannot read the credentials');
SELECT tests.clear_authentication();

SELECT bot_token_secret AS tok1, client_secret_secret AS cs1
  FROM public.discord_migration_secrets WHERE server_id = '55555555-0000-0000-0000-000000000005' \gset

SET LOCAL role service_role;
INSERT INTO out VALUES ('cred1', public.discord_migration_credentials('55555555-0000-0000-0000-000000000005'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'cred1'),
  jsonb_build_object('client_id', '300000000000000274', 'client_secret', 'abcdefghijklmnopqrstuvwxyz274001',
                     'bot_token', 'MTAxMDEwMTAxMDEwMTAxMDEw' || '.GabcDE.' || 'abcdefghijklmnopqrstuvwxyz0123456789AB'),
  'service_role reads the three values; the token loses its Bot prefix');

-- Rotation replaces the old Vault secret; a null argument keeps the current value.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_migration_set_own_credentials('55555555-0000-0000-0000-000000000005', NULL, NULL,
  ('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GxyzDE.' || 'zyxwvutsrqponmlkjihgfedcba9876543210ZY'));
SELECT tests.clear_authentication();
SELECT results_eq(
  format($q$SELECT s.client_id, s.client_secret_secret = %L, s.bot_token_secret <> %L,
                   (SELECT count(*)::int FROM vault.secrets WHERE id = %L)
              FROM public.discord_migration_secrets s WHERE s.server_id = '55555555-0000-0000-0000-000000000005'$q$,
         :'cs1', :'tok1', :'tok1'),
  $q$VALUES ('300000000000000274', true, true, 0)$q$,
  'a null argument keeps the client id and secret; the replaced token''s Vault row is gone');

-- Token regeneration ------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('tok_new', to_jsonb(public.discord_migration_regenerate_token('55555555-0000-0000-0000-000000000005')));
SELECT tests.clear_authentication();
SELECT ok((SELECT v #>> '{}' <> (SELECT v ->> 'link_token' FROM out WHERE k = 'get1') AND length(v #>> '{}') = 48
             FROM out WHERE k = 'tok_new')
      AND (SELECT link_token FROM public.discord_migrations WHERE server_id = '55555555-0000-0000-0000-000000000005')
          = (SELECT v #>> '{}' FROM out WHERE k = 'tok_new'),
  'regenerate_token returns a new 48 character token and stores it');

-- The hosted bridge: guild default and credentials ------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('get2pre', public.discord_migration_get('f2740000-0000-0000-0000-0000000000a2'));
INSERT INTO out VALUES ('save2', public.discord_migration_save('f2740000-0000-0000-0000-0000000000a2', NULL, 'bridge'));
INSERT INTO out VALUES ('get2', public.discord_migration_get('f2740000-0000-0000-0000-0000000000a2'));
SELECT tests.clear_authentication();
SELECT is((SELECT v ->> 'bridge_discord_guild_id' FROM out WHERE k = 'get2pre'), '900000000000000274',
  'get returns the bridge''s guild before any migration row exists');
SELECT is((SELECT v ->> 'discord_guild_id' FROM out WHERE k = 'save2'), '900000000000000274',
  'save with a null guild id copies the hosted bridge''s guild');
SELECT is((SELECT v ->> 'bridge_available' FROM out WHERE k = 'get2'), 'false',
  'a hosted bridge without its token is not an available bridge');

SET LOCAL role service_role;
SELECT throws_ok($q$SELECT public.discord_migration_credentials('f2740000-0000-0000-0000-0000000000a2')$q$,
  'P0001', 'MIGRATION_CREDENTIALS_MISSING', 'the bridge source needs the bridge token and own client credentials');
RESET role;

SELECT vault.create_secret('hosted-bot-token-274', NULL, 'test 274') AS hosted_tok \gset
INSERT INTO public.discord_bridge_secrets (bridge_id, discord_token_secret)
VALUES ('f2740000-0000-0000-0000-0000000000b2', :'hosted_tok');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.discord_migration_get('f2740000-0000-0000-0000-0000000000a2') ->> 'bridge_available', 'true',
  'a hosted bridge that holds its token makes the bridge available');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_migration_set_own_credentials('f2740000-0000-0000-0000-0000000000a2',
  '300000000000000275', 'abcdefghijklmnopqrstuvwxyz274002', NULL);
SELECT tests.clear_authentication();
SET LOCAL role service_role;
INSERT INTO out VALUES ('cred2', public.discord_migration_credentials('f2740000-0000-0000-0000-0000000000a2'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'cred2'),
  '{"client_id":"300000000000000275","client_secret":"abcdefghijklmnopqrstuvwxyz274002","bot_token":"hosted-bot-token-274"}'::jsonb,
  'the bridge source takes the bot token from the hosted bridge and the rest from the migration');

-- The instance bot ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_migration_save('f2740000-0000-0000-0000-0000000000a3', '900000000000000276', 'instance_bot');
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT throws_ok($q$SELECT public.discord_migration_credentials('f2740000-0000-0000-0000-0000000000a3')$q$,
  'P0001', 'MIGRATION_CREDENTIALS_MISSING', 'the instance bot source raises while no instance bot is stored');
RESET role;

SELECT vault.create_secret('instance-bot-token-274', NULL, 'test 274 bot') AS ib_tok \gset
SELECT vault.create_secret('instance-client-secret-274', NULL, 'test 274 secret') AS ib_cs \gset
INSERT INTO public.discord_bridge_instance_bot (id, application_id, bot_token_secret, client_secret_secret)
VALUES (true, '300000000000000277', :'ib_tok', :'ib_cs')
ON CONFLICT (id) DO UPDATE SET application_id = EXCLUDED.application_id,
  bot_token_secret = EXCLUDED.bot_token_secret, client_secret_secret = EXCLUDED.client_secret_secret;
SET LOCAL role service_role;
SELECT throws_ok($q$SELECT public.discord_migration_credentials('f2740000-0000-0000-0000-0000000000a3')$q$,
  'P0001', 'MIGRATION_CREDENTIALS_MISSING', 'the instance bot source raises while the instance bot is configured but disabled');
RESET role;
UPDATE public.instance_config SET config_value = 'true'::jsonb WHERE config_key = 'discord_bridge_instance_bot_enabled';
SET LOCAL role service_role;
INSERT INTO out VALUES ('cred3', public.discord_migration_credentials('f2740000-0000-0000-0000-0000000000a3'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'cred3'),
  '{"client_id":"300000000000000277","client_secret":"instance-client-secret-274","bot_token":"instance-bot-token-274"}'::jsonb,
  'the instance bot source reads the instance bot');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.discord_migration_get('f2740000-0000-0000-0000-0000000000a3') ->> 'instance_bot_available', 'true',
  'a configured, enabled instance bot is available');
SELECT tests.clear_authentication();

-- Instance configuration --------------------------------------------------------------------------
SELECT ok('discord_migration_account_creation' = ANY (public.public_instance_config_keys()),
  'discord_migration_account_creation is a public instance config key');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'discord_migration_account_creation'),
  'true'::jsonb, 'account creation through the migration defaults to true');

-- Role snapshot -----------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.discord_migration_store_discord_roles('55555555-0000-0000-0000-000000000005', jsonb_build_array(
  jsonb_build_object('id', '400000000000000001', 'name', 'Admins', 'color', 255, 'position', 5, 'harmony_permissions', '17179869183'),
  jsonb_build_object('id', '400000000000000002', 'name', 'Mods', 'color', 0, 'position', 3, 'harmony_permissions', '8'),
  jsonb_build_object('id', '123456789012345678', 'name', '@everyone', 'color', 0, 'position', 0, 'harmony_permissions', '0')));
RESET role;
SELECT is((SELECT harmony_permissions FROM public.discord_migration_discord_roles
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND discord_role_id = '400000000000000001'),
  17179869183::bigint, 'harmony_permissions round trips');
SELECT is((SELECT count(*)::int FROM public.discord_migration_discord_roles
            WHERE server_id = '55555555-0000-0000-0000-000000000005'),
  2, '@everyone (the guild id) is never stored');

INSERT INTO public.discord_migration_role_map (server_id, discord_role_id, harmony_role_id) VALUES
  ('55555555-0000-0000-0000-000000000005', '400000000000000001', 'f2740000-0000-0000-0000-0000000000c1'),
  ('55555555-0000-0000-0000-000000000005', '400000000000000002', 'f2740000-0000-0000-0000-0000000000c2');
SET LOCAL role service_role;
SELECT public.discord_migration_store_discord_roles('55555555-0000-0000-0000-000000000005', jsonb_build_array(
  jsonb_build_object('id', '400000000000000001', 'name', 'Admins renamed', 'color', 1, 'position', 6, 'harmony_permissions', '1')));
RESET role;
SELECT is((SELECT array_agg(discord_role_id) FROM public.discord_migration_role_map
            WHERE server_id = '55555555-0000-0000-0000-000000000005'),
  ARRAY['400000000000000001'], 'a role missing from the new snapshot loses its map row');
SELECT is((SELECT name || '/' || harmony_permissions FROM public.discord_migration_discord_roles
            WHERE server_id = '55555555-0000-0000-0000-000000000005'),
  'Admins renamed/1', 'the snapshot is replaced');

-- Warnings ----------------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.discord_migration_store_warnings('55555555-0000-0000-0000-000000000005', '["bot_cannot_ban"]'::jsonb);
RESET role;
SELECT is((SELECT readiness_warnings FROM public.discord_migrations WHERE server_id = '55555555-0000-0000-0000-000000000005'),
  '["bot_cannot_ban"]'::jsonb, 'store_warnings keeps the warnings');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_store_warnings('55555555-0000-0000-0000-000000000005', '[]'::jsonb)$q$,
  '42501', NULL, 'a client cannot store warnings');
SELECT throws_ok($q$SELECT public.discord_migration_store_discord_roles('55555555-0000-0000-0000-000000000005', '[]'::jsonb)$q$,
  '42501', NULL, 'a client cannot store the role snapshot');
SELECT tests.clear_authentication();

-- Links -------------------------------------------------------------------------------------------
SELECT throws_ok($q$INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status, sync_fields)
  VALUES ('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', '500000000000000001', 'active', '{nickname}')$q$,
  '23514', NULL, 'a sync field outside the list violates the check');
INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status, sync_fields)
VALUES ('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', '500000000000000001', 'active',
        '{avatar,server_nickname}');
SELECT throws_ok($q$INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status)
  VALUES ('55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', '500000000000000001', 'active')$q$,
  '23505', NULL, 'a Discord account links to one member per server');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.discord_migration_get('55555555-0000-0000-0000-000000000005') -> 'link_counts' ->> 'active', '1',
  'get counts the active link');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.discord_migration_members('55555555-0000-0000-0000-000000000005') -> 0) ->> 'discord_user_id', '500000000000000001',
  'members lists the link with its Discord account');
SELECT is((public.discord_migration_members('55555555-0000-0000-0000-000000000005') -> 0) ->> 'status', 'active',
  'members lists the link status');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.discord_migration_members('55555555-0000-0000-0000-000000000005')$q$,
  '42501', NULL, 'a member without MANAGE_SERVER cannot list the linked members');
SELECT tests.clear_authentication();

-- Open migrations keep their guild -----------------------------------------------------------------
UPDATE public.discord_migrations SET state = 'open', opened_at = now()
 WHERE server_id = '55555555-0000-0000-0000-000000000005';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_save('55555555-0000-0000-0000-000000000005', '123456789012345679', 'own')$q$,
  '55000', NULL, 'the guild id cannot change while the migration is open');
SELECT lives_ok($q$SELECT public.discord_migration_save('55555555-0000-0000-0000-000000000005', '123456789012345678', 'own')$q$,
  'saving the same guild id while open is allowed');
SELECT tests.clear_authentication();
UPDATE public.discord_migrations SET state = 'draft', opened_at = NULL
 WHERE server_id = '55555555-0000-0000-0000-000000000005';

-- A new guild drops the snapshot and the map -------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_migration_save('55555555-0000-0000-0000-000000000005', '123456789012345679', 'own');
SELECT tests.clear_authentication();
SELECT is((SELECT (SELECT count(*) FROM public.discord_migration_discord_roles WHERE server_id = '55555555-0000-0000-0000-000000000005')
              + (SELECT count(*) FROM public.discord_migration_role_map WHERE server_id = '55555555-0000-0000-0000-000000000005')),
  0::bigint, 'a draft that moves to another guild drops the role snapshot and map');

-- Role map, permission gaps, lifecycle ---------------------------------------------------------------
-- Server s4 (alice owns it):
--   mgr  role mgr (position 10): MANAGE_SERVER, MANAGE_ROLES, KICK_MEMBERS (648); no BAN_MEMBERS
--   srv  role srv (position 10): MANAGE_SERVER only (128): configures, cannot edit roles
--   adm  role adm (position 50): ADMINISTRATOR (1)
--   Harmony roles   h1 'moderator ' (5) VIEW_CHANNEL, h2 Helper (4), h3 Elite (20), h4 Boss (3, is_admin),
--                   h5 Gappy (6) VIEW_CHANNEL|PIN_MESSAGES, h6 Target (2)
--   Discord roles   d1 Moderator, d2 Helpers, d3 Elite, d4 Boss (snapshot ADMINISTRATOR), d5 Gappy
--                   (KICK|BAN|VIEW), d6 Admin gap (ADMINISTRATOR|VIEW), d7 everyone, d8 Chief
CREATE FUNCTION pg_temp.d(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT '4100000000000000' || lpad(n::text, 2, '0') $f$;
CREATE FUNCTION pg_temp.h(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT ('f2740000-0000-0000-0000-0000000000d' || n)::uuid $f$;
CREATE FUNCTION pg_temp.e(dn int, hn int) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT jsonb_build_object('discord_role_id', pg_temp.d(dn), 'harmony_role_id', pg_temp.h(hn)) $f$;
CREATE FUNCTION pg_temp.map4() RETURNS jsonb LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(jsonb_agg(jsonb_build_array(m.discord_role_id, m.harmony_role_id) ORDER BY m.discord_role_id), '[]'::jsonb)
    FROM public.discord_migration_role_map m WHERE m.server_id = 'f2740000-0000-0000-0000-0000000000a4' $f$;
CREATE FUNCTION pg_temp.perm(n int) RETURNS bigint LANGUAGE sql STABLE AS $f$
  SELECT permissions FROM public.server_roles WHERE id = pg_temp.h(n) $f$;

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('a2740000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dm-mgr@test.local'),
  ('a2740000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dm-srv@test.local'),
  ('a2740000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dm-adm@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('e2740000-0000-0000-0000-000000000001', 'a2740000-0000-0000-0000-000000000001', 'dmmgr', 'Mgr', true),
  ('e2740000-0000-0000-0000-000000000002', 'a2740000-0000-0000-0000-000000000002', 'dmsrv', 'Srv', true),
  ('e2740000-0000-0000-0000-000000000003', 'a2740000-0000-0000-0000-000000000003', 'dmadm', 'Adm', true);
INSERT INTO public.servers (id, name, owner)
VALUES ('f2740000-0000-0000-0000-0000000000a4', 'S4 274', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('e2740000-0000-0000-0000-000000000001', 'f2740000-0000-0000-0000-0000000000a4', 'accepted'),
  ('e2740000-0000-0000-0000-000000000002', 'f2740000-0000-0000-0000-0000000000a4', 'accepted'),
  ('e2740000-0000-0000-0000-000000000003', 'f2740000-0000-0000-0000-0000000000a4', 'accepted')
ON CONFLICT DO NOTHING;
INSERT INTO public.server_roles (id, server_id, name, position, permissions, is_admin) VALUES
  ('f2740000-0000-0000-0000-0000000000e1', 'f2740000-0000-0000-0000-0000000000a4', 'mgr', 10, 648, false),
  ('f2740000-0000-0000-0000-0000000000e2', 'f2740000-0000-0000-0000-0000000000a4', 'srv', 10, 128, false),
  ('f2740000-0000-0000-0000-0000000000e3', 'f2740000-0000-0000-0000-0000000000a4', 'adm', 50, 1, false),
  (pg_temp.h(1), 'f2740000-0000-0000-0000-0000000000a4', 'moderator ', 5, 2, false),
  (pg_temp.h(2), 'f2740000-0000-0000-0000-0000000000a4', 'Helper', 4, 0, false),
  (pg_temp.h(3), 'f2740000-0000-0000-0000-0000000000a4', 'Elite', 20, 0, false),
  (pg_temp.h(4), 'f2740000-0000-0000-0000-0000000000a4', 'Boss', 3, 0, true),
  (pg_temp.h(5), 'f2740000-0000-0000-0000-0000000000a4', 'Gappy', 6, 2 | 8388608, false),
  (pg_temp.h(6), 'f2740000-0000-0000-0000-0000000000a4', 'Target', 2, 0, false);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('e2740000-0000-0000-0000-000000000001', 'f2740000-0000-0000-0000-0000000000e1', 'f2740000-0000-0000-0000-0000000000a4'),
  ('e2740000-0000-0000-0000-000000000002', 'f2740000-0000-0000-0000-0000000000e2', 'f2740000-0000-0000-0000-0000000000a4'),
  ('e2740000-0000-0000-0000-000000000003', 'f2740000-0000-0000-0000-0000000000e3', 'f2740000-0000-0000-0000-0000000000a4');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_migration_save('f2740000-0000-0000-0000-0000000000a4', '900000000000000401', 'own');
SELECT public.discord_migration_set_own_credentials('f2740000-0000-0000-0000-0000000000a4',
  '300000000000000278', 'abcdefghijklmnopqrstuvwxyz274003',
  ('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GabcDE.' || 'abcdefghijklmnopqrstuvwxyz0123456789AB'));
SELECT tests.clear_authentication();
INSERT INTO public.discord_migration_discord_roles (server_id, discord_role_id, name, position, harmony_permissions) VALUES
  ('f2740000-0000-0000-0000-0000000000a4', pg_temp.d(1), 'Moderator', 5, 0);

-- Readiness: one unmapped role, then mapped
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('ready1', public.discord_migration_readiness('f2740000-0000-0000-0000-0000000000a4'));
INSERT INTO out VALUES ('map1', public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1))));
SELECT tests.clear_authentication();
SELECT ok((SELECT v ->> 'ready' = 'false' AND v ->> 'has_credentials' = 'true' AND v ->> 'has_guild' = 'true'
                  AND v ->> 'roles_fetched' = 'true'
                  AND v -> 'unmapped_roles' = jsonb_build_array(jsonb_build_object('discord_role_id', pg_temp.d(1), 'name', 'Moderator'))
             FROM out WHERE k = 'ready1'),
  'readiness is false with one unmapped role and lists it');
SELECT ok((SELECT v ->> 'ready' = 'true' AND v -> 'unmapped_roles' = '[]'::jsonb FROM out WHERE k = 'map1'),
  'save_role_map returns readiness, ready once the role is mapped');

INSERT INTO public.discord_migration_discord_roles (server_id, discord_role_id, name, position, harmony_permissions) VALUES
  ('f2740000-0000-0000-0000-0000000000a4', pg_temp.d(2), 'Helpers', 4, 0),
  ('f2740000-0000-0000-0000-0000000000a4', pg_temp.d(3), 'Elite', 20, 0),
  ('f2740000-0000-0000-0000-0000000000a4', pg_temp.d(4), 'Boss', 3, 1),
  ('f2740000-0000-0000-0000-0000000000a4', pg_temp.d(5), 'Gappy', 6, 2 | 512 | 1024),
  ('f2740000-0000-0000-0000-0000000000a4', pg_temp.d(6), 'Admin gap', 2, 3),
  ('f2740000-0000-0000-0000-0000000000a4', pg_temp.d(7), 'everyone', 1, 0),
  ('f2740000-0000-0000-0000-0000000000a4', pg_temp.d(8), 'Chief', 1, 0);

-- Auto match
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('match', public.discord_migration_auto_match('f2740000-0000-0000-0000-0000000000a4'));
SELECT tests.clear_authentication();
SELECT ok((SELECT v @> jsonb_build_array(jsonb_build_object('discord_role_id', pg_temp.d(1), 'harmony_role_id', pg_temp.h(1)))
             FROM out WHERE k = 'match'),
  'auto_match pairs Moderator with "moderator " by trimmed, case-insensitive name');
SELECT ok((SELECT v @> jsonb_build_array(jsonb_build_object('discord_role_id', pg_temp.d(2), 'harmony_role_id', NULL))
                  AND v @> jsonb_build_array(jsonb_build_object('discord_role_id', pg_temp.d(7), 'harmony_role_id', NULL))
                  AND jsonb_array_length(v) = 8
             FROM out WHERE k = 'match'),
  'auto_match proposes nothing for inexact names or the default role, and lists every Discord role');
SELECT is(pg_temp.map4(), jsonb_build_array(jsonb_build_array(pg_temp.d(1), pg_temp.h(1))), 'auto_match writes nothing');

-- Hierarchy: a manager maps only roles below their own top role; the owner maps any
SELECT tests.authenticate_as('a2740000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2)))$q$,
  'a MANAGE_SERVER manager maps a role below their own');
SELECT throws_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3)))$q$,
  '42501', NULL, 'a manager cannot map a role at or above their own top role');
SELECT tests.clear_authentication();
SELECT is(pg_temp.map4(), jsonb_build_array(jsonb_build_array(pg_temp.d(1), pg_temp.h(1)), jsonb_build_array(pg_temp.d(2), pg_temp.h(2))),
  'the refused map left the map unchanged');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3)))$q$,
  'the owner maps a role above any manager');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('a2740000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3)))$q$,
  'a manager re-saving the map with an unchanged high row is not refused');
SELECT throws_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2)))$q$,
  '42501', NULL, 'a manager cannot unmap a role at or above their own top role');
SELECT tests.clear_authentication();

-- Administrator-bearing rows are owner-only and need confirmation
SELECT tests.authenticate_as('a2740000-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3), pg_temp.e(4, 2)))$q$,
  '42501', 'ADMIN_ROLE_OWNER_ONLY', 'a manager cannot map a Discord role that carries ADMINISTRATOR');
SELECT tests.clear_authentication();
SELECT is(jsonb_array_length(pg_temp.map4()), 3, 'the refused admin map wrote nothing');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3), pg_temp.e(4, 2)))$q$,
  'P0001', 'ADMIN_ROLE_NEEDS_CONFIRM', 'the owner needs to confirm an administrator mapping');
SELECT tests.clear_authentication();
SELECT is(jsonb_array_length(pg_temp.map4()), 3, 'the unconfirmed admin map wrote nothing');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3), pg_temp.e(4, 2)), p_confirm_admin => true)$q$,
  'the owner saves an administrator mapping with confirmation');
SELECT lives_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3), pg_temp.e(4, 2)))$q$,
  'saving the same map again needs no confirmation');
SELECT tests.clear_authentication();
SELECT is(jsonb_array_length(pg_temp.map4()), 4, 'the confirmed admin map was written');

SELECT tests.authenticate_as('a2740000-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3), pg_temp.e(4, 2), pg_temp.e(8, 4)))$q$,
  '42501', 'ADMIN_ROLE_OWNER_ONLY', 'a manager cannot map onto a Harmony role with is_admin');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3), pg_temp.e(4, 2), pg_temp.e(8, 4)))$q$,
  'P0001', 'ADMIN_ROLE_NEEDS_CONFIRM', 'the owner needs to confirm a mapping onto a Harmony role with is_admin');
SELECT lives_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3), pg_temp.e(4, 2), pg_temp.e(8, 4)), true)$q$,
  'the owner confirms it');

-- Unmappable Harmony roles
SELECT throws_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), jsonb_build_object('discord_role_id', pg_temp.d(7), 'harmony_role_id',
    (SELECT id FROM public.server_roles WHERE server_id = 'f2740000-0000-0000-0000-0000000000a4' AND is_default))))$q$,
  '22023', NULL, 'the default role cannot be mapped');
SELECT throws_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), jsonb_build_object('discord_role_id', pg_temp.d(7), 'harmony_role_id',
    'f2740000-0000-0000-0000-0000000000c1')))$q$,
  '22023', NULL, 'a role of another server cannot be mapped');

-- The map the later checks use
SELECT lives_ok($q$SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a4',
  jsonb_build_array(pg_temp.e(1, 1), pg_temp.e(2, 2), pg_temp.e(3, 3), pg_temp.e(4, 2), pg_temp.e(5, 5),
                    pg_temp.e(6, 6), pg_temp.e(8, 4)), true)$q$,
  'the owner saves the full map');
SELECT tests.clear_authentication();

-- Admin impact lists active holders only
INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status, discord_role_ids) VALUES
  ('f2740000-0000-0000-0000-0000000000a4', 'e2740000-0000-0000-0000-000000000001', '510000000000000001', 'active', ARRAY[pg_temp.d(4), pg_temp.d(1)]),
  ('f2740000-0000-0000-0000-0000000000a4', 'e2740000-0000-0000-0000-000000000002', '510000000000000002', 'left', ARRAY[pg_temp.d(4)]),
  ('f2740000-0000-0000-0000-0000000000a4', 'e2740000-0000-0000-0000-000000000003', '510000000000000003', 'active', ARRAY[pg_temp.d(1)]);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('impact', public.discord_migration_admin_impact('f2740000-0000-0000-0000-0000000000a4', pg_temp.d(4)));
SELECT tests.clear_authentication();
SELECT is((SELECT v FROM out WHERE k = 'impact'),
  jsonb_build_object('holders', jsonb_build_array(jsonb_build_object(
    'user_id', 'e2740000-0000-0000-0000-000000000001', 'username', 'dmmgr', 'display_name', 'Mgr'))),
  'admin_impact lists the active holder and not the member who left');

-- Permission gaps
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('gaps', public.discord_migration_permission_gaps('f2740000-0000-0000-0000-0000000000a4'));
SELECT tests.clear_authentication();
SELECT is((SELECT e -> 'missing' FROM out, jsonb_array_elements(v) e WHERE k = 'gaps' AND e ->> 'discord_role_id' = pg_temp.d(5)),
  '["KICK_MEMBERS","BAN_MEMBERS"]'::jsonb, 'permission_gaps names the bits the Discord role has and the Harmony role lacks, in bit order');
SELECT ok((SELECT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE e ->> 'discord_role_id' IN (pg_temp.d(1), pg_temp.d(2), pg_temp.d(3)))
                  AND (SELECT e ->> 'harmony_role_id' FROM jsonb_array_elements(v) e WHERE e ->> 'discord_role_id' = pg_temp.d(5)) = pg_temp.h(5)::text
             FROM out WHERE k = 'gaps'),
  'permission_gaps omits rows with nothing missing');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.discord_migration_get('f2740000-0000-0000-0000-0000000000a4') -> 'permission_gaps',
  (SELECT v FROM out WHERE k = 'gaps'), 'get carries the permission gaps');
SELECT tests.clear_authentication();

-- Applying permissions: the caller's own rights decide
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.discord_migration_apply_permissions('f2740000-0000-0000-0000-0000000000a4', ARRAY['4100000000000000'||'05'])$q$,
  '42501', NULL, 'a non-manager cannot apply permissions');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('a2740000-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.discord_migration_apply_permissions('f2740000-0000-0000-0000-0000000000a4', ARRAY['4100000000000000'||'05'])$q$,
  '42501', 'Missing permission: MANAGE_ROLES', 'a manager without MANAGE_ROLES cannot apply permissions');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('a2740000-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_apply_permissions('f2740000-0000-0000-0000-0000000000a4', ARRAY['4100000000000000'||'05'])$q$,
  '42501', 'Cannot grant BAN_MEMBERS without holding it', 'a manager cannot grant BAN_MEMBERS without holding it');
SELECT tests.clear_authentication();
SELECT is(pg_temp.perm(5), 8388610::bigint, 'the refused applies left the Harmony role unchanged');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('apply1', public.discord_migration_apply_permissions('f2740000-0000-0000-0000-0000000000a4', ARRAY['4100000000000000'||'05']));
INSERT INTO out VALUES ('apply2', public.discord_migration_apply_permissions('f2740000-0000-0000-0000-0000000000a4', ARRAY['4100000000000000'||'05']));
SELECT tests.clear_authentication();
SELECT is((SELECT v FROM out WHERE k = 'apply1'),
  jsonb_build_object('updated', jsonb_build_array(jsonb_build_object('harmony_role_id', pg_temp.h(5), 'added', jsonb_build_array('KICK_MEMBERS', 'BAN_MEMBERS')))),
  'the owner applies the gap and gets the added bits');
SELECT is(pg_temp.perm(5), (2 | 8388608 | 512 | 1024)::bigint, 'the Harmony role gained exactly the gap and kept its Harmony-only bit');
SELECT is((SELECT v FROM out WHERE k = 'apply2'), '{"updated":[]}'::jsonb, 'applying again changes nothing');

SELECT tests.authenticate_as('a2740000-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.discord_migration_apply_permissions('f2740000-0000-0000-0000-0000000000a4', ARRAY['4100000000000000'||'06'], true)$q$,
  '42501', 'ADMIN_ROLE_OWNER_ONLY', 'a non-owner holding ADMINISTRATOR cannot apply an ADMINISTRATOR gap');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_apply_permissions('f2740000-0000-0000-0000-0000000000a4', ARRAY['4100000000000000'||'06'])$q$,
  'P0001', 'ADMIN_ROLE_NEEDS_CONFIRM', 'the owner needs to confirm an ADMINISTRATOR gap');
SELECT tests.clear_authentication();
SELECT is(pg_temp.perm(6), 0::bigint, 'the refused ADMINISTRATOR applies left the role unchanged');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_apply_permissions('f2740000-0000-0000-0000-0000000000a4', ARRAY['4100000000000000'||'06'], true)$q$,
  'the owner applies an ADMINISTRATOR gap with confirmation');
SELECT tests.clear_authentication();
SELECT is(pg_temp.perm(6), 3::bigint, 'and the role gained ADMINISTRATOR and VIEW_CHANNEL');

-- Lifecycle (server s3: instance bot enabled, so credentials are present)
INSERT INTO public.server_roles (id, server_id, name, position, permissions)
VALUES ('f2740000-0000-0000-0000-0000000000f1', 'f2740000-0000-0000-0000-0000000000a3', 'S3Role', 1, 0);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_set_state('f2740000-0000-0000-0000-0000000000a3', 'open')$q$,
  'P0001', 'MIGRATION_NOT_READY', 'a migration without a role snapshot cannot open');
SELECT tests.clear_authentication();
INSERT INTO public.discord_migration_discord_roles (server_id, discord_role_id, name, position, harmony_permissions)
VALUES ('f2740000-0000-0000-0000-0000000000a3', '420000000000000001', 'S3 Discord', 1, 0);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_set_state('f2740000-0000-0000-0000-0000000000a3', 'open')$q$,
  'P0001', 'MIGRATION_NOT_READY', 'a migration with an unmapped role cannot open');
SELECT public.discord_migration_save_role_map('f2740000-0000-0000-0000-0000000000a3',
  jsonb_build_array(jsonb_build_object('discord_role_id', '420000000000000001', 'harmony_role_id', 'f2740000-0000-0000-0000-0000000000f1')));
SELECT throws_ok($q$SELECT public.discord_migration_request_sync('f2740000-0000-0000-0000-0000000000a3')$q$,
  '55000', NULL, 'a sync can be requested only while open');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.discord_migration_set_state('f2740000-0000-0000-0000-0000000000a3', 'open')$q$,
  '42501', NULL, 'a non-manager cannot change the state');
SELECT throws_ok($q$SELECT public.discord_migration_request_sync('f2740000-0000-0000-0000-0000000000a3')$q$,
  '42501', NULL, 'a non-manager cannot request a sync');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('open1', public.discord_migration_set_state('f2740000-0000-0000-0000-0000000000a3', 'open'));
SELECT tests.clear_authentication();
SELECT ok((SELECT state = 'open' AND opened_at IS NOT NULL AND finished_at IS NULL AND sync_requested_at IS NOT NULL
             FROM public.discord_migrations WHERE server_id = 'f2740000-0000-0000-0000-0000000000a3'),
  'opening sets opened_at and asks for a sync');
SELECT is((SELECT v ->> 'state' FROM out WHERE k = 'open1'), 'open', 'set_state returns the configuration');

UPDATE public.discord_migrations SET sync_requested_at = NULL WHERE server_id = 'f2740000-0000-0000-0000-0000000000a3';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_request_sync('f2740000-0000-0000-0000-0000000000a3')$q$, 'a sync can be requested while open');
SELECT throws_ok($q$SELECT public.discord_migration_set_state('f2740000-0000-0000-0000-0000000000a3', 'open')$q$,
  '55000', NULL, 'an open migration cannot be opened again');
SELECT throws_ok($q$SELECT public.discord_migration_set_state('f2740000-0000-0000-0000-0000000000a3', 'draft')$q$,
  '22023', NULL, 'a migration cannot return to draft');
SELECT tests.clear_authentication();
UPDATE public.discord_migrations SET sync_paused_reason = 'removal_brake', sync_requested_at = NULL
 WHERE server_id = 'f2740000-0000-0000-0000-0000000000a3';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_set_state('f2740000-0000-0000-0000-0000000000a3', 'open')$q$,
  'a paused open migration resumes');
SELECT tests.clear_authentication();
SELECT ok((SELECT state = 'open' AND sync_paused_reason IS NULL AND sync_requested_at IS NOT NULL
             FROM public.discord_migrations WHERE server_id = 'f2740000-0000-0000-0000-0000000000a3'),
  'resuming clears the pause and asks for a sync');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_set_state('f2740000-0000-0000-0000-0000000000a3', 'finished')$q$, 'an open migration finishes');
SELECT tests.clear_authentication();
SELECT ok((SELECT sync_requested_at IS NOT NULL FROM public.discord_migrations WHERE server_id = 'f2740000-0000-0000-0000-0000000000a3'),
  'request_sync stored the time');
SELECT ok((SELECT state = 'finished' AND finished_at IS NOT NULL FROM public.discord_migrations WHERE server_id = 'f2740000-0000-0000-0000-0000000000a3'),
  'finishing sets finished_at');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_migration_request_sync('f2740000-0000-0000-0000-0000000000a3')$q$,
  '55000', NULL, 'a finished migration takes no sync request');
SELECT throws_ok($q$SELECT public.discord_migration_save('f2740000-0000-0000-0000-0000000000a3', '900000000000000299', 'instance_bot')$q$,
  '55000', NULL, 'a finished migration keeps its guild');
SELECT tests.clear_authentication();

UPDATE public.discord_migrations SET sync_requested_at = NULL, sync_paused_reason = 'removal_brake'
 WHERE server_id = 'f2740000-0000-0000-0000-0000000000a3';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_set_state('f2740000-0000-0000-0000-0000000000a3', 'open')$q$, 'a finished migration reopens');
SELECT tests.clear_authentication();
SELECT ok((SELECT state = 'open' AND finished_at IS NULL AND sync_paused_reason IS NULL AND sync_requested_at IS NOT NULL
             FROM public.discord_migrations WHERE server_id = 'f2740000-0000-0000-0000-0000000000a3'),
  'reopening clears finished_at and the pause, and asks for a sync');

-- Deleting the migration deletes its Vault secrets --------------------------------------------------
SELECT bot_token_secret AS tok2, client_secret_secret AS cs2
  FROM public.discord_migration_secrets WHERE server_id = '55555555-0000-0000-0000-000000000005' \gset
DELETE FROM public.discord_migrations WHERE server_id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'tok2', :'cs2')), 0,
  'deleting the migration deletes its Vault secrets');
SELECT is((SELECT count(*)::int FROM public.discord_migration_secrets WHERE server_id = '55555555-0000-0000-0000-000000000005'), 0,
  'and its secrets row');

SELECT * FROM finish();
ROLLBACK;
