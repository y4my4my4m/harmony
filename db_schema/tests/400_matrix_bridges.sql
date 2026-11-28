-- 20261126100001_matrix_bridges.sql: grants and RLS, creation and the provisioned bot, setup codes,
-- pairs and the bot's allowlist, reports, the gateway's configuration, deletion.
--
--   alice    owner of server_1 (fixture) and s3, s5
--   bob      accepted member of server_1; later holds a MANAGE_SERVER role
--   mallory  no member of server_1
--   server_1 general (fixture), c2 text, c3 category, c4 text hidden from @everyone, c7 voice
--   s2 (mallory) with c5; s3 (alice) with c6; s4 remote; s5 (alice) without channels
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(137);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;
-- Assertions run as service_role too; rolled back with the file.
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO public.servers (id, name, owner) VALUES
  ('f4000000-0000-0000-0000-0000000000a2', 'Mallory Server', '33333333-0000-0000-0000-000000000003'),
  ('f4000000-0000-0000-0000-0000000000a3', 'Third Server', '11111111-0000-0000-0000-000000000001'),
  ('f4000000-0000-0000-0000-0000000000a4', 'Remote Server', '11111111-0000-0000-0000-000000000001'),
  ('f4000000-0000-0000-0000-0000000000a5', 'Fifth Server', '11111111-0000-0000-0000-000000000001');
UPDATE public.servers SET is_local_server = false WHERE id = 'f4000000-0000-0000-0000-0000000000a4';
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f4000000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'second', 0),
  ('f4000000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'a category', 2),
  ('f4000000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005', 'private', 0),
  ('f4000000-0000-0000-0000-0000000000c7', '55555555-0000-0000-0000-000000000005', 'a voice channel', 1),
  ('f4000000-0000-0000-0000-0000000000c5', 'f4000000-0000-0000-0000-0000000000a2', 'elsewhere', 0),
  ('f4000000-0000-0000-0000-0000000000c6', 'f4000000-0000-0000-0000-0000000000a3', 'third-general', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f4000000-0000-0000-0000-0000000000c4', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

-- The paired channels of a bot's install, by name.
CREATE FUNCTION pg_temp.allowlist(p_bot uuid) RETURNS text LANGUAGE sql AS $$
    SELECT (SELECT COALESCE(string_agg(c.name, ',' ORDER BY c.name), '')
              FROM unnest(p.allowed_channel_ids) x JOIN public.channels c ON c.id = x)
      FROM public.bot_server_permissions p WHERE p.bot_id = p_bot
$$;

-- SQLSTATE of pairing general with p_room; NULL when it is paired.
CREATE FUNCTION pg_temp.refused(p_bridge uuid, p_room text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
    PERFORM public.matrix_bridge_pair(p_bridge, '66666666-0000-0000-0000-000000000006', p_room);
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
END;
$$;

-- Grants and RLS. ---------------------------------------------------------------------------
SELECT ok((SELECT bool_and(c.relrowsecurity) FROM pg_class c
            WHERE c.oid IN ('public.matrix_bridges'::regclass, 'public.matrix_bridge_setup_codes'::regclass)),
  'RLS is on for both tables');
SELECT ok(NOT EXISTS (SELECT 1
                        FROM unnest(ARRAY['matrix_bridges', 'matrix_bridge_setup_codes']) t,
                             unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p,
                             unnest(ARRAY['anon', 'authenticated']) r
                       WHERE has_table_privilege(r, 'public.' || t, p)),
  'clients hold no privilege on either table');
SELECT ok(has_table_privilege('service_role', 'public.matrix_bridges', 'SELECT')
      AND has_table_privilege('service_role', 'public.matrix_bridge_setup_codes', 'SELECT'),
  'service_role holds both tables');

CREATE TEMP TABLE client_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO client_fns VALUES
  ('public.matrix_bridge_create(uuid, text)'), ('public.matrix_bridge_setup_code(uuid)'),
  ('public.matrix_bridge_pair(uuid, uuid, text, text, text)'), ('public.matrix_bridge_unpair(uuid, uuid)'),
  ('public.matrix_bridge_delete(uuid)'), ('public.matrix_bridge_state(uuid)');
CREATE TEMP TABLE service_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO service_fns VALUES
  ('public.matrix_bridge_redeem_code(text)'),
  ('public.matrix_bridge_report_status(uuid, text, jsonb, jsonb, text, jsonb)'),
  ('public.matrix_bridge_config(uuid)'), ('public.matrix_bridge_channel_member(uuid, uuid, uuid)'),
  ('public.matrix_bridge_send_check(uuid, uuid, uuid)'),
  ('public.matrix_bridge_bind_room(uuid, uuid, text, text, text)');
CREATE TEMP TABLE internal_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO internal_fns VALUES
  ('public.matrix_bridge_for_manager(uuid)'), ('public.matrix_bridge_json(uuid)'),
  ('public.matrix_bridge_install_bot(uuid, uuid, uuid)'), ('public.matrix_bridge_provision_bot(uuid, uuid)'),
  ('public.matrix_bridge_issue_token(uuid)'), ('public.matrix_bridge_managed_by(uuid, uuid)'),
  ('public.matrix_bridge_normalize_code(text, text)'), ('public.matrix_bot_is_managed(uuid)'),
  ('public.matrix_bridge_member_row(uuid, uuid)'), ('public.matrix_bridge_optouts_changed()'),
  ('public.bridge_privacy_changed(uuid)');

SELECT is_empty($q$SELECT fn FROM client_fns WHERE has_function_privilege('anon', fn, 'EXECUTE')
                                                OR has_function_privilege('service_role', fn, 'EXECUTE')$q$,
  'the manager functions are for signed-in callers alone');
SELECT is_empty($q$SELECT fn FROM client_fns WHERE NOT has_function_privilege('authenticated', fn, 'EXECUTE')$q$,
  'authenticated executes every manager function');
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
  'internal helpers are executable by their owner alone');
SELECT is_empty($q$SELECT fn FROM (SELECT fn FROM client_fns UNION ALL SELECT fn FROM service_fns UNION ALL SELECT fn FROM internal_fns) f
                    JOIN pg_proc p ON p.oid = f.fn
                   WHERE p.prosecdef AND NOT COALESCE(p.proconfig::text LIKE '%search_path=public%pg_temp%', false)$q$,
  'every definer pins its search_path');

-- Creation. ---------------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'self')$q$,
  '42501', NULL, 'anon cannot create a bridge');
