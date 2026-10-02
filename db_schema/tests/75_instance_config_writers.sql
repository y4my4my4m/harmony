-- 20261006750001_instance_config_writers.sql: one client-shaped set_instance_config, both
-- writers admin-only and not executable by anon.
--
--   alice    instance admin
--   mallory  plain user
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(7);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

SELECT results_eq(
    $q$SELECT p.oid::regprocedure::text COLLATE "default",
              has_function_privilege('anon', p.oid, 'EXECUTE'),
              has_function_privilege('authenticated', p.oid, 'EXECUTE'),
              'search_path=public, pg_temp' = ANY (p.proconfig)
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('set_instance_config', 'batch_set_instance_config')
        ORDER BY 1$q$,
    $q$VALUES ('batch_set_instance_config(text[],jsonb[])'::text, false, true, true),
              ('set_instance_config(text,jsonb,uuid,text)'::text, false, true, true)$q$,
    'one set_instance_config, the client''s; neither writer is executable by anon');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.set_instance_config(p_key => 'instance_name', p_value => '"x"'::jsonb)$q$,
    '42501', NULL, 'a plain user cannot write a key');
SELECT throws_ok(
    $q$SELECT public.batch_set_instance_config(ARRAY['instance_name'], ARRAY['"x"'::jsonb])$q$,
    '42501', NULL, 'a plain user cannot batch-write keys');
SELECT throws_ok(
    $q$SELECT public.set_instance_config(p_key => 'instance_name', p_value => '"x"'::jsonb,
                                         p_user_id => '11111111-0000-0000-0000-000000000001')$q$,
    '42501', NULL, 'naming an admin''s profile id grants nothing');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_instance_config(p_key => 'oauth_providers', p_value => '["github"]'::jsonb,
                                     p_user_id => '33333333-0000-0000-0000-000000000003',
                                     p_description => 'probe'),
          true, 'an admin writes one key by the client''s named arguments');
SELECT is(public.batch_set_instance_config(ARRAY['instance_description'], ARRAY['"probe"'::jsonb]),
          true, 'an admin batch-writes keys');
SELECT tests.clear_authentication();

SELECT results_eq(
    $q$SELECT ic.config_value, ic.updated_by
         FROM public.instance_config ic WHERE ic.config_key = 'oauth_providers'$q$,
    $q$VALUES ('["github"]'::jsonb, '11111111-0000-0000-0000-000000000001'::uuid)$q$,
    'the write is the caller''s, whatever p_user_id says');

SELECT * FROM finish();
ROLLBACK;
