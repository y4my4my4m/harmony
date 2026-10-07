-- 20261008300001_discord_bridges.sql: grants and RLS, bridge creation, one-time setup codes,
-- pairing, settings, guild selection, heartbeats, hosted tokens in Vault, deletion and
-- effective_channel_encryption's bridge_count.
--
--   alice  owner of server_1 (fixture), s3 and s4
--   bob    accepted member of server_1; later holds a MANAGE_SERVER role
--   mallory  owner of s2, no member of server_1
--
-- Discord: guild g1 100000000000000001 with channels d1, d2, d3 (2000...01-03); guild g2
-- 100000000000000002 with channel d9.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(121);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;
-- Assertions run as service_role too; rolled back with the file.
GRANT USAGE ON SCHEMA tests TO service_role;

-- Setup, as postgres. -----------------------------------------------------------------------
INSERT INTO public.servers (id, name, owner) VALUES
  ('86000000-0000-0000-0000-0000000000a2', 'Mallory Server', '33333333-0000-0000-0000-000000000003'),
  ('86000000-0000-0000-0000-0000000000a3', 'Hosted Server', '11111111-0000-0000-0000-000000000001'),
  ('86000000-0000-0000-0000-0000000000a4', 'Spare Server', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('86000000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'second', 0),
  ('86000000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'a category', 2),
  ('86000000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005', 'private', 0),
  ('86000000-0000-0000-0000-0000000000c5', '86000000-0000-0000-0000-0000000000a2', 'elsewhere', 0),
  ('86000000-0000-0000-0000-0000000000c6', '86000000-0000-0000-0000-0000000000a3', 'hosted-general', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT '86000000-0000-0000-0000-0000000000c4', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

-- Grants and RLS. ---------------------------------------------------------------------------
SELECT ok((SELECT bool_and(c.relrowsecurity) FROM pg_class c
            WHERE c.oid IN ('public.discord_bridges'::regclass, 'public.discord_bridge_channels'::regclass,
                            'public.discord_bridge_setup_codes'::regclass, 'public.discord_bridge_secrets'::regclass)),
  'RLS is on for every bridge table');
SELECT ok(NOT EXISTS (SELECT 1
                        FROM unnest(ARRAY['discord_bridges', 'discord_bridge_channels',
                                          'discord_bridge_setup_codes', 'discord_bridge_secrets']) t,
                             unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
                       WHERE has_table_privilege('anon', 'public.' || t, p)),
  'anon holds no privilege on the bridge tables');
SELECT ok(has_table_privilege('authenticated', 'public.discord_bridges', 'SELECT')
      AND has_table_privilege('authenticated', 'public.discord_bridge_channels', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.discord_bridges', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.discord_bridges', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.discord_bridge_channels', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.discord_bridge_channels', 'DELETE'),
  'authenticated reads bridges and pairs and writes neither');
SELECT ok(NOT has_table_privilege('authenticated', 'public.discord_bridge_setup_codes', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.discord_bridge_secrets', 'SELECT'),
  'authenticated reads neither setup codes nor secrets');
SELECT ok(has_table_privilege('service_role', 'public.discord_bridges', 'SELECT')
      AND has_table_privilege('service_role', 'public.discord_bridge_secrets', 'SELECT'),
  'service_role holds the bridge tables');

CREATE TEMP TABLE client_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO client_fns VALUES
  ('public.discord_bridge_create(uuid, text)'), ('public.discord_bridge_setup_code(uuid)'),
  ('public.discord_bridge_set_hosted_token(uuid, text)'), ('public.discord_bridge_set_guild(uuid, text)'),
  ('public.discord_bridge_pair(uuid, uuid, text, text)'), ('public.discord_bridge_unpair(uuid, uuid)'),
  ('public.discord_bridge_update_settings(uuid, jsonb)'), ('public.discord_bridge_delete(uuid)');
CREATE TEMP TABLE service_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO service_fns VALUES
  ('public.discord_bridge_redeem_code(text)'), ('public.discord_bridge_hosted_list()'),
  ('public.discord_bridge_report_status(uuid, jsonb, jsonb, text)'),
  ('public.discord_bridge_bot_pair(uuid, uuid, text, text, text)'),
  ('public.discord_bridge_bot_unpair(uuid, text)'),
  ('public.discord_bridge_encrypted_channel_ids(uuid)');
CREATE TEMP TABLE internal_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO internal_fns VALUES
  ('public.discord_bridge_provision_bot(uuid, uuid)'), ('public.discord_bridge_issue_token(uuid)'),
  ('public.discord_bridge_pair_internal(uuid, uuid, text, text, text, uuid)'),
  ('public.discord_bridge_for_manager(uuid)'), ('public.discord_bridge_hosting_enabled()'),
  ('public.discord_bridge_hosting_limit()'), ('public.discord_bridge_assert_vault()'),
  ('public.discord_bridge_guild_channels(jsonb, text)'), ('public.discord_bridge_normalize_code(text)');

SELECT is_empty($q$SELECT fn FROM client_fns WHERE has_function_privilege('anon', fn, 'EXECUTE')$q$,
  'anon executes no bridge RPC');
SELECT is_empty($q$SELECT fn FROM client_fns WHERE NOT has_function_privilege('authenticated', fn, 'EXECUTE')$q$,
  'authenticated executes every client bridge RPC');
SELECT is_empty($q$SELECT fn FROM service_fns
                    WHERE has_function_privilege('anon', fn, 'EXECUTE')
                       OR has_function_privilege('authenticated', fn, 'EXECUTE')$q$,
  'clients execute no gateway function');
SELECT is_empty($q$SELECT fn FROM service_fns WHERE NOT has_function_privilege('service_role', fn, 'EXECUTE')$q$,
  'service_role executes the gateway functions');
SELECT is_empty($q$SELECT fn FROM internal_fns
                    WHERE has_function_privilege('anon', fn, 'EXECUTE')
                       OR has_function_privilege('authenticated', fn, 'EXECUTE')
                       OR has_function_privilege('service_role', fn, 'EXECUTE')$q$,
  'internal bridge helpers are executable by their owner alone');
SELECT results_eq(
  $q$SELECT config_key, config_value FROM public.instance_config
      WHERE config_key IN ('discord_bridge_hosting_enabled', 'discord_bridge_hosting_limit') ORDER BY 1$q$,
  $q$VALUES ('discord_bridge_hosting_enabled', 'false'::jsonb), ('discord_bridge_hosting_limit', '25'::jsonb)$q$,
  'hosting is off by default with a limit of 25');
SELECT ok('discord_bridge_hosting_enabled' = ANY (public.public_instance_config_keys()),
  'discord_bridge_hosting_enabled is a public instance key');

-- discord_bridge_create. --------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.discord_bridge_create('55555555-0000-0000-0000-000000000005', 'self')$q$,
  '42501', NULL, 'anon cannot create a bridge');
SELECT throws_ok($q$SELECT count(*) FROM public.discord_bridges$q$,
  '42501', NULL, 'anon cannot read bridges');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.discord_bridge_create('55555555-0000-0000-0000-000000000005', 'self')$q$,
  '42501', NULL, 'a non-member cannot create a bridge');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.discord_bridge_create('55555555-0000-0000-0000-000000000005', 'self')$q$,
  '42501', NULL, 'a member without MANAGE_SERVER cannot create a bridge');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_bridge_create('55555555-0000-0000-0000-000000000005', 'relay')$q$,
  '22023', NULL, 'an unknown mode is refused');
SELECT throws_ok($q$SELECT public.discord_bridge_create('86000000-0000-0000-0000-0000000000ff', 'self')$q$,
  'P0002', NULL, 'an unknown server is refused');
SELECT public.discord_bridge_create('55555555-0000-0000-0000-000000000005', 'self') AS b1 \gset
SELECT throws_ok($q$SELECT public.discord_bridge_create('55555555-0000-0000-0000-000000000005', 'self')$q$,
  '23505', NULL, 'a server has one bridge');
SELECT tests.clear_authentication();

SELECT bot_id AS b1_bot FROM public.discord_bridges WHERE id = :'b1' \gset
SELECT results_eq(
  format($q$SELECT mode, created_by, settings, discord_guild_id FROM public.discord_bridges WHERE id = %L$q$, :'b1'),
  $q$VALUES ('self', '11111111-0000-0000-0000-000000000001'::uuid,
             '{"sync_member_list":true,"sync_presence":false,"sync_reactions":true,"sync_edits":true,"sync_deletes":true}'::jsonb,
             NULL::text)$q$,
  'the bridge is self mode, created by alice, with default settings and no guild');
SELECT results_eq(
  format($q$SELECT bot_type, owner_id, is_public, is_active FROM public.bots WHERE id = %L$q$, :'b1_bot'),
  $q$VALUES ('bridge', '11111111-0000-0000-0000-000000000001'::uuid, false, true)$q$,
  'the bridge bot is a private bridge-type bot owned by the creator');
SELECT results_eq(
  format($q$SELECT is_active, read_messages, send_messages, manage_channels, installed_by
              FROM public.bot_server_permissions WHERE bot_id = %L AND server_id = '55555555-0000-0000-0000-000000000005'$q$, :'b1_bot'),
  $q$VALUES (true, true, true, true, '11111111-0000-0000-0000-000000000001'::uuid)$q$,
  'the bridge bot is installed with read, send and manage_channels');
SELECT is((SELECT count(*)::int FROM public.bot_tokens WHERE bot_id = :'b1_bot'), 0,
  'creation issues no token');

-- RLS reads. --------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.discord_bridges WHERE id = :'b1'), 1, 'the owner reads the bridge');
SELECT throws_ok(format($q$UPDATE public.discord_bridges SET mode = 'hosted' WHERE id = %L$q$, :'b1'),
  '42501', NULL, 'a client cannot write a bridge row directly');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.discord_bridges), 0, 'a member without MANAGE_SERVER reads no bridge');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.discord_bridges), 0, 'a non-member reads no bridge');

