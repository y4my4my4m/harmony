-- 20261117800001_auth_provider_credentials.sql: who sets sign-in provider credentials, what is
-- refused, what members and the service role read.
--
--   alice is an instance admin here; bob is not.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(30);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
UPDATE public.instance_config SET config_value = '["discord", "google"]'::jsonb WHERE config_key = 'oauth_providers';

CREATE TEMP TABLE r302 (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON r302 TO authenticated, service_role;

-- Members are refused. ------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.auth_provider_credentials_status()$$, '42501', NULL, 'a member cannot read the status');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('discord', '123456789012345678', 'abcdefghijklmnop')$$,
  '42501', NULL, 'a member cannot set credentials');
SELECT throws_ok($$SELECT public.auth_provider_credentials_clear('discord')$$, '42501', NULL, 'a member cannot clear them');
SELECT throws_ok($$SELECT * FROM public.auth_provider_credentials$$, '42501', NULL, 'a member cannot read the table');
SELECT throws_ok($$SELECT * FROM public.auth_provider_credentials_render()$$, '42501', NULL, 'a member cannot render secrets');
SELECT throws_ok($$SELECT public.auth_provider_writer_report(true, NULL)$$, '42501', NULL, 'a member cannot report as the writer');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT public.auth_provider_credentials_status()$$, '42501', NULL, 'anonymous callers are refused');

-- The admin sets Discord. ---------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('discord', '123456789012345678', NULL)$$,
  '22023', 'A client id and a client secret are required', 'a new provider needs a secret');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('apple', 'abc', 'abcdefghijklmnop')$$,
  '22023', 'Unknown sign-in provider', 'only the four built-in providers');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('discord', 'not-digits', 'abcdefghijklmnop')$$,
  '22023', 'Not a client id', 'a Discord client id is an application id');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('google', E'abc\nGOTRUE_JWT_SECRET=x', 'abcdefghijklmnop')$$,
  '22023', 'Not a client id', 'a newline in a client id is refused');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('google', 'abc,def', 'abcdefghijklmnop')$$,
  '22023', 'Not a client id', 'a comma in a client id is refused');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('google', 'abc', E'abcdefgh\nGOTRUE_URI_ALLOW_LIST=*')$$,
  '22023', 'Not a client secret', 'a newline in a secret is refused');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('google', 'abc', 'abcd efgh ijkl')$$,
  '22023', 'Not a client secret', 'a space in a secret is refused');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('google', 'abc', '"abcdefghijkl"')$$,
  '22023', 'Not a client secret', 'a quote in a secret is refused');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('google', 'abc', '#abcdefghijkl')$$,
  '22023', 'Not a client secret', 'a leading # is refused');
SELECT throws_ok($$SELECT public.auth_provider_credentials_set('google', 'abc', 'abc$defghijkl')$$,
  '22023', 'Not a client secret', 'a $ is refused');

INSERT INTO r302 VALUES ('set', public.auth_provider_credentials_set(' Discord ', '123456789012345678', 'Secret_one-123'));
SELECT is((SELECT v #> '{providers,0}' FROM r302 WHERE k = 'set') - 'updated_at',
  '{"provider": "discord", "client_id": "123456789012345678", "has_secret": true}'::jsonb,
  'the status names the client id, never the secret');
SELECT ok(position('Secret_one' IN (SELECT v::text FROM r302 WHERE k = 'set')) = 0, 'the secret is not in the status');

INSERT INTO r302 VALUES ('keep', public.auth_provider_credentials_set('discord', NULL, 'Secret_two-456'));
SELECT is((SELECT v #>> '{providers,0,client_id}' FROM r302 WHERE k = 'keep'), '123456789012345678',
  'an empty client id keeps the stored one');

SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE description = 'Sign-in provider discord: client secret'), 1,
  'a new secret replaces the stored Vault secret');
SELECT is((SELECT count(*)::int FROM public.admin_audit_log
            WHERE target_id = 'auth_provider_credentials' AND action_details ->> 'provider' = 'discord'), 2,
  'both saves are logged');
SELECT ok(position('Secret_' IN (SELECT string_agg(action_details::text, ' ') FROM public.admin_audit_log
                                  WHERE target_id = 'auth_provider_credentials')) = 0,
  'the audit log holds no secret');

-- The service role renders. -------------------------------------------------------------------
SET LOCAL ROLE service_role;
INSERT INTO r302 SELECT 'render', to_jsonb(x) FROM public.auth_provider_credentials_render() x WHERE x.provider = 'discord';
SELECT public.auth_provider_writer_report(true, NULL);
RESET ROLE;
SELECT is((SELECT v FROM r302 WHERE k = 'render'),
  '{"provider": "discord", "client_id": "123456789012345678", "client_secret": "Secret_two-456", "enabled": true}'::jsonb,
  'the writer reads the secret and the provider is on');

UPDATE public.instance_config SET config_value = '{"discord": false, "google": true}'::jsonb WHERE config_key = 'oauth_providers';
SELECT is((SELECT enabled FROM public.auth_provider_credentials_render() WHERE provider = 'discord'), false,
  'a hidden button turns the provider off');
UPDATE public.instance_config SET config_value = '"google, discord"'::jsonb WHERE config_key = 'oauth_providers';
SELECT is((SELECT enabled FROM public.auth_provider_credentials_render() WHERE provider = 'discord'), true,
  'a comma list names it');

-- Clearing turns it off and keeps the row for the writer. ---------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO r302 VALUES ('clear', public.auth_provider_credentials_clear('discord'));
SELECT is((SELECT v #> '{providers,0}' FROM r302 WHERE k = 'clear') - 'updated_at',
  '{"provider": "discord", "client_id": null, "has_secret": false}'::jsonb, 'clear drops the client id and the secret');
SELECT is((SELECT v #>> '{writer,live}' FROM r302 WHERE k = 'clear'), 'true', 'the writer passed within 90 s');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE description = 'Sign-in provider discord: client secret'), 0,
  'the Vault secret is deleted');
SELECT is((SELECT to_jsonb(x) FROM public.auth_provider_credentials_render() x WHERE x.provider = 'discord'),
  '{"provider": "discord", "client_id": null, "client_secret": null, "enabled": false}'::jsonb,
  'a cleared provider renders off');

SELECT * FROM finish();
ROLLBACK;
