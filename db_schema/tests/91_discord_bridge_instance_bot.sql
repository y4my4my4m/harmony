-- 20261008800001_discord_bridge_instance_bot.sql: grants and RLS, the instance bot's admin
-- RPCs and Vault secrets, link states, linking a Discord guild, the instance limit, heartbeats
-- of instance bridges, the host's view and deletion.
--
--   alice    owner of server_1 (fixture), s2 and s4
--   bob      accepted member of server_1 without MANAGE_SERVER; no instance admin
--   mallory  owner of s3, which runs a self-run bridge
--   erin     instance admin
--
-- Discord: application 300000000000000091; guilds g1 100000000000000091, g2 ...092, g3 ...093,
-- g9 ...099; channel d1 200000000000000091 in g1.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(90);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;
GRANT USAGE ON SCHEMA tests TO service_role;

-- Setup, as postgres. -----------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('eeeeeeee-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'erin@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin)
VALUES ('91000000-0000-0000-0000-0000000000e5', 'eeeeeeee-0000-0000-0000-000000000005', 'erin', 'Erin', true, true);
INSERT INTO public.servers (id, name, owner) VALUES
  ('91000000-0000-0000-0000-0000000000a2', 'Second Server', '11111111-0000-0000-0000-000000000001'),
  ('91000000-0000-0000-0000-0000000000a3', 'Mallory Server', '33333333-0000-0000-0000-000000000003'),
  ('91000000-0000-0000-0000-0000000000a4', 'Spare Server', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridges (server_id, mode, created_by)
VALUES ('91000000-0000-0000-0000-0000000000a3', 'self', '33333333-0000-0000-0000-000000000003');
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'discord_bridge_hosting_enabled';

-- Grants and RLS. ---------------------------------------------------------------------------
SELECT ok((SELECT bool_and(c.relrowsecurity) FROM pg_class c
            WHERE c.oid IN ('public.discord_bridge_instance_bot'::regclass, 'public.discord_bridge_link_states'::regclass)),
  'RLS is on for the instance bot and link state tables');
SELECT ok(NOT EXISTS (SELECT 1
                        FROM unnest(ARRAY['discord_bridge_instance_bot', 'discord_bridge_link_states']) t,
                             unnest(ARRAY['anon', 'authenticated']) r,
                             unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
                       WHERE has_table_privilege(r, 'public.' || t, p)),
  'clients hold no privilege on the instance bot and link state tables');
SELECT ok(has_table_privilege('service_role', 'public.discord_bridge_instance_bot', 'SELECT')
      AND has_table_privilege('service_role', 'public.discord_bridge_link_states', 'SELECT'),
  'service_role holds both tables');

CREATE TEMP TABLE client_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO client_fns VALUES
  ('public.discord_bridge_instance_link(uuid)'), ('public.discord_bridge_instance_bot_set(text, text, text)'),
  ('public.discord_bridge_instance_bot_clear()'), ('public.discord_bridge_instance_bot_status()');
CREATE TEMP TABLE service_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO service_fns VALUES
  ('public.discord_bridge_instance_link_check(text, text)'),
  ('public.discord_bridge_instance_link_complete(text, text, text)'),
  ('public.discord_bridge_instance_hosted()'), ('public.discord_bridge_instance_bot_secrets()');
CREATE TEMP TABLE internal_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO internal_fns VALUES
  ('public.discord_bridge_instance_bot_enabled()'), ('public.discord_bridge_instance_presence()'),
  ('public.discord_bridge_instance_bot_limit()'), ('public.discord_bridge_instance_bot_configured()'),
  ('public.discord_bridge_instance_linked_count(uuid)'), ('public.discord_bridge_instance_bot_purge()');

SELECT is_empty($q$SELECT fn FROM client_fns WHERE has_function_privilege('anon', fn, 'EXECUTE')$q$,
  'anon executes no instance bot RPC');
SELECT is_empty($q$SELECT fn FROM client_fns WHERE NOT has_function_privilege('authenticated', fn, 'EXECUTE')$q$,
  'authenticated executes the instance bot RPCs, which check the caller');
SELECT is_empty($q$SELECT fn FROM service_fns
                    WHERE has_function_privilege('anon', fn, 'EXECUTE')
                       OR has_function_privilege('authenticated', fn, 'EXECUTE')$q$,
  'clients execute no instance bot gateway function');
SELECT is_empty($q$SELECT fn FROM service_fns WHERE NOT has_function_privilege('service_role', fn, 'EXECUTE')$q$,
  'service_role executes the instance bot gateway functions');
SELECT is_empty($q$SELECT fn FROM internal_fns
                    WHERE has_function_privilege('anon', fn, 'EXECUTE')
                       OR has_function_privilege('authenticated', fn, 'EXECUTE')
                       OR has_function_privilege('service_role', fn, 'EXECUTE')$q$,
  'internal instance bot helpers are executable by their owner alone');
SELECT ok(NOT has_function_privilege('authenticated', 'public.discord_bridge_report_status(uuid, jsonb, jsonb, text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.discord_bridge_set_guild(uuid, text)', 'EXECUTE'),
  'the replaced bridge functions keep their grants');
SELECT results_eq(
  $q$SELECT config_key, config_value FROM public.instance_config
      WHERE config_key IN ('discord_bridge_instance_bot_enabled', 'discord_bridge_instance_presence',
                           'discord_bridge_instance_bot_limit') ORDER BY 1$q$,
  $q$VALUES ('discord_bridge_instance_bot_enabled', 'false'::jsonb), ('discord_bridge_instance_bot_limit', '100'::jsonb),
            ('discord_bridge_instance_presence', 'false'::jsonb)$q$,
  'the instance bot is off by default, without presence, with a limit of 100');
SELECT ok('discord_bridge_instance_bot_enabled' = ANY (public.public_instance_config_keys())
      AND NOT ('discord_bridge_instance_bot_limit' = ANY (public.public_instance_config_keys()))
      AND NOT ('discord_bridge_instance_presence' = ANY (public.public_instance_config_keys())),
  'only the enabled flag is a public instance key');
SELECT ok('discord_bridge_hosting_enabled' = ANY (public.public_instance_config_keys()),
  'the hosting flag stays public');

-- Admin RPCs. -------------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.discord_bridge_instance_bot_status()$q$, '42501', NULL,
  'anon reads no instance bot status');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_bot_status()$q$, '42501', NULL,
  'a user who is no instance admin reads no instance bot status');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_bot_set('300000000000000091', NULL, NULL)$q$, '42501', NULL,
  'a non-admin cannot configure the instance bot');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_bot_clear()$q$, '42501', NULL,
  'a non-admin cannot clear the instance bot');