-- Setup codes. ------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format('SELECT public.discord_bridge_setup_code(%L)', :'b1'),
  '42501', NULL, 'a member without MANAGE_SERVER cannot get a setup code');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_bridge_setup_code(:'b1') AS code1 \gset
SELECT public.discord_bridge_setup_code(:'b1') AS code2 \gset
SELECT tests.clear_authentication();
SELECT ok(:'code1' ~ '^HB-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$',
  'a setup code reads HB-XXXX-XXXX-XXXX without I, O, 0 or 1');
SELECT results_eq(
  format($q$SELECT code_hash, expires_at BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes', used_at
              FROM public.discord_bridge_setup_codes WHERE bridge_id = %L$q$, :'b1'),
  format($q$VALUES (%L, true, NULL::timestamptz)$q$, encode(sha256(convert_to(:'code2', 'UTF8')), 'hex')),
  'a new code replaces the earlier one, stored as its SHA-256 with a 30 minute expiry');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.discord_bridge_setup_codes c
                       WHERE c.code_hash IN (:'code1', :'code2') OR c.code_hash LIKE 'HB-%'),
  'no plaintext code is stored');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format('SELECT public.discord_bridge_redeem_code(%L)', :'code2'),
  '42501', NULL, 'a client cannot redeem a code');
