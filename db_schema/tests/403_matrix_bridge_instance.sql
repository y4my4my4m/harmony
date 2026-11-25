-- 20261126100004_matrix_bridge_instance.sql: grants and RLS, the operator's connection and its Vault
-- secrets, the offers, instance bridges, room codes and links, the host's view, bridge_hosts.
--
--   erin     instance admin
--   alice    owner of server_1 (fixture) and s3
--   bob      accepted member of server_1; later holds a MANAGE_SERVER role
--   mallory  owner of s2
--   server_1 general (fixture), c2 text, c4 text hidden from @everyone; s2 with c5; s3 with c6
--   mx       alice's custom Matrix bot in server_1 (a config.json bridge of 1.9.8), scoped install
--            [c2, c4]
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(127);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('eeeeeeee-0000-0000-0000-000000000403', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin403@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin)
VALUES ('f4030000-0000-0000-0000-0000000000e5', 'eeeeeeee-0000-0000-0000-000000000403', 'erin403', 'Erin', true, true);
INSERT INTO public.servers (id, name, owner) VALUES
  ('f4030000-0000-0000-0000-0000000000a2', 'Mallory Server', '33333333-0000-0000-0000-000000000003'),
  ('f4030000-0000-0000-0000-0000000000a3', 'Third Server', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f4030000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'second', 0),
  ('f4030000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'a category', 2),
  ('f4030000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005', 'private', 0),
  ('f4030000-0000-0000-0000-0000000000c5', 'f4030000-0000-0000-0000-0000000000a2', 'elsewhere', 0),
  ('f4030000-0000-0000-0000-0000000000c6', 'f4030000-0000-0000-0000-0000000000a3', 'third-general', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f4030000-0000-0000-0000-0000000000c4', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
INSERT INTO public.bots (id, username, display_name, owner_id, bot_type, is_active) VALUES
  ('f4030000-0000-0000-0000-0000000000b1', 'mx403', 'Matrix 403', '11111111-0000-0000-0000-000000000001', 'bot', true);
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, allowed_channel_ids) VALUES
  ('f4030000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   ARRAY['f4030000-0000-0000-0000-0000000000c2', 'f4030000-0000-0000-0000-0000000000c4']::uuid[]);
UPDATE public.instance_config SET config_value = '"harmony.test"' WHERE config_key = 'domain';

-- SQLSTATE of instance_set, NULL when it is stored.
CREATE FUNCTION pg_temp.refused(p_connection text, p_url text, p_token text, p_server text, p_local text, p_service text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
    PERFORM public.matrix_bridge_instance_set(p_connection, p_url, p_token, p_server, p_local, p_service);
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
END;
$$;
CREATE FUNCTION pg_temp.secret(p_id uuid) RETURNS text LANGUAGE sql AS $$
    SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = p_id
$$;
-- 'channel room bound proof state error' of the pairs of a bot.
CREATE FUNCTION pg_temp.pairs(p_bot uuid) RETURNS text LANGUAGE sql AS $$
    SELECT COALESCE(string_agg(concat_ws(' ', c.name, bc.room_id, bc.room_bound::text, COALESCE(bc.room_proof, '-'), COALESCE(bc.state, '-'),
                                         COALESCE(bc.state_error, '-')), '; ' ORDER BY c.name), '')
      FROM public.bridge_channels bc JOIN public.channels c ON c.id = bc.channel_id WHERE bc.bot_id = p_bot
$$;

-- Grants, RLS and configuration. ------------------------------------------------------------
SELECT ok((SELECT bool_and(relrowsecurity) FROM pg_class
            WHERE oid IN ('public.matrix_bridge_instance'::regclass, 'public.matrix_bridge_room_codes'::regclass, 'public.bridge_hosts'::regclass)),
  'RLS is on for the connection, the room codes and the hosts');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['matrix_bridge_instance', 'matrix_bridge_room_codes', 'bridge_hosts']) t,
                                    unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p, unnest(ARRAY['anon', 'authenticated']) r
                       WHERE has_table_privilege(r, 'public.' || t, p)),
  'clients hold no privilege on them');
CREATE TEMP TABLE client_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO client_fns VALUES
  ('public.matrix_bridge_instance_status()'), ('public.matrix_bridge_instance_set(text, text, text, text, text, text)'),
  ('public.matrix_bridge_instance_registration()'), ('public.matrix_bridge_instance_clear()'), ('public.bridge_hosts_status()'),
  ('public.matrix_bridge_offers()'), ('public.matrix_bridge_room_code(uuid, uuid, text, text)');
CREATE TEMP TABLE service_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO service_fns VALUES
  ('public.matrix_bridge_instance_hosted()'), ('public.matrix_bridge_link_room(text, text, text)'), ('public.bridge_host_report(text, text, jsonb)');
SELECT is_empty($q$SELECT fn FROM client_fns WHERE has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('service_role', fn, 'EXECUTE')
                                                OR NOT has_function_privilege('authenticated', fn, 'EXECUTE')$q$,
  'the admin and manager functions are for signed-in callers, whom they check');
SELECT is_empty($q$SELECT fn FROM service_fns WHERE has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')
                                                 OR NOT has_function_privilege('service_role', fn, 'EXECUTE')$q$,
  'the gateway functions are the service role''s');
SELECT is_empty($q$SELECT fn::regprocedure FROM unnest(ARRAY['public.matrix_bridge_instance_enabled()', 'public.matrix_bridge_instance_limit()',
                          'public.matrix_bridge_instance_configured()', 'public.matrix_bridge_instance_user()',
                          'public.matrix_bridge_instance_view(public.matrix_bridge_instance)', 'public.matrix_bridge_instance_log(uuid, jsonb, jsonb)']) fn,
                          unnest(ARRAY['anon', 'authenticated', 'service_role']) r
                   WHERE has_function_privilege(r, fn, 'EXECUTE')$q$, 'helpers are executable by their owner alone');
