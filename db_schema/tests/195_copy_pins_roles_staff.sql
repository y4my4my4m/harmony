-- 20261030100001_copy_pins_roles_staff.sql: a local server's pins, roles and role assignments
-- queue their federation jobs, a copy's never; profiles.instance_role holds a remote account's
-- staff role, written by the service role only; a copy's Admin role may go;
-- federation_server_recipients names a server's member instances with their shared inbox.
--
-- Fixture server_1: alice owns it, bob is a member, banned is banned. Added here:
--   remote195    a remote account, member of server_1, shared inbox https://remote.test/inbox
--   gone195      a remote account, member of server_1, suspended
--   copy195      a server reference (is_local_server false) with channel far195 and a message
-- queue_federation_job is replaced for the transaction with a recorder into tests.fed_jobs:
-- pg_notify delivers only at commit and every file rolls back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(29);

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

CREATE OR REPLACE FUNCTION pg_temp.jobs(p_name text) RETURNS bigint
LANGUAGE sql STABLE AS $fn$
  SELECT count(*) FROM tests.fed_jobs WHERE name = p_name;
$fn$;

UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, shared_inbox_url, is_local, is_suspended)
VALUES ('f1950000-0000-0000-0000-0000000000e1', 'remote195', 'Remote 195', 'remote.test',
        'https://remote.test/users/remote195', 'https://remote.test/inbox', false, false),
       ('f1950000-0000-0000-0000-0000000000e2', 'gone195', 'Gone 195', 'gone.test',
        'https://gone.test/users/gone195', 'https://gone.test/inbox', false, true);
INSERT INTO public.user_servers (user_id, server_id, status, member_instance)
VALUES ('f1950000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005', 'accepted', 'remote.test'),
       ('f1950000-0000-0000-0000-0000000000e2', '55555555-0000-0000-0000-000000000005', 'accepted', 'gone.test');

INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id)
VALUES ('f1950000-0000-0000-0000-0000000000a1', 'Copy 195', 'f1950000-0000-0000-0000-0000000000e1', false, true,
        'remote.test', 'https://remote.test/servers/f1950000-0000-0000-0000-0000000000a1');
INSERT INTO public.channels (id, server_id, name, type, is_remote)
VALUES ('f1950000-0000-0000-0000-0000000000c1', 'f1950000-0000-0000-0000-0000000000a1', 'far195', 0, true);
INSERT INTO public.messages (id, channel_id, user_id, content, metadata)
VALUES ('f1950000-0000-0000-0000-000000000001', 'f1950000-0000-0000-0000-0000000000c1',
        'f1950000-0000-0000-0000-0000000000e1', '[{"type":"text","text":"remote"}]',
        '{"federated":true,"ap_id":"https://remote.test/messages/f1950000-0000-0000-0000-000000000001"}');
INSERT INTO public.messages (id, channel_id, content, is_system, metadata)
VALUES ('f1950000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006',
        '[{"type":"text","text":"started a thread"}]', true, '{"type":"thread_created"}');
DELETE FROM tests.fed_jobs;

-- Pins. -------------------------------------------------------------------------------------------
UPDATE public.messages SET is_pinned = true, pinned_at = now(), pinned_by = '11111111-0000-0000-0000-000000000001'
 WHERE id = '88888888-0000-0000-0000-000000000008';
SELECT results_eq(
    $q$SELECT data ->> 'message_id', data ->> 'channel_id', data ->> 'server_id', (data ->> 'pinned')::boolean
         FROM tests.fed_jobs WHERE name = 'federate-channel-pin'$q$,
    $q$VALUES ('88888888-0000-0000-0000-000000000008', '66666666-0000-0000-0000-000000000006',
               '55555555-0000-0000-0000-000000000005', true)$q$,
    'a pin in a local server''s channel queues federate-channel-pin');
UPDATE public.messages SET content = '[{"type":"text","text":"edited"}]' WHERE id = '88888888-0000-0000-0000-000000000008';
SELECT is(pg_temp.jobs('federate-channel-pin'), 1::bigint, 'an edit of a pinned message queues no pin job');
UPDATE public.messages SET is_pinned = false, pinned_at = NULL, pinned_by = NULL WHERE id = '88888888-0000-0000-0000-000000000008';
SELECT is((SELECT (data ->> 'pinned')::boolean FROM tests.fed_jobs WHERE name = 'federate-channel-pin' ORDER BY ctid DESC LIMIT 1),
          false, 'an unpin queues federate-channel-pin with pinned false');

