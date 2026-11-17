-- History import for every bridge mode and Harmony-side consent for private Discord channels,
-- after 20261117700001_bridge_import_modes.sql.
--
-- Fixture server_1 (alice owns and is the instance admin, bob is a member) with #general. Added:
-- bridge301 (mode instance after setup) run by bot301 with the pairs
--   A  #general  Discord ...01
--   B  p301b     Discord ...02

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(25);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f3010000-0000-0000-0000-0000000000b1', 'bot301', 'Bot 301', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f3010000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'p301b', 0);
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f3010000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f3010000-0000-0000-0000-0000000000b1', '900000000000000301', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f3010000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '3010000000000000001', 'both'),
  ('f3010000-0000-0000-0000-0000000000d1', 'f3010000-0000-0000-0000-000000000002', '3010000000000000002', 'both');

CREATE FUNCTION pg_temp.mode(p_value text) RETURNS void LANGUAGE sql AS
$fn$ UPDATE public.instance_config SET config_value = to_jsonb(p_value) WHERE config_key = 'bridge_history_import' $fn$;
CREATE FUNCTION pg_temp.bridge_mode(p_mode text) RETURNS void LANGUAGE sql AS
$fn$ UPDATE public.discord_bridges SET mode = p_mode WHERE id = 'f3010000-0000-0000-0000-0000000000d1' $fn$;
CREATE FUNCTION pg_temp.block() RETURNS text LANGUAGE sql AS
$fn$ SELECT public.discord_bridge_import_block('f3010000-0000-0000-0000-0000000000d1') $fn$;
CREATE FUNCTION pg_temp.job(p_k text) RETURNS uuid LANGUAGE sql AS
$fn$ SELECT i.id FROM public.discord_bridge_imports i
      WHERE i.bridge_id = 'f3010000-0000-0000-0000-0000000000d1' AND right(i.discord_channel_id, 1) = p_k $fn$;
CREATE FUNCTION pg_temp.row_of(p_k text) RETURNS public.discord_bridge_imports LANGUAGE sql AS
$fn$ SELECT i FROM public.discord_bridge_imports i WHERE i.id = pg_temp.job(p_k) $fn$;
CREATE FUNCTION pg_temp.patch(p_k text, p_patch jsonb) RETURNS public.discord_bridge_imports LANGUAGE sql AS
$fn$ SELECT public.discord_bridge_import_update('f3010000-0000-0000-0000-0000000000d1', pg_temp.job(p_k), p_patch) $fn$;

-- The switch ------------------------------------------------------------------------------------------
SELECT pg_temp.bridge_mode('instance');
SELECT ok((SELECT description FROM public.instance_config WHERE config_key = 'bridge_history_import') LIKE '%all for every bridge%',
          'the setting names its three values');

SELECT pg_temp.mode('self_run');
SELECT is(pg_temp.block(), 'bridge_mode', 'self_run: the instance bot may not import');
SELECT pg_temp.bridge_mode('hosted');
SELECT is(pg_temp.block(), 'bridge_mode', 'self_run: a hosted bridge may not');
SELECT pg_temp.bridge_mode('self');
SELECT is(pg_temp.block(), NULL, 'self_run: a self-run bridge may');

SELECT pg_temp.mode('all');
SELECT is(pg_temp.block(), NULL, 'all: a self-run bridge may import');
SELECT pg_temp.bridge_mode('hosted');
SELECT is(pg_temp.block(), NULL, 'all: a hosted bridge may');
SELECT pg_temp.bridge_mode('instance');
SELECT is(pg_temp.block(), NULL, 'all: the instance bot may');
SELECT is(public.discord_bridge_import_block('f3010000-0000-0000-0000-00000000ffff'), 'bridge_mode',
          'all: a bridge that does not exist may not');

SELECT pg_temp.mode('everything');
SELECT is(pg_temp.block(), 'instance_off', 'an unknown value is off');
SELECT pg_temp.mode('off');
SELECT is(pg_temp.block(), 'instance_off', 'off is off');