SELECT results_eq(
  $q$SELECT config_key, config_value, config_key = ANY (public.public_instance_config_keys()) FROM public.instance_config
      WHERE config_key LIKE 'matrix\_bridge\_instance%' ORDER BY 1$q$,
  $q$VALUES ('matrix_bridge_instance_enabled', 'false'::jsonb, true), ('matrix_bridge_instance_limit', '100'::jsonb, false)$q$,
  'the mode is off by default with a limit of 100; the switch is a public key');

-- The operator's connection. ----------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok('SELECT public.matrix_bridge_instance_status()', '42501', NULL, 'anon reads no status');
SELECT throws_ok('SELECT public.matrix_bridge_offers()', '42501', NULL, 'nor the offers');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok('SELECT public.matrix_bridge_instance_status()', '42501', NULL, 'a member who is no admin reads no status');
SELECT throws_ok($q$SELECT public.matrix_bridge_instance_set('account', 'https://hs.test', 'syt_abcdefgh', NULL, NULL, NULL)$q$, '42501', NULL, 'stores no connection');
SELECT throws_ok('SELECT public.matrix_bridge_instance_registration()', '42501', NULL, 'gets no registration');
SELECT throws_ok('SELECT public.matrix_bridge_instance_clear()', '42501', NULL, 'clears nothing');
SELECT throws_ok('SELECT public.bridge_hosts_status()', '42501', NULL, 'and reads no hosts');
SELECT is(public.matrix_bridge_offers(), '{"hosted":false,"instance":false,"instance_user":null}'::jsonb, 'nothing is offered at first');

SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000403');
SELECT is(public.matrix_bridge_instance_status(),
  '{"enabled":false,"configured":false,"connection":null,"homeserver_url":null,"server_name":null,"sender_localpart":null,"appservice_url":null,
    "has_access_token":false,"has_service_tokens":false,"linked_count":0,"limit":100,"hosting_enabled":false,"hosting_limit":25,"hosted_count":0,
    "host":null}'::jsonb, 'nothing is stored at first');
SELECT is(pg_temp.refused(NULL, 'https://hs.test', NULL, NULL, NULL, NULL), '22023', 'a connection is required');
SELECT is(pg_temp.refused('bot', 'https://hs.test', NULL, NULL, NULL, NULL), '22023', 'and known');
SELECT is(pg_temp.refused('account', NULL, 'syt_abcdefgh', NULL, NULL, NULL), '22023', 'a homeserver is required');
SELECT is(pg_temp.refused('application_service', 'https://hs.test', NULL, NULL, NULL, NULL), '22023', 'an application service needs a server name');
SELECT is_empty($q$SELECT x FROM unnest(ARRAY['matrix.test', 'ftp://hs.test', 'https://user:pw@hs.test', 'https://hs.test/?a=1', 'https://hs.test/#a', 'https://hs test',
                                              'https://' || repeat('a', 260)]) x
                   WHERE pg_temp.refused('account', x, 'syt_abcdefgh', NULL, NULL, NULL) IS DISTINCT FROM '22023'$q$,
  'a homeserver is an http or https URL without credentials, query or fragment');
SELECT is_empty($q$SELECT s, l FROM (VALUES ('example.org', 'Harmony'), ('example.org', 'a b'), ('exa mple.org', 'harmony'), ('example.org:x', 'harmony'),
                                            ('@sam:example.org', 'harmony'), ('example.org', repeat('a', 220))) v(s, l)
                   WHERE pg_temp.refused('application_service', 'https://hs.test', NULL, s, l, NULL) IS DISTINCT FROM '22023'$q$,
  'names the bridge could not use are refused');
SELECT is(pg_temp.refused('account', 'https://hs.test', 'short', NULL, NULL, NULL), '22023', 'so is a malformed token');
SELECT is(pg_temp.refused('account', 'https://hs.test', NULL, NULL, NULL, 'gopher://x'), '22023', 'and a malformed application service URL');
SELECT public.matrix_bridge_instance_set('account', ' http://synapse:8008/ ', ' syt_operator-1 ', '', NULL, '') AS set1 \gset
SELECT tests.clear_authentication();
SELECT is(:'set1'::jsonb - 'host' - 'linked_count' - 'limit' - 'hosting_enabled' - 'hosting_limit' - 'hosted_count',
  '{"enabled":false,"configured":true,"connection":"account","homeserver_url":"http://synapse:8008","server_name":null,"sender_localpart":"harmony_relay",
    "appservice_url":"https://harmony.test/matrix-appservice","has_access_token":true,"has_service_tokens":false}'::jsonb,
  'an account is stored; a private homeserver is the operator''s choice');
SELECT access_token_secret AS a1 FROM public.matrix_bridge_instance \gset
SELECT is(pg_temp.secret(:'a1'), 'syt_operator-1', 'the token is a Vault secret');
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000403');
SELECT throws_ok('SELECT public.matrix_bridge_instance_registration()', '22023', NULL, 'an account has no registration');
SELECT is(pg_temp.refused('', '', 'syt_operator-2', NULL, NULL, NULL), NULL, 'the token alone is replaced');
SELECT tests.clear_authentication();
SELECT results_eq(
  format($q$SELECT homeserver_url, access_token_secret <> %L, (SELECT count(*)::int FROM vault.secrets WHERE id = %L) FROM public.matrix_bridge_instance$q$, :'a1', :'a1'),
  $q$VALUES ('http://synapse:8008', true, 0)$q$, 'empty fields keep what is stored; the replaced token leaves Vault');
SELECT access_token_secret AS a2 FROM public.matrix_bridge_instance \gset

-- As an application service. ----------------------------------------------------------------
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000403');
SELECT public.matrix_bridge_instance_set('application_service', NULL, NULL, 'example.org', NULL, 'http://bridge:9009/') -> 'configured' AS c1 \gset
SELECT is(:'c1'::text, 'false', 'an application service is configured once it is registered');
SELECT public.matrix_bridge_instance_registration() AS reg1 \gset
SELECT public.matrix_bridge_instance_status() AS st1 \gset
SELECT tests.clear_authentication();
SELECT is(:'reg1'::jsonb - 'as_token' - 'hs_token',
  '{"id":"harmony-matrix-relay","url":"http://bridge:9009","sender_localpart":"harmony_relay","rate_limited":false,
    "de.sorunome.msc2409.push_ephemeral":false,
    "namespaces":{"users":[{"exclusive":true,"regex":"^@harmony_relay:example\\.org$"},{"exclusive":true,"regex":"^@harmony_relay_h_[0-9a-f]{32}:example\\.org$"}],
                  "aliases":[],"rooms":[]}}'::jsonb, 'the registration is the bridge''s own');
