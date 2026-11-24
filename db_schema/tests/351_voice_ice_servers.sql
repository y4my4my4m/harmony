-- 20261124100002_voice_ice_servers.sql: the instance's STUN and TURN servers for peer-to-peer calls,
-- with coturn shared-secret credentials minted per caller.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(16);

SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'voice_stun_urls'), '"default"'::jsonb,
          'STUN servers default to the app''s list');
SELECT is((SELECT count(*)::int FROM public.instance_config
            WHERE config_key IN ('voice_turn_urls', 'voice_turn_auth', 'voice_turn_username', 'voice_turn_secret')),
          4, 'the TURN settings are seeded');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.voice_ice_servers(), '{"stun": null, "turn": null}'::jsonb,
          'unset: the app''s STUN servers and no TURN server');
SELECT tests.clear_authentication();

UPDATE public.instance_config SET config_value = '[]' WHERE config_key = 'voice_stun_urls';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.voice_ice_servers() -> 'stun', '[]'::jsonb, 'an empty list is no STUN server');
SELECT tests.clear_authentication();

UPDATE public.instance_config SET config_value = '["stun:stun.example.org:3478", "https://bad.example", "STUNS:stun.example.org:5349"]'
 WHERE config_key = 'voice_stun_urls';
UPDATE public.instance_config SET config_value = '["turn:turn.example.org:3478?transport=udp", "stun:wrong.example", "turns:turn.example.org:5349"]'
 WHERE config_key = 'voice_turn_urls';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.voice_ice_servers() -> 'stun', '["stun:stun.example.org:3478", "STUNS:stun.example.org:5349"]'::jsonb,
          'STUN URLs of another scheme are left out');
SELECT is(public.voice_ice_servers() -> 'turn', 'null'::jsonb, 'TURN URLs without a secret give no TURN server');
SELECT tests.clear_authentication();

UPDATE public.instance_config SET config_value = '" s3cret "' WHERE config_key = 'voice_turn_secret';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
CREATE TEMP TABLE minted AS SELECT public.voice_ice_servers() -> 'turn' AS turn;
SELECT tests.clear_authentication();
SELECT is((SELECT turn -> 'urls' FROM minted),
          '["turn:turn.example.org:3478?transport=udp", "turns:turn.example.org:5349"]'::jsonb,
          'TURN URLs of another scheme are left out');
SELECT is((SELECT split_part(turn ->> 'username', ':', 2) FROM minted), '22222222-0000-0000-0000-000000000002',
          'a shared-secret username names the caller''s profile');
SELECT ok((SELECT split_part(turn ->> 'username', ':', 1)::bigint - floor(extract(epoch FROM now()))::bigint FROM minted)
          = 86400, 'and expires a day from now');
SELECT is((SELECT turn ->> 'credential' FROM minted),
          (SELECT encode(extensions.hmac(turn ->> 'username', 's3cret', 'sha1'), 'base64') FROM minted),
          'the credential is base64(HMAC-SHA1(secret, username)), the secret trimmed');

UPDATE public.instance_config SET config_value = '"password"' WHERE config_key = 'voice_turn_auth';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.voice_ice_servers() -> 'turn', 'null'::jsonb, 'a password account without a name gives no TURN server');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '"harmony"' WHERE config_key = 'voice_turn_username';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.voice_ice_servers() -> 'turn',
          '{"urls": ["turn:turn.example.org:3478?transport=udp", "turns:turn.example.org:5349"], "username": "harmony", "credential": "s3cret"}'::jsonb,
          'a password account is handed out as set, to any account of the instance');

SELECT is((SELECT count(*)::int FROM public.instance_config WHERE config_key LIKE 'voice\_turn\_%'), 0,
          'a member reads none of the TURN settings');
SELECT tests.clear_authentication();

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.instance_config WHERE config_key LIKE 'voice\_turn\_%'), 4,
          'an admin reads them');
SELECT tests.clear_authentication();

SELECT ok(NOT has_function_privilege('anon', 'public.voice_ice_servers()', 'EXECUTE'),
          'anon cannot call voice_ice_servers');
SELECT ok(has_function_privilege('authenticated', 'public.voice_ice_servers()', 'EXECUTE'),
          'a signed-in account can');

SELECT * FROM finish();
ROLLBACK;
