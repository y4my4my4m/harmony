-- 20261114200001_copy_emojis.sql: a local federated server's emoji changes queue
-- federate-server-update, other emojis never; emojis.ap_id is one per server and an http(s) id;
-- an emoji row of a copy is usable by the copy's members.
--
-- Fixture server_1: alice owns it, bob is a member. Added here:
--   remote287    a remote account
--   copy287      a server reference (is_local_server false); bob a member
--   quiet287     a local server with federation off
-- queue_federation_job is replaced for the transaction with a recorder into tests.fed_jobs:
-- pg_notify delivers only at commit and every file rolls back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(17);

CREATE TABLE tests.fed_jobs (name text, data jsonb);

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.fed_jobs VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.updates(p_server uuid) RETURNS bigint
LANGUAGE sql STABLE AS $fn$
  SELECT count(*) FROM tests.fed_jobs WHERE name = 'federate-server-update' AND data ->> 'server_id' = p_server::text;
$fn$;

UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, is_local)
VALUES ('f2870000-0000-0000-0000-0000000000e1', 'remote287', 'Remote 287', 'remote.test',
        'https://remote.test/users/remote287', false);
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id)
VALUES ('f2870000-0000-0000-0000-0000000000a1', 'Copy 287', 'f2870000-0000-0000-0000-0000000000e1', false, true,
        'remote.test', 'https://remote.test/servers/f2870000-0000-0000-0000-0000000000a1');
INSERT INTO public.servers (id, name, owner, federation_enabled)
VALUES ('f2870000-0000-0000-0000-0000000000a2', 'Quiet 287', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', 'f2870000-0000-0000-0000-0000000000a1', 'accepted');
DELETE FROM tests.fed_jobs;

-- Column. -----------------------------------------------------------------------------------------
SELECT has_column('public', 'emojis', 'ap_id', 'emojis.ap_id exists');

-- A local federated server. -----------------------------------------------------------------------
INSERT INTO public.emojis (id, name, url, server_id, uploader)
VALUES ('f2870000-0000-0000-0000-000000000001', 'wave287', 'emojis/wave287.webp',
        '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001');
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 1::bigint,
    'an emoji added to a local federated server queues federate-server-update');

UPDATE public.emojis SET name = 'hello287' WHERE id = 'f2870000-0000-0000-0000-000000000001';
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 2::bigint, 'a rename queues it');

UPDATE public.emojis SET url = 'emojis/hello287-2.webp' WHERE id = 'f2870000-0000-0000-0000-000000000001';
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 3::bigint, 'a new image queues it');

UPDATE public.emojis SET usage_count = 7, last_used = now() WHERE id = 'f2870000-0000-0000-0000-000000000001';
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 3::bigint, 'a use counted queues nothing');

UPDATE public.emojis SET deleted_at = now() WHERE id = 'f2870000-0000-0000-0000-000000000001';
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 4::bigint, 'a removal queues it');

UPDATE public.emojis SET deleted_at = NULL WHERE id = 'f2870000-0000-0000-0000-000000000001';
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 5::bigint, 'a restore queues it');

UPDATE public.emojis SET server_id = 'f2870000-0000-0000-0000-0000000000a2' WHERE id = 'f2870000-0000-0000-0000-000000000001';
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 6::bigint,
    'a move to another server queues it for the server it left');

UPDATE public.emojis SET server_id = '55555555-0000-0000-0000-000000000005' WHERE id = 'f2870000-0000-0000-0000-000000000001';
DELETE FROM public.emojis WHERE id = 'f2870000-0000-0000-0000-000000000001';
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 8::bigint, 'moving back and a delete queue it');

-- Emojis that are no local federated server's. ----------------------------------------------------
DELETE FROM tests.fed_jobs;
INSERT INTO public.emojis (name, url, server_id, uploader)
VALUES ('quiet287', 'emojis/quiet287.webp', 'f2870000-0000-0000-0000-0000000000a2', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.emojis (name, url, server_id, scope, domain, ap_id)
VALUES ('far287', 'https://remote.test/emojis/far287.webp', 'f2870000-0000-0000-0000-0000000000a1', 'server', 'remote.test',
        'https://remote.test/servers/f2870000-0000-0000-0000-0000000000a1/emojis/f2870000-0000-0000-0000-0000000000f1');
INSERT INTO public.emojis (name, url, scope, uploader)
VALUES ('inst287', 'emojis/inst287.webp', 'instance', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.emojis (name, url, scope, uploader)
VALUES ('mine287', 'emojis/mine287.webp', 'user', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.emojis (name, url, domain)
VALUES ('seen287', 'https://remote.test/emojis/seen287.webp', 'remote.test');
SELECT is((SELECT count(*) FROM tests.fed_jobs), 0::bigint,
    'emojis of a server with federation off, of a copy, of the instance, of a person and seen elsewhere queue nothing');

-- ap_id. --------------------------------------------------------------------------------------------
SELECT throws_ok(
    $q$INSERT INTO public.emojis (name, url, server_id, scope, domain, ap_id)
       VALUES ('twice287', 'https://remote.test/emojis/twice287.webp', 'f2870000-0000-0000-0000-0000000000a1', 'server',
               'remote.test', 'https://remote.test/servers/f2870000-0000-0000-0000-0000000000a1/emojis/f2870000-0000-0000-0000-0000000000f1')$q$,
    '23505', NULL, 'one row per emoji id per copy');
SELECT throws_ok(
    $q$INSERT INTO public.emojis (name, url, server_id, scope, ap_id)
       VALUES ('bad287', 'https://remote.test/emojis/bad287.webp', 'f2870000-0000-0000-0000-0000000000a1', 'server',
               'javascript:alert(1)')$q$,
    '23514', NULL, 'an emoji id is an http(s) URL');
SELECT lives_ok(
    $q$INSERT INTO public.emojis (name, url, server_id, scope, domain, ap_id)
       VALUES ('far287', 'https://remote.test/emojis/far287.webp', '55555555-0000-0000-0000-000000000005', 'server', 'remote.test',
               'https://remote.test/servers/f2870000-0000-0000-0000-0000000000a1/emojis/f2870000-0000-0000-0000-0000000000f1')$q$,
    'the same id on another server is another row');

-- Use. ----------------------------------------------------------------------------------------------
SELECT ok(public.emoji_usable(
    (SELECT e FROM public.emojis e WHERE e.server_id = 'f2870000-0000-0000-0000-0000000000a1' AND e.name = 'far287'),
    '22222222-0000-0000-0000-000000000002', 'f2870000-0000-0000-0000-0000000000a1'),
    'a member of a copy uses its emoji there');
SELECT ok(NOT public.emoji_usable(
    (SELECT e FROM public.emojis e WHERE e.server_id = 'f2870000-0000-0000-0000-0000000000a1' AND e.name = 'far287'),
    '33333333-0000-0000-0000-000000000003', 'f2870000-0000-0000-0000-0000000000a1'),
    'an account that is not its member does not');
SELECT ok(NOT public.emoji_usable(
    (SELECT e FROM public.emojis e WHERE e.name = 'seen287'),
    '22222222-0000-0000-0000-000000000002', 'f2870000-0000-0000-0000-0000000000a1'),
    'an emoji only seen in an activity is nobody''s to use');

-- Privileges. ---------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.trigger_queue_server_emojis_federation()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.trigger_queue_server_emojis_federation()', 'EXECUTE'),
    'clients cannot call the trigger function');

SELECT * FROM finish();
ROLLBACK;