SELECT ok(:'reg1'::jsonb ->> 'as_token' ~ '^[0-9a-f]{64}$' AND :'reg1'::jsonb ->> 'hs_token' ~ '^[0-9a-f]{64}$'
      AND :'reg1'::jsonb ->> 'as_token' <> :'reg1'::jsonb ->> 'hs_token', 'with two random tokens');
SELECT as_token_secret AS as1, hs_token_secret AS hs1 FROM public.matrix_bridge_instance \gset
SELECT ok(pg_temp.secret(:'as1') = :'reg1'::jsonb ->> 'as_token' AND pg_temp.secret(:'hs1') = :'reg1'::jsonb ->> 'hs_token', 'kept in Vault');
SELECT is(:'st1'::jsonb -> 'configured', 'true'::jsonb, 'which configures it');
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000403');
SELECT public.matrix_bridge_instance_registration() AS reg2 \gset
SELECT public.matrix_bridge_instance_set(NULL, NULL, NULL, NULL, 'bridge.bot', NULL) IS NOT NULL AS renamed \gset
SELECT public.matrix_bridge_instance_registration() AS reg3 \gset
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'as1', :'hs1')), 0, 'a new registration replaces both tokens');
SELECT isnt(:'reg1'::jsonb ->> 'as_token', :'reg2'::jsonb ->> 'as_token', 'with others');
SELECT results_eq(format($q$SELECT r ->> 'id', r #>> '{namespaces,users,0,regex}' FROM (SELECT %L::jsonb AS r) x$q$, :'reg3'),
  $q$VALUES ('harmony-matrix-relay-bridge.bot', '^@bridge\.bot:example\.org$')$q$, 'another sender has another id and an escaped name');
SELECT ok((SELECT bool_and(l.action_details::text !~ ('syt_operator|' || (:'reg1'::jsonb ->> 'as_token') || '|' || (:'reg1'::jsonb ->> 'hs_token')
                                                      || '|' || (:'reg3'::jsonb ->> 'as_token') || '|' || :'a1' || '|' || :'as1'))
             FROM public.admin_audit_log l WHERE l.target_id = 'matrix_bridge_instance')
      AND (SELECT count(*) = 7 FROM public.admin_audit_log l
            WHERE l.target_id = 'matrix_bridge_instance' AND l.admin_id = 'f4030000-0000-0000-0000-0000000000e5' AND l.action_type = 'config_change'),
  'every change is logged for the admin, without a secret or its Vault id');
SELECT ok(:'st1'::text !~ ('syt_|' || (:'reg1'::jsonb ->> 'as_token') || '|' || :'a2' || '|' || :'as1' || '|' || :'hs1'), 'the status names none');

-- Offers and creation. ----------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.matrix_bridge_offers() -> 'instance', 'false'::jsonb, 'a stored connection alone is not offered');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'instance')$q$, '0A000', NULL, 'nor can a bridge use it');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'matrix_bridge_instance_enabled';
UPDATE public.instance_config SET config_value = '1' WHERE config_key = 'matrix_bridge_instance_limit';
SET LOCAL role service_role;
SELECT public.bridge_host_report('matrix', '0.3.0', '{"instance":{"ready":true,"user_id":"@bridge:example.org"},"hosted":0}') IS NOT NULL AS h \gset
RESET role;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.matrix_bridge_offers(), '{"hosted":false,"instance":true,"instance_user":"@bridge:example.org"}'::jsonb,
  'on and configured, it is offered, with the user a room invites');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'instance')$q$, '42501', NULL, 'to managers');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'instance') AS s1 \gset
SELECT :'s1'::jsonb ->> 'id' AS b1, :'s1'::jsonb ->> 'bot_id' AS b1_bot \gset
SELECT throws_ok($q$SELECT public.matrix_bridge_create('f4030000-0000-0000-0000-0000000000a3', 'instance')$q$, '54000', NULL, 'up to the instance limit');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '100' WHERE config_key = 'matrix_bridge_instance_limit';
SELECT harmony_token_secret AS t1 FROM public.matrix_bridge_secrets WHERE bridge_id = :'b1' \gset
SELECT is(public.verify_bot_token(encode(sha256(convert_to(pg_temp.secret(:'t1'), 'UTF8')), 'hex')) ->> 'bot_id', :'b1_bot',
  'the bridge bot''s Harmony token is a Vault secret');
SELECT ok(NOT :'s1'::text ~ ('harmony_bot_[0-9a-f]{64}|' || :'t1'), 'which the state does not name');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format('SELECT public.matrix_bridge_setup_code(%L)', :'b1'), '22023', NULL, 'an instance bridge takes no setup code');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_set_account(%L, 'https://hs.test', 'syt_abcdefgh')$q$, :'b1'), '22023', NULL, 'nor an account');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '!room:example.org')$q$, :'b1'),
  '22023', NULL, 'and no room a manager names');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '#room:example.org')$q$, :'b1'),
  '22023', NULL, 'by alias neither');

