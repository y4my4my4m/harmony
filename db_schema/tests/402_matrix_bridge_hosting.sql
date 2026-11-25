-- 20261126100003_matrix_bridge_hosting.sql: grants and RLS, the hosting switch and limit, the Matrix
-- account of a hosted bridge, its Vault secrets and what the bridge host reads.
--
--   alice    owner of server_1 (fixture), s3 and s4
--   bob      accepted member of server_1 without MANAGE_SERVER
--   mallory  owner of s2
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(52);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO public.servers (id, name, owner) VALUES
  ('f4020000-0000-0000-0000-0000000000a2', 'Mallory Server', '33333333-0000-0000-0000-000000000003'),
  ('f4020000-0000-0000-0000-0000000000a3', 'Third Server', '11111111-0000-0000-0000-000000000001'),
  ('f4020000-0000-0000-0000-0000000000a4', 'Fourth Server', '11111111-0000-0000-0000-000000000001');

-- SQLSTATE of set_account, NULL when it is stored.
CREATE FUNCTION pg_temp.refused(p_bridge uuid, p_url text, p_token text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
    PERFORM public.matrix_bridge_set_account(p_bridge, p_url, p_token);
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
END;
$$;
CREATE FUNCTION pg_temp.secret(p_id uuid) RETURNS text LANGUAGE sql AS $$
    SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = p_id
$$;

-- Grants, RLS and configuration. ------------------------------------------------------------
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.matrix_bridge_secrets'::regclass), 'RLS is on for the secrets');
SELECT ok(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p, unnest(ARRAY['anon', 'authenticated']) r
                       WHERE has_table_privilege(r, 'public.matrix_bridge_secrets', p)),
  'clients hold no privilege on the secrets');
SELECT ok(has_function_privilege('authenticated', 'public.matrix_bridge_set_account(uuid, text, text)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.matrix_bridge_set_account(uuid, text, text)', 'EXECUTE')
      AND NOT has_function_privilege('service_role', 'public.matrix_bridge_set_account(uuid, text, text)', 'EXECUTE'),
  'set_account is for signed-in callers');
SELECT ok(has_function_privilege('service_role', 'public.matrix_bridge_hosted_list()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.matrix_bridge_hosted_list()', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.matrix_bridge_hosted_list()', 'EXECUTE'),
  'the hosted list is the gateway''s');
SELECT is_empty($q$SELECT fn::regprocedure FROM unnest(ARRAY['public.matrix_bridge_hosting_enabled()', 'public.matrix_bridge_hosting_limit()',
                          'public.matrix_bridge_vault_token(uuid)', 'public.matrix_bridge_admit_mode(text)', 'public.matrix_bridge_json(uuid)']) fn,
                          unnest(ARRAY['anon', 'authenticated', 'service_role']) r
                   WHERE has_function_privilege(r, fn, 'EXECUTE')$q$, 'helpers are executable by their owner alone');
SELECT results_eq(
  $q$SELECT config_key, config_value FROM public.instance_config WHERE config_key LIKE 'matrix\_bridge\_hosting%' ORDER BY 1$q$,
  $q$VALUES ('matrix_bridge_hosting_enabled', 'false'::jsonb), ('matrix_bridge_hosting_limit', '25'::jsonb)$q$,
  'hosting is off by default with a limit of 25');
SELECT ok('matrix_bridge_hosting_enabled' = ANY (public.public_instance_config_keys())
      AND NOT 'matrix_bridge_hosting_limit' = ANY (public.public_instance_config_keys())
      AND 'discord_bridge_hosting_enabled' = ANY (public.public_instance_config_keys()),
  'the switch is a public instance key, the limit is not');

-- Creation. ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'hosted')$q$, '0A000', NULL,
  'hosted mode needs hosting enabled');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'matrix_bridge_hosting_enabled';
UPDATE public.instance_config SET config_value = '1' WHERE config_key = 'matrix_bridge_hosting_limit';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'hosted')$q$, '42501', NULL,
  'and a manager');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'hosted') AS h1 \gset