-- Starts under all, for the instance bot ---------------------------------------------------------------
SELECT pg_temp.mode('all');
SELECT is((SELECT count(*) FROM public.discord_bridge_import_start_internal(
               'f3010000-0000-0000-0000-0000000000d1', NULL, 'discord', NULL, NULL, true)),
          2::bigint, 'all: a Discord-side start through the instance bot queues both pairs');
SELECT ok(NOT (pg_temp.row_of('1')).private_approved AND NOT (pg_temp.row_of('2')).private_approved,
          'a Discord-side start never records Harmony consent');

-- Harmony-side consent ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*) FROM public.discord_bridge_import_start('f3010000-0000-0000-0000-0000000000d1',
               ARRAY['66666666-0000-0000-0000-000000000006']::uuid[], true)),
          1::bigint, 'the app start takes the consent');
SELECT ok((pg_temp.row_of('1')).private_approved, 'a queued job takes consent given before it runs');
SELECT ok(NOT (pg_temp.row_of('2')).private_approved, 'a job outside the call keeps its value');
SELECT tests.clear_authentication();

SELECT pg_temp.patch('1', '{"state": "running"}');
SELECT pg_temp.patch('1', '{"state": "failed", "error": "discord_approval_required"}');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT state || ':' || private_approved FROM public.discord_bridge_import_start(
               'f3010000-0000-0000-0000-0000000000d1', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])),
          'queued:false', 'a retry without the consent does not keep the earlier one');
SELECT tests.clear_authentication();

SELECT pg_temp.patch('1', '{"state": "running"}');
SELECT pg_temp.patch('1', '{"state": "failed", "error": "discord_approval_required"}');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT state || ':' || private_approved || ':' || requested_via FROM public.discord_bridge_import_start(
               'f3010000-0000-0000-0000-0000000000d1', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[], true)),
          'queued:true:harmony', 'a failed job retried with the consent is queued with it');
SELECT tests.clear_authentication();

SELECT pg_temp.patch('2', '{"state": "running"}');
SELECT pg_temp.patch('2', '{"state": "done"}');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT state || ':' || private_approved FROM public.discord_bridge_import_start(
               'f3010000-0000-0000-0000-0000000000d1', ARRAY['f3010000-0000-0000-0000-000000000002']::uuid[], true)),
          'queued:true', 'a finished job started again records the consent with its reset');
SELECT tests.clear_authentication();

SELECT pg_temp.patch('1', '{"state": "running"}');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT state || ':' || private_approved FROM public.discord_bridge_import_start(
               'f3010000-0000-0000-0000-0000000000d1', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])),
          'running:true', 'a running job is left as it is');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT * FROM public.discord_bridge_import_start('f3010000-0000-0000-0000-0000000000d1', NULL, true)$q$,
                 '42501', NULL, 'a member who does not manage the server cannot start');
SELECT tests.clear_authentication();

SELECT pg_temp.mode('self_run');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT * FROM public.discord_bridge_import_start('f3010000-0000-0000-0000-0000000000d1', NULL, true)$q$,
                 '0A000', 'import_disabled', 'self_run: the instance bot''s app start is refused');
SELECT tests.clear_authentication();

-- Shape and grants ----------------------------------------------------------------------------------
SELECT col_not_null('public', 'discord_bridge_imports', 'private_approved', 'private_approved is never null');
SELECT col_default_is('public', 'discord_bridge_imports', 'private_approved', 'false', 'and false unless given');
SELECT ok(to_regprocedure('public.discord_bridge_import_start(uuid, uuid[])') IS NULL
          AND to_regprocedure('public.discord_bridge_import_start_internal(uuid, text[], text, uuid, jsonb)') IS NULL,
          'the earlier signatures are gone');
SELECT ok(has_function_privilege('authenticated', 'public.discord_bridge_import_start(uuid, uuid[], boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.discord_bridge_import_start(uuid, uuid[], boolean)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.discord_bridge_import_start_internal(uuid, text[], text, uuid, jsonb, boolean)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.discord_bridge_import_start_internal(uuid, text[], text, uuid, jsonb, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.discord_bridge_import_block(uuid)', 'EXECUTE'),
          'the app calls its start; the gateway functions are for the service role');

SELECT * FROM finish();
ROLLBACK;