SELECT tests.clear_authentication();

SET LOCAL role service_role;
INSERT INTO out VALUES ('old', public.discord_bridge_redeem_code(:'code1'));
INSERT INTO out VALUES ('first', public.discord_bridge_redeem_code(' ' || replace(lower(:'code2'), '-', '') || ' '));
INSERT INTO out VALUES ('again', public.discord_bridge_redeem_code(:'code2'));
INSERT INTO out VALUES ('malformed', public.discord_bridge_redeem_code('HB-NOPE'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'old'), NULL, 'a superseded code redeems nothing');
SELECT results_eq(
  $q$SELECT v->>'bridge_id', v->>'server_id', v->>'harmony_token' ~ '^harmony_bot_[0-9a-f]{64}$' FROM out WHERE k = 'first'$q$,
  format($q$VALUES (%L, '55555555-0000-0000-0000-000000000005', true)$q$, :'b1'),
  'redeeming returns the bridge, its server and a bot token; case, whitespace and dashes are ignored');
SELECT is((SELECT v FROM out WHERE k = 'again'), NULL, 'a code redeems once');
SELECT is((SELECT v FROM out WHERE k = 'malformed'), NULL, 'a malformed code redeems nothing');
SELECT (v->>'harmony_token') AS token1 FROM out WHERE k = 'first' \gset
SELECT results_eq(
  format($q$SELECT (public.verify_bot_token(%L)->>'valid')::boolean, public.verify_bot_token(%L)->>'bot_id'$q$,
         encode(sha256(convert_to(:'token1', 'UTF8')), 'hex'), encode(sha256(convert_to(:'token1', 'UTF8')), 'hex')),
  format($q$VALUES (true, %L)$q$, :'b1_bot'),
  'the redeemed token authenticates as the bridge bot');
SELECT is((SELECT used_at IS NOT NULL FROM public.discord_bridge_setup_codes WHERE bridge_id = :'b1'), true,
  'the redeemed code is marked used');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_bridge_setup_code(:'b1') AS code3 \gset
SELECT public.discord_bridge_setup_code(:'b1') AS code4 \gset
SELECT tests.clear_authentication();
UPDATE public.discord_bridge_setup_codes SET expires_at = now() - interval '1 second' WHERE bridge_id = :'b1';
SET LOCAL role service_role;
INSERT INTO out VALUES ('expired', public.discord_bridge_redeem_code(:'code4'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'expired'), NULL, 'an expired code redeems nothing');
UPDATE public.discord_bridge_setup_codes SET expires_at = now() + interval '1 minute' WHERE bridge_id = :'b1';
SET LOCAL role service_role;
INSERT INTO out VALUES ('second', public.discord_bridge_redeem_code(
  E'hb\u2013' || replace(substr(:'code4', 4), '-', E'\u2014')));
RESET role;
SELECT ok((SELECT v->>'harmony_token' ~ '^harmony_bot_' FROM out WHERE k = 'second'),
  'a code typed with typographic dashes redeems');
-- The helper is executable by its owner only; a clone migrated as another role skips this.
SELECT CASE WHEN has_function_privilege('public.discord_bridge_normalize_code(text)', 'EXECUTE') THEN results_eq(
  $q$SELECT x, public.discord_bridge_normalize_code(x)
       FROM (VALUES ('ABCD EFGH JK23'), ('hbabcdefghjk23'), ('HBCDEFGHJKLM'), ('HB-ABCD-EFGH-JK2'), ('HB_ABCD_EFGH_JK23')) v(x)$q$,
  $q$VALUES ('ABCD EFGH JK23', 'HB-ABCD-EFGH-JK23'), ('hbabcdefghjk23', 'HB-ABCD-EFGH-JK23'),
            ('HBCDEFGHJKLM', 'HB-HBCD-EFGH-JKLM'), ('HB-ABCD-EFGH-JK2', NULL), ('HB_ABCD_EFGH_JK23', NULL)$q$,
  'a typed code normalizes to HB-XXXX-XXXX-XXXX; the prefix is optional and 12 characters must remain')
ELSE skip('discord_bridge_normalize_code is owned by another role here') END;
SELECT is((public.verify_bot_token(encode(sha256(convert_to(:'token1', 'UTF8')), 'hex'))->>'valid')::boolean, false,
  'redeeming again revokes the previous token');
SELECT is((SELECT count(*)::int FROM public.bot_tokens WHERE bot_id = :'b1_bot' AND is_active), 1,
  'the bridge bot holds one active token');

