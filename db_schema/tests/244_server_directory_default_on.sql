-- 20261107900001_server_directory_default_on.sql: servers.federation_discoverable is on by
-- default and stays as its owner sets it; the backfill turns it on for every local server once;
-- the directory still lists only local, public, federated, unsuspended servers; a change of the
-- flag is a server.update audit row.
--
--   alice    fixture profile (aaaaaaaa / 11111111), owner of every server below
-- queue_federation_job is replaced for the transaction: queued jobs land in tests.jobs244.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(18);

CREATE TABLE tests.jobs244 (name text, data jsonb);
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs244 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

DELETE FROM public.instance_config
 WHERE config_key IN ('enable_inbound_federation', 'enable_outbound_federation', 'federation_settings');

-- Default
SELECT col_default_is('public', 'servers', 'federation_discoverable', 'true', 'servers are listed by default');

-- n1 public and federated, n2 private, n3 federation off, n4 suspended: created without the flag.
INSERT INTO public.servers (id, name, owner, public, federation_enabled) VALUES
  ('f2440000-0000-0000-0000-0000000000a1', 'New Hall', '11111111-0000-0000-0000-000000000001', true, true),
  ('f2440000-0000-0000-0000-0000000000a2', 'New Private', '11111111-0000-0000-0000-000000000001', false, true),
  ('f2440000-0000-0000-0000-0000000000a3', 'New Closed', '11111111-0000-0000-0000-000000000001', true, false),
  ('f2440000-0000-0000-0000-0000000000a4', 'New Suspended', '11111111-0000-0000-0000-000000000001', true, true);
UPDATE public.servers SET suspended_at = now() WHERE id = 'f2440000-0000-0000-0000-0000000000a4';

SELECT is((SELECT array_agg(federation_discoverable ORDER BY id) FROM public.servers WHERE id::text LIKE 'f2440000-%-0000000000a_'),
  ARRAY[true, true, true, true], 'a new server takes the flag on');
SELECT is(ARRAY(SELECT d.id::text FROM public.federation_server_directory() d WHERE d.id::text LIKE 'f2440000-%'),
  ARRAY['f2440000-0000-0000-0000-0000000000a1'],
  'a new public, federated server is listed; a private, unfederated or suspended one is not');

INSERT INTO public.instance_config (config_key, config_value) VALUES ('enable_inbound_federation', 'false'::jsonb);
SELECT is((SELECT count(*)::int FROM public.federation_server_directory()), 0,
  'with inbound federation off nothing is listed');
DELETE FROM public.instance_config WHERE config_key = 'enable_inbound_federation';

-- The owner's choice stays across private and unfederated states.
TRUNCATE tests.jobs244;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.update_server('f2440000-0000-0000-0000-0000000000a1', '{"public": false}') ->> 'federation_discoverable'),
  'true', 'making a listed server private keeps the flag');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.federation_server_directory() d WHERE d.id = 'f2440000-0000-0000-0000-0000000000a1'), 0,
  'and the server leaves the directory');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.update_server('f2440000-0000-0000-0000-0000000000a1', '{"public": true}');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.federation_server_directory() d WHERE d.id = 'f2440000-0000-0000-0000-0000000000a1'), 1,
  'made public again, it is listed again');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.update_server('f2440000-0000-0000-0000-0000000000a1', '{"federation_discoverable": false}');
SELECT public.update_server('f2440000-0000-0000-0000-0000000000a1', '{"public": false}');
SELECT public.update_server('f2440000-0000-0000-0000-0000000000a1', '{"public": true}');
SELECT public.update_server('f2440000-0000-0000-0000-0000000000a1', '{"federation_enabled": false}');
SELECT public.update_server('f2440000-0000-0000-0000-0000000000a1', '{"federation_enabled": true}');
SELECT tests.clear_authentication();
SELECT is((SELECT federation_discoverable FROM public.servers WHERE id = 'f2440000-0000-0000-0000-0000000000a1'), false,
  'turned off by its owner, the flag stays off through private and unfederated spells');
