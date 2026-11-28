-- 20261127100001_copy_welcome_screens.sql: a local federated server's welcome screen changes queue
-- federate-server-update, a copy's never; a copy's screen, as its Group's harmony:welcome stores
-- it, holds the copy's local members to its rules (20261006300001) as a local server's does.
--
-- Fixture server_1: alice owns it, bob is a member. Added here:
--   host406    a remote account, owner of the copy's Group
--   far406     a remote account, member of the copy
--   carol406   joins the copy inside this transaction
--   olga406    joined the copy two days ago, before acceptance was required
--   copy406    a server reference (is_local_server false) with one text channel, chan406
--   quiet406   a local server with federation off
-- queue_federation_job is replaced for the transaction with a recorder into tests.fed_jobs.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(18);

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

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('a4060000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol406@test.local'),
  ('a4060000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'olga406@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f4060000-0000-0000-0000-0000000000c1', 'a4060000-0000-0000-0000-0000000000a1', 'carol406', 'Carol', true),
  ('f4060000-0000-0000-0000-0000000000c2', 'a4060000-0000-0000-0000-0000000000a2', 'olga406', 'Olga', true);
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, is_local) VALUES
  ('f4060000-0000-0000-0000-0000000000e1', 'host406', 'Host', 'remote.test', 'https://remote.test/users/host406', false),
  ('f4060000-0000-0000-0000-0000000000e2', 'far406', 'Far', 'remote.test', 'https://remote.test/users/far406', false);

INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id)
VALUES ('f4060000-0000-0000-0000-0000000000a1', 'Copy 406', 'f4060000-0000-0000-0000-0000000000e1', false, true,
        'remote.test', 'https://remote.test/servers/f4060000-0000-0000-0000-0000000000a1');
INSERT INTO public.channels (id, server_id, name, type, ap_id, is_remote)
VALUES ('f4060000-0000-0000-0000-0000000000b1', 'f4060000-0000-0000-0000-0000000000a1', 'general', 0,
        'https://remote.test/servers/f4060000-0000-0000-0000-0000000000a1/channels/f4060000-0000-0000-0000-0000000000b1', true);
INSERT INTO public.servers (id, name, owner, federation_enabled)
VALUES ('f4060000-0000-0000-0000-0000000000a2', 'Quiet 406', '11111111-0000-0000-0000-000000000001', false);

INSERT INTO public.user_servers (user_id, server_id, status, created_at) VALUES
  ('f4060000-0000-0000-0000-0000000000c1', 'f4060000-0000-0000-0000-0000000000a1', 'accepted', now()),
  ('f4060000-0000-0000-0000-0000000000c2', 'f4060000-0000-0000-0000-0000000000a1', 'accepted', now() - interval '2 days'),
  ('f4060000-0000-0000-0000-0000000000e2', 'f4060000-0000-0000-0000-0000000000a1', 'accepted', now() - interval '2 days');
DELETE FROM tests.fed_jobs;

SELECT has_trigger('public', 'server_welcome_screens', 'z_server_welcome_screens_federation',
    'server_welcome_screens has z_server_welcome_screens_federation');

-- A local federated server. -----------------------------------------------------------------------
INSERT INTO public.server_welcome_screens (server_id, enabled, message, rules, require_acceptance, enabled_at,
                                           acceptance_required_at)
VALUES ('55555555-0000-0000-0000-000000000005', true, 'Hi', '[{"title":"Be kind","description":""}]', false, now(), NULL);
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 1::bigint,
    'a screen set on a local federated server queues federate-server-update');

UPDATE public.server_welcome_screens SET require_acceptance = true, acceptance_required_at = now()
 WHERE server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 2::bigint, 'requiring acceptance queues it');

UPDATE public.server_welcome_screens SET updated_at = now() + interval '1 minute', updated_by = NULL
 WHERE server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 2::bigint, 'a save that changes nothing shown queues nothing');

DELETE FROM public.server_welcome_screens WHERE server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.updates('55555555-0000-0000-0000-000000000005'), 3::bigint, 'removing the screen queues it');

-- Screens that are no local federated server's. ---------------------------------------------------
DELETE FROM tests.fed_jobs;
INSERT INTO public.server_welcome_screens (server_id, enabled, message, rules)
VALUES ('f4060000-0000-0000-0000-0000000000a2', false, '', '[]');
INSERT INTO public.server_welcome_screens (server_id, enabled, message, rules, require_acceptance, enabled_at,
                                           acceptance_required_at)
VALUES ('f4060000-0000-0000-0000-0000000000a1', true, 'Welcome to the copy',
        '[{"title":"Be kind","description":"To everyone."}]', true, now() - interval '1 day', now() - interval '1 day');
SELECT is((SELECT count(*) FROM tests.fed_jobs), 0::bigint,
    'screens of a server with federation off and of a copy queue nothing');