SELECT results_eq(
  format($q$SELECT s ->> 'mode', s -> 'has_account', s -> 'homeserver_url' FROM (SELECT %L::jsonb AS s) x$q$, :'h1'),
  $q$VALUES ('hosted', 'false'::jsonb, 'null'::jsonb)$q$, 'a hosted bridge starts without an account');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('f4020000-0000-0000-0000-0000000000a3', 'hosted')$q$, '54000', NULL,
  'hosted bridges stop at the instance limit');
SELECT lives_ok($q$SELECT public.matrix_bridge_create('f4020000-0000-0000-0000-0000000000a3', 'self')$q$, 'which self-run bridges do not count toward');
SELECT :'h1'::jsonb ->> 'id' AS h1, :'h1'::jsonb ->> 'bot_id' AS h1_bot \gset
SELECT throws_ok(format('SELECT public.matrix_bridge_setup_code(%L)', :'h1'), '22023', NULL, 'a hosted bridge takes no setup code');
SELECT public.matrix_bridge_state('f4020000-0000-0000-0000-0000000000a3') ->> 'id' AS s3 \gset

-- The account. ------------------------------------------------------------------------------
SELECT is(pg_temp.refused(:'s3', 'https://matrix.example.org', 'syt_abcdefgh'), '22023', 'a self-run bridge stores no account');
SELECT is(pg_temp.refused('f4020000-0000-0000-0000-0000000000ff', 'https://matrix.example.org', 'syt_abcdefgh'), 'P0002', 'an unknown bridge stores none');
SELECT is_empty(format($f$SELECT x FROM unnest(ARRAY['', 'matrix.example.org', 'http://matrix.example.org', 'ftp://matrix.example.org',
    'https://', 'https://matrix.example.org/_matrix', 'https://matrix.example.org/?a=1', 'https://matrix.example.org#x', 'https://user@matrix.example.org',
    'https://user:pass@matrix.example.org', 'https://matrix.example.org:0', 'https://matrix.example.org:65536', 'https://matrix.example.org:99999999999999999999',
    'https://matrix example.org', 'https://-matrix.example.org', 'https://matrix..example.org', E'https://matrix.example.org\nx', 'https://' || repeat('a', 250) || '.org',
    'https://matrix.example.org\@evil.example', 'https://[::1', 'javascript:alert(1)']) x
   WHERE pg_temp.refused(%L, x, 'syt_abcdefgh') IS DISTINCT FROM '22023'$f$, :'h1'), 'a homeserver is https and a host alone');
SELECT is(pg_temp.refused(:'h1', NULL, 'syt_abcdefgh'), '22023', 'and required');
SELECT is_empty(format($f$SELECT x FROM unnest(ARRAY['', 'short', 'with space in it', E'with\ttab-inside', 'caf' || chr(233) || '-token', repeat('a', 4097)]) x
   WHERE pg_temp.refused(%L, 'https://matrix.example.org', x) IS DISTINCT FROM '22023'$f$, :'h1'), 'a token is 8 to 4096 printable ASCII characters');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.refused(:'h1', 'https://matrix.example.org', 'syt_abcdefgh'), '42501', 'a member who does not manage the server stores no account');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.refused(:'h1', 'https://matrix.example.org', 'syt_abcdefgh'), '42501', 'nor does a stranger');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_set_account(:'h1', E' HTTPS://Matrix.Example.org:8448/ \n', E' syt_first-token_1 \n') AS acc1 \gset
SELECT tests.clear_authentication();
SELECT results_eq(format($q$SELECT s ->> 'homeserver_url', s -> 'has_account' FROM (SELECT %L::jsonb AS s) x$q$, :'acc1'),
  $q$VALUES ('https://matrix.example.org:8448', 'true'::jsonb)$q$, 'the account is stored, its homeserver without a trailing slash');
SELECT access_token_secret AS a1, harmony_token_secret AS t1 FROM public.matrix_bridge_secrets WHERE bridge_id = :'h1' \gset
SELECT is(pg_temp.secret(:'a1'), 'syt_first-token_1', 'the token is a Vault secret');
SELECT isnt((SELECT secret FROM vault.secrets WHERE id = :'a1'), 'syt_first-token_1', 'stored encrypted');
SELECT is(public.verify_bot_token(encode(sha256(convert_to(pg_temp.secret(:'t1'), 'UTF8')), 'hex')) ->> 'bot_id', :'h1_bot',
  'the Harmony token beside it is the bridge bot''s');