DELETE FROM tests.fed_jobs;
UPDATE public.messages SET is_pinned = true, pinned_at = now() WHERE id = 'f1950000-0000-0000-0000-000000000001';
SELECT is(pg_temp.jobs('federate-channel-pin'), 0::bigint, 'a pin written on a copy queues nothing');
UPDATE public.messages SET is_pinned = true, pinned_at = now() WHERE id = 'f1950000-0000-0000-0000-000000000002';
SELECT is(pg_temp.jobs('federate-channel-pin'), 0::bigint, 'nor a pinned notice that has no Note');
UPDATE public.messages SET is_pinned = true, pinned_at = now() WHERE id = '88888888-0000-0000-0000-000000000008';
DELETE FROM tests.fed_jobs;
UPDATE public.messages SET is_deleted = true WHERE id = '88888888-0000-0000-0000-000000000008';
SELECT is((SELECT is_pinned FROM public.messages WHERE id = '88888888-0000-0000-0000-000000000008'), false,
          'deleting a pinned message unpins it');
SELECT is(pg_temp.jobs('federate-channel-pin'), 0::bigint, 'and queues no pin job: the Delete goes out on its own');
UPDATE public.messages SET is_deleted = false WHERE id = '88888888-0000-0000-0000-000000000008';

UPDATE public.servers SET federation_enabled = false WHERE id = '55555555-0000-0000-0000-000000000005';
DELETE FROM tests.fed_jobs;
UPDATE public.messages SET is_pinned = true, pinned_at = now() WHERE id = '88888888-0000-0000-0000-000000000008';
SELECT is(pg_temp.jobs('federate-channel-pin'), 0::bigint, 'a pin in a server with federation off queues nothing');
UPDATE public.messages SET is_pinned = false, pinned_at = NULL WHERE id = '88888888-0000-0000-0000-000000000008';
UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';

-- Roles. ------------------------------------------------------------------------------------------
DELETE FROM tests.fed_jobs;
INSERT INTO public.server_roles (id, server_id, name, color, position, hoist)
VALUES ('f1950000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005', 'Tester', '#2ecc71', 5, true);
SELECT results_eq(
    $q$SELECT data ->> 'server_id' FROM tests.fed_jobs WHERE name = 'federate-server-update'$q$,
    $q$VALUES ('55555555-0000-0000-0000-000000000005')$q$,
    'a new role queues the Group''s Update');
UPDATE public.server_roles SET color = '#e91e63' WHERE id = 'f1950000-0000-0000-0000-0000000000b1';
SELECT is(pg_temp.jobs('federate-server-update'), 2::bigint, 'a recoloured role queues it');
UPDATE public.server_roles SET permissions = 8 WHERE id = 'f1950000-0000-0000-0000-0000000000b1';
SELECT is(pg_temp.jobs('federate-server-update'), 2::bigint, 'a change of permission bits alone does not: they are not on the wire');
UPDATE public.server_roles SET color = '#123456' WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
SELECT is(pg_temp.jobs('federate-server-update'), 2::bigint, 'nor a change of the default role');

INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1950000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005');
SELECT results_eq(
    $q$SELECT data ->> 'server_id', data ->> 'user_id' FROM tests.fed_jobs WHERE name = 'federate-member-roles'$q$,
    $q$VALUES ('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002')$q$,
    'an assignment queues federate-member-roles for the member');
DELETE FROM public.user_roles
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = 'f1950000-0000-0000-0000-0000000000b1';
SELECT is(pg_temp.jobs('federate-member-roles'), 2::bigint, 'and so does its removal');
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1950000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005');
DELETE FROM tests.fed_jobs;
DELETE FROM public.server_roles WHERE id = 'f1950000-0000-0000-0000-0000000000b1';
SELECT is(pg_temp.jobs('federate-server-update'), 1::bigint, 'a deleted role queues the Group''s Update');
SELECT is(pg_temp.jobs('federate-member-roles'), 0::bigint, 'and its assignments, cascading, queue nothing more');

DELETE FROM tests.fed_jobs;
INSERT INTO public.server_roles (id, server_id, name, position, hoist, ap_id)
VALUES ('f1950000-0000-0000-0000-0000000000b2', 'f1950000-0000-0000-0000-0000000000a1', 'Mirror', 3, true,
        'https://remote.test/servers/f1950000-0000-0000-0000-0000000000a1/roles/f1950000-0000-0000-0000-0000000000b2');
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('f1950000-0000-0000-0000-0000000000e1', 'f1950000-0000-0000-0000-0000000000b2', 'f1950000-0000-0000-0000-0000000000a1');
SELECT is((SELECT count(*) FROM tests.fed_jobs), 0::bigint, 'roles and assignments written on a copy queue nothing');