-- Room codes. -------------------------------------------------------------------------------
SELECT throws_ok(format($q$SELECT public.matrix_bridge_room_code(%L, 'f4030000-0000-0000-0000-0000000000c5')$q$, :'b1'), '22023', NULL, 'a channel of another server has no code');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_room_code(%L, 'f4030000-0000-0000-0000-0000000000c3')$q$, :'b1'), '22023', NULL, 'nor a category');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_room_code(%L, '66666666-0000-0000-0000-000000000006', 'sideways')$q$, :'b1'), '22023', NULL, 'an unknown direction is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_room_code(%L, '66666666-0000-0000-0000-000000000006', 'both', 'puppet')$q$, :'b1'), '22023', NULL, 'and an unknown sender mode');
SELECT public.matrix_bridge_create('f4030000-0000-0000-0000-0000000000a3', 'self') ->> 'id' AS s3 \gset
SELECT throws_ok(format($q$SELECT public.matrix_bridge_room_code(%L, 'f4030000-0000-0000-0000-0000000000c6')$q$, :'s3'), '22023', NULL, 'a self-run bridge has no room codes');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_room_code(%L, '66666666-0000-0000-0000-000000000006')$q$, :'b1'), '42501', NULL, 'nor a member who does not manage the server');
SELECT tests.clear_authentication();
INSERT INTO public.server_roles (id, server_id, name, permissions, position) VALUES
  ('f4030000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'Managers', 128, 5);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f4030000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_room_code(%L, 'f4030000-0000-0000-0000-0000000000c4')$q$, :'b1'), '42501', NULL, 'nor a manager for a channel hidden from them');
SELECT public.matrix_bridge_room_code(:'b1', '66666666-0000-0000-0000-000000000006') ->> 'code' AS bob_code \gset
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_room_code(:'b1', 'f4030000-0000-0000-0000-0000000000c2') ->> 'code' AS second_code \gset
SELECT public.matrix_bridge_room_code(:'b1', '66666666-0000-0000-0000-000000000006', 'to_matrix', 'relay') AS code1 \gset
SELECT tests.clear_authentication();
SELECT ok(:'code1'::jsonb ->> 'code' ~ '^ML-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'
      AND (:'code1'::jsonb ->> 'expires_at')::timestamptz = now() + interval '30 minutes'
      AND :'code1'::jsonb ->> 'user_id' = '@bridge:example.org', 'a code reads ML-XXXX-XXXX-XXXX, lives 30 minutes and names whom to invite');
SELECT results_eq(
  $q$SELECT c.name, k.direction, k.sender_mode, k.code_hash FROM public.matrix_bridge_room_codes k JOIN public.channels c ON c.id = k.channel_id ORDER BY c.name$q$,
  format($q$VALUES ('general', 'to_matrix', 'relay', %L), ('second', 'both', 'ghost', %L)$q$,
         encode(sha256(convert_to(:'code1'::jsonb ->> 'code', 'UTF8')), 'hex'), encode(sha256(convert_to(:'second_code', 'UTF8')), 'hex')),
  'one per channel, hashed; the code of one channel leaves another''s');
SELECT :'code1'::jsonb ->> 'code' AS code1 \gset

-- Linking: one answer for every bad code. ---------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('replaced', public.matrix_bridge_link_room(:'bob_code', '!room:example.org', '@sam:example.org'));
INSERT INTO out VALUES ('unknown', public.matrix_bridge_link_room('ML-AAAA-BBBB-CCCC', '!room:example.org', '@sam:example.org'));
INSERT INTO out VALUES ('malformed', public.matrix_bridge_link_room('nope', '!room:example.org', '@sam:example.org'));
INSERT INTO out VALUES ('null', public.matrix_bridge_link_room(NULL, '!room:example.org', '@sam:example.org'));
INSERT INTO out VALUES ('other-prefix', public.matrix_bridge_link_room('MX' || substr(:'code1', 3), '!room:example.org', '@sam:example.org'));
SELECT throws_ok(format($q$SELECT public.matrix_bridge_link_room(%L, 'room', '@sam:example.org')$q$, :'code1'), '22023', NULL, 'a malformed room is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_link_room(%L, '!room:example.org', 'sam')$q$, :'code1'), '22023', NULL, 'so is a malformed sender');
INSERT INTO out VALUES ('as-setup-code', public.matrix_bridge_redeem_code(:'code1'));
RESET role;
UPDATE public.instance_config SET config_value = 'false' WHERE config_key = 'matrix_bridge_instance_enabled';
SET LOCAL role service_role;
INSERT INTO out VALUES ('off', public.matrix_bridge_link_room(:'code1', '!room:example.org', '@sam:example.org'));
RESET role;
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'matrix_bridge_instance_enabled';
UPDATE public.matrix_bridge_room_codes SET expires_at = now() - interval '1 second' WHERE channel_id = '66666666-0000-0000-0000-000000000006';
SET LOCAL role service_role;
INSERT INTO out VALUES ('expired', public.matrix_bridge_link_room(:'code1', '!room:example.org', '@sam:example.org'));
RESET role;
UPDATE public.matrix_bridge_room_codes SET expires_at = now() + interval '1 minute' WHERE channel_id = '66666666-0000-0000-0000-000000000006';
SELECT is_empty($q$SELECT k FROM out WHERE k IN ('replaced', 'unknown', 'malformed', 'null', 'other-prefix', 'as-setup-code', 'off', 'expired') AND v IS NOT NULL$q$,
  'a replaced, unknown, malformed, missing, foreign or expired code and a switched-off mode answer alike');
SELECT is((SELECT count(*)::int FROM public.matrix_bridge_room_codes WHERE used_at IS NOT NULL) + (SELECT count(*)::int FROM public.bridge_channels WHERE bot_id = :'b1_bot'), 0,
  'and consume and bind nothing');

-- An encrypted channel. ---------------------------------------------------------------------
INSERT INTO public.server_encryption_settings (server_id, encryption_mode) VALUES ('55555555-0000-0000-0000-000000000005', 'optional')
ON CONFLICT (server_id) DO UPDATE SET encryption_mode = 'optional';
INSERT INTO public.channel_encryption_settings (channel_id, messages_encrypted) VALUES ('66666666-0000-0000-0000-000000000006', true)
ON CONFLICT (channel_id) DO UPDATE SET messages_encrypted = true;
SET LOCAL role service_role;
SELECT throws_ok(format($q$SELECT public.matrix_bridge_link_room(%L, '!room:example.org', '@sam:example.org')$q$, :'code1'), '55000', 'channel_encrypted',
  'a channel encrypted since is not linked');
RESET role;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_room_code(%L, '66666666-0000-0000-0000-000000000006')$q$, :'b1'), '22023', NULL, 'nor gets a code');
SELECT tests.clear_authentication();
UPDATE public.channel_encryption_settings SET messages_encrypted = false WHERE channel_id = '66666666-0000-0000-0000-000000000006';