SELECT throws_ok($q$SELECT count(*) FROM public.discord_bridge_instance_bot$q$, '42501', NULL,
  'a client cannot read the instance bot row');

SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000005');
SELECT is(public.discord_bridge_instance_bot_status(),
  '{"enabled":false,"configured":false,"application_id":null,"has_client_secret":false,"has_bot_token":false,
    "bot_user_name":null,"linked_count":0,"limit":100,"presence":false}'::jsonb,
  'an unconfigured instance bot reports nothing stored');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_bot_set(NULL, NULL, NULL)$q$, '22023', NULL,
  'the first configuration needs an application id');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_bot_set('12345', NULL, NULL)$q$, '22023', NULL,
  'an application id must be a Discord snowflake');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_bot_set('300000000000000091', 'not a secret!', NULL)$q$, '22023', NULL,
  'a malformed client secret is refused');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_bot_set('300000000000000091', NULL, 'not a token')$q$, '22023', NULL,
  'a malformed bot token is refused');
INSERT INTO out VALUES ('set1', public.discord_bridge_instance_bot_set(' 300000000000000091 ',
  'abcdefghijklmnopqrstuvwxyz012345',
  ('Bot MTAxMDEwMTAxMDEwMTAxMDEw' || '.GabcDE.' || 'abcdefghijklmnopqrstuvwxyz0123456789AB')));
SELECT tests.clear_authentication();