SELECT throws_ok($q$SELECT count(*) FROM public.matrix_bridges$q$, '42501', NULL, 'anon cannot read bridges');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'self')$q$,
  '42501', NULL, 'a non-member cannot create a bridge');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'self')$q$,
  '42501', NULL, 'a member without MANAGE_SERVER cannot create a bridge');
SELECT throws_ok($q$SELECT public.matrix_bridge_state('55555555-0000-0000-0000-000000000005')$q$,
  '42501', NULL, 'nor read its state');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.matrix_bridge_state('55555555-0000-0000-0000-000000000005'), NULL, 'a server without a bridge has no state');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'relay')$q$,
  '22023', NULL, 'an unknown mode is refused');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', NULL)$q$,
  '22023', NULL, 'a missing mode is refused');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'hosted')$q$,
  '0A000', NULL, 'hosted mode is not offered');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'instance')$q$,
  '0A000', NULL, 'instance mode is not offered');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('f4000000-0000-0000-0000-0000000000ff', 'self')$q$,
  'P0002', NULL, 'an unknown server is refused');
SELECT throws_ok($q$SELECT public.matrix_bridge_create('f4000000-0000-0000-0000-0000000000a4', 'self')$q$,
  'P0002', NULL, 'a server of another instance is refused');
SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'self') AS created \gset
SELECT throws_ok($q$SELECT public.matrix_bridge_create('55555555-0000-0000-0000-000000000005', 'self')$q$,
  '23505', NULL, 'a server has one bridge');
SELECT is(public.matrix_bridge_state('55555555-0000-0000-0000-000000000005'), :'created'::jsonb,
  'creation answers the state');
SELECT throws_ok($q$UPDATE public.matrix_bridges SET mode = 'hosted'$q$, '42501', NULL, 'a client writes no bridge row');
SELECT throws_ok($q$SELECT * FROM public.matrix_bridge_setup_codes$q$, '42501', NULL, 'a client reads no setup code');
SELECT tests.clear_authentication();

SELECT id AS b1, bot_id AS b1_bot FROM public.matrix_bridges WHERE server_id = '55555555-0000-0000-0000-000000000005' \gset
SELECT is(:'created'::jsonb - 'created_at' - 'updated_at',
  jsonb_build_object('id', :'b1', 'server_id', '55555555-0000-0000-0000-000000000005', 'bot_id', :'b1_bot', 'mode', 'self',
                     'connection', NULL, 'homeserver_url', NULL, 'has_account', false, 'status', '{}'::jsonb,
                     'snapshot', '{}'::jsonb, 'bridge_version', NULL, 'last_seen_at', NULL, 'pairs', '[]'::jsonb),
  'a new bridge is self-run, reports nothing yet and has no pairs');
SELECT results_eq(
  format($q$SELECT bot_type, bridge_platform, display_name, owner_id, is_public, is_active FROM public.bots WHERE id = %L$q$, :'b1_bot'),
  $q$VALUES ('bot', 'matrix', 'Matrix Bridge', '11111111-0000-0000-0000-000000000001'::uuid, false, true)$q$,
  'the bridge bot is a private Matrix bot of the creator, not a bridge-type bot');
SELECT results_eq(
  format($q$SELECT is_active, read_messages, send_messages, manage_messages, manage_channels, manage_roles, allowed_channel_ids
              FROM public.bot_server_permissions WHERE bot_id = %L AND server_id = '55555555-0000-0000-0000-000000000005'$q$, :'b1_bot'),
  $q$VALUES (true, true, true, false, false, false, ARRAY[]::uuid[])$q$,
  'it is installed to read and send, without a channel');
SELECT is((SELECT count(*)::int FROM public.bot_tokens WHERE bot_id = :'b1_bot'), 0, 'creation issues no token');
SELECT is(public.bridge_channel_platform(:'b1_bot', '66666666-0000-0000-0000-000000000006'), NULL,
  'the bot relays no channel before a pair');

-- Setup codes. ------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format('SELECT public.matrix_bridge_setup_code(%L)', :'b1'),
  '42501', NULL, 'a member without MANAGE_SERVER cannot get a setup code');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.matrix_bridge_setup_code('f4000000-0000-0000-0000-0000000000ff')$q$,
  'P0002', NULL, 'an unknown bridge has no setup code');
SELECT public.matrix_bridge_setup_code(:'b1') AS answer1 \gset
SELECT public.matrix_bridge_setup_code(:'b1') AS answer2 \gset
SELECT tests.clear_authentication();
SELECT :'answer1'::jsonb ->> 'code' AS code1, :'answer2'::jsonb ->> 'code' AS code2 \gset
SELECT ok(:'code1' ~ '^MX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$',
  'a setup code reads MX-XXXX-XXXX-XXXX without I, O, 0 or 1');