-- A good code. ------------------------------------------------------------------------------
UPDATE public.matrix_bridges SET updated_at = '2000-01-01';
SET LOCAL role service_role;
INSERT INTO out VALUES ('link1', public.matrix_bridge_link_room(' ' || lower(:'code1') || ' ', '!room:example.org', '@sam:example.org'));
INSERT INTO out VALUES ('again', public.matrix_bridge_link_room(:'code1', '!other:example.org', '@sam:example.org'));
INSERT INTO out VALUES ('config1', public.matrix_bridge_config(:'b1_bot'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'link1'),
  jsonb_build_object('bridge_id', :'b1', 'server_name', 'Test Server', 'channel_id', '66666666-0000-0000-0000-000000000006', 'channel_name', 'general'),
  'a code links its channel with the room it was posted in; it is kept after the encrypted answer');
SELECT is((SELECT v FROM out WHERE k = 'again'), NULL, 'once');
SELECT is(pg_temp.pairs(:'b1_bot'), 'general !room:example.org true code - -', 'the room is bound and proved');
SELECT results_eq(format($q$SELECT direction, sender_mode, sender_mode_set_by_manager FROM public.bridge_channels WHERE bot_id = %L$q$, :'b1_bot'),
  $q$VALUES ('to_matrix', 'relay', true)$q$, 'with the direction and sender mode of the code');
SELECT is((SELECT used_by FROM public.matrix_bridge_room_codes WHERE used_at IS NOT NULL), '@sam:example.org', 'who posted it is kept');
SELECT results_eq('SELECT server_id, updated_at = now() FROM public.matrix_bridges ORDER BY server_id',
  $q$VALUES ('55555555-0000-0000-0000-000000000005'::uuid, true), ('f4030000-0000-0000-0000-0000000000a3'::uuid, false)$q$, 'a link is a configuration change of its bridge');
SELECT is((SELECT v #>> '{pairs,0,room_id}' FROM out WHERE k = 'config1'), '!room:example.org', 'which the bridge reads');
SELECT is((SELECT allowed_channel_ids::text FROM public.bot_server_permissions WHERE bot_id = :'b1_bot'), '{66666666-0000-0000-0000-000000000006}', 'and its bot sees the channel');
SET LOCAL role service_role;
SELECT is(public.matrix_bridge_bind_room(:'b1_bot', '66666666-0000-0000-0000-000000000006', '!room:example.org', 'ghost') ->> 'room_id', '!room:example.org',
  'the bridge binds the linked room again');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_bind_room(%L, '66666666-0000-0000-0000-000000000006', '!stolen:example.org', 'ghost')$q$, :'b1_bot'), '22023', NULL,
  'and no other');
RESET role;

-- Changing a linked pair. -------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(format($q$SELECT public.matrix_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '!room:example.org', 'both', 'ghost')$q$, :'b1'),
  'a manager changes the direction and sender mode of a linked pair');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '!else:example.org')$q$, :'b1'), '22023', NULL, 'and not its room');
SELECT tests.clear_authentication();
SELECT is((SELECT concat_ws(' ', room_id, room_bound, room_proof, direction, sender_mode) FROM public.bridge_channels WHERE bot_id = :'b1_bot'),
  '!room:example.org t code both ghost', 'which stays bound and proved');

-- The same bridge: the room on another channel, another room on the channel. ----------------
SET LOCAL role service_role;
SELECT public.matrix_bridge_link_room(:'second_code', '!room:example.org', '@sam:example.org') IS NOT NULL AS l2 \gset
RESET role;
SELECT is(pg_temp.pairs(:'b1_bot'), 'second !room:example.org true code - -', 'a room linked to another channel of the bridge leaves the first');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_room_code(:'b1', 'f4030000-0000-0000-0000-0000000000c2') ->> 'code' AS code3 \gset
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT public.matrix_bridge_link_room(:'code3', '!new:example.org', '@sam:example.org') IS NOT NULL AS l3 \gset
RESET role;
SELECT is(pg_temp.pairs(:'b1_bot'), 'second !new:example.org true code - -', 'a channel linked to another room leaves the first');

-- An issuer who lost the sight of the channel, or the permission. ---------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.matrix_bridge_room_code(:'b1', '66666666-0000-0000-0000-000000000006') ->> 'code' AS bob1 \gset
SELECT tests.clear_authentication();
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
VALUES ('66666666-0000-0000-0000-000000000006', 'user', NULL, '22222222-0000-0000-0000-000000000002', 0, 2);
SET LOCAL role service_role;
INSERT INTO out VALUES ('blinded', public.matrix_bridge_link_room(:'bob1', '!bob:example.org', '@bob:example.org'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'blinded'), NULL, 'the code of a manager who no longer sees the channel links nothing');
DELETE FROM public.channel_permission_overrides WHERE channel_id = '66666666-0000-0000-0000-000000000006';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.matrix_bridge_room_code(:'b1', '66666666-0000-0000-0000-000000000006') ->> 'code' AS bob2 \gset
SELECT tests.clear_authentication();
DELETE FROM public.user_roles WHERE role_id = 'f4030000-0000-0000-0000-0000000000d1';
SET LOCAL role service_role;
INSERT INTO out VALUES ('demoted', public.matrix_bridge_link_room(:'bob2', '!bob:example.org', '@bob:example.org'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'demoted'), NULL, 'the code of a manager who lost MANAGE_SERVER links nothing');
SELECT is((SELECT count(*)::int FROM public.bridge_channels WHERE room_id = '!bob:example.org'), 0, 'and binds nothing');

-- A room bound elsewhere moves to the code. -------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.configure_matrix_bridge('f4030000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
         ARRAY['f4030000-0000-0000-0000-0000000000c2', 'f4030000-0000-0000-0000-0000000000c4']::uuid[]) AS cfg \gset