SELECT is((SELECT v - 'linked_count' FROM out WHERE k = 'set1'),
  '{"enabled":false,"configured":true,"application_id":"300000000000000091","has_client_secret":true,
    "has_bot_token":true,"bot_user_name":null,"limit":100,"presence":false}'::jsonb,
  'storing the application and both secrets reports it configured, still disabled');
SELECT bot_token_secret AS tok1, client_secret_secret AS cs1 FROM public.discord_bridge_instance_bot \gset
SELECT results_eq(
  format($q$SELECT (SELECT decrypted_secret COLLATE "default" FROM vault.decrypted_secrets WHERE id = %L),
                   (SELECT decrypted_secret COLLATE "default" FROM vault.decrypted_secrets WHERE id = %L)$q$, :'tok1', :'cs1'),
  $q$VALUES (('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GabcDE.' || 'abcdefghijklmnopqrstuvwxyz0123456789AB'),
             'abcdefghijklmnopqrstuvwxyz012345')$q$,
  'both secrets are Vault secrets; the token loses its Bot prefix');
SELECT ok((SELECT bool_and(action_details::text NOT LIKE '%abcdefghijklmnopqrstuvwxyz%')
             FROM public.admin_audit_log WHERE target_id = 'discord_bridge_instance_bot')
      AND EXISTS (SELECT 1 FROM public.admin_audit_log
                   WHERE target_id = 'discord_bridge_instance_bot' AND action_type = 'config_change'
                     AND admin_id = '91000000-0000-0000-0000-0000000000e5'),
  'the change is logged for the admin, without its secrets');

SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000005');
SELECT lives_ok($q$SELECT public.discord_bridge_instance_bot_set('', '',
  ('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GxyzDE.' || 'zyxwvutsrqponmlkjihgfedcba9876543210ZY'))$q$,
  'an admin replaces the bot token alone');
SELECT tests.clear_authentication();
SELECT results_eq(
  format($q$SELECT application_id, client_secret_secret = %L, bot_token_secret <> %L,
                   (SELECT count(*)::int FROM vault.secrets WHERE id = %L)
              FROM public.discord_bridge_instance_bot$q$, :'cs1', :'tok1', :'tok1'),
  $q$VALUES ('300000000000000091', true, true, 0)$q$,
  'empty fields keep the application and client secret; the replaced token''s Vault row is gone');

-- Linking. ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_link('55555555-0000-0000-0000-000000000005')$q$,
  '0A000', 'instance_bot_unavailable', 'linking needs the instance bot enabled');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'discord_bridge_instance_bot_enabled';

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.discord_bridge_instance_link('55555555-0000-0000-0000-000000000005')$q$,
  '42501', NULL, 'anon cannot link');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_link('55555555-0000-0000-0000-000000000005')$q$,
  '42501', NULL, 'a member without MANAGE_SERVER cannot link');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_link('55555555-0000-0000-0000-000000000005')$q$,
  '42501', NULL, 'a non-member cannot link');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_link('91000000-0000-0000-0000-0000000000a3')$q$,
  '23505', 'bridge_exists', 'a server with a bridge in another mode is refused');
SELECT throws_ok($q$SELECT public.discord_bridge_create('91000000-0000-0000-0000-0000000000a4', 'instance')$q$,
  '22023', NULL, 'discord_bridge_create does not create instance bridges');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('link1', public.discord_bridge_instance_link('55555555-0000-0000-0000-000000000005'));
INSERT INTO out VALUES ('link2', public.discord_bridge_instance_link('55555555-0000-0000-0000-000000000005'));
SELECT is((SELECT count(*)::int FROM public.discord_bridges WHERE mode = 'instance'), 1,
  'the manager reads the instance bridge');
SELECT throws_ok($q$SELECT count(*) FROM public.discord_bridge_link_states$q$, '42501', NULL,
  'a client cannot read link states');
SELECT tests.clear_authentication();

SELECT v->>'bridge_id' AS i1, v->>'state' AS st1 FROM out WHERE k = 'link1' \gset
SELECT v->>'state' AS st2 FROM out WHERE k = 'link2' \gset
SELECT bot_id AS i1_bot FROM public.discord_bridges WHERE id = :'i1' \gset
SELECT ok(:'st1' ~ '^[0-9a-f]{64}$' AND :'st2' ~ '^[0-9a-f]{64}$' AND :'st1' <> :'st2',
  'a state is 64 hex characters, new on every link');