SELECT results_eq(
  format($q$SELECT code_hash, expires_at, created_by, used_at FROM public.matrix_bridge_setup_codes WHERE bridge_id = %L$q$, :'b1'),
  format($q$VALUES (%L, now() + interval '30 minutes', '11111111-0000-0000-0000-000000000001'::uuid, NULL::timestamptz)$q$,
         encode(sha256(convert_to(:'code2', 'UTF8')), 'hex')),
  'a new code replaces the earlier one, stored as its SHA-256 for 30 minutes');
SELECT is((:'answer2'::jsonb ->> 'expires_at')::timestamptz, now() + interval '30 minutes', 'the answer carries the expiry');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format('SELECT public.matrix_bridge_redeem_code(%L)', :'code2'),
  '42501', NULL, 'a client cannot redeem a code');
SELECT public.discord_bridge_create('55555555-0000-0000-0000-000000000005', 'self') AS d1 \gset
SELECT public.discord_bridge_setup_code(:'d1') AS hb_code \gset
SELECT tests.clear_authentication();

-- A code given to the other platform's route.
SET LOCAL role service_role;
INSERT INTO out VALUES ('mx-at-discord', public.discord_bridge_redeem_code(:'code2'));
INSERT INTO out VALUES ('mx-body-at-discord', public.discord_bridge_redeem_code(substr(:'code2', 4)));
INSERT INTO out VALUES ('hb-at-matrix', public.matrix_bridge_redeem_code(:'hb_code'));
INSERT INTO out VALUES ('hb-body-at-matrix', public.matrix_bridge_redeem_code(substr(:'hb_code', 4)));
RESET role;
SELECT is_empty($q$SELECT k FROM out WHERE k LIKE '%-at-%' AND v IS NOT NULL$q$,
  'neither platform redeems the other''s code, with its prefix or without');
SELECT ok((SELECT used_at IS NULL FROM public.matrix_bridge_setup_codes WHERE bridge_id = :'b1')
      AND (SELECT used_at IS NULL FROM public.discord_bridge_setup_codes WHERE bridge_id = :'d1'),
  'and neither consumes it');

SET LOCAL role service_role;
INSERT INTO out VALUES ('old', public.matrix_bridge_redeem_code(:'code1'));
INSERT INTO out VALUES ('malformed', public.matrix_bridge_redeem_code('MX-NOPE'));
INSERT INTO out VALUES ('null', public.matrix_bridge_redeem_code(NULL));
INSERT INTO out VALUES ('first', public.matrix_bridge_redeem_code(E' mx\u2013' || replace(lower(substr(:'code2', 4)), '-', E'\u2014') || ' '));
INSERT INTO out VALUES ('again', public.matrix_bridge_redeem_code(:'code2'));
RESET role;
SELECT is_empty($q$SELECT k FROM out WHERE k IN ('old', 'malformed', 'null') AND v IS NOT NULL$q$,
  'a superseded, malformed or missing code redeems nothing');
SELECT results_eq(
  $q$SELECT v->>'bridge_id', v->>'server_id', v->>'harmony_token' ~ '^harmony_bot_[0-9a-f]{64}$',
            (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v) k) FROM out WHERE k = 'first'$q$,
  format($q$VALUES (%L, '55555555-0000-0000-0000-000000000005', true, ARRAY['bridge_id', 'harmony_token', 'server_id'])$q$, :'b1'),
  'redeeming answers the bridge, its server and a bot token; case, whitespace and typographic dashes are ignored');
SELECT is((SELECT v FROM out WHERE k = 'again'), NULL, 'a code redeems once');
SELECT (v->>'harmony_token') AS token1 FROM out WHERE k = 'first' \gset
SELECT is(public.verify_bot_token(encode(sha256(convert_to(:'token1', 'UTF8')), 'hex')) ->> 'bot_id', :'b1_bot',
  'the token authenticates as the bridge bot');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_setup_code(:'b1') ->> 'code' AS code3 \gset
SELECT tests.clear_authentication();
UPDATE public.matrix_bridge_setup_codes SET expires_at = now() - interval '1 second' WHERE bridge_id = :'b1';
SET LOCAL role service_role;
INSERT INTO out VALUES ('expired', public.matrix_bridge_redeem_code(:'code3'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'expired'), NULL, 'an expired code redeems nothing');
SELECT ok((SELECT used_at IS NULL FROM public.matrix_bridge_setup_codes WHERE bridge_id = :'b1'), 'and is not marked used');
SELECT is((public.verify_bot_token(encode(sha256(convert_to(:'token1', 'UTF8')), 'hex'))->>'valid')::boolean, true,
  'a refused code leaves the earlier token alone');
UPDATE public.matrix_bridge_setup_codes SET expires_at = now() + interval '1 minute' WHERE bridge_id = :'b1';
SET LOCAL role service_role;
INSERT INTO out VALUES ('second', public.matrix_bridge_redeem_code(:'code3'));
RESET role;
SELECT ok((SELECT v->>'harmony_token' ~ '^harmony_bot_' FROM out WHERE k = 'second'), 'the next code redeems');
SELECT is((public.verify_bot_token(encode(sha256(convert_to(:'token1', 'UTF8')), 'hex'))->>'valid')::boolean, false,
  'and revokes the earlier token');
SELECT is((SELECT count(*)::int FROM public.bot_tokens WHERE bot_id = :'b1_bot' AND is_active), 1,
  'the bridge bot holds one active token');