SELECT public.matrix_bridge_pair(:'s3', 'f4030000-0000-0000-0000-0000000000c6', '!self:example.org') ->> 'bot_id' AS s3_bot \gset
SELECT public.matrix_bridge_room_code(:'b1', '66666666-0000-0000-0000-000000000006') ->> 'code' AS code4 \gset
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.matrix_bridge_create('f4030000-0000-0000-0000-0000000000a2', 'instance') AS s2 \gset
SELECT :'s2'::jsonb ->> 'id' AS b2, :'s2'::jsonb ->> 'bot_id' AS b2_bot \gset
SELECT throws_ok(format($q$SELECT public.matrix_bridge_room_code(%L, '66666666-0000-0000-0000-000000000006')$q$, :'b2'), '22023', NULL, 'a manager gets no code for a channel of another server');
SELECT public.matrix_bridge_room_code(:'b2', 'f4030000-0000-0000-0000-0000000000c5') ->> 'code' AS code5 \gset
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT public.matrix_bridge_bind_room(:'s3_bot', 'f4030000-0000-0000-0000-0000000000c6', '!self:example.org', 'ghost') IS NOT NULL AS bs \gset
SELECT public.matrix_bridge_report_status(:'s3_bot', NULL, '{"ready":true}', '{"rooms":[]}', '1', '[{"channel_id":"f4030000-0000-0000-0000-0000000000c6","state":"ready"}]') IS NOT NULL AS rs \gset
UPDATE public.matrix_bridges SET updated_at = '2000-01-01' WHERE id = :'s3';
SELECT public.matrix_bridge_link_room(:'code4', '!self:example.org', '@sam:example.org') IS NOT NULL AS l4 \gset
SELECT public.matrix_bridge_report_status(:'s3_bot', NULL, '{"ready":true}', '{"rooms":[]}', '1', '[{"channel_id":"f4030000-0000-0000-0000-0000000000c6","state":"ready"}]') IS NOT NULL AS rs2 \gset
INSERT INTO out VALUES ('moved-read', public.matrix_bridge_room(:'s3_bot', 'f4030000-0000-0000-0000-0000000000c6'));
SELECT throws_ok(format($q$SELECT public.matrix_bridge_bind_room(%L, 'f4030000-0000-0000-0000-0000000000c6', '!self:example.org', 'ghost')$q$, :'s3_bot'), '23505', NULL,
  'a bridge does not bind a room back that was linked elsewhere');
RESET role;
SELECT is(pg_temp.pairs(:'s3_bot'), 'third-general !self:example.org false - error room_in_use', 'its pair is unbound and in error, whatever it reports');
SELECT is((SELECT v -> 'room_id' FROM out WHERE k = 'moved-read'), 'null'::jsonb, 'and reads as no room');
SELECT is(pg_temp.pairs(:'b1_bot'), 'general !self:example.org true code - -; second !new:example.org true code - -', 'the linked channel has it');
SELECT is((SELECT updated_at FROM public.matrix_bridges WHERE id = :'s3'), now(), 'the earlier bridge is told');

SET LOCAL role service_role;
SELECT public.matrix_bridge_link_room(:'code5', '!self:example.org', '@mallory:example.org') IS NOT NULL AS l5 \gset
INSERT INTO out VALUES ('config-moved', public.matrix_bridge_config(:'b1_bot'));
SELECT throws_ok(format($q$SELECT public.matrix_bridge_bind_room(%L, '66666666-0000-0000-0000-000000000006', '!self:example.org', 'ghost')$q$, :'b1_bot'), '23505', NULL,
  'an instance bridge binds no room back either');
RESET role;
SELECT is(pg_temp.pairs(:'b2_bot'), 'elsewhere !self:example.org true code - -', 'a later code moves the room on');
SELECT is((SELECT v -> 'pairs' -> 0 ->> 'room_id' FROM out WHERE k = 'config-moved'), NULL, 'the earlier instance bridge is not given the room any more');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.matrix_bridge_unpair(:'b2', 'f4030000-0000-0000-0000-0000000000c5') IS NOT NULL AS u5 \gset
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT throws_ok(format($q$SELECT public.matrix_bridge_bind_room(%L, '66666666-0000-0000-0000-000000000006', '!self:example.org', 'ghost')$q$, :'b1_bot'), '23505', NULL,
  'not even once the room is free: it needs a code');
SELECT is(public.matrix_bridge_bind_room(:'s3_bot', 'f4030000-0000-0000-0000-0000000000c6', '!self:example.org', 'ghost') ->> 'room_id', '!self:example.org',
  'a self-run bridge binds a free room it names');
RESET role;

-- A custom bot's room: that channel alone changes.
SET LOCAL role service_role;
SELECT public.matrix_bridge_bind_room(p_bot_id => 'f4030000-0000-0000-0000-0000000000b1', p_channel_id => 'f4030000-0000-0000-0000-0000000000c2',
         p_room_id => '!custom:example.org', p_initial_sender_mode => 'relay') IS NOT NULL AS bc \gset
SELECT public.matrix_bridge_bind_room(p_bot_id => 'f4030000-0000-0000-0000-0000000000b1', p_channel_id => 'f4030000-0000-0000-0000-0000000000c4',
         p_room_id => '!kept:example.org', p_initial_sender_mode => 'ghost') IS NOT NULL AS bk \gset
RESET role;
CREATE TEMP TABLE before ON COMMIT DROP AS
  SELECT to_jsonb(bc) AS pair, to_jsonb(b) - 'updated_at' AS bot, to_jsonb(p) AS install
    FROM public.bridge_channels bc
    JOIN public.bots b ON b.id = bc.bot_id
    JOIN public.bot_server_permissions p ON p.bot_id = bc.bot_id
   WHERE bc.channel_id = 'f4030000-0000-0000-0000-0000000000c4';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.matrix_bridge_room_code(:'b2', 'f4030000-0000-0000-0000-0000000000c5') ->> 'code' AS code6 \gset
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT public.matrix_bridge_link_room(:'code6', '!custom:example.org', '@mallory:example.org') IS NOT NULL AS l6 \gset
INSERT INTO out VALUES ('custom-read', public.matrix_bridge_room('f4030000-0000-0000-0000-0000000000b1', 'f4030000-0000-0000-0000-0000000000c2'));
INSERT INTO out VALUES ('custom-kept', public.matrix_bridge_room('f4030000-0000-0000-0000-0000000000b1', 'f4030000-0000-0000-0000-0000000000c4'));
SELECT throws_ok($q$SELECT public.matrix_bridge_bind_room(p_bot_id => 'f4030000-0000-0000-0000-0000000000b1',
                             p_channel_id => 'f4030000-0000-0000-0000-0000000000c2', p_room_id => '!custom:example.org', p_initial_sender_mode => 'relay')$q$,
  '23505', NULL, 'a custom bot does not bind a room back that was linked elsewhere');