SELECT is((SELECT v->>'bridge_id' FROM out WHERE k = 'link2'), :'i1', 'linking again reuses the bridge');
SELECT results_eq(
  format($q$SELECT b.mode, b.created_by, b.discord_guild_id, bo.bot_type, bo.owner_id,
                   p.read_messages AND p.send_messages AND p.manage_channels
              FROM public.discord_bridges b
              JOIN public.bots bo ON bo.id = b.bot_id
              JOIN public.bot_server_permissions p ON p.bot_id = b.bot_id AND p.server_id = b.server_id
             WHERE b.id = %L$q$, :'i1'),
  $q$VALUES ('instance', '11111111-0000-0000-0000-000000000001'::uuid, NULL::text, 'bridge',
             '11111111-0000-0000-0000-000000000001'::uuid, true)$q$,
  'the first link creates an unlinked instance bridge with its bridge bot installed');
SELECT harmony_token_secret AS i1_hsec FROM public.discord_bridge_secrets WHERE bridge_id = :'i1' \gset
SELECT results_eq(
  format($q$SELECT s.discord_token_secret IS NULL,
                   public.verify_bot_token(encode(sha256(convert_to(d.decrypted_secret, 'UTF8')), 'hex'))->>'bot_id'
              FROM public.discord_bridge_secrets s
              JOIN vault.decrypted_secrets d ON d.id = s.harmony_token_secret
             WHERE s.bridge_id = %L$q$, :'i1'),
  format($q$VALUES (true, %L)$q$, :'i1_bot'),
  'the bridge bot''s Harmony token is a Vault secret and no Discord token is stored');
SELECT is((SELECT count(*)::int FROM public.bot_tokens WHERE bot_id = :'i1_bot' AND is_active), 1,
  'linking again issues no second Harmony token');
SELECT results_eq(
  format($q$SELECT state_hash = encode(sha256(convert_to(%L, 'UTF8')), 'hex'), used_at IS NOT NULL,
                   expires_at BETWEEN now() + interval '14 minutes' AND now() + interval '16 minutes',
                   created_by
              FROM public.discord_bridge_link_states WHERE bridge_id = %L ORDER BY used_at NULLS LAST$q$,
         :'st1', :'i1'),
  $q$VALUES (true, true, true, '11111111-0000-0000-0000-000000000001'::uuid),
            (false, false, true, '11111111-0000-0000-0000-000000000001'::uuid)$q$,
  'states are stored as SHA-256 with a 15 minute expiry; a new state marks the earlier one used');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.discord_bridge_link_states WHERE state_hash IN (:'st1', :'st2')),
  'no raw state is stored');

-- Preflight and completion (gateway). -------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format($q$SELECT public.discord_bridge_instance_link_complete(%L, '100000000000000091', 'Guild One')$q$, :'st2'),
  '42501', NULL, 'a client cannot complete a link');
SELECT throws_ok(format($q$SELECT public.discord_bridge_instance_link_check(%L, NULL)$q$, :'st2'),
  '42501', NULL, 'a client cannot check a state');
SELECT tests.clear_authentication();

SET LOCAL role service_role;
INSERT INTO out VALUES ('chk_bad', public.discord_bridge_instance_link_check('nope', NULL));
INSERT INTO out VALUES ('chk_unknown', public.discord_bridge_instance_link_check(repeat('a', 64), NULL));
INSERT INTO out VALUES ('chk_old', public.discord_bridge_instance_link_check(:'st1', NULL));
INSERT INTO out VALUES ('chk_ok', public.discord_bridge_instance_link_check(:'st2', '100000000000000091'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'chk_bad'), '{"bridge_id":null,"server_id":null,"error":"state_invalid"}'::jsonb,
  'a malformed state is invalid and names no server');
SELECT is((SELECT v FROM out WHERE k = 'chk_unknown'), '{"bridge_id":null,"server_id":null,"error":"state_invalid"}'::jsonb,
  'a state never issued is invalid and names no server');