SELECT results_eq(
  $q$SELECT x, public.matrix_bridge_normalize_code(x, 'MX')
       FROM (VALUES ('ABCD EFGH JK23'), ('mxabcdefghjk23'), ('MXCDEFGHJKLM'), ('MX-ABCD-EFGH-JK2'), ('HB-ABCD-EFGH-JK23')) v(x)$q$,
  $q$VALUES ('ABCD EFGH JK23', 'MX-ABCD-EFGH-JK23'), ('mxabcdefghjk23', 'MX-ABCD-EFGH-JK23'),
            ('MXCDEFGHJKLM', 'MX-MXCD-EFGH-JKLM'), ('MX-ABCD-EFGH-JK2', NULL), ('HB-ABCD-EFGH-JK23', NULL)$q$,
  'a typed code normalizes to MX-XXXX-XXXX-XXXX; the prefix is optional and 12 characters must remain');

-- A manager who loses the permission. -------------------------------------------------------
INSERT INTO public.server_roles (id, server_id, name, permissions, position) VALUES
  ('f4000000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'Managers', 128, 5);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.matrix_bridge_setup_code(:'b1') ->> 'code' AS bob_code \gset
SELECT tests.clear_authentication();
DELETE FROM public.user_roles WHERE role_id = 'f4000000-0000-0000-0000-0000000000d1';
SET LOCAL role service_role;
INSERT INTO out VALUES ('demoted', public.matrix_bridge_redeem_code(:'bob_code'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'demoted'), NULL, 'the code of a manager who lost MANAGE_SERVER redeems nothing');
SELECT is((SELECT count(*)::int FROM public.bot_tokens WHERE bot_id = :'b1_bot' AND is_active), 1,
  'and the running bridge keeps its token');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format('SELECT public.matrix_bridge_delete(%L)', :'b1'), '42501', NULL, 'nor can they delete the bridge');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_unpair(%L, '66666666-0000-0000-0000-000000000006')$q$, :'b1'),
  '42501', NULL, 'nor unpair');

-- Pairs. ------------------------------------------------------------------------------------
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '!general:example.org')$q$, :'b1'),
  '42501', NULL, 'nor pair');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.matrix_bridge_pair('f4000000-0000-0000-0000-0000000000ff', '66666666-0000-0000-0000-000000000006', '!a:b')$q$,
  'P0002', NULL, 'an unknown bridge pairs nothing');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c5', '!a:b')$q$, :'b1'),
  '22023', NULL, 'a channel of another server is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c3', '!a:b')$q$, :'b1'),
  '22023', NULL, 'a category is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c7', '!a:b')$q$, :'b1'),
  '22023', NULL, 'a voice channel is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, NULL, '!a:b')$q$, :'b1'),
  '22023', NULL, 'a missing channel is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '!a:b', 'to_discord')$q$, :'b1'),
  '22023', NULL, 'an unknown direction is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '!a:b', 'both', 'puppet')$q$, :'b1'),
  '22023', NULL, 'an unknown sender mode is refused');
SELECT is_empty(
  format($f$SELECT x FROM unnest(ARRAY['', '!', 'general', '#general', '#:example.org', '#a b:example.org', '@sam:example.org',
                                       '!a/b:example.org', E'!a\u0001:example.org', 'https://matrix.to/#/!a:b',
                                       '!' || repeat('a', 255), '#' || repeat('a', 250) || ':b.org']) x
             WHERE pg_temp.refused(%L, x) IS DISTINCT FROM '22023'$f$, :'b1'),
  'a room that is no Matrix room id or alias is refused');
SELECT tests.clear_authentication();

UPDATE public.matrix_bridges SET updated_at = '2000-01-01' WHERE id = :'b1';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_pair(:'b1', '66666666-0000-0000-0000-000000000006', E' !general:example.org\n') AS paired \gset
SELECT tests.clear_authentication();
SELECT is(:'paired'::jsonb -> 'pairs',
  jsonb_build_array(jsonb_build_object('channel_id', '66666666-0000-0000-0000-000000000006', 'room_id', '!general:example.org',
    'room_alias', NULL, 'direction', 'both', 'sender_mode', 'ghost', 'state', NULL, 'state_error', NULL)),
  'a pair by room id relays both ways as ghosts by default, and pairing answers the state');
SELECT is((SELECT updated_at FROM public.matrix_bridges WHERE id = :'b1'), now(), 'pairing is a configuration change');
SELECT is(pg_temp.allowlist(:'b1_bot'), 'general', 'the bot sees the paired channel alone');
SELECT is(public.bridge_channel_platform(:'b1_bot', '66666666-0000-0000-0000-000000000006'), 'matrix',
  'the bot relays the paired channel to Matrix');
SELECT is(public.bridge_channel_platform(:'b1_bot', 'f4000000-0000-0000-0000-0000000000c2'), NULL, 'and no other');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c2', '!general:example.org')$q$, :'b1'),
  '23505', NULL, 'a room the bridge names for another channel is refused');

-- Room claims: naming a room claims nothing, binding it does.
SELECT public.matrix_bridge_create('f4000000-0000-0000-0000-0000000000a3', 'self') ->> 'id' AS b3 \gset
SELECT lives_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c6', '!general:example.org')$q$, :'b3'),
  'another server may name a room no bridge has bound');
SELECT tests.clear_authentication();
SELECT bot_id AS b3_bot FROM public.matrix_bridges WHERE id = :'b3' \gset
SELECT is((SELECT array_agg(room_bound) FROM public.bridge_channels WHERE room_id = '!general:example.org'), ARRAY[false, false],
  'a room named by id is not bound');