-- Pairing before a guild. -------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '200000000000000001', 'both')$q$, :'b1'),
  '22023', NULL, 'pairing needs a selected guild');
SELECT tests.clear_authentication();

-- Heartbeats. -------------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('unknown', public.discord_bridge_report_status('86000000-0000-0000-0000-0000000000ee',
  '{}'::jsonb, '{"guilds":[]}'::jsonb, '2.0.0'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'unknown'), NULL, 'a heartbeat from a bot without a bridge stores nothing');
SET LOCAL role service_role;
SELECT throws_ok(format($q$SELECT public.discord_bridge_report_status(%L, '{}'::jsonb, '{"guilds":{}}'::jsonb, '2.0.0')$q$, :'b1_bot'),
  '22023', NULL, 'a snapshot without a guilds array is refused');
RESET role;

SET LOCAL role service_role;
INSERT INTO out VALUES ('hb0', public.discord_bridge_report_status(:'b1_bot',
  '{"version":"2.0.0","discord":{"connected":false},"harmony":{"connected":true},"problems":[{"code":"discord_unreachable","params":{}}]}'::jsonb,
  '{"guilds":[{"id":"100000000000000001","name":"Guild One","channels":[]}]}'::jsonb, '2.0.0'));
RESET role;
SELECT results_eq(
  format($q$SELECT discord_guild_id, snapshot, status->'problems'->0->>'code', bridge_version, last_seen_at = now()
              FROM public.discord_bridges WHERE id = %L$q$, :'b1'),
  $q$VALUES (NULL::text, NULL::jsonb, 'discord_unreachable', '2.0.0', true)$q$,
  'a disconnected report stores status and last_seen_at, selects no guild and stores no snapshot');
SELECT is((SELECT v->>'discord_guild_id' FROM out WHERE k = 'hb0'), NULL, 'a disconnected report answers with the stored guild');

UPDATE public.discord_bridges SET updated_at = '2000-01-01' WHERE id = :'b1';
SET LOCAL role service_role;
INSERT INTO out VALUES ('hb1', public.discord_bridge_report_status(:'b1_bot',
  '{"discord":{"connected":true,"application_id":"300000000000000001","bot_user":{"id":"300000000000000001","name":"Relay"},
    "intents":{"message_content":true,"members":true,"presence":false}},"harmony":{"connected":true},"problems":[]}'::jsonb,
  '{"guilds":[{"id":"100000000000000001","name":"Guild One","icon":null,"channels":[
     {"id":"200000000000000001","name":"general","type":0,"parent_id":null,"position":0,"can_view":true,"can_send":true,"can_manage_webhooks":true},
     {"id":"200000000000000002","name":"memes","type":0,"parent_id":null,"position":1,"can_view":true,"can_send":true,"can_manage_webhooks":true},
     {"id":"200000000000000003","name":"news","type":0,"parent_id":null,"position":2,"can_view":true,"can_send":false,"can_manage_webhooks":false}]}]}'::jsonb,
  '2.0.0'));
RESET role;
SELECT is((SELECT v->>'discord_guild_id' FROM out WHERE k = 'hb1'), '100000000000000001',
  'the heartbeat answers with the selected guild');
SELECT results_eq(
  format($q$SELECT discord_guild_id, discord_guild_name, discord_application_id, discord_bot_name, bridge_version,
                   last_seen_at = now(), updated_at = now(), status->'problems'
              FROM public.discord_bridges WHERE id = %L$q$, :'b1'),
  $q$VALUES ('100000000000000001', 'Guild One', '300000000000000001', 'Relay', '2.0.0', true, true, '[]'::jsonb)$q$,
  'a heartbeat with one guild selects it, records the application and bot, and counts as a config change');

UPDATE public.discord_bridges SET updated_at = '2000-01-01' WHERE id = :'b1';
SET LOCAL role service_role;
SELECT public.discord_bridge_report_status(:'b1_bot', '{"discord":{"connected":true},"problems":[{"code":"rate_limited","params":{}}]}'::jsonb,
  (SELECT snapshot FROM public.discord_bridges WHERE id = :'b1'), '2.0.1') IS NOT NULL AS hb2 \gset
RESET role;
SELECT results_eq(
  format($q$SELECT updated_at, bridge_version, status->'problems'->0->>'code' FROM public.discord_bridges WHERE id = %L$q$, :'b1'),
  $q$VALUES ('2000-01-01'::timestamptz, '2.0.1', 'rate_limited')$q$,
  'a heartbeat that changes no configuration leaves updated_at alone');
SET LOCAL role service_role;
SELECT public.discord_bridge_report_status(:'b1_bot', '{"discord":{"connected":false}}'::jsonb,
  '{"guilds":[]}'::jsonb, '2.0.1') IS NOT NULL AS hb2b \gset
RESET role;
SELECT results_eq(
  format($q$SELECT discord_guild_id, jsonb_array_length(snapshot->'guilds'), status->'discord'->>'connected'
              FROM public.discord_bridges WHERE id = %L$q$, :'b1'),
  $q$VALUES ('100000000000000001', 1, 'false')$q$,
  'a disconnected report without guilds keeps the stored snapshot and guild');

