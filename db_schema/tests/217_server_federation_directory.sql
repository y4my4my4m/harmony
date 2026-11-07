-- 20261105100001_server_federation_directory.sql: servers.federation_discoverable, written
-- through update_server; the directory federation_server_directory lists local, public,
-- federated, unsuspended servers with the flag on while both instance switches are on;
-- record_instance_directory stores a peer's directory URL on its federated_instances row; a
-- change of the flag queues the Group's Update. The flag's default and its persistence across
-- private and unfederated states are 20261107900001 (244_server_directory_default_on.sql).
--
--   alice    fixture profile (01_fixtures.sql), owner of every server below
--   bob      fixture member of the fixture server without MANAGE_SERVER
-- queue_federation_job is replaced for the transaction: queued jobs land in tests.jobs217.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(22);

CREATE TABLE tests.jobs217 (name text, data jsonb);
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs217 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

DELETE FROM public.instance_config
 WHERE config_key IN ('enable_inbound_federation', 'enable_outbound_federation', 'federation_settings');

SELECT col_not_null('public', 'servers', 'federation_discoverable', 'federation_discoverable is not null');
SELECT is((SELECT count(*)::int FROM public.federation_server_directory() d
            WHERE d.id = '55555555-0000-0000-0000-000000000005'),
  0, 'a private fixture server is not listed');

-- s1 listed, most members; s2 listed; s3 public and federated, not listed; s1-s3 start with the
-- flag off. s4 private, s5 federation off, s6 suspended, s7 a remote copy: the flag on each, none
-- listed.
INSERT INTO public.servers (id, name, owner, public, federation_enabled, federation_discoverable) VALUES
  ('f2170000-0000-0000-0000-0000000000a1', 'Listed Hall', '11111111-0000-0000-0000-000000000001', true, true, false),
  ('f2170000-0000-0000-0000-0000000000a2', 'Listed Den', '11111111-0000-0000-0000-000000000001', true, true, false),
  ('f2170000-0000-0000-0000-0000000000a3', 'Unlisted', '11111111-0000-0000-0000-000000000001', true, true, false);
INSERT INTO public.servers (id, name, owner, public, federation_enabled) VALUES
  ('f2170000-0000-0000-0000-0000000000a4', 'Private', '11111111-0000-0000-0000-000000000001', false, true),
  ('f2170000-0000-0000-0000-0000000000a5', 'Closed', '11111111-0000-0000-0000-000000000001', true, false),
  ('f2170000-0000-0000-0000-0000000000a6', 'Suspended', '11111111-0000-0000-0000-000000000001', true, true);
INSERT INTO public.servers (id, name, public, federation_enabled, is_local_server, ap_id, host_domain) VALUES
  ('f2170000-0000-0000-0000-0000000000a7', 'Copy', true, true, false,
   'https://peer217.test/servers/f2170000-0000-0000-0000-0000000000a7', 'peer217.test');
UPDATE public.servers SET federation_discoverable = true, suspended_at = now()
 WHERE id = 'f2170000-0000-0000-0000-0000000000a6';
UPDATE public.servers SET federation_discoverable = true
 WHERE id IN ('f2170000-0000-0000-0000-0000000000a4', 'f2170000-0000-0000-0000-0000000000a5',
              'f2170000-0000-0000-0000-0000000000a7');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2170000-0000-0000-0000-0000000000a1', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f2170000-0000-0000-0000-0000000000a1', 'accepted'),
  ('33333333-0000-0000-0000-000000000003', 'f2170000-0000-0000-0000-0000000000a1', 'pending'),
  ('33333333-0000-0000-0000-000000000003', 'f2170000-0000-0000-0000-0000000000a2', 'pending')
ON CONFLICT DO NOTHING;
TRUNCATE tests.jobs217;

-- update_server
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.update_server('f2170000-0000-0000-0000-0000000000a1', '{"federation_discoverable": true}') ->> 'federation_discoverable'),
  'true', 'the owner lists a public, federated server');
SELECT lives_ok($$SELECT public.update_server('f2170000-0000-0000-0000-0000000000a2', '{"federation_discoverable": true}')$$,
  'and a second one');
SELECT is((public.update_server('55555555-0000-0000-0000-000000000005', '{"federation_discoverable": false}') ->> 'federation_discoverable'),
  'false', 'a private server takes the flag');