SELECT is((SELECT v FROM out WHERE k = 'chk_old'),
  jsonb_build_object('bridge_id', :'i1', 'server_id', '55555555-0000-0000-0000-000000000005', 'error', 'state_invalid'),
  'a superseded state is invalid and names its server');
SELECT is((SELECT v FROM out WHERE k = 'chk_ok'),
  jsonb_build_object('bridge_id', :'i1', 'server_id', '55555555-0000-0000-0000-000000000005', 'error', NULL),
  'the current state passes the preflight');

UPDATE public.discord_bridges SET updated_at = '2000-01-01' WHERE id = :'i1';
SET LOCAL role service_role;
SELECT throws_ok(format($q$SELECT public.discord_bridge_instance_link_complete(%L, 'guild', 'Guild One')$q$, :'st2'),
  '22023', NULL, 'a guild id must be a Discord snowflake');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_link_complete(repeat('b', 64), '100000000000000091', 'Guild One')$q$,
  'P0002', 'state_invalid', 'an unknown state completes nothing');
SELECT throws_ok(format($q$SELECT public.discord_bridge_instance_link_complete(%L, '100000000000000091', 'Guild One')$q$, :'st1'),
  'P0002', 'state_invalid', 'a superseded state completes nothing');
INSERT INTO out VALUES ('done1', public.discord_bridge_instance_link_complete(:'st2', '100000000000000091', ' Guild One '));
SELECT throws_ok(format($q$SELECT public.discord_bridge_instance_link_complete(%L, '100000000000000091', 'Guild One')$q$, :'st2'),
  'P0002', 'state_invalid', 'a state completes once');
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'done1'),
  jsonb_build_object('bridge_id', :'i1', 'server_id', '55555555-0000-0000-0000-000000000005'),
  'completing answers with the bridge and its server');
SELECT results_eq(
  format($q$SELECT discord_guild_id, discord_guild_name, updated_at = now() FROM public.discord_bridges WHERE id = %L$q$, :'i1'),
  $q$VALUES ('100000000000000091', 'Guild One', true)$q$,
  'completing links the guild from the token response, a configuration change the gateway announces');

-- One instance bridge per guild. ------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('link_s2', public.discord_bridge_instance_link('91000000-0000-0000-0000-0000000000a2'));
SELECT tests.clear_authentication();
SELECT v->>'bridge_id' AS i2, v->>'state' AS st3 FROM out WHERE k = 'link_s2' \gset
SELECT bot_id AS i2_bot FROM public.discord_bridges WHERE id = :'i2' \gset
SET LOCAL role service_role;
INSERT INTO out VALUES ('chk_taken', public.discord_bridge_instance_link_check(:'st3', '100000000000000091'));
SELECT throws_ok(format($q$SELECT public.discord_bridge_instance_link_complete(%L, '100000000000000091', 'Guild One')$q$, :'st3'),
  '23505', 'guild_linked_elsewhere', 'a guild linked to another instance bridge is refused');
INSERT INTO out VALUES ('chk_after', public.discord_bridge_instance_link_check(:'st3', NULL));
RESET role;
SELECT is((SELECT v->>'error' FROM out WHERE k = 'chk_taken'), 'guild_linked_elsewhere',
  'the preflight refuses a guild linked elsewhere');
SELECT is((SELECT v->>'error' FROM out WHERE k = 'chk_after'), NULL,
  'a refused completion leaves the state unused');
SELECT throws_ok(format($q$UPDATE public.discord_bridges SET discord_guild_id = '100000000000000091' WHERE id = %L$q$, :'i2'),
  '23505', NULL, 'the table holds one instance bridge per guild');

-- Limit. ------------------------------------------------------------------------------------
UPDATE public.instance_config SET config_value = '1' WHERE config_key = 'discord_bridge_instance_bot_limit';
SET LOCAL role service_role;
INSERT INTO out VALUES ('chk_limit', public.discord_bridge_instance_link_check(:'st3', '100000000000000092'));
SELECT throws_ok(format($q$SELECT public.discord_bridge_instance_link_complete(%L, '100000000000000092', 'Guild Two')$q$, :'st3'),
  '54000', 'limit_reached', 'a new guild past the limit is refused at completion');