RESET role;
SELECT is(pg_temp.pairs('f4030000-0000-0000-0000-0000000000b1'),
  'private !kept:example.org true - - -; second !custom:example.org false - error room_in_use', 'its pair is unbound and in error');
SELECT is((SELECT v -> 'room_id' FROM out WHERE k = 'custom-read'), 'null'::jsonb, 'and reads as no room');
SELECT is((SELECT v FROM out WHERE k = 'custom-kept'), '{"room_id":"!kept:example.org","sender_mode":"ghost"}'::jsonb, 'its other channel keeps its room');
SELECT results_eq(
  $q$SELECT to_jsonb(bc), to_jsonb(b) - 'updated_at', to_jsonb(p) FROM public.bridge_channels bc JOIN public.bots b ON b.id = bc.bot_id
       JOIN public.bot_server_permissions p ON p.bot_id = bc.bot_id WHERE bc.channel_id = 'f4030000-0000-0000-0000-0000000000c4'$q$,
  'SELECT pair, bot, install FROM before', 'and everything else: the pair, the bot and its install');
SELECT is(public.bridge_channel_platform('f4030000-0000-0000-0000-0000000000b1', 'f4030000-0000-0000-0000-0000000000c4'), 'matrix', 'which it still relays');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT results_eq(
  $q$SELECT x ->> 'channel_name', x ->> 'room_id' FROM jsonb_array_elements(public.get_server_matrix_bridges('55555555-0000-0000-0000-000000000005')) x ORDER BY 1$q$,
  $q$VALUES ('private', '!kept:example.org'), ('second', NULL::text)$q$, 'and its manager sees the one room');
SELECT lives_ok($q$SELECT public.configure_matrix_bridge('f4030000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
                     ARRAY['f4030000-0000-0000-0000-0000000000c4']::uuid[])$q$, 'the manager drops the lost channel');
SELECT is(public.configure_matrix_bridge('f4030000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
            ARRAY['f4030000-0000-0000-0000-0000000000c2', 'f4030000-0000-0000-0000-0000000000c4']::uuid[]), true, 'and pairs it anew');
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT is(public.matrix_bridge_bind_room(p_bot_id => 'f4030000-0000-0000-0000-0000000000b1', p_channel_id => 'f4030000-0000-0000-0000-0000000000c2',
            p_room_id => '!another:example.org', p_initial_sender_mode => 'relay') ->> 'room_id', '!another:example.org', 'for another room');

-- One bridge's bot against another bridge's channel. ----------------------------------------
SELECT is_empty(format($f$SELECT bot, what FROM (VALUES (%L::uuid, 'f4030000-0000-0000-0000-0000000000c5'::uuid), (%L::uuid, '66666666-0000-0000-0000-000000000006'::uuid)) v(bot, channel),
    LATERAL (VALUES ('platform', public.bridge_channel_platform(bot, channel)),
                    ('config', (SELECT p ->> 'channel_id' FROM jsonb_array_elements(public.matrix_bridge_config(bot) -> 'pairs') p WHERE p ->> 'channel_id' = channel::text))) t(what, answer)
   WHERE answer IS NOT NULL$f$, :'b1_bot', :'b2_bot'), 'an instance bridge relays and reads no channel of another');
RESET role;
CREATE FUNCTION pg_temp.state_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE p_sql;
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
END;
$$;
SELECT is_empty(format($f$SELECT call FROM (VALUES (%1$L, 'f4030000-0000-0000-0000-0000000000c5'), (%2$L, '66666666-0000-0000-0000-000000000006')) v(bot, channel),
    LATERAL (VALUES (format('SELECT public.matrix_bridge_room(%%L, %%L)', bot, channel)),
                    (format('SELECT public.matrix_bridge_bind_room(%%L, %%L, ''!x:y'', ''relay'')', bot, channel)),
                    (format('SELECT * FROM public.matrix_bridge_channel_members(%%L, %%L)', bot, channel)),
                    (format('SELECT * FROM public.matrix_bridge_channel_member(%%L, %%L, %%L)', bot, channel, '11111111-0000-0000-0000-000000000001')),
                    (format('INSERT INTO public.messages (channel_id, bot_id, content, metadata) VALUES (%%L, %%L, ''[]'', ''{"matrix_user":{"id":"@a:b","username":"a"}}'')', channel, bot))) t(call)
   WHERE pg_temp.state_of(call) IS DISTINCT FROM '42501'$f$, :'b1_bot', :'b2_bot'),
  'nor does it read or bind its room, list its members or write as a Matrix person there');

-- The host's view. --------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok('SELECT public.matrix_bridge_instance_hosted()', '42501', NULL, 'a manager reads nothing of the host''s work');
SELECT throws_ok($q$SELECT public.matrix_bridge_link_room('ML-AAAA-BBBB-CCCC', '!a:b', '@a:b')$q$, '42501', NULL, 'and links nothing');
SELECT tests.clear_authentication();
SET LOCAL role service_role;
INSERT INTO out VALUES ('hosted', public.matrix_bridge_instance_hosted());
RESET role;
SELECT results_eq(
  $q$SELECT v ->> 'connection', v ->> 'homeserver_url', v ->> 'server_name', v ->> 'sender_localpart', v ->> 'as_token', v ->> 'hs_token', v -> 'access_token',
            jsonb_array_length(v -> 'bridges'), v -> 'bridges' -> 0 ->> 'bridge_id', v -> 'bridges' -> 0 ->> 'harmony_token' FROM out WHERE k = 'hosted'$q$,
  format($q$VALUES ('application_service', 'http://synapse:8008', 'example.org', 'bridge.bot', %L, %L, 'null'::jsonb, 2, %L, %L)$q$,
         :'reg3'::jsonb ->> 'as_token', :'reg3'::jsonb ->> 'hs_token',
         (SELECT id FROM public.matrix_bridges WHERE mode = 'instance' ORDER BY created_at, id LIMIT 1),
         (SELECT pg_temp.secret(s.harmony_token_secret) FROM public.matrix_bridge_secrets s
           WHERE s.bridge_id = (SELECT id FROM public.matrix_bridges WHERE mode = 'instance' ORDER BY created_at, id LIMIT 1))),
  'the host reads the connection and every instance bridge with its token');
