-- 20261110900006_bridge_attachment_mode_public.sql: bridge_attachment_mode is a public
-- instance_config key, so a signed-in non-admin (a server manager) reads it.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(4);

SELECT ok('bridge_attachment_mode' = ANY (public.public_instance_config_keys()),
  'bridge_attachment_mode is in public_instance_config_keys()');
SELECT ok('discord_bridge_hosting_enabled' = ANY (public.public_instance_config_keys()),
  'earlier public keys are kept');

UPDATE public.instance_config SET config_value = '"mirror"'::jsonb WHERE config_key = 'bridge_attachment_mode';

SET LOCAL ROLE authenticated;
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'bridge_attachment_mode'), '"mirror"'::jsonb,
  'an authenticated non-admin reads bridge_attachment_mode');
SELECT is((SELECT count(*)::int FROM public.instance_config WHERE config_key = 'bridge_attachment_mode'), 1,
  'one row is visible');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