RESET role;
SELECT is((SELECT v->>'error' FROM out WHERE k = 'chk_limit'), 'limit_reached', 'the preflight refuses past the limit');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_link('91000000-0000-0000-0000-0000000000a4')$q$,
  '54000', 'limit_reached', 'a new instance bridge past the limit is refused');
SELECT lives_ok($q$SELECT public.discord_bridge_instance_link('55555555-0000-0000-0000-000000000005')$q$,
  'a linked bridge re-links at the limit');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.discord_bridges WHERE server_id = '91000000-0000-0000-0000-0000000000a4'), 0,
  'a refused link creates no bridge');
UPDATE public.instance_config SET config_value = '100' WHERE config_key = 'discord_bridge_instance_bot_limit';

UPDATE public.discord_bridge_link_states SET expires_at = now() - interval '1 second' WHERE bridge_id = :'i2';
SET LOCAL role service_role;
SELECT throws_ok(format($q$SELECT public.discord_bridge_instance_link_complete(%L, '100000000000000092', 'Guild Two')$q$, :'st3'),
  'P0002', 'state_invalid', 'an expired state completes nothing');
RESET role;

-- Heartbeats of instance bridges. -----------------------------------------------------------
SET LOCAL role service_role;
SELECT public.discord_bridge_report_status(:'i1_bot',
  '{"discord":{"connected":true,"application_id":"300000000000000091","bot_user":{"id":"300000000000000091","name":"Harmony Relay"}},"problems":[]}'::jsonb,
  '{"guilds":[{"id":"100000000000000099","name":"Someone Else","channels":[{"id":"200000000000000099","name":"theirs"}]},
              {"id":"100000000000000091","name":"Guild One Renamed","channels":[{"id":"200000000000000091","name":"general"}]}]}'::jsonb,
  '2.1.0') IS NOT NULL AS hb1 \gset
SELECT public.discord_bridge_report_status(:'i2_bot',
  '{"discord":{"connected":true,"application_id":"300000000000000091","bot_user":{"id":"300000000000000091","name":"Harmony Relay"}},"problems":[]}'::jsonb,
  '{"guilds":[{"id":"100000000000000099","name":"Someone Else","channels":[]}]}'::jsonb, '2.1.0') IS NOT NULL AS hb2 \gset
RESET role;
SELECT results_eq(
  format($q$SELECT discord_guild_id, discord_guild_name, snapshot FROM public.discord_bridges WHERE id = %L$q$, :'i1'),
  $q$VALUES ('100000000000000091', 'Guild One Renamed',
             '{"guilds":[{"id":"100000000000000091","name":"Guild One Renamed","channels":[{"id":"200000000000000091","name":"general"}]}]}'::jsonb)$q$,
  'an instance bridge stores its own guild of the report and no other');
SELECT results_eq(
  format($q$SELECT discord_guild_id, snapshot FROM public.discord_bridges WHERE id = %L$q$, :'i2'),
  $q$VALUES (NULL::text, '{"guilds":[]}'::jsonb)$q$,
  'a heartbeat selects no guild for an unlinked instance bridge');
SELECT results_eq(
  $q$SELECT bot_user_id, bot_user_name FROM public.discord_bridge_instance_bot$q$,
  $q$VALUES ('300000000000000091', 'Harmony Relay')$q$,
  'a heartbeat of the instance application records its bot user');
SET LOCAL role service_role;
SELECT public.discord_bridge_report_status(:'i1_bot',
  '{"discord":{"connected":true,"application_id":"300000000000000077","bot_user":{"id":"300000000000000077","name":"Impostor"}}}'::jsonb,
  '{"guilds":[]}'::jsonb, '2.1.0') IS NOT NULL AS hb3 \gset
RESET role;
SELECT is((SELECT bot_user_name FROM public.discord_bridge_instance_bot), 'Harmony Relay',
  'a report of another application leaves the instance bot user alone');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format($q$SELECT public.discord_bridge_set_guild(%L, '100000000000000091')$q$, :'i1'),
  '22023', NULL, 'an instance bridge''s guild cannot be chosen from its snapshot');
