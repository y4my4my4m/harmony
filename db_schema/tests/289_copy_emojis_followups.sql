-- 20261114400001_copy_emojis_followups.sql: deleting a copy detaches its mirrored emojis and the
-- reactions naming one keep it; a local server's emojis go with it; a copy's emoji is renamed by
-- the service role alone; allow_cross_server_emojis federates.
--
-- Fixture server_1 (local): alice owns it. Added here:
--   remote289    a remote account
--   copy289      a server reference (is_local_server false) with mirrored emoji far289
--   local289     a local server of alice with emoji near289
-- queue_federation_job is replaced for the transaction with a recorder into tests.fed_jobs.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

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

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, is_local)
VALUES ('f2890000-0000-0000-0000-0000000000e1', 'remote289', 'Remote 289', 'remote.test',
        'https://remote.test/users/remote289', false);
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id)
VALUES ('f2890000-0000-0000-0000-0000000000a1', 'Copy 289', 'f2890000-0000-0000-0000-0000000000e1', false, true,
        'remote.test', 'https://remote.test/servers/f2890000-0000-0000-0000-0000000000a1');
INSERT INTO public.servers (id, name, owner)
VALUES ('f2890000-0000-0000-0000-0000000000a2', 'Local 289', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.emojis (id, name, url, server_id, scope, domain, ap_id)
VALUES ('f2890000-0000-0000-0000-000000000001', 'far289', 'https://remote.test/emojis/far289.webp',
        'f2890000-0000-0000-0000-0000000000a1', 'server', 'remote.test',
        'https://remote.test/servers/f2890000-0000-0000-0000-0000000000a1/emojis/f2890000-0000-0000-0000-0000000000f1');
INSERT INTO public.emojis (id, name, url, server_id, uploader)
VALUES ('f2890000-0000-0000-0000-000000000002', 'near289', 'emojis/near289.webp',
        'f2890000-0000-0000-0000-0000000000a2', '11111111-0000-0000-0000-000000000001');
-- A reaction in server_1 names the copy's emoji.
INSERT INTO public.reactions (id, message_id, user_id, emoji_id)
VALUES ('f2890000-0000-0000-0000-0000000000c1', '88888888-0000-0000-0000-000000000008',
        '22222222-0000-0000-0000-000000000002', 'f2890000-0000-0000-0000-000000000001');
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
DELETE FROM tests.fed_jobs;

-- Renames. --------------------------------------------------------------------------------------
SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
SET LOCAL request.jwt.claim.role = 'authenticated';
SELECT throws_ok(
    $q$SELECT public.rename_emoji('f2890000-0000-0000-0000-000000000001', 'mine289')$q$,
    '42501', NULL, 'an instance admin cannot rename a copy''s emoji');
SELECT lives_ok(
    $q$SELECT public.rename_emoji('f2890000-0000-0000-0000-000000000002', 'nearer289')$q$,
    'an emoji of a local server is renamed as before');
SELECT throws_ok(
    $q$SELECT public.admin_purge_emoji('f2890000-0000-0000-0000-000000000001')$q$,
    '42501', NULL, 'an instance admin cannot purge a copy''s emoji: the next sync would bring it back');
SELECT lives_ok(
    $q$SELECT public.remove_emoji('f2890000-0000-0000-0000-000000000001')$q$,
    'an instance admin removes it instead');
RESET role;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SET LOCAL request.jwt.claim.role = 'service_role';
SELECT lives_ok(
    $q$UPDATE public.emojis SET name = 'farther289' WHERE id = 'f2890000-0000-0000-0000-000000000001'$q$,
    'the service role renames it');
RESET request.jwt.claims;
RESET request.jwt.claim.role;

-- Deletion. --------------------------------------------------------------------------------------
DELETE FROM public.servers WHERE id = 'f2890000-0000-0000-0000-0000000000a1';
SELECT results_eq(
    $q$SELECT server_id, ap_id, domain, name FROM public.emojis WHERE id = 'f2890000-0000-0000-0000-000000000001'$q$,
    $q$VALUES (NULL::uuid, NULL::text, 'remote.test'::text, 'farther289'::varchar)$q$,
    'a deleted copy''s emoji stays, detached, as an emoji seen in an activity');
SELECT is((SELECT emoji_id FROM public.reactions WHERE id = 'f2890000-0000-0000-0000-0000000000c1'),
    'f2890000-0000-0000-0000-000000000001'::uuid, 'and the reaction naming it keeps it');
DELETE FROM public.servers WHERE id = 'f2890000-0000-0000-0000-0000000000a2';
SELECT is((SELECT count(*) FROM public.emojis WHERE id = 'f2890000-0000-0000-0000-000000000002'), 0::bigint,
    'a local server''s emojis go with it');

-- Cross-server use federates. --------------------------------------------------------------------
UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';
DELETE FROM tests.fed_jobs;
UPDATE public.servers SET allow_cross_server_emojis = false WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT count(*) FROM tests.fed_jobs WHERE name = 'federate-server-update'
            AND data ->> 'server_id' = '55555555-0000-0000-0000-000000000005'), 1::bigint,
    'turning cross-server emojis off queues federate-server-update');
UPDATE public.servers SET description = description WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT count(*) FROM tests.fed_jobs), 1::bigint, 'an update changing nothing a copy shows queues none');

-- Privileges. ------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.detach_copy_emojis()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.detach_copy_emojis()', 'EXECUTE'),
    'clients cannot call detach_copy_emojis');
SELECT ok(NOT has_function_privilege('authenticated', 'public.guard_copy_emoji_write()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.guard_copy_emoji_write()', 'EXECUTE'),
    'clients cannot call guard_copy_emoji_write');

SELECT * FROM finish();
ROLLBACK;