SET LOCAL role service_role;
INSERT INTO out VALUES ('unbound', public.matrix_bridge_room(:'b1_bot', '66666666-0000-0000-0000-000000000006'));
SELECT throws_ok(format($q$SELECT public.matrix_bridge_bind_room(%L, '66666666-0000-0000-0000-000000000006', '!other:example.org', 'ghost')$q$, :'b1_bot'),
  '22023', NULL, 'a pair named by id binds no other room');
INSERT INTO out VALUES ('bind1', public.matrix_bridge_bind_room(:'b1_bot', '66666666-0000-0000-0000-000000000006', '!general:example.org', 'relay'));
INSERT INTO out VALUES ('bound', public.matrix_bridge_room(:'b1_bot', '66666666-0000-0000-0000-000000000006'));
SELECT throws_ok(format($q$SELECT public.matrix_bridge_bind_room(%L, 'f4000000-0000-0000-0000-0000000000c6', '!general:example.org', 'relay')$q$, :'b3_bot'),
  '23505', 'The Matrix room is bound to another channel', 'the first bridge to bind the room has it');
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'unbound'), '{"room_id":null,"sender_mode":"ghost","room_bound":false}'::jsonb,
  'an unbound pair reads as no room');
SELECT is((SELECT v FROM out WHERE k = 'bind1'), '{"room_id":"!general:example.org","sender_mode":"ghost"}'::jsonb, 'binding answers the room');
SELECT is((SELECT v FROM out WHERE k = 'bound'), (SELECT v FROM out WHERE k = 'bind1'), 'and it reads as the room from then on');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c6', '!general:example.org')$q$, :'b3'),
  '23505', NULL, 'a room bound elsewhere is refused');
SELECT is(public.matrix_bridge_pair(:'b1', '66666666-0000-0000-0000-000000000006', '!general:example.org') #>> '{pairs,0,room_id}', '!general:example.org',
  'pairing the channel with its own room again');
SELECT tests.clear_authentication();
SELECT is((SELECT room_bound FROM public.bridge_channels WHERE bot_id = :'b1_bot'), true, 'keeps it bound');
SELECT throws_ok(format($q$UPDATE public.bridge_channels SET room_bound = true WHERE bot_id = %L$q$, :'b3_bot'),
  '23505', NULL, 'the database holds one bound channel per room');
SELECT throws_ok($q$UPDATE public.bridge_channels SET room_proof = 'invite' WHERE room_id = '!general:example.org'$q$, '23514', NULL,
  'a room is proved by a code or not at all');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c2', '#second:example.org', 'to_matrix', 'relay')$q$, :'b1'),
  'a pair by alias');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c4', '#second:example.org')$q$, :'b1'),
  '23505', NULL, 'an alias names one channel of a bridge');
SELECT lives_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c6', '#second:example.org')$q$, :'b3'),
  'the bridge of another server may name the alias: the room behind it is known once bound');
SELECT tests.clear_authentication();
SELECT results_eq(
  format($q$SELECT room_id, room_alias, direction, sender_mode, sender_mode_set_by_manager FROM public.bridge_channels
             WHERE bot_id = %L AND channel_id = 'f4000000-0000-0000-0000-0000000000c2'$q$, :'b1_bot'),
  $q$VALUES (NULL::text, '#second:example.org', 'to_matrix', 'relay', true)$q$,
  'an alias waits for the bridge to bind its room; the direction and sender mode are the manager''s');
SELECT is(pg_temp.allowlist(:'b1_bot'), 'general,second', 'the allowlist follows');

-- Private channel: VIEW_CHANNEL is denied to @everyone. Bob manages the server and does not see it.
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c4', '!private:example.org')$q$, :'b1'),
  '42501', NULL, 'a manager cannot pair a channel hidden from them');
SELECT is(jsonb_array_length(public.matrix_bridge_state('55555555-0000-0000-0000-000000000005') -> 'pairs'), 2,
  'a member holding MANAGE_SERVER reads the state');
SELECT tests.clear_authentication();