UPDATE public.instance_config SET config_value = 'false' WHERE config_key = 'matrix_bridge_instance_enabled';
SELECT is(public.matrix_bridge_instance_hosted(), NULL, 'nothing while the mode is off');
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'matrix_bridge_instance_enabled';

-- Hosts. ------------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.bridge_host_report('discord') IS NOT NULL AS d1 \gset
SELECT throws_ok($q$SELECT public.bridge_host_report('irc')$q$, '22023', NULL, 'an unknown platform is refused');
SELECT throws_ok($q$SELECT public.bridge_host_report('matrix', '1', '[]')$q$, '22023', NULL, 'and a status that is no object');
SELECT throws_ok($q$SELECT public.bridge_host_report('matrix', '1', jsonb_build_object('x', repeat('x', 65536)))$q$, '22023', NULL, 'or over 64 KiB');
RESET role;
UPDATE public.bridge_hosts SET last_seen_at = now() - interval '30 seconds';
SET LOCAL role service_role;
SELECT public.bridge_host_report('discord') IS NOT NULL AS d2 \gset
RESET role;
SELECT is((SELECT last_seen_at FROM public.bridge_hosts WHERE platform = 'discord'), now() - interval '30 seconds', 'a call is recorded at most once a minute');
UPDATE public.bridge_hosts SET last_seen_at = now() - interval '2 minutes';
SET LOCAL role service_role;
SELECT public.bridge_host_report('discord') IS NOT NULL AS d3, public.bridge_host_report('matrix') IS NOT NULL AS m3 \gset
RESET role;
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000403');
SELECT is((SELECT jsonb_agg(h - 'last_seen_at') FROM jsonb_array_elements(public.bridge_hosts_status()) h),
  '[{"platform":"discord","version":null,"status":{}},
    {"platform":"matrix","version":"0.3.0","status":{"instance":{"ready":true,"user_id":"@bridge:example.org"},"hosted":0}}]'::jsonb,
  'an admin reads both hosts; a call without a status keeps the last one');
SELECT is((public.matrix_bridge_instance_status() - 'host') - ARRAY['connection','homeserver_url','server_name','sender_localpart','appservice_url'],
  '{"enabled":true,"configured":true,"has_access_token":true,"has_service_tokens":true,"linked_count":2,"limit":100,"hosting_enabled":false,"hosting_limit":25,"hosted_count":0}'::jsonb,
  'the status counts the instance bridges');
SELECT is(public.matrix_bridge_instance_status() #>> '{host,version}', '0.3.0', 'and carries the host''s report');

-- Another homeserver. -----------------------------------------------------------------------
SELECT tests.clear_authentication();
SELECT access_token_secret AS a8, as_token_secret AS as8, hs_token_secret AS hs8 FROM public.matrix_bridge_instance \gset
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000403');
SELECT is(public.matrix_bridge_instance_set(NULL, 'http://synapse:8008/', NULL, NULL, NULL, NULL) -> 'has_service_tokens', 'true'::jsonb,
  'the same homeserver keeps the tokens');
SELECT public.matrix_bridge_instance_set(NULL, 'https://elsewhere.test', NULL, NULL, NULL, NULL) AS moved \gset
SELECT is((SELECT jsonb_build_object('configured', m -> 'configured', 'token', m -> 'has_access_token', 'service', m -> 'has_service_tokens')
             FROM (SELECT :'moved'::jsonb AS m) x), '{"configured":false,"token":false,"service":false}'::jsonb,
  'another homeserver gets none of the stored tokens');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'a8', :'as8', :'hs8')), 0, 'which leave Vault');
SELECT is(public.matrix_bridge_instance_hosted(), NULL, 'and the host gets nothing to send there');
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000403');
SELECT public.matrix_bridge_instance_set(NULL, 'http://synapse:8008', 'syt_operator-3', NULL, NULL, NULL) AS back \gset
SELECT public.matrix_bridge_instance_registration() IS NOT NULL AS again \gset
SELECT is(:'back'::jsonb -> 'has_access_token', 'true'::jsonb, 'a token given with the homeserver is its own');

-- Clearing and deletion. --------------------------------------------------------------------
SELECT tests.clear_authentication();
SELECT access_token_secret AS a9, as_token_secret AS as9, hs_token_secret AS hs9 FROM public.matrix_bridge_instance \gset
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000403');
SELECT lives_ok('SELECT public.matrix_bridge_instance_clear()', 'an admin forgets the connection');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'a9', :'as9', :'hs9')) + (SELECT count(*)::int FROM public.matrix_bridge_instance), 0, 'its secrets leave Vault');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'matrix_bridge_instance_enabled'), 'false'::jsonb, 'the mode is off');
SELECT is((SELECT count(*)::int FROM public.matrix_bridges WHERE mode = 'instance'), 2, 'the bridges stay');
SELECT harmony_token_secret AS t9 FROM public.matrix_bridge_secrets WHERE bridge_id = :'b2' \gset
DELETE FROM public.servers WHERE id = 'f4030000-0000-0000-0000-0000000000a2';
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id = :'t9'), 0, 'a deleted server takes its bridge''s secret');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_delete(:'b1') IS NOT NULL AS gone \gset
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id = :'t1') + (SELECT count(*)::int FROM public.matrix_bridge_room_codes), 0, 'a deleted bridge its secret and its codes');

SELECT * FROM finish();
ROLLBACK;
