-- 20261021200001_ap_conformance.sql: the actor's Update federates profile fields,
-- discoverability, colour and display-name emoji; a failing endpoint is dead after 7 days.
--
--   ap161      local account
--   rap161     remote account
--
-- queue_federation_job is replaced for the transaction so queued jobs can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

CREATE TABLE tests.jobs161 (name text, data jsonb);
GRANT INSERT, SELECT, DELETE ON tests.jobs161 TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs161 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1610000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ap161@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1610000-0000-0000-0000-0000000000c1', 'f1610000-0000-0000-0000-0000000000a1', 'ap161', 'AP', true);
INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, inbox_url) VALUES
  ('f1610000-0000-0000-0000-0000000000d1', 'rap161', 'Remote', false, 'remote161.test',
   'https://remote161.test/users/rap161', 'https://remote161.test/users/rap161/inbox');

CREATE FUNCTION tests.profile_jobs161() RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM tests.jobs161
   WHERE name = 'federate-profile' AND data->>'profile_id' = 'f1610000-0000-0000-0000-0000000000c1'
$$;

-- Profile Update federation -----------------------------------------------------------------
SELECT tests.authenticate_as('f1610000-0000-0000-0000-0000000000a1');
UPDATE public.profiles SET profile_fields = '[{"name":"Site","value":"https://ap161.test"}]'::jsonb
 WHERE id = 'f1610000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
SELECT is(tests.profile_jobs161(), 1, 'a profile fields change federates the actor');

DELETE FROM tests.jobs161;
SELECT tests.authenticate_as('f1610000-0000-0000-0000-0000000000a1');
UPDATE public.profiles SET federation_discoverable = false WHERE id = 'f1610000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
SELECT is(tests.profile_jobs161(), 1, 'a discoverability change federates the actor');

DELETE FROM tests.jobs161;
SELECT tests.authenticate_as('f1610000-0000-0000-0000-0000000000a1');
UPDATE public.profiles SET color = '#0ea5e9' WHERE id = 'f1610000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
SELECT is(tests.profile_jobs161(), 1, 'a colour change federates the actor');

DELETE FROM tests.jobs161;
UPDATE public.profiles
   SET federation_metadata = '{"display_name_emojis":[{"name":"blob161","url":"https://ap161.test/blob.png"}]}'::jsonb
 WHERE id = 'f1610000-0000-0000-0000-0000000000c1';
SELECT is(tests.profile_jobs161(), 1, 'a display-name emoji change federates the actor');

DELETE FROM tests.jobs161;
SELECT tests.authenticate_as('f1610000-0000-0000-0000-0000000000a1');
UPDATE public.profiles SET profile_fields = '[{"name":"Site","value":"https://ap161.test"}]'::jsonb
 WHERE id = 'f1610000-0000-0000-0000-0000000000c1';
SELECT tests.clear_authentication();
SELECT is(tests.profile_jobs161(), 0, 'rewriting the same profile fields federates nothing');

UPDATE public.profiles SET updated_at = now() - interval '1 minute' WHERE id = 'f1610000-0000-0000-0000-0000000000c1';
SELECT is(tests.profile_jobs161(), 0, 'a change to an unfederated column federates nothing');

UPDATE public.profiles SET profile_fields = '[{"name":"Site","value":"elsewhere"}]'::jsonb, color = '#ff0000'
 WHERE id = 'f1610000-0000-0000-0000-0000000000d1';
SELECT is((SELECT count(*)::int FROM tests.jobs161), 0, 'a remote account federates nothing');

SELECT ok(NOT has_function_privilege('authenticated', 'public.trigger_queue_profile_federation()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.trigger_queue_profile_federation()', 'EXECUTE'),
          'clients cannot call the profile federation trigger function');

-- Endpoint health ---------------------------------------------------------------------------
SELECT public.update_endpoint_health('https://remote161.test/inbox', 'remote161.test', false, 503, 'HTTP 503');
UPDATE public.federation_endpoint_health SET first_failure_at = now() - interval '3 days'
 WHERE endpoint_url = 'https://remote161.test/inbox';
SELECT public.update_endpoint_health('https://remote161.test/inbox', 'remote161.test', false, 503, 'HTTP 503');
SELECT is((SELECT is_dead FROM public.federation_endpoint_health WHERE endpoint_url = 'https://remote161.test/inbox'),
          false, 'an endpoint failing for 3 days is alive: deliveries to it are still being retried');

UPDATE public.federation_endpoint_health SET first_failure_at = now() - interval '7 days 1 minute'
 WHERE endpoint_url = 'https://remote161.test/inbox';
SELECT public.update_endpoint_health('https://remote161.test/inbox', 'remote161.test', false, 503, 'HTTP 503');
SELECT is((SELECT is_dead FROM public.federation_endpoint_health WHERE endpoint_url = 'https://remote161.test/inbox'),
          true, 'an endpoint failing for over 7 days is dead');

SELECT public.update_endpoint_health('https://remote161.test/inbox', 'remote161.test', true, 202, NULL);
SELECT is((SELECT is_dead FROM public.federation_endpoint_health WHERE endpoint_url = 'https://remote161.test/inbox'),
          false, 'a success revives it');

SELECT public.update_endpoint_health('https://gone161.test/inbox', 'gone161.test', false, 410, 'HTTP 410');
UPDATE public.federation_endpoint_health SET first_failure_at = now() - interval '25 hours'
 WHERE endpoint_url = 'https://gone161.test/inbox';
SELECT public.update_endpoint_health('https://gone161.test/inbox', 'gone161.test', false, 410, 'HTTP 410');
SELECT is((SELECT is_dead FROM public.federation_endpoint_health WHERE endpoint_url = 'https://gone161.test/inbox'),
          true, 'an endpoint answering 410 for over 24 hours is dead');

SELECT public.update_endpoint_health('https://busy161.test/inbox', 'busy161.test', false, 503, 'HTTP 503');
UPDATE public.federation_endpoint_health SET first_failure_at = now() - interval '25 hours'
 WHERE endpoint_url = 'https://busy161.test/inbox';
SELECT public.update_endpoint_health('https://busy161.test/inbox', 'busy161.test', false, 503, 'HTTP 503');
SELECT is((SELECT is_dead FROM public.federation_endpoint_health WHERE endpoint_url = 'https://busy161.test/inbox'),
          false, 'an endpoint answering 503 for 25 hours is alive');

SELECT ok(NOT has_function_privilege('authenticated', 'public.update_endpoint_health(text, text, boolean, integer, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.update_endpoint_health(text, text, boolean, integer, text)', 'EXECUTE'),
          'clients cannot record endpoint health');

SELECT * FROM finish();
ROLLBACK;