-- Nothing a client reads carries a secret. ---------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('state', public.matrix_bridge_state('55555555-0000-0000-0000-000000000005'));
SELECT throws_ok('SELECT * FROM public.matrix_bridge_secrets', '42501', NULL, 'a manager reads no secret row');
SELECT throws_ok('SELECT * FROM public.matrix_bridge_hosted_list()', '42501', NULL, 'nor the hosted list');
SELECT throws_ok('SELECT count(*) FROM vault.decrypted_secrets', '42501', NULL, 'nor Vault');
SELECT tests.clear_authentication();
SELECT ok(NOT (SELECT v::text ~ ('syt_first|harmony_bot_[0-9a-f]{64}|' || :'a1' || '|' || :'t1') FROM out WHERE k = 'state'),
  'the state names no secret, not even its Vault id');
SELECT ok(NOT :'acc1'::text ~ ('syt_first|harmony_bot_[0-9a-f]{64}|' || :'a1' || '|' || :'t1'), 'nor does set_account''s answer');

-- The host's view. --------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out SELECT 'list', COALESCE(jsonb_agg(to_jsonb(l)), '[]') FROM public.matrix_bridge_hosted_list() l;
INSERT INTO out VALUES ('config', public.matrix_bridge_config(:'h1_bot'));
RESET role;
SELECT results_eq(
  $q$SELECT jsonb_array_length(v), v -> 0 ->> 'bridge_id', v -> 0 ->> 'homeserver_url', v -> 0 ->> 'access_token', v -> 0 ->> 'harmony_token' ~ '^harmony_bot_'
       FROM out WHERE k = 'list'$q$,
  format($q$VALUES (1, %L, 'https://matrix.example.org:8448', 'syt_first-token_1', true)$q$, :'h1'),
  'the bridge host reads the hosted bridge with both tokens');
SELECT is((SELECT v ->> 'mode' FROM out WHERE k = 'config'), 'hosted', 'the bridge then reads its configuration as a self-run one');
UPDATE public.instance_config SET config_value = 'false' WHERE config_key = 'matrix_bridge_hosting_enabled';
SET LOCAL role service_role;
INSERT INTO out SELECT 'list-off', COALESCE(jsonb_agg(to_jsonb(l)), '[]') FROM public.matrix_bridge_hosted_list() l;
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'list-off'), '[]'::jsonb, 'nothing while hosting is off');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.refused(:'h1', 'https://matrix.example.org', 'syt_abcdefgh'), '0A000', 'nor is an account stored then');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'matrix_bridge_hosting_enabled';

-- Replacing the account. --------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.matrix_bridge_report_status(:'h1_bot', 'account', '{"ready":true}', '{"rooms":[{"room_id":"!a"}]}', '1', '[]') IS NOT NULL AS r \gset
RESET role;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_set_account(:'h1', 'https://matrix.example.org:8448', 'syt_second-token') AS acc2 \gset
SELECT tests.clear_authentication();
SELECT is(jsonb_array_length(:'acc2'::jsonb #> '{snapshot,rooms}'), 1, 'another token of the same homeserver keeps the rooms');
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'a1', :'t1')), 0, 'the replaced secrets leave Vault');
SELECT access_token_secret AS a2, harmony_token_secret AS t2 FROM public.matrix_bridge_secrets WHERE bridge_id = :'h1' \gset
SELECT is(pg_temp.secret(:'a2'), 'syt_second-token', 'for the new token');
SELECT is((SELECT count(*)::int FROM public.bot_tokens WHERE bot_id = :'h1_bot' AND is_active), 1, 'the bridge bot holds one active token');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_set_account(:'h1', 'https://other.example.org', 'syt_third-token') AS acc3 \gset
SELECT tests.clear_authentication();
SELECT results_eq(format($q$SELECT s -> 'snapshot', s -> 'status' FROM (SELECT %L::jsonb AS s) x$q$, :'acc3'),
  $q$VALUES ('{}'::jsonb, '{}'::jsonb)$q$, 'another homeserver forgets what the earlier account reported');
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'a2', :'t2')), 0, 'and its secrets');