SELECT is((SELECT count(*)::int FROM public.federation_server_directory() d WHERE d.id = 'f2440000-0000-0000-0000-0000000000a1'), 0,
  'and the server stays out of the directory');

SELECT is((SELECT count(*)::int FROM tests.jobs244
            WHERE name = 'federate-server-update' AND data ->> 'server_id' = 'f2440000-0000-0000-0000-0000000000a1'),
  6, 'each change while federated queues the Group''s Update');

-- Audit
SELECT is((SELECT l.changes -> 'federation_discoverable' FROM public.server_audit_log l
            WHERE l.server_id = 'f2440000-0000-0000-0000-0000000000a1'
              AND l.changes ? 'federation_discoverable'
            ORDER BY l.created_at LIMIT 1),
  '{"old": true, "new": false}'::jsonb, 'turning it off is a server.update audit row');
SELECT is((SELECT l.actor_id::text || '/' || l.source || '/' || l.action FROM public.server_audit_log l
            WHERE l.server_id = 'f2440000-0000-0000-0000-0000000000a1' AND l.changes ? 'federation_discoverable'
            ORDER BY l.created_at LIMIT 1),
  '11111111-0000-0000-0000-000000000001/user/server.update', 'naming the owner who did it');

-- Backfill: the rows as 20261105100001 left them, then the migration's backfill block.
ALTER TABLE public.servers ALTER COLUMN federation_discoverable SET DEFAULT false;
INSERT INTO public.servers (id, name, owner, public, federation_enabled) VALUES
  ('f2440000-0000-0000-0000-0000000000b1', 'Old Hall', '11111111-0000-0000-0000-000000000001', true, true),
  ('f2440000-0000-0000-0000-0000000000b2', 'Old Private', '11111111-0000-0000-0000-000000000001', false, true),
  ('f2440000-0000-0000-0000-0000000000b3', 'Old Closed', '11111111-0000-0000-0000-000000000001', false, false);
INSERT INTO public.servers (id, name, public, federation_enabled, is_local_server, ap_id, host_domain) VALUES
  ('f2440000-0000-0000-0000-0000000000b4', 'Old Copy', true, true, false,
   'https://peer244.test/servers/f2440000-0000-0000-0000-0000000000b4', 'peer244.test');
SELECT is((SELECT count(*)::int FROM public.federation_server_directory() d WHERE d.id::text LIKE 'f2440000-%-0000000000b_'), 0,
  'before the backfill no old server is listed');

\! sed -n '/^-- Backfill$/,/^-- End of backfill\.$/p' /db_schema/migrations/20261107900001_server_directory_default_on.sql > /tmp/upgrade244.sql
\! test -s /tmp/upgrade244.sql || echo 'ERROR: /db_schema/migrations/20261107900001_server_directory_default_on.sql is not in the container; copy db_schema to /db_schema'
\i /tmp/upgrade244.sql

SELECT is((SELECT array_agg(federation_discoverable ORDER BY id) FROM public.servers WHERE id::text LIKE 'f2440000-%-0000000000b_'),
  ARRAY[true, true, true, false], 'the backfill turns the flag on for every local server, not for a copy');
SELECT is(ARRAY(SELECT d.id::text FROM public.federation_server_directory() d WHERE d.id::text LIKE 'f2440000-%-0000000000b_'),
  ARRAY['f2440000-0000-0000-0000-0000000000b1'], 'of them only the public, federated one is listed');
SELECT col_default_is('public', 'servers', 'federation_discoverable', 'true', 'and the default is on');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.update_server('f2440000-0000-0000-0000-0000000000b1', '{"federation_discoverable": false}');
SELECT tests.clear_authentication();
CREATE TEMP TABLE servers244 AS SELECT id, federation_discoverable FROM public.servers;
\i /tmp/upgrade244.sql
SELECT ok(NOT EXISTS (SELECT id, federation_discoverable FROM public.servers EXCEPT SELECT * FROM servers244),
  'a second run changes nothing');
SELECT is((SELECT federation_discoverable FROM public.servers WHERE id = 'f2440000-0000-0000-0000-0000000000b1'), false,
  'an owner''s off after the backfill stays off');

SELECT * FROM finish();
ROLLBACK;