-- Pairing. ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '200000000000000001', 'both')$q$, :'b1'),
  '42501', NULL, 'a member without MANAGE_SERVER cannot pair');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '200000000000000099', 'both')$q$, :'b1'),
  '22023', NULL, 'a Discord channel outside the selected guild is refused');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '86000000-0000-0000-0000-0000000000c5', '200000000000000001', 'both')$q$, :'b1'),
  '22023', NULL, 'a channel of another server is refused');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '86000000-0000-0000-0000-0000000000c3', '200000000000000001', 'both')$q$, :'b1'),
  '22023', NULL, 'a category is refused');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '200000000000000001', 'sideways')$q$, :'b1'),
  '22023', NULL, 'an unknown direction is refused');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', 'general', 'both')$q$, :'b1'),
  '22023', NULL, 'a Discord channel id must be a snowflake');
SELECT tests.clear_authentication();

UPDATE public.discord_bridges SET updated_at = '2000-01-01' WHERE id = :'b1';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_bridge_pair(:'b1', '66666666-0000-0000-0000-000000000006', '200000000000000001', NULL) AS p1 \gset
SELECT tests.clear_authentication();
SELECT results_eq(
  format($q$SELECT harmony_channel_id, discord_channel_id, discord_channel_name, direction, created_by
              FROM public.discord_bridge_channels WHERE id = %L$q$, :'p1'),
  $q$VALUES ('66666666-0000-0000-0000-000000000006'::uuid, '200000000000000001', 'general', 'both',
             '11111111-0000-0000-0000-000000000001'::uuid)$q$,
  'a pair takes its Discord name from the snapshot and defaults to both directions');
SELECT is((SELECT updated_at FROM public.discord_bridges WHERE id = :'b1'), now(),
  'pairing is a configuration change');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '200000000000000002', 'both')$q$, :'b1'),
  '23505', NULL, 'a Harmony channel pairs once');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '86000000-0000-0000-0000-0000000000c2', '200000000000000001', 'both')$q$, :'b1'),
  '23505', NULL, 'a Discord channel pairs once');
SELECT is(public.discord_bridge_pair(:'b1', '66666666-0000-0000-0000-000000000006', '200000000000000001', 'to_discord'),
  :'p1'::uuid, 'pairing the same channels again redirects the pair');
SELECT is((SELECT direction FROM public.discord_bridge_channels WHERE id = :'p1'), 'to_discord',
  'the redirected pair carries the new direction');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_channels WHERE bridge_id = :'b1'), 1,
  'the owner reads the pairs');
SELECT tests.clear_authentication();

SELECT throws_ok(format($q$INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id)
                           VALUES (%L, '86000000-0000-0000-0000-0000000000c5', '200000000000000003')$q$, :'b1'),
  '23514', NULL, 'the table refuses a channel of another server');

-- MANAGE_SERVER through a role, and private channels. ---------------------------------------
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('86000000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'Managers', 5, 128);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', '86000000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.discord_bridges WHERE id = :'b1'), 1,
  'a member holding MANAGE_SERVER reads the bridge');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_channels WHERE bridge_id = :'b1'), 1,
  'a member holding MANAGE_SERVER reads the pairs');
SELECT throws_ok(format($q$SELECT public.discord_bridge_pair(%L, '86000000-0000-0000-0000-0000000000c4', '200000000000000002', 'both')$q$, :'b1'),
  '42501', NULL, 'a manager cannot pair a channel hidden from them');
SELECT lives_ok(format($q$SELECT public.discord_bridge_pair(%L, '86000000-0000-0000-0000-0000000000c2', '200000000000000002', 'to_harmony')$q$, :'b1'),
  'a member holding MANAGE_SERVER pairs a channel they see');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(format($q$SELECT public.discord_bridge_pair(%L, '86000000-0000-0000-0000-0000000000c4', '200000000000000003', 'both')$q$, :'b1'),
  'the owner pairs a private channel');
SELECT is(public.discord_bridge_unpair(:'b1', '86000000-0000-0000-0000-0000000000c4'), true, 'unpairing removes the pair');
SELECT is(public.discord_bridge_unpair(:'b1', '86000000-0000-0000-0000-0000000000c4'), false, 'unpairing twice removes nothing');

-- Settings. ---------------------------------------------------------------------------------
SELECT throws_ok(format($q$SELECT public.discord_bridge_update_settings(%L, '{"sync_everything":true}')$q$, :'b1'),
  '22023', NULL, 'an unknown setting is refused');
SELECT throws_ok(format($q$SELECT public.discord_bridge_update_settings(%L, '{"sync_presence":"yes"}')$q$, :'b1'),
  '22023', NULL, 'a non-boolean setting is refused');
SELECT throws_ok(format($q$SELECT public.discord_bridge_update_settings(%L, '[true]')$q$, :'b1'),
  '22023', NULL, 'settings must be an object');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.discord_bridge_update_settings(:'b1', '{"sync_presence":true,"sync_deletes":false}'),
  '{"sync_member_list":true,"sync_presence":true,"sync_reactions":true,"sync_edits":true,"sync_deletes":false}'::jsonb,
  'whitelisted booleans merge into the settings');
SELECT tests.clear_authentication();

