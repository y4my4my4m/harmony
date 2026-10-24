-- 20261028500001_instance_federation_switches.sql: the instance's switches as the federation
-- backend reads them; both off closes every local server and leaves every copy; one on again
-- reopens what the closing turned off.
--
-- Fixture server_1: alice owns it, bob is a member. Added here:
--   rp193       a profile of remote.test, accepted member of server_1
--   copy193     a server hosted on remote.test (is_local_server false); alice and bob are members

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(22);

DELETE FROM public.instance_config
 WHERE config_key IN ('enable_inbound_federation', 'enable_outbound_federation', 'federation_settings');

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, inbox_url, is_local)
VALUES ('f1930000-0000-0000-0000-0000000000f1', 'rp193', 'Remote 193', 'remote.test',
        'https://remote.test/users/rp193', 'https://remote.test/users/rp193/inbox', false);
UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('f1930000-0000-0000-0000-0000000000f1', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO public.servers (id, name, owner, is_local_server, host_domain, ap_id)
VALUES ('f1930000-0000-0000-0000-0000000000a1', 'Copy 193', 'f1930000-0000-0000-0000-0000000000f1', false,
        'remote.test', 'https://remote.test/servers/f1930000-0000-0000-0000-0000000000a1');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f1930000-0000-0000-0000-0000000000a1', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f1930000-0000-0000-0000-0000000000a1', 'accepted');

CREATE FUNCTION pg_temp.set_flag(p_key text, p_value jsonb) RETURNS void LANGUAGE sql AS $$
    INSERT INTO public.instance_config (config_key, config_value) VALUES (p_key, p_value)
    ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value
$$;
CREATE FUNCTION pg_temp.switches() RETURNS text LANGUAGE sql AS $$
    SELECT s.inbound::text || '/' || s.outbound::text FROM public.instance_federation_switches() s
$$;

-- Privileges. -------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.instance_federation_switches()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.instance_federation_switches()', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.instance_federation_switches()', 'EXECUTE'),
          'the switches are read by the federation backend only');
SELECT ok(NOT has_function_privilege('authenticated', 'public.apply_instance_federation_switches()', 'EXECUTE'),
          'clients cannot run the closing');
SELECT ok(NOT has_table_privilege('authenticated', 'public.instance_federation_closures', 'SELECT'),
          'clients cannot read the closures');

-- Reading. ----------------------------------------------------------------------------------------
SELECT is(pg_temp.switches(), 'true/true', 'with nothing stored both switches are on');
SELECT pg_temp.set_flag('federation_settings', '{"enable_inbound_federation": false}');
SELECT is(pg_temp.switches(), 'false/true', 'federation_settings, as written before 1.9.0, is read');
SELECT pg_temp.set_flag('enable_inbound_federation', '"true"');
SELECT is(pg_temp.switches(), 'true/true', 'the individual key wins, a quoted value included');
SELECT pg_temp.set_flag('enable_outbound_federation', 'false');
SELECT is(pg_temp.switches(), 'true/false', 'outbound off alone');
SELECT is((SELECT federation_enabled FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'),
          true, 'outbound off alone closes nothing');

-- Closing. ----------------------------------------------------------------------------------------
SELECT pg_temp.set_flag('enable_inbound_federation', 'false');
SELECT is(pg_temp.switches(), 'false/false', 'both off');
SELECT is((SELECT federation_enabled FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'),
          false, 'both off turns a local server''s federation off');
SELECT ok(EXISTS (SELECT 1 FROM public.instance_federation_closures
                   WHERE server_id = '55555555-0000-0000-0000-000000000005'),
          'and records that the instance closed it');
SELECT results_eq(
    $q$SELECT reason FROM public.federation_member_removals
        WHERE server_id = '55555555-0000-0000-0000-000000000005'
          AND profile_id = 'f1930000-0000-0000-0000-0000000000f1'$q$,
    $q$VALUES ('federation_closed'::text)$q$,
    'the member from another instance gets the Group''s Remove');
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE user_id = 'f1930000-0000-0000-0000-0000000000f1'),
          0, 'and loses the membership');
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE server_id = 'f1930000-0000-0000-0000-0000000000a1'),
          0, 'every local member leaves the server hosted elsewhere');
SELECT results_eq(
    $q$SELECT profile_id, reason FROM public.instance_server_leaves
        WHERE server_id = 'f1930000-0000-0000-0000-0000000000a1' ORDER BY profile_id$q$,
    $q$VALUES ('11111111-0000-0000-0000-000000000001'::uuid, 'federation_off'::text),
              ('22222222-0000-0000-0000-000000000002'::uuid, 'federation_off'::text)$q$,
    'each with a Leave to send');
SELECT is((SELECT data ->> 'action' FROM public.notifications
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND type = 'server_instance_removed'
            ORDER BY created_at DESC LIMIT 1),
          'federation_off', 'and a notice saying why');

-- The guard. --------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005'$q$,
    '42501', 'INSTANCE_FEDERATION_OFF: federation is off on this instance',
    'the owner cannot turn federation on while the instance is closed');
SELECT tests.clear_authentication();
INSERT INTO public.servers (id, name, owner, federation_enabled)
VALUES ('f1930000-0000-0000-0000-0000000000b1', 'New 193', '11111111-0000-0000-0000-000000000001', true);
SELECT is((SELECT federation_enabled FROM public.servers WHERE id = 'f1930000-0000-0000-0000-0000000000b1'),
          false, 'a server created while closed starts with federation off');
SELECT lives_ok($q$SELECT public.apply_instance_federation_switches()$q$, 'closing again changes nothing');

-- Reopening. --------------------------------------------------------------------------------------
SELECT pg_temp.set_flag('enable_inbound_federation', 'true');
SELECT is((SELECT federation_enabled FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'),
          true, 'one switch on again turns the closed server back on');
SELECT is((SELECT count(*)::int FROM public.instance_federation_closures), 0, 'and forgets the closure');
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE user_id = 'f1930000-0000-0000-0000-0000000000f1'),
          0, 'nobody removed comes back');

SELECT * FROM finish();
ROLLBACK;