SELECT throws_ok($$SELECT public.update_server('f2170000-0000-0000-0000-0000000000a3', '{"federation_discoverable": "yes"}')$$,
  '22023', NULL, 'the flag is a boolean');
SELECT is((public.update_server('f2170000-0000-0000-0000-0000000000a3', '{"federation_discoverable": true, "public": false}') ->> 'federation_discoverable'),
  'true', 'listing and making private in one change is taken');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM tests.jobs217
            WHERE name = 'federate-server-update'
              AND data ->> 'server_id' IN ('f2170000-0000-0000-0000-0000000000a1', 'f2170000-0000-0000-0000-0000000000a2')),
  2, 'each listing queues the Group''s Update');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.update_server('f2170000-0000-0000-0000-0000000000a1', '{"federation_discoverable": false}')$$,
  '42501', NULL, 'a member without MANAGE_SERVER does not change it');
SELECT tests.clear_authentication();

-- federation_server_directory
SELECT is(ARRAY(SELECT d.id::text FROM public.federation_server_directory() d),
  ARRAY['f2170000-0000-0000-0000-0000000000a1', 'f2170000-0000-0000-0000-0000000000a2'],
  'the directory lists exactly the listed servers, most members first');
SELECT is((SELECT d.member_count FROM public.federation_server_directory() d
            WHERE d.id = 'f2170000-0000-0000-0000-0000000000a1'), 2::bigint,
  'member_count counts accepted memberships');
SELECT is((SELECT d.total_count FROM public.federation_server_directory(1, 0) d), 2::bigint,
  'total_count is the whole listing');
SELECT is(ARRAY(SELECT d.id::text FROM public.federation_server_directory(1, 1) d),
  ARRAY['f2170000-0000-0000-0000-0000000000a2'], 'p_limit and p_offset page it');

INSERT INTO public.instance_config (config_key, config_value) VALUES ('enable_outbound_federation', 'false'::jsonb);
SELECT is((SELECT count(*)::int FROM public.federation_server_directory()), 0,
  'with outbound federation off nothing is listed');
DELETE FROM public.instance_config WHERE config_key = 'enable_outbound_federation';

SELECT ok(NOT has_function_privilege('authenticated', 'public.federation_server_directory(integer, integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.federation_server_directory(integer, integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.federation_server_directory(integer, integer)', 'EXECUTE'),
  'only the service role reads the directory');

-- Making a listed server private or closing its federation unlists it; the flag stays.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.update_server('f2170000-0000-0000-0000-0000000000a2', '{"public": false}');
SELECT public.update_server('f2170000-0000-0000-0000-0000000000a1', '{"federation_enabled": false}');
SELECT tests.clear_authentication();
SELECT is((SELECT array_agg(federation_discoverable ORDER BY id) FROM public.servers
            WHERE id IN ('f2170000-0000-0000-0000-0000000000a1', 'f2170000-0000-0000-0000-0000000000a2')),
  ARRAY[true, true], 'making a listed server private or closing its federation keeps the flag');
SELECT is((SELECT count(*)::int FROM public.federation_server_directory()), 0, 'and nothing is listed');

-- record_instance_directory
INSERT INTO public.federated_instances (domain, metadata) VALUES ('peer217.test', '{"keep": 1}');
SELECT ok(public.record_instance_directory('Peer217.test', 'https://peer217.test/servers/directory'),
  'a known instance''s directory is stored');
SELECT is((SELECT ARRAY[metadata ->> 'server_directory', metadata ->> 'keep', (metadata ? 'directory_checked_at')::text]
             FROM public.federated_instances WHERE domain = 'peer217.test'),
  ARRAY['https://peer217.test/servers/directory', '1', 'true'],
  'under metadata.server_directory, the rest of the metadata kept');
SELECT public.record_instance_directory('peer217.test', NULL);
SELECT is((SELECT (metadata ? 'server_directory') FROM public.federated_instances WHERE domain = 'peer217.test'),
  false, 'an instance that names none has it removed');
SELECT is(public.record_instance_directory('unknown217.test', 'https://unknown217.test/servers/directory'), false,
  'an unknown instance gets no row');
SELECT ok(NOT has_function_privilege('authenticated', 'public.record_instance_directory(text, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.record_instance_directory(text, text)', 'EXECUTE'),
  'only the service role records directories');

SELECT * FROM finish();
ROLLBACK;