-- Discord-side link and unlink (gateway). ---------------------------------------------------
SET LOCAL role service_role;
SELECT throws_ok($q$SELECT public.discord_bridge_bot_pair('86000000-0000-0000-0000-0000000000ee',
                   '86000000-0000-0000-0000-0000000000c2', '200000000000000003', 'news', 'both')$q$,
  'P0002', NULL, 'a bot without a bridge cannot link');
SELECT throws_ok(format($q$SELECT public.discord_bridge_bot_pair(%L, '86000000-0000-0000-0000-0000000000c5', '200000000000000003', 'news', 'both')$q$, :'b1_bot'),
  '22023', NULL, 'the bridge bot cannot link a channel of another server');
SELECT throws_ok(format($q$SELECT public.discord_bridge_bot_pair(%L, '86000000-0000-0000-0000-0000000000c2', '200000000000000003', 'news', 'both')$q$, :'b1_bot'),
  '23505', NULL, 'the bridge bot cannot link a Harmony channel paired elsewhere');
INSERT INTO out VALUES ('unlink', to_jsonb(public.discord_bridge_bot_unpair(:'b1_bot', '200000000000000002')));
INSERT INTO out VALUES ('link', to_jsonb(public.discord_bridge_bot_pair(:'b1_bot', '86000000-0000-0000-0000-0000000000c2',
                                                                       '200000000000000003', 'news-renamed', 'both')));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'unlink'), 'true'::jsonb, 'the bridge bot unlinks a Discord channel');
SELECT results_eq(
  format($q$SELECT harmony_channel_id, discord_channel_name, created_by FROM public.discord_bridge_channels
             WHERE bridge_id = %L AND discord_channel_id = '200000000000000003'$q$, :'b1'),
  $q$VALUES ('86000000-0000-0000-0000-0000000000c2'::uuid, 'news-renamed', NULL::uuid)$q$,
  'the bridge bot links with the name it reports, attributed to no member');

-- Guild selection. --------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.discord_bridge_report_status(:'b1_bot', '{"discord":{"connected":true}}'::jsonb,
  '{"guilds":[{"id":"100000000000000001","name":"Guild One","channels":[{"id":"200000000000000001","name":"general"},
                                                                         {"id":"200000000000000003","name":"news"}]},
              {"id":"100000000000000002","name":"Guild Two","channels":[{"id":"200000000000000009","name":"lobby"}]}]}'::jsonb,
  '2.0.1') IS NOT NULL AS hb3 \gset
RESET role;
SELECT is((SELECT discord_channel_name FROM public.discord_bridge_channels
            WHERE bridge_id = :'b1' AND discord_channel_id = '200000000000000003'), 'news',
  'a heartbeat refreshes the pairs'' Discord names');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format($q$SELECT public.discord_bridge_set_guild(%L, '100000000000000003')$q$, :'b1'),
  '22023', NULL, 'a guild outside the snapshot is refused');
SELECT lives_ok(format($q$SELECT public.discord_bridge_set_guild(%L, '100000000000000001')$q$, :'b1'),
  'reselecting the current guild succeeds');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_channels WHERE bridge_id = :'b1'), 2,
  'reselecting the current guild keeps the pairs');

-- Encryption counting. ----------------------------------------------------------------------
SELECT is((public.effective_channel_encryption('66666666-0000-0000-0000-000000000006')->>'bridge_count')::int, 1,
  'a paired channel counts its bridge');
SELECT is((public.effective_channel_encryption('86000000-0000-0000-0000-0000000000c4')->>'bridge_count')::int, 0,
  'the v2 bridge bot does not count in an unpaired channel');
SELECT tests.clear_authentication();

INSERT INTO public.discord_bridge_pairings (server_id, pairing_code, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', 'HRM-AB12-CD34', '11111111-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.effective_channel_encryption('86000000-0000-0000-0000-0000000000c4')->>'bridge_count')::int, 0,
  'a v1 pairing row alone counts no bridge');
SELECT tests.clear_authentication();

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('86000000-0000-0000-0000-0000000000b1', 'discord-bridge', 'Old Bridge', '11111111-0000-0000-0000-000000000001', 'bot');
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by)
VALUES ('86000000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT results_eq(
  $q$SELECT (e->>'bridge_count')::int, (e->>'bot_count')::int
       FROM (SELECT public.effective_channel_encryption('86000000-0000-0000-0000-0000000000c4') e) x$q$,
  $q$VALUES (1, 1)$q$,
  'a v1 pairing with a bot the v1 setup page recognises counts one bridge');
SELECT is((public.effective_channel_encryption('66666666-0000-0000-0000-000000000006')->>'bridge_count')::int, 2,
  'a paired channel counts the v1 bridge as well');
SELECT tests.clear_authentication();

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('86000000-0000-0000-0000-0000000000b2', 'legacy-relay', 'Legacy Relay', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by)
VALUES ('86000000-0000-0000-0000-0000000000b2', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.effective_channel_encryption('86000000-0000-0000-0000-0000000000c4')->>'bridge_count')::int, 1,
  'a v1 bridge-type install counts once, in every channel, with no pairing bonus');
SELECT tests.clear_authentication();