-- The bot deleted elsewhere. ----------------------------------------------------------------
DELETE FROM public.bots WHERE id = :'h1_bot';
SET LOCAL role service_role;
INSERT INTO out SELECT 'list-botless', COALESCE(jsonb_agg(to_jsonb(l)), '[]') FROM public.matrix_bridge_hosted_list() l;
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'list-botless'), '[]'::jsonb, 'a hosted bridge whose bot is gone is not run');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_pair(:'h1', '66666666-0000-0000-0000-000000000006', '!a:example.org') ->> 'bot_id' AS h1_bot2 \gset
SELECT tests.clear_authentication();
SET LOCAL role service_role;
INSERT INTO out SELECT 'list-again', COALESCE(jsonb_agg(to_jsonb(l)), '[]') FROM public.matrix_bridge_hosted_list() l;
RESET role;
SELECT is(public.verify_bot_token(encode(sha256(convert_to((SELECT v -> 0 ->> 'harmony_token' FROM out WHERE k = 'list-again'), 'UTF8')), 'hex')) ->> 'bot_id',
  :'h1_bot2', 'the next pair provisions a bot and stores its token');
SELECT is((SELECT v -> 0 ->> 'access_token' FROM out WHERE k = 'list-again'), 'syt_third-token', 'the account stays');
UPDATE public.bots SET is_active = false WHERE id = :'h1_bot2';
SELECT is((SELECT count(*)::int FROM public.matrix_bridge_hosted_list()), 0, 'an inactive bot''s bridge is not run');
UPDATE public.bots SET is_active = true WHERE id = :'h1_bot2';

-- Another community's bridge. ---------------------------------------------------------------
UPDATE public.instance_config SET config_value = '2' WHERE config_key = 'matrix_bridge_hosting_limit';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.matrix_bridge_create('f4020000-0000-0000-0000-0000000000a2', 'hosted') AS h2 \gset
SELECT :'h2'::jsonb ->> 'id' AS h2, :'h2'::jsonb ->> 'bot_id' AS h2_bot \gset
SELECT is(pg_temp.refused(:'h2', 'https://mallory.example.org', 'syt_mallory-token'), NULL, 'another community stores its account');
SELECT is(pg_temp.refused(:'h1', 'https://mallory.example.org', 'syt_mallory-token'), '42501', 'and not in this one''s bridge');
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT throws_ok(format($q$SELECT public.matrix_bridge_bind_room(%L, '66666666-0000-0000-0000-000000000006', '!a:example.org', 'relay')$q$, :'h2_bot'),
  '42501', NULL, 'a bridge bot binds no room of another bridge''s pair');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_room(%L, '66666666-0000-0000-0000-000000000006')$q$, :'h2_bot'), '42501', NULL, 'nor reads one');
INSERT INTO out VALUES ('foreign-report', public.matrix_bridge_report_status(:'h2_bot', NULL, '{"ready":true}', '{"rooms":[]}', '1',
  '[{"channel_id":"66666666-0000-0000-0000-000000000006","state":"error","error":"x"}]'));
RESET role;
SELECT is((SELECT state FROM public.bridge_channels WHERE channel_id = '66666666-0000-0000-0000-000000000006'), NULL, 'nor reports its state');

-- Deletion. ---------------------------------------------------------------------------------
SELECT access_token_secret AS a4, harmony_token_secret AS t4 FROM public.matrix_bridge_secrets WHERE bridge_id = :'h1' \gset
SELECT access_token_secret AS a5, harmony_token_secret AS t5 FROM public.matrix_bridge_secrets WHERE bridge_id = :'h2' \gset
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'a4', :'t4', :'a5', :'t5')), 4, 'two bridges hold four secrets');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_delete(:'h1') IS NOT NULL AS gone \gset
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'a4', :'t4')), 0, 'deleting a bridge deletes its secrets');
DELETE FROM public.servers WHERE id = 'f4020000-0000-0000-0000-0000000000a2';
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE id IN (:'a5', :'t5'))
        + (SELECT count(*)::int FROM public.matrix_bridge_secrets), 0, 'so does deleting its server');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.matrix_bridge_create('f4020000-0000-0000-0000-0000000000a4', 'hosted')$q$, 'a deleted bridge frees its place');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