-- The copy's screen. --------------------------------------------------------------------------------
SELECT tests.authenticate_as('a4060000-0000-0000-0000-0000000000a1');
SELECT results_eq(
    $q$SELECT (w ->> 'must_accept')::boolean, (w ->> 'should_show')::boolean, (w ->> 'can_manage')::boolean,
              (w ->> 'is_local')::boolean, jsonb_array_length(w -> 'rules'), w ->> 'message'
         FROM public.get_server_welcome('f4060000-0000-0000-0000-0000000000a1') w$q$,
    $q$VALUES (true, true, false, false, 1, 'Welcome to the copy')$q$,
    'a member who joined the copy after acceptance was required must accept, and is shown the screen');

-- A copy whose Group names no owner.
SELECT tests.clear_authentication();
UPDATE public.servers SET owner = NULL WHERE id = 'f4060000-0000-0000-0000-0000000000a1';
SELECT tests.authenticate_as('a4060000-0000-0000-0000-0000000000a1');
SELECT results_eq(
    $q$SELECT (w ->> 'must_accept')::boolean, (w ->> 'can_manage')::boolean
         FROM public.get_server_welcome('f4060000-0000-0000-0000-0000000000a1') w$q$,
    $q$VALUES (true, false)$q$,
    'with no owner, must accept and cannot manage are still true and false, not null');

SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('f4060000-0000-0000-0000-0000000000b1', 'f4060000-0000-0000-0000-0000000000c1',
               '[{"type":"text","text":"hello"}]')$q$,
    'P0001', 'RULES_NOT_ACCEPTED:f4060000-0000-0000-0000-0000000000a1',
    'until then the copy refuses their messages');

SELECT throws_ok(
    $q$SELECT public.set_server_welcome('f4060000-0000-0000-0000-0000000000a1', false, '', '[]'::jsonb, false)$q$,
    '42501', 'The welcome screen is configured on the server''s home instance',
    'no one here sets a copy''s screen');

SELECT tests.authenticate_as('a4060000-0000-0000-0000-0000000000a2');
SELECT is((SELECT (w ->> 'must_accept')::boolean FROM public.get_server_welcome('f4060000-0000-0000-0000-0000000000a1') w),
    false, 'a member who joined the copy before is grandfathered');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('f4060000-0000-0000-0000-0000000000b1', 'f4060000-0000-0000-0000-0000000000c2',
               '[{"type":"text","text":"from olga"}]')$q$,
    'and posts');

SELECT tests.clear_authentication();
-- pgTAP lives in tests, which service_role cannot use: the insert runs bare, checked after.
SET LOCAL ROLE service_role;
INSERT INTO public.messages (channel_id, user_id, content, metadata)
VALUES ('f4060000-0000-0000-0000-0000000000b1', 'f4060000-0000-0000-0000-0000000000e2',
        '[{"type":"text","text":"relayed"}]',
        '{"ap_id":"https://remote.test/messages/f4060000-0000-0000-0000-0000000000d1"}');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = 'f4060000-0000-0000-0000-0000000000b1'
              AND user_id = 'f4060000-0000-0000-0000-0000000000e2'), 1,
    'a message the Group relays from a member elsewhere is stored: their acceptance is their instance''s');

SELECT tests.authenticate_as('a4060000-0000-0000-0000-0000000000a1');
SELECT results_eq(
    $q$SELECT (w ->> 'must_accept')::boolean, w ->> 'rules_accepted_at' IS NOT NULL
         FROM public.accept_server_rules('f4060000-0000-0000-0000-0000000000a1') w$q$,
    $q$VALUES (false, true)$q$,
    'accepting the copy''s rules records it on the copy');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('f4060000-0000-0000-0000-0000000000b1', 'f4060000-0000-0000-0000-0000000000c1',
               '[{"type":"text","text":"hello again"}]')$q$,
    'then they post');
SELECT tests.clear_authentication();

-- A screen the Group no longer requires. -----------------------------------------------------------
UPDATE public.user_servers SET rules_accepted_at = NULL
 WHERE user_id = 'f4060000-0000-0000-0000-0000000000c1' AND server_id = 'f4060000-0000-0000-0000-0000000000a1';
UPDATE public.server_welcome_screens SET require_acceptance = false, acceptance_required_at = NULL
 WHERE server_id = 'f4060000-0000-0000-0000-0000000000a1';
SELECT tests.authenticate_as('a4060000-0000-0000-0000-0000000000a1');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('f4060000-0000-0000-0000-0000000000b1', 'f4060000-0000-0000-0000-0000000000c1',
               '[{"type":"text","text":"no longer asked"}]')$q$,
    'once the Group stops requiring acceptance, the copy stops asking');
SELECT tests.clear_authentication();

-- Federation trigger lists. ------------------------------------------------------------------------
-- Read, not called: ALTER TABLE refuses a table with pending trigger events from the writes above.
SELECT ok(position('server_welcome_screens DISABLE TRIGGER z_server_welcome_screens_federation'
                   IN pg_get_functiondef('public.disable_federation_triggers()'::regprocedure)) > 0,
    'disable_federation_triggers disables it');
SELECT ok(position('server_welcome_screens ENABLE TRIGGER z_server_welcome_screens_federation'
                   IN pg_get_functiondef('public.enable_federation_triggers()'::regprocedure)) > 0,
    'enable_federation_triggers enables it');

SELECT * FROM finish();
ROLLBACK;