-- Encrypted channels (gateway). ------------------------------------------------------------
INSERT INTO public.server_encryption_settings (server_id, encryption_mode)
VALUES ('55555555-0000-0000-0000-000000000005', 'optional')
ON CONFLICT (server_id) DO UPDATE SET encryption_mode = 'optional';
INSERT INTO public.channel_encryption_settings (channel_id, messages_encrypted)
VALUES ('86000000-0000-0000-0000-0000000000c2', true)
ON CONFLICT (channel_id) DO UPDATE SET messages_encrypted = true;
SET LOCAL role service_role;
INSERT INTO out SELECT 'encrypted', to_jsonb(array_agg(id ORDER BY id)) FROM public.discord_bridge_encrypted_channel_ids(:'b1') id;
INSERT INTO out SELECT 'encrypted_none', COALESCE(to_jsonb(array_agg(id)), '[]')
  FROM public.discord_bridge_encrypted_channel_ids('86000000-0000-0000-0000-0000000000ee') id;
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'encrypted'), '["86000000-0000-0000-0000-0000000000c2"]'::jsonb,
  'the gateway reads the bridge server''s encrypted channels, as channel_messages_encrypted reports them');
SELECT is((SELECT v FROM out WHERE k = 'encrypted_none'), '[]'::jsonb, 'an unknown bridge has no encrypted channels');
UPDATE public.server_encryption_settings SET encryption_mode = 'required' WHERE server_id = '55555555-0000-0000-0000-000000000005';
SET LOCAL role service_role;
INSERT INTO out SELECT 'encrypted_required', to_jsonb(count(*)) FROM public.discord_bridge_encrypted_channel_ids(:'b1');
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'encrypted_required'),
  to_jsonb((SELECT count(*) FROM public.channels WHERE server_id = '55555555-0000-0000-0000-000000000005')),
  'a server requiring encryption reports every channel encrypted');
DELETE FROM public.server_encryption_settings WHERE server_id = '55555555-0000-0000-0000-000000000005';

-- Guild switch. -----------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(format($q$SELECT public.discord_bridge_set_guild(%L, '100000000000000002')$q$, :'b1'),
  'a manager selects another reported guild');
SELECT tests.clear_authentication();
SELECT results_eq(
  format($q$SELECT discord_guild_id, discord_guild_name,
                   (SELECT count(*)::int FROM public.discord_bridge_channels WHERE bridge_id = %L)
              FROM public.discord_bridges WHERE id = %L$q$, :'b1', :'b1'),
  $q$VALUES ('100000000000000002', 'Guild Two', 0)$q$,
  'switching guilds drops pairs whose Discord channel is outside the new guild');

-- Hosted mode. ------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_bridge_create('86000000-0000-0000-0000-0000000000a3', 'hosted')$q$,
  '0A000', NULL, 'hosted mode needs hosting enabled');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'discord_bridge_hosting_enabled';
UPDATE public.instance_config SET config_value = '1' WHERE config_key = 'discord_bridge_hosting_limit';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_bridge_create('86000000-0000-0000-0000-0000000000a3', 'hosted') AS h1 \gset
SELECT throws_ok($q$SELECT public.discord_bridge_create('86000000-0000-0000-0000-0000000000a4', 'hosted')$q$,
  '54000', NULL, 'hosted bridges stop at the instance limit');
SELECT throws_ok(format('SELECT public.discord_bridge_setup_code(%L)', :'h1'),
  '22023', NULL, 'a hosted bridge takes no setup code');
SELECT throws_ok(format($q$SELECT public.discord_bridge_set_hosted_token(%L, ('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GabcDE.' || 'abcdefghijklmnopqrstuvwxyz0123456789AB'))$q$, :'b1'),
  '22023', NULL, 'a self-run bridge stores no Discord token');
SELECT throws_ok(format($q$SELECT public.discord_bridge_set_hosted_token(%L, 'not a token')$q$, :'h1'),
  '22023', NULL, 'a malformed Discord token is refused');
SELECT lives_ok(format($q$SELECT public.discord_bridge_set_hosted_token(%L, ('Bot MTAxMDEwMTAxMDEwMTAxMDEw' || '.GabcDE.' || 'abcdefghijklmnopqrstuvwxyz0123456789AB'))$q$, :'h1'),
  'a manager stores the hosted bridge''s Discord token');
SELECT throws_ok($q$SELECT count(*) FROM public.discord_bridge_secrets$q$,
  '42501', NULL, 'a client cannot read bridge secrets');
SELECT throws_ok($q$SELECT count(*) FROM public.discord_bridge_hosted_list()$q$,
  '42501', NULL, 'a client cannot list hosted bridges');
SELECT tests.clear_authentication();

SELECT bot_id AS h1_bot FROM public.discord_bridges WHERE id = :'h1' \gset
SELECT discord_token_secret AS h1_dsec, harmony_token_secret AS h1_hsec FROM public.discord_bridge_secrets WHERE bridge_id = :'h1' \gset
SELECT is((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = :'h1_dsec'),
  ('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GabcDE.' || 'abcdefghijklmnopqrstuvwxyz0123456789AB'),
  'the Discord token is a Vault secret, without its Bot prefix');
SELECT isnt((SELECT secret FROM vault.secrets WHERE id = :'h1_dsec'),
  ('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GabcDE.' || 'abcdefghijklmnopqrstuvwxyz0123456789AB'),
  'Vault stores the Discord token encrypted');
