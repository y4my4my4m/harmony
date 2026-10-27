-- 20261030800001_custom_oauth_providers.sql: instance_config custom_oauth_providers, the sign-in
-- buttons of the instance's own OAuth/OIDC providers, is readable by every client and written by
-- instance admins only.
--
--   admin202   an instance admin
--   alice      a member without staff rights here

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(11);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2020000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin202@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin) VALUES
  ('f2020000-0000-0000-0000-0000000000d1', 'f2020000-0000-0000-0000-0000000000a1', 'admin202', 'Admin', true, true);
UPDATE public.profiles SET is_admin = false, is_moderator = false WHERE id = '11111111-0000-0000-0000-000000000001';
INSERT INTO public.instance_config (config_key, config_value) VALUES ('maintainer_email', '"ops@test.local"')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

CREATE TEMP TABLE r202 (k text PRIMARY KEY, v jsonb);
GRANT ALL ON r202 TO anon, authenticated;

SELECT is((SELECT count(*)::int FROM unnest(public.public_instance_config_keys()) k WHERE k = 'custom_oauth_providers'), 1,
  'custom_oauth_providers is a public key, once');
SELECT ok('oauth_providers' = ANY (public.public_instance_config_keys())
          AND NOT ('maintainer_email' = ANY (public.public_instance_config_keys())),
  'the other keys keep their visibility');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'custom_oauth_providers'), '[]'::jsonb,
  'a new instance lists no custom providers');

-- Visitors. ---------------------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
INSERT INTO r202 SELECT 'anon:' || config_key, config_value FROM public.instance_config
 WHERE config_key IN ('custom_oauth_providers', 'maintainer_email');
SELECT tests.clear_authentication();
SELECT is((SELECT v FROM r202 WHERE k = 'anon:custom_oauth_providers'), '[]'::jsonb,
  'a visitor reads the custom providers');
SELECT ok(NOT EXISTS (SELECT 1 FROM r202 WHERE k = 'anon:maintainer_email'),
  'a visitor still does not read admin-only keys');

-- Members. ----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
  $$SELECT public.set_instance_config('custom_oauth_providers', '[{"id":"custom:evil","name":"Evil"}]'::jsonb)$$,
  '42501', NULL, 'a member cannot set the custom providers');
UPDATE public.instance_config SET config_value = '[{"id":"custom:evil","name":"Evil"}]'::jsonb
 WHERE config_key = 'custom_oauth_providers';
SELECT tests.clear_authentication();
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'custom_oauth_providers'), '[]'::jsonb,
  'a member''s direct update changes nothing');

-- Admins. -----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('f2020000-0000-0000-0000-0000000000a1');
SELECT ok(public.set_instance_config('custom_oauth_providers',
            '[{"id":"custom:authentik","name":"Authentik","icon":"https://auth.test/icon.svg"}]'::jsonb),
  'an admin sets the custom providers');
SELECT tests.clear_authentication();
SELECT is((SELECT config_value -> 0 ->> 'id' FROM public.instance_config WHERE config_key = 'custom_oauth_providers'),
  'custom:authentik', 'the admin''s value is stored');
SELECT ok(EXISTS (SELECT 1 FROM public.admin_audit_log
                   WHERE target_id = 'custom_oauth_providers' AND action_type = 'config_change'),
  'the change is in the admin log');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO r202 SELECT 'member:' || config_key, config_value FROM public.instance_config
 WHERE config_key = 'custom_oauth_providers';
SELECT tests.clear_authentication();
SELECT is((SELECT v -> 0 ->> 'name' FROM r202 WHERE k = 'member:custom_oauth_providers'), 'Authentik',
  'members read what the admin set');

SELECT * FROM finish();
ROLLBACK;