SELECT tests.clear_authentication();

SET LOCAL role service_role;
SELECT public.discord_bridge_report_status(:'i1_bot',
  '{"discord":{"connected":true,"application_id":"300000000000000091"}}'::jsonb,
  '{"guilds":[{"id":"100000000000000091","name":"Guild One","channels":[{"id":"200000000000000091","name":"general"}]}]}'::jsonb,
  '2.1.0') IS NOT NULL AS hb4 \gset
RESET role;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(format($q$SELECT public.discord_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '200000000000000091', 'both')$q$, :'i1'),
  'a manager pairs a channel of the linked guild');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '200000000000000099', 'both')$q$, :'i1'),
  '22023', NULL, 'a channel of another guild the shared bot sees cannot be paired');
SELECT tests.clear_authentication();

-- Host view (gateway). ----------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_hosted()$q$, '42501', NULL, 'a client cannot read the host view');
SELECT throws_ok($q$SELECT count(*) FROM public.discord_bridge_instance_bot_secrets()$q$, '42501', NULL,
  'a client cannot read the OAuth2 client secret');
SELECT tests.clear_authentication();

SET LOCAL role service_role;
INSERT INTO out VALUES ('hosted', public.discord_bridge_instance_hosted());
INSERT INTO out SELECT 'secrets', to_jsonb(s) FROM public.discord_bridge_instance_bot_secrets() s;
INSERT INTO out SELECT 'hosted_list', COALESCE(jsonb_agg(h.bridge_id), '[]') FROM public.discord_bridge_hosted_list() h;
RESET role;
SELECT results_eq(
  $q$SELECT v->>'application_id', v->>'discord_token', v->'presence', jsonb_array_length(v->'bridges'),
            v->'bridges'->0->>'bridge_id', v->'bridges'->0->>'discord_guild_id',
            (v->'bridges'->0->>'harmony_token') ~ '^harmony_bot_'
       FROM out WHERE k = 'hosted'$q$,
  format($q$VALUES ('300000000000000091', ('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GxyzDE.' || 'zyxwvutsrqponmlkjihgfedcba9876543210ZY'),
                    'false'::jsonb, 1, %L, '100000000000000091', true)$q$, :'i1'),
  'the host view carries the bot token and the linked bridges with their Harmony tokens');
SELECT is((SELECT v FROM out WHERE k = 'secrets'),
  '{"client_id":"300000000000000091","client_secret":"abcdefghijklmnopqrstuvwxyz012345"}'::jsonb,
  'the code exchange reads the client id and secret');
SELECT is((SELECT v FROM out WHERE k = 'hosted_list'), '[]'::jsonb, 'GET /hosted lists no instance bridge');

UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'discord_bridge_instance_presence';
SET LOCAL role service_role;
INSERT INTO out VALUES ('hosted_presence', public.discord_bridge_instance_hosted());
RESET role;
SELECT is((SELECT v->'presence' FROM out WHERE k = 'hosted_presence'), 'true'::jsonb,
  'the host view carries the presence switch');

SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000005');
SELECT results_eq(
  $q$SELECT (s->>'enabled')::boolean, (s->>'linked_count')::int, s->>'bot_user_name', (s->>'presence')::boolean
       FROM (SELECT public.discord_bridge_instance_bot_status() s) x$q$,
  $q$VALUES (true, 1, 'Harmony Relay', true)$q$,
  'the status counts linked instance bridges and names the bot');
SELECT tests.clear_authentication();