SELECT is((public.verify_bot_token(encode(sha256(convert_to(
            (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = :'h1_hsec'), 'UTF8')), 'hex'))->>'bot_id'),
  :'h1_bot', 'the stored Harmony token authenticates as the hosted bridge bot');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_bridge_set_hosted_token(:'h1', ('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GxyzDE.' || 'zyxwvutsrqponmlkjihgfedcba9876543210ZY'));
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'h1_dsec', :'h1_hsec')), 0,
  'replacing the token deletes the previous Vault secrets');

SET LOCAL role service_role;
INSERT INTO out SELECT 'hosted', COALESCE(jsonb_agg(to_jsonb(h)), '[]') FROM public.discord_bridge_hosted_list() h;
RESET role;
SELECT results_eq(
  $q$SELECT jsonb_array_length(v), v->0->>'discord_token', (v->0->>'harmony_token') ~ '^harmony_bot_' FROM out WHERE k = 'hosted'$q$,
  $q$VALUES (1, ('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GxyzDE.' || 'zyxwvutsrqponmlkjihgfedcba9876543210ZY'), true)$q$,
  'service_role lists the hosted bridge with both tokens');
SELECT is((SELECT v->0->>'bridge_id' FROM out WHERE k = 'hosted'), :'h1', 'the hosted list names the bridge');
UPDATE public.instance_config SET config_value = 'false' WHERE config_key = 'discord_bridge_hosting_enabled';
SET LOCAL role service_role;
INSERT INTO out SELECT 'hosted_off', COALESCE(jsonb_agg(to_jsonb(h)), '[]') FROM public.discord_bridge_hosted_list() h;
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'hosted_off'), '[]'::jsonb, 'the hosted list is empty while hosting is disabled');

-- Deletion. ---------------------------------------------------------------------------------
SELECT discord_token_secret AS h1_dsec2, harmony_token_secret AS h1_hsec2 FROM public.discord_bridge_secrets WHERE bridge_id = :'h1' \gset
INSERT INTO public.messages (id, channel_id, bot_id, content)
VALUES ('86000000-0000-0000-0000-0000000000e1', '86000000-0000-0000-0000-0000000000c6', :'h1_bot',
        '[{"type":"text","text":"relayed from Discord"}]'::jsonb);

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(format('SELECT public.discord_bridge_delete(%L)', :'h1'),
  '42501', NULL, 'a non-member cannot delete a bridge');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(format('SELECT public.discord_bridge_delete(%L)', :'h1'), 'the owner deletes the hosted bridge');
SELECT lives_ok(format('SELECT public.discord_bridge_delete(%L)', :'b1'), 'the owner deletes the self-run bridge');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM public.discord_bridge_secrets WHERE bridge_id = :'h1')
          + (SELECT count(*)::int FROM vault.secrets WHERE id IN (:'h1_dsec2', :'h1_hsec2')), 0,
  'deleting a hosted bridge deletes its secrets and their Vault rows');
SELECT results_eq(
  format($q$SELECT b.is_active,
                   (SELECT count(*)::int FROM public.bot_tokens t WHERE t.bot_id = b.id AND t.is_active),
                   (SELECT count(*)::int FROM public.bot_server_permissions p WHERE p.bot_id = b.id),
                   (SELECT count(*)::int FROM public.messages m WHERE m.bot_id = b.id)
              FROM public.bots b WHERE b.id = %L$q$, :'h1_bot'),
  $q$VALUES (false, 0, 0, 1)$q$,
  'a bridge bot that relayed messages is deactivated, uninstalled and revoked; its messages stay');
SELECT is((SELECT count(*)::int FROM public.bots WHERE id = :'b1_bot'), 0,
  'a bridge bot that relayed nothing is deleted');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_channels WHERE bridge_id = :'b1')
          + (SELECT count(*)::int FROM public.discord_bridge_setup_codes WHERE bridge_id = :'b1'), 0,
  'deleting a bridge deletes its pairs and setup codes');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_bridge_create('86000000-0000-0000-0000-0000000000a4', 'self') AS b4 \gset
SELECT tests.clear_authentication();
SELECT bot_id AS b4_bot FROM public.discord_bridges WHERE id = :'b4' \gset
DELETE FROM public.servers WHERE id = '86000000-0000-0000-0000-0000000000a4';
SELECT is((SELECT count(*)::int FROM public.discord_bridges WHERE id = :'b4')
          + (SELECT count(*)::int FROM public.bots WHERE id = :'b4_bot'), 0,
  'deleting the server deletes its bridge and the bridge bot');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_bridge_create('55555555-0000-0000-0000-000000000005', 'self') AS b5 \gset
SELECT tests.clear_authentication();
SELECT bot_id AS b5_bot FROM public.discord_bridges WHERE id = :'b5' \gset
DELETE FROM public.bots WHERE id = :'b5_bot';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_bridge_setup_code(:'b5') AS code5 \gset
SELECT tests.clear_authentication();
SELECT ok((SELECT bot_id IS NOT NULL AND bot_id <> :'b5_bot'::uuid FROM public.discord_bridges WHERE id = :'b5'),
  'a setup code provisions a new bridge bot when the old one was deleted');

SELECT * FROM finish();
ROLLBACK;