-- Reports. ----------------------------------------------------------------------------------
UPDATE public.matrix_bridges SET updated_at = '2000-01-01' WHERE id = :'b1';
SET LOCAL role service_role;
INSERT INTO out VALUES ('foreign', public.matrix_bridge_report_status('f4000000-0000-0000-0000-0000000000ee', 'account', '{}', '{"rooms":[]}', '0.2.0', '[]'));
INSERT INTO out VALUES ('report', public.matrix_bridge_report_status(:'b1_bot', 'application_service',
  '{"ready":true,"user_id":"@harmony:example.org","problems":[]}', '{"rooms":[{"room_id":"!general:example.org","name":"General"}]}', '0.2.0',
  '[{"channel_id":"66666666-0000-0000-0000-000000000006","state":"ready","error":null},
    {"channel_id":"F4000000-0000-0000-0000-0000000000C2","state":"error","error":"not_invited"},
    {"channel_id":"f4000000-0000-0000-0000-0000000000c6","state":"ready"},
    {"channel_id":"nonsense","state":"ready"}, 7]'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'foreign'), NULL, 'a report from a bot without a bridge stores nothing');
SELECT is((SELECT v FROM out WHERE k = 'report'), '{"ok": true}'::jsonb, 'a report answers ok');
SELECT results_eq(
  format($q$SELECT connection, status, snapshot, bridge_version, last_seen_at = now(), updated_at FROM public.matrix_bridges WHERE id = %L$q$, :'b1'),
  $q$VALUES ('application_service', '{"ready":true,"user_id":"@harmony:example.org","problems":[]}'::jsonb,
             '{"rooms":[{"room_id":"!general:example.org","name":"General"}]}'::jsonb, '0.2.0', true, '2000-01-01'::timestamptz)$q$,
  'a report stores its parts and is no configuration change');
SELECT results_eq(
  format($q$SELECT c.name, bc.state, bc.state_error FROM public.bridge_channels bc JOIN public.channels c ON c.id = bc.channel_id
             WHERE bc.bot_id = %L ORDER BY c.name$q$, :'b1_bot'),
  $q$VALUES ('general', 'ready', NULL::text), ('second', 'error', 'not_invited')$q$,
  'and sets the state of the bridge''s own pairs');
SELECT is((SELECT state FROM public.bridge_channels WHERE channel_id = 'f4000000-0000-0000-0000-0000000000c6'), NULL,
  'a pair of another bridge keeps its state');
SET LOCAL role service_role;
SELECT public.matrix_bridge_report_status(:'b1_bot', NULL, '{"ready":false}', '{"rooms":[]}', '0.2.0',
  '[{"channel_id":"f4000000-0000-0000-0000-0000000000c2","state":"ready"}]') IS NOT NULL AS r1b \gset
RESET role;
SELECT is((SELECT (state, state_error)::text FROM public.bridge_channels
            WHERE bot_id = :'b1_bot' AND channel_id = 'f4000000-0000-0000-0000-0000000000c2'), '(error,not_invited)',
  'a pair without a bound room is not ready, whatever the bridge reports');
SET LOCAL role service_role;
SELECT public.matrix_bridge_report_status(:'b1_bot', NULL, '{"ready":false,"problems":[{"code":"matrix_unreachable"}]}', '{"rooms":[]}', '0.2.0',
  jsonb_build_array(jsonb_build_object('channel_id', '66666666-0000-0000-0000-000000000006', 'state', 'sideways', 'error', repeat('x', 400)))) IS NOT NULL AS r2 \gset
RESET role;
SELECT results_eq(
  format($q$SELECT connection, status #>> '{problems,0,code}', jsonb_array_length(snapshot -> 'rooms') FROM public.matrix_bridges WHERE id = %L$q$, :'b1'),
  $q$VALUES ('application_service', 'matrix_unreachable', 1)$q$,
  'a bridge that is not ready keeps the connection and the rooms it reported');
SELECT results_eq(
  format($q$SELECT state, char_length(state_error) FROM public.bridge_channels
             WHERE bot_id = %L AND channel_id = '66666666-0000-0000-0000-000000000006'$q$, :'b1_bot'),
  $q$VALUES (NULL::text, 300)$q$, 'an unknown state is dropped and an error is cut to 300 characters');
SET LOCAL role service_role;
SELECT throws_ok(format($q$SELECT public.matrix_bridge_report_status(%L, NULL, '[]', '{"rooms":[]}', '1', '[]')$q$, :'b1_bot'),
  '22023', NULL, 'a status that is no object is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_report_status(%L, NULL, '{}', '{"rooms":{}}', '1', '[]')$q$, :'b1_bot'),
  '22023', NULL, 'a snapshot without a rooms array is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_report_status(%L, NULL, '{}', '{"rooms":[]}', '1', '{}')$q$, :'b1_bot'),
  '22023', NULL, 'pairs that are no array are refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_report_status(%L, 'bot', '{}', '{"rooms":[]}', '1', '[]')$q$, :'b1_bot'),
  '22023', NULL, 'an unknown connection is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_report_status(%L, NULL, jsonb_build_object('x', repeat('x', 65536)), '{"rooms":[]}', '1', '[]')$q$, :'b1_bot'),
  '22023', NULL, 'a status over 64 KiB is refused');
SELECT throws_ok(format($q$SELECT public.matrix_bridge_report_status(%L, NULL, '{}', jsonb_build_object('rooms', jsonb_build_array(repeat('x', 2097152))), '1', '[]')$q$, :'b1_bot'),
  '22023', NULL, 'a snapshot over 2 MiB is refused');
SELECT lives_ok(format($q$SELECT public.matrix_bridge_report_status(%L, 'account', '{"ready":true}', '{"rooms":[]}', repeat('9', 80), NULL)$q$, :'b1_bot'),
  'a report without pairs and with a long version is stored');
RESET role;
SELECT is((SELECT (connection, char_length(bridge_version))::text FROM public.matrix_bridges WHERE id = :'b1'), '(account,64)',
  'with the version cut to 64 characters');

-- The gateway's configuration. --------------------------------------------------------------
INSERT INTO public.server_encryption_settings (server_id, encryption_mode)
VALUES ('55555555-0000-0000-0000-000000000005', 'optional')
ON CONFLICT (server_id) DO UPDATE SET encryption_mode = 'optional';
INSERT INTO public.channel_encryption_settings (channel_id, messages_encrypted)
VALUES ('f4000000-0000-0000-0000-0000000000c2', true)
ON CONFLICT (channel_id) DO UPDATE SET messages_encrypted = true;
SET LOCAL role service_role;
INSERT INTO out VALUES ('config', public.matrix_bridge_config(:'b1_bot'));
INSERT INTO out VALUES ('config-none', public.matrix_bridge_config('f4000000-0000-0000-0000-0000000000ee'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'config-none'), NULL, 'a bot without a bridge has no configuration');
SELECT is((SELECT v FROM out WHERE k = 'config'),
  jsonb_build_object('bridge_id', :'b1', 'server_id', '55555555-0000-0000-0000-000000000005', 'mode', 'self',
    'updated_at', (SELECT updated_at FROM public.matrix_bridges WHERE id = :'b1'), 'privacy_version', '0:0',
    'pairs', jsonb_build_array(
      jsonb_build_object('channel_id', '66666666-0000-0000-0000-000000000006', 'channel_name', 'general', 'room_id', '!general:example.org',
        'room_alias', NULL, 'direction', 'both', 'sender_mode', 'ghost', 'encrypted', false),
      jsonb_build_object('channel_id', 'f4000000-0000-0000-0000-0000000000c2', 'channel_name', 'second', 'room_id', NULL,
        'room_alias', '#second:example.org', 'direction', 'to_matrix', 'sender_mode', 'relay', 'encrypted', true))),
  'the configuration names the pairs, their rooms and the encrypted channels');

-- Changing a pair. --------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.matrix_bridge_bind_room(:'b1_bot', 'f4000000-0000-0000-0000-0000000000c2', '!second:example.org', 'ghost', '#second:example.org') IS NOT NULL AS bound \gset
SELECT public.matrix_bridge_report_status(:'b1_bot', NULL, '{"ready":true}', '{"rooms":[]}', '0.2.0',
  '[{"channel_id":"f4000000-0000-0000-0000-0000000000c2","state":"ready","error":"ghosts_unavailable"}]') IS NOT NULL AS r3 \gset
RESET role;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_pair(:'b1', 'f4000000-0000-0000-0000-0000000000c2', '#second:example.org', 'both', 'ghost') AS repaired \gset
SELECT tests.clear_authentication();
SELECT is(:'repaired'::jsonb #> '{pairs,1}',
  jsonb_build_object('channel_id', 'f4000000-0000-0000-0000-0000000000c2', 'room_id', '!second:example.org', 'room_alias', '#second:example.org',
    'direction', 'both', 'sender_mode', 'ghost', 'state', 'ready', 'state_error', 'ghosts_unavailable'),
  'a pair kept by its alias keeps the bound room and its state');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_pair(:'b1', 'f4000000-0000-0000-0000-0000000000c2', '#other:example.org') AS moved \gset
SELECT tests.clear_authentication();
SELECT results_eq(
  format($q$SELECT x ->> 'room_id', x ->> 'room_alias', x ->> 'state', x ->> 'state_error' FROM (SELECT %L::jsonb #> '{pairs,1}' AS x) p$q$, :'moved'),
  $q$VALUES (NULL::text, '#other:example.org', NULL::text, NULL::text)$q$,
  'another alias drops the bound room and the state');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(format($q$SELECT public.matrix_bridge_pair(%L, 'f4000000-0000-0000-0000-0000000000c6', '!second:example.org')$q$, :'b3'),
  'the room it left is free for another bridge');
SELECT public.matrix_bridge_pair(:'b1', 'f4000000-0000-0000-0000-0000000000c2', '!elsewhere:example.org') AS by_id \gset
SELECT is(:'by_id'::jsonb #>> '{pairs,1,room_id}', '!elsewhere:example.org', 'a room id replaces the alias');
SELECT is(:'by_id'::jsonb #> '{pairs,1,room_alias}', 'null'::jsonb, 'which goes');

-- Unpairing and channel deletion. -----------------------------------------------------------
SELECT tests.clear_authentication();
UPDATE public.matrix_bridges SET updated_at = '2000-01-01' WHERE id = :'b1';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(jsonb_array_length(public.matrix_bridge_unpair(:'b1', '66666666-0000-0000-0000-000000000006') -> 'pairs'), 1,
  'unpairing answers the state without the pair');
SELECT is(jsonb_array_length(public.matrix_bridge_unpair(:'b1', '66666666-0000-0000-0000-000000000006') -> 'pairs'), 1,
  'unpairing twice changes nothing');
SELECT tests.clear_authentication();
SELECT is((SELECT updated_at FROM public.matrix_bridges WHERE id = :'b1'), now(), 'unpairing is a configuration change');
SELECT is(pg_temp.allowlist(:'b1_bot'), 'second', 'and the bot no longer sees the channel');
SELECT is(public.bridge_channel_platform(:'b1_bot', '66666666-0000-0000-0000-000000000006'), NULL, 'nor relays it');
UPDATE public.matrix_bridges SET updated_at = '2000-01-01' WHERE id = :'b1';
DELETE FROM public.channels WHERE id = 'f4000000-0000-0000-0000-0000000000c2';
SELECT is(pg_temp.allowlist(:'b1_bot'), '', 'a deleted channel leaves the allowlist');
SELECT is((SELECT updated_at FROM public.matrix_bridges WHERE id = :'b1'), now(), 'and is a configuration change');

-- An install removed or cut down elsewhere. -------------------------------------------------
DELETE FROM public.bot_server_permissions WHERE bot_id = :'b1_bot';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(format($q$SELECT public.matrix_bridge_pair(%L, '66666666-0000-0000-0000-000000000006', '!general:example.org')$q$, :'b1'),
  'pairing after the bot was removed from the server');
SELECT tests.clear_authentication();
SELECT is(pg_temp.allowlist(:'b1_bot'), 'general', 'installs it again for its channels');
UPDATE public.bot_server_permissions SET allowed_channel_ids = NULL, send_messages = false WHERE bot_id = :'b1_bot';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_pair(:'b1', '66666666-0000-0000-0000-000000000006', '!general:example.org') IS NOT NULL AS again \gset
SELECT tests.clear_authentication();
SELECT results_eq(format($q$SELECT send_messages, pg_temp.allowlist(bot_id) FROM public.bot_server_permissions WHERE bot_id = %L$q$, :'b1_bot'),
  $q$VALUES (true, 'general')$q$, 'pairing converges an install that was widened or cut down');

-- The bot deleted elsewhere. ----------------------------------------------------------------
UPDATE public.matrix_bridges SET updated_at = '2000-01-01' WHERE id = :'b3';
DELETE FROM public.bots WHERE id = (SELECT bot_id FROM public.matrix_bridges WHERE id = :'b3');
SELECT results_eq(format($q$SELECT bot_id, updated_at = now() FROM public.matrix_bridges WHERE id = %L$q$, :'b3'),
  $q$VALUES (NULL::uuid, true)$q$, 'a bridge outlives its bot');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.matrix_bridge_state('f4000000-0000-0000-0000-0000000000a3') -> 'pairs', '[]'::jsonb, 'without the pairs the bot owned');
SELECT public.matrix_bridge_setup_code(:'b3') ->> 'code' AS code4 \gset
SELECT ok(public.matrix_bridge_state('f4000000-0000-0000-0000-0000000000a3') ->> 'bot_id' IS NOT NULL, 'the next code provisions a bot');

-- Deletion. ---------------------------------------------------------------------------------
SELECT lives_ok(format('SELECT public.matrix_bridge_delete(%L)', :'b3'), 'a manager deletes a bridge');
SELECT throws_ok(format('SELECT public.matrix_bridge_delete(%L)', :'b3'), 'P0002', NULL, 'once');
SELECT tests.clear_authentication();
SET LOCAL role service_role;
INSERT INTO out VALUES ('deleted', public.matrix_bridge_redeem_code(:'code4'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'deleted'), NULL, 'a code of a deleted bridge redeems nothing');
SELECT is((SELECT count(*)::int FROM public.bots WHERE owner_id = '11111111-0000-0000-0000-000000000001' AND bridge_platform = 'matrix'), 1,
  'the bot that authored nothing is deleted');

INSERT INTO public.messages (channel_id, bot_id, content, metadata) VALUES
  ('66666666-0000-0000-0000-000000000006', :'b1_bot', '[{"type":"text","text":"relayed"}]',
   '{"matrix_user":{"id":"@sam:example.org","username":"sam"},"bridge_source":"matrix"}');
SELECT (SELECT v->>'harmony_token' FROM out WHERE k = 'second') AS token2 \gset
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_delete(:'b1') IS NOT NULL AS gone \gset
SELECT tests.clear_authentication();
SELECT results_eq(format($q$SELECT is_active, bridge_platform FROM public.bots WHERE id = %L$q$, :'b1_bot'),
  $q$VALUES (false, NULL::text)$q$, 'a bot that relayed is kept for its messages, inactive');
SELECT is((public.verify_bot_token(encode(sha256(convert_to(:'token2', 'UTF8')), 'hex'))->>'valid')::boolean, false,
  'its token is revoked');
SELECT is((SELECT count(*)::int FROM public.bot_tokens WHERE bot_id = :'b1_bot' AND is_active), 0,
  'for good: reactivating the bot brings no token back');
SELECT is((SELECT count(*)::int FROM public.bridge_channels WHERE bot_id = :'b1_bot')
        + (SELECT count(*)::int FROM public.bot_server_permissions WHERE bot_id = :'b1_bot'), 0, 'its pairs and its install are gone');
SELECT is((SELECT count(*)::int FROM public.messages WHERE bot_id = :'b1_bot'), 1, 'the relayed history stays');

-- The bot of a manager who lost the permission. ---------------------------------------------
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-0000000000a3', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, permissions, position) VALUES
  ('f4000000-0000-0000-0000-0000000000d3', 'f4000000-0000-0000-0000-0000000000a3', 'Managers', 128, 5);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-0000000000d3', 'f4000000-0000-0000-0000-0000000000a3');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.matrix_bridge_create('f4000000-0000-0000-0000-0000000000a3', 'self') AS s6 \gset
SELECT :'s6'::jsonb ->> 'id' AS b6, :'s6'::jsonb ->> 'bot_id' AS b6_bot \gset
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_setup_code(:'b6') IS NOT NULL AS c6 \gset
SELECT tests.clear_authentication();
SELECT is((SELECT owner_id FROM public.bots WHERE id = :'b6_bot'), '22222222-0000-0000-0000-000000000002'::uuid,
  'another manager''s code leaves the bot with the manager who made it');
DELETE FROM public.user_roles WHERE role_id = 'f4000000-0000-0000-0000-0000000000d3';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_setup_code(:'b6') IS NOT NULL AS c7 \gset
SELECT tests.clear_authentication();
SELECT is((SELECT owner_id FROM public.bots WHERE id = :'b6_bot'), '11111111-0000-0000-0000-000000000001'::uuid,
  'once they lost MANAGE_SERVER it passes to the manager who takes over');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format('SELECT public.rotate_bot_token(%L)', :'b6_bot'), '42501', NULL, 'and they issue no token for it');
SELECT tests.clear_authentication();

-- Deletion with the server.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.matrix_bridge_create('f4000000-0000-0000-0000-0000000000a5', 'self') ->> 'bot_id' AS b5_bot \gset
SELECT tests.clear_authentication();
SELECT lives_ok($q$DELETE FROM public.servers WHERE id = 'f4000000-0000-0000-0000-0000000000a5'$q$, 'the server goes with its bridge');
SELECT is((SELECT count(*)::int FROM public.bots WHERE id = :'b5_bot'), 0, 'and the bridge bot');

SELECT * FROM finish();
ROLLBACK;