SELECT lives_ok(
    $q$DELETE FROM public.server_roles WHERE server_id = 'f1950000-0000-0000-0000-0000000000a1' AND is_admin$q$,
    'a copy''s own Admin role may go');
SELECT throws_ok(
    $q$DELETE FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_admin$q$,
    'P0001', 'Cannot delete the Admin role. This role is protected.',
    'a local server''s Admin role stays protected');
SELECT throws_ok(
    $q$DELETE FROM public.server_roles WHERE server_id = 'f1950000-0000-0000-0000-0000000000a1' AND is_default$q$,
    'P0001', 'Cannot delete the @everyone role. This role is protected.',
    'and so does a copy''s default role');

-- Instance staff. ---------------------------------------------------------------------------------
SELECT lives_ok(
    $q$UPDATE public.profiles SET instance_role = 'admin' WHERE id = 'f1950000-0000-0000-0000-0000000000e1'$q$,
    'the service role stores a remote account''s instance role');
SELECT throws_ok(
    $q$UPDATE public.profiles SET instance_role = 'owner' WHERE id = 'f1950000-0000-0000-0000-0000000000e1'$q$,
    '23514', NULL, 'an instance role is admin or moderator');
SELECT throws_ok(
    $q$UPDATE public.profiles SET instance_role = 'admin' WHERE id = '22222222-0000-0000-0000-000000000002'$q$,
    '23514', NULL, 'a local account holds none: is_admin and is_moderator are its');

DELETE FROM tests.fed_jobs;
UPDATE public.profiles SET is_moderator = true WHERE id = '22222222-0000-0000-0000-000000000002';
SELECT is(pg_temp.jobs('federate-profile'), 1::bigint, 'a staff change of a local account federates its actor');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$UPDATE public.profiles SET instance_role = 'admin' WHERE id = '11111111-0000-0000-0000-000000000001'$q$,
    '42501', 'instance_role is set from the account''s own instance',
    'a client cannot name itself staff of an instance');
SELECT lives_ok(
    $q$UPDATE public.profiles SET display_name = 'Alice 195' WHERE id = '11111111-0000-0000-0000-000000000001'$q$,
    'and edits the rest of its profile');
SELECT is(has_function_privilege('authenticated', 'public.federation_server_recipients(uuid)', 'EXECUTE'), false,
          'a client cannot list a server''s member instances');
SELECT tests.clear_authentication();

-- Recipients. Federation off above removed the remote members (20261025100002). ----------------
INSERT INTO public.user_servers (user_id, server_id, status, member_instance)
VALUES ('f1950000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005', 'accepted', 'remote.test'),
       ('f1950000-0000-0000-0000-0000000000e2', '55555555-0000-0000-0000-000000000005', 'accepted', 'gone.test')
ON CONFLICT DO NOTHING;
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, shared_inbox_url, is_local)
VALUES ('f1950000-0000-0000-0000-0000000000e3', 'banned195', 'Banned 195', 'banned.test',
        'https://banned.test/users/banned195', 'https://banned.test/inbox', false);
INSERT INTO public.user_servers (user_id, server_id, status, member_instance)
VALUES ('f1950000-0000-0000-0000-0000000000e3', '55555555-0000-0000-0000-000000000005', 'accepted', 'banned.test');
INSERT INTO public.server_bans (server_id, user_id, banned_by)
VALUES ('55555555-0000-0000-0000-000000000005', 'f1950000-0000-0000-0000-0000000000e3', '11111111-0000-0000-0000-000000000001');

SELECT results_eq(
    $q$SELECT instance, member_ap_ids, member_count, shared_inbox
         FROM public.federation_server_recipients('55555555-0000-0000-0000-000000000005')$q$,
    $q$VALUES ('remote.test'::text, ARRAY['https://remote.test/users/remote195']::text[], 1, 'https://remote.test/inbox'::text)$q$,
    'a server''s member instances, with the inbox their accounts name; no local, suspended or banned account');
UPDATE public.servers SET federation_enabled = false WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT count(*) FROM public.federation_server_recipients('55555555-0000-0000-0000-000000000005')), 0::bigint,
          'a server with federation off names none');

SELECT * FROM finish();
ROLLBACK;