UPDATE public.instance_config SET config_value = 'false' WHERE config_key = 'discord_bridge_instance_bot_enabled';
SET LOCAL role service_role;
INSERT INTO out VALUES ('hosted_off', COALESCE(public.discord_bridge_instance_hosted(), 'null'::jsonb));
INSERT INTO out SELECT 'secrets_off', to_jsonb(count(*)) FROM public.discord_bridge_instance_bot_secrets();
SELECT throws_ok(format($q$SELECT public.discord_bridge_instance_link_complete(%L, '100000000000000092', 'Guild Two')$q$, :'st3'),
  '0A000', 'instance_bot_unavailable', 'nothing completes while the instance bot is off');
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'hosted_off'), 'null'::jsonb, 'the host view is empty while the instance bot is off');
SELECT is((SELECT v FROM out WHERE k = 'secrets_off'), '0'::jsonb, 'no client secret is read while the instance bot is off');
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'discord_bridge_instance_bot_enabled';

-- Re-linking to another guild. --------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('relink', public.discord_bridge_instance_link('55555555-0000-0000-0000-000000000005'));
SELECT tests.clear_authentication();
SELECT v->>'state' AS st4 FROM out WHERE k = 'relink' \gset
SET LOCAL role service_role;
INSERT INTO out VALUES ('done_same', public.discord_bridge_instance_link_complete(:'st4', '100000000000000091', ''));
RESET role;
SELECT results_eq(
  format($q$SELECT discord_guild_name, snapshot IS NOT NULL,
                   (SELECT count(*)::int FROM public.discord_bridge_channels WHERE bridge_id = %L)
              FROM public.discord_bridges WHERE id = %L$q$, :'i1', :'i1'),
  $q$VALUES ('Guild One', true, 1)$q$,
  'linking the same guild again keeps its name, snapshot and pairs');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('relink2', public.discord_bridge_instance_link('55555555-0000-0000-0000-000000000005'));
SELECT tests.clear_authentication();
SELECT v->>'state' AS st5 FROM out WHERE k = 'relink2' \gset
SET LOCAL role service_role;
INSERT INTO out VALUES ('done_other', public.discord_bridge_instance_link_complete(:'st5', '100000000000000093', 'Guild Three'));
RESET role;
SELECT results_eq(
  format($q$SELECT discord_guild_id, discord_guild_name, snapshot,
                   (SELECT count(*)::int FROM public.discord_bridge_channels WHERE bridge_id = %L)
              FROM public.discord_bridges WHERE id = %L$q$, :'i1', :'i1'),
  $q$VALUES ('100000000000000093', 'Guild Three', NULL::jsonb, 0)$q$,
  'linking another guild drops the pairs and the old snapshot');

-- Deletion and clearing. --------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(format('SELECT public.discord_bridge_delete(%L)', :'i1'), 'the owner deletes the instance bridge');
SELECT tests.clear_authentication();
SELECT results_eq(
  format($q$SELECT (SELECT count(*)::int FROM public.discord_bridge_link_states WHERE bridge_id = %L),
                   (SELECT count(*)::int FROM public.discord_bridge_secrets WHERE bridge_id = %L),
                   (SELECT count(*)::int FROM vault.secrets WHERE id = %L),
                   (SELECT count(*)::int FROM public.bots WHERE id = %L)$q$, :'i1', :'i1', :'i1_hsec', :'i1_bot'),
  $q$VALUES (0, 0, 0, 0)$q$,
  'deleting an instance bridge deletes its states, its Harmony token secret and its bot');

SELECT bot_token_secret AS tok2, client_secret_secret AS cs2 FROM public.discord_bridge_instance_bot \gset
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000005');
SELECT lives_ok($q$SELECT public.discord_bridge_instance_bot_clear()$q$, 'an admin clears the instance bot');
SELECT is(public.discord_bridge_instance_bot_status() - 'linked_count' - 'limit' - 'presence',
  '{"enabled":false,"configured":false,"application_id":null,"has_client_secret":false,"has_bot_token":false,
    "bot_user_name":null}'::jsonb,
  'clearing turns the instance bot off and forgets the application');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_bridge_instance_link('91000000-0000-0000-0000-0000000000a2')$q$,
  '0A000', 'instance_bot_unavailable', 'nothing links after clearing');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'tok2', :'cs2')), 0,
  'clearing deletes both Vault secrets');
SELECT is((SELECT count(*)::int FROM public.discord_bridges WHERE id = :'i2'), 1,
  'clearing keeps the instance bridges');

SELECT * FROM finish();
ROLLBACK;
