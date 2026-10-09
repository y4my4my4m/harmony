-- 20261009700001_bridge_bot_manage_roles.sql: a Discord bridge bot's install holds manage_roles,
-- which bot-gateway requires for every role write.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(3);

INSERT INTO public.discord_bridges (id, server_id, mode, discord_guild_id, created_by)
VALUES ('a0000000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005', 'instance',
        '900000000000000100', '11111111-0000-0000-0000-000000000001');

SELECT ok(pg_get_functiondef('public.discord_bridge_provision_bot(uuid, uuid)'::regprocedure) ~ 'manage_roles',
          'provisioning installs bridge bots with manage_roles');

-- Executable only by its owner; a production clone's owner is not the test role. Dynamic SQL:
-- the executor checks EXECUTE on every function a plan names, taken branch or not.
CREATE TEMP TABLE provisioned (bot_id uuid);
DO $$
BEGIN
  IF has_function_privilege('public.discord_bridge_provision_bot(uuid, uuid)', 'EXECUTE') THEN
    EXECUTE 'INSERT INTO provisioned SELECT public.discord_bridge_provision_bot($1, $2)'
      USING 'a0000000-0000-0000-0000-0000000000b1'::uuid, '11111111-0000-0000-0000-000000000001'::uuid;
  END IF;
END $$;

SELECT CASE
  WHEN (SELECT bot_id FROM provisioned) IS NOT NULL THEN
    is((SELECT p.manage_roles FROM public.bot_server_permissions p
         WHERE p.bot_id = (SELECT bot_id FROM provisioned)
           AND p.server_id = '55555555-0000-0000-0000-000000000005'),
       true, 'a provisioned bridge bot holds manage_roles')
  ELSE skip('discord_bridge_provision_bot is not executable by this role')
END;

SELECT is_empty(
    $q$SELECT b.id FROM public.discord_bridges b
         JOIN public.bot_server_permissions p ON p.bot_id = b.bot_id AND p.server_id = b.server_id
        WHERE p.manage_roles IS DISTINCT FROM true$q$,
    'no bridge bot install lacks manage_roles');

SELECT * FROM finish();
ROLLBACK;
