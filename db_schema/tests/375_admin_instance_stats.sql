-- 20261124600003_admin_instance_stats.sql: the admin panel's statistics come from a one-row
-- snapshot that instance staff read and refresh, computed without row-level security.
--
--   alice  instance admin, bob instance moderator, mallory neither
--   e375...  rows of known shape, so the snapshot's changes across a refresh are exact
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(35);

CREATE FUNCTION pg_temp.snap(p_name text) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT current_setting('tests.snap_' || p_name)::jsonb $$;
-- Stores admin_instance_stats(p_refresh) as alice under p_name.
CREATE FUNCTION pg_temp.read_as_admin(p_name text, p_refresh boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
  PERFORM set_config('tests.snap_' || p_name, public.admin_instance_stats(p_refresh)::text, true);
  PERFORM tests.clear_authentication();
END $$;

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
UPDATE public.profiles SET is_moderator = true WHERE id = '22222222-0000-0000-0000-000000000002';

-- Privileges ----------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.admin_instance_stats(boolean)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.admin_instance_stats(boolean)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.admin_instance_stats(boolean)', 'EXECUTE'),
          'admin_instance_stats: authenticated and service_role, not anon');
SELECT ok(NOT has_function_privilege('anon', 'public.refresh_admin_instance_stats(bigint)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.refresh_admin_instance_stats(bigint)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.refresh_admin_instance_stats(bigint)', 'EXECUTE'),
          'refresh_admin_instance_stats: service_role only');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_instance_stats'::regclass)
          AND NOT has_table_privilege('authenticated', 'public.admin_instance_stats', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.admin_instance_stats', 'SELECT'),
          'the snapshot table has row-level security and no client grant');
SELECT ok(to_regprocedure('public.get_db_size()') IS NULL AND to_regprocedure('public.get_db_connection_count()') IS NULL,
          'get_db_size and get_db_connection_count are gone');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
          OR EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'admin-instance-stats'
                        AND schedule = '*/5 * * * *' AND command = 'SELECT public.refresh_admin_instance_stats()'),
          'pg_cron refreshes the snapshot every 5 minutes where it exists');

-- Callers -------------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$ SELECT public.admin_instance_stats() $$, '42501', NULL, 'an account that is not staff is refused');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as_anon();
SELECT throws_ok($$ SELECT public.admin_instance_stats() $$, '42501', NULL, 'anon is refused');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$ SELECT public.refresh_admin_instance_stats() $$, '42501', NULL, 'an admin cannot call the refresh directly');
SELECT tests.clear_authentication();

-- A missing snapshot is computed on read -------------------------------------------------------
DELETE FROM public.admin_instance_stats;
SELECT pg_temp.read_as_admin('a', false);
SELECT ok(pg_temp.snap('a') ->> 'computed_at' IS NOT NULL AND (pg_temp.snap('a') ->> 'age_seconds')::numeric < 60
          AND (pg_temp.snap('a') -> 'refreshing_elsewhere') = 'false',
          'a missing snapshot is computed on read');
SELECT is((SELECT count(*)::int FROM public.admin_instance_stats), 1, 'and stored as the one row');
SELECT ok((pg_temp.snap('a') ->> 'db_connections')::int >= 1 AND (pg_temp.snap('a') ->> 'db_size_bytes')::bigint > 0,
          'an admin reads the live connection count and the database size');
SELECT is((pg_temp.snap('a') ->> 'users_total')::bigint, (SELECT count(*) FROM public.profiles),
          'users_total counts every profile');
SELECT is((pg_temp.snap('a') ->> 'servers_total')::bigint, (SELECT count(*) FROM public.servers),
          'servers_total counts every server, not those the admin is in');
SELECT is((pg_temp.snap('a') ->> 'users_federated')::bigint, (SELECT count(*) FROM public.profiles WHERE is_local IS NOT TRUE),
          'users_federated counts profiles whose is_local is false or null');
SELECT is((pg_temp.snap('a') ->> 'users_suspended')::bigint, (SELECT count(*) FROM public.profiles WHERE is_suspended),
          'users_suspended counts suspended profiles');

-- Known rows ----------------------------------------------------------------------------------
INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, created_at) VALUES
  ('e3750000-0000-0000-0000-000000000001', 'local375', 'L', true, 'localhost', NULL, now()),
  ('e3750000-0000-0000-0000-000000000002', 'remote375a', 'Ra', false, 'r375.test', 'https://r375.test/u/a', now()),
  ('e3750000-0000-0000-0000-000000000003', 'remote375b', 'Rb', false, 'r375.test', 'https://r375.test/u/b', now() - interval '2 days');
UPDATE public.profiles SET is_suspended = true, suspension_reason = '375' WHERE id = 'e3750000-0000-0000-0000-000000000003';

INSERT INTO public.posts (id, author_id, content, is_deleted, created_at) VALUES
  ('e3750000-0000-0000-0000-0000000000a1', 'e3750000-0000-0000-0000-000000000002', '[{"type":"text","text":"a"}]', false, now()),
  ('e3750000-0000-0000-0000-0000000000a2', 'e3750000-0000-0000-0000-000000000002', '[{"type":"text","text":"b"}]', true, now()),
  ('e3750000-0000-0000-0000-0000000000a3', 'e3750000-0000-0000-0000-000000000002', '[{"type":"text","text":"c"}]', false, now() - interval '3 days'),
  ('e3750000-0000-0000-0000-0000000000a4', 'e3750000-0000-0000-0000-000000000002', '[{"type":"text","text":"d"}]', true, now() - interval '3 days');

-- s1 a recent message; s2 a 40-day-old message and a deleted recent one; s3 a recent thread reply
-- under a 40-day-old message.
INSERT INTO public.servers (id, name, owner) VALUES
  ('e3750000-0000-0000-0000-0000000000b1', 's375 active', '11111111-0000-0000-0000-000000000001'),
  ('e3750000-0000-0000-0000-0000000000b2', 's375 idle', '11111111-0000-0000-0000-000000000001'),
  ('e3750000-0000-0000-0000-0000000000b3', 's375 thread', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('e3750000-0000-0000-0000-0000000000c1', 'e3750000-0000-0000-0000-0000000000b1', 'c1', 0),
  ('e3750000-0000-0000-0000-0000000000c2', 'e3750000-0000-0000-0000-0000000000b2', 'c2', 0),
  ('e3750000-0000-0000-0000-0000000000c3', 'e3750000-0000-0000-0000-0000000000b3', 'c3', 0);
INSERT INTO public.messages (id, channel_id, user_id, content, created_at, is_deleted) VALUES
  ('e3750000-0000-0000-0000-0000000000d1', 'e3750000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"x"}]', now() - interval '1 day', false),
  ('e3750000-0000-0000-0000-0000000000d2', 'e3750000-0000-0000-0000-0000000000c2', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"x"}]', now() - interval '40 days', false),
  ('e3750000-0000-0000-0000-0000000000d3', 'e3750000-0000-0000-0000-0000000000c2', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"x"}]', now(), true),
  ('e3750000-0000-0000-0000-0000000000d4', 'e3750000-0000-0000-0000-0000000000c3', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"x"}]', now() - interval '40 days', false);
INSERT INTO public.threads (id, channel_id, parent_message_id, name) VALUES
  ('e3750000-0000-0000-0000-0000000000e3', 'e3750000-0000-0000-0000-0000000000c3', 'e3750000-0000-0000-0000-0000000000d4', 't375');
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content, created_at) VALUES
  ('e3750000-0000-0000-0000-0000000000d5', 'e3750000-0000-0000-0000-0000000000c3', 'e3750000-0000-0000-0000-0000000000e3',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"reply"}]', now() - interval '2 days');

INSERT INTO public.federated_instances (domain, is_blocked, is_trusted, last_seen_at, created_at) VALUES
  ('blocked375.test', true, false, now() - interval '10 days', now() - interval '10 days'),
  ('trusted375.test', false, true, now(), now()),
  ('plain375.test', false, false, now() - interval '3 days', now() - interval '3 days');

INSERT INTO public.federation_delivery_queue (target_inbox_url, target_domain, status) VALUES
  ('https://q375.test/inbox', 'q375.test', 'pending'),
  ('https://q375.test/inbox', 'q375.test', 'pending'),
  ('https://q375.test/inbox', 'q375.test', 'delivered'),
  ('https://q375.test/inbox', 'q375.test', 'failed'),
  ('https://q375.test/inbox', 'q375.test', 'dead');

INSERT INTO public.federation_endpoint_health (endpoint_url, domain, is_dead, consecutive_failures, total_failures, total_successes) VALUES
  ('https://dead375.test/inbox', 'dead375.test', true, 5, 9, 1),
  ('https://ok375.test/inbox', 'ok375.test', false, 0, 2, 10),
  ('https://flaky375.test/inbox', 'flaky375.test', false, 2, 4, 3);

-- Refresh semantics ---------------------------------------------------------------------------
UPDATE public.admin_instance_stats SET computed_at = computed_at - interval '61 seconds';
SELECT pg_temp.read_as_admin('stale_read', false);
SELECT is((pg_temp.snap('stale_read') ->> 'computed_at')::timestamptz,
          (SELECT computed_at FROM public.admin_instance_stats),
          'a read of a 61-second-old snapshot without p_refresh does not recompute');
SELECT is(pg_temp.snap('stale_read') -> 'users_total', pg_temp.snap('a') -> 'users_total',
          'and returns the stored figures');

SELECT pg_temp.read_as_admin('b', true);
SELECT ok((pg_temp.snap('b') ->> 'computed_at')::timestamptz > (pg_temp.snap('a') ->> 'computed_at')::timestamptz,
          'p_refresh recomputes a snapshot older than 60 s');

SELECT is((SELECT jsonb_object_agg(k, (pg_temp.snap('b') ->> k)::bigint - (pg_temp.snap('a') ->> k)::bigint)
             FROM unnest(ARRAY['users_total', 'users_local', 'users_federated', 'users_suspended', 'users_new_24h',
                               'servers_total', 'servers_active_30d',
                               'posts_total', 'posts_24h', 'instances_total', 'instances_blocked', 'instances_trusted',
                               'instances_active_7d', 'instances_new_24h', 'queue_pending', 'queue_delivered',
                               'queue_failed', 'endpoints_total', 'endpoints_dead', 'endpoints_healthy',
                               'endpoints_failing', 'endpoints_failures', 'endpoints_successes']) k),
          '{"users_total": 3, "users_local": 1, "users_federated": 2, "users_suspended": 1, "users_new_24h": 2,
            "servers_total": 3, "servers_active_30d": 2,
            "posts_total": 2, "posts_24h": 1, "instances_total": 3, "instances_blocked": 1, "instances_trusted": 1,
            "instances_active_7d": 2, "instances_new_24h": 1, "queue_pending": 2, "queue_delivered": 1,
            "queue_failed": 1, "endpoints_total": 3, "endpoints_dead": 1, "endpoints_healthy": 1,
            "endpoints_failing": 2, "endpoints_failures": 15, "endpoints_successes": 14}'::jsonb,
          'every figure moves by exactly the known rows');
SELECT is(pg_temp.snap('b') -> 'approximate', '[]'::jsonb, 'small tables are counted exactly');
SELECT ok((pg_temp.snap('b') ->> 'compute_ms')::int >= 0, 'the refresh records its duration');

SELECT pg_temp.read_as_admin('c', true);
SELECT is(pg_temp.snap('c') ->> 'computed_at', pg_temp.snap('b') ->> 'computed_at',
          'p_refresh within 60 s of the last refresh does not recompute');

UPDATE public.admin_instance_stats SET computed_at = computed_at - interval '901 seconds';
SELECT pg_temp.read_as_admin('d', false);
SELECT ok((pg_temp.snap('d') ->> 'computed_at')::timestamptz > (pg_temp.snap('b') ->> 'computed_at')::timestamptz,
          'a read recomputes a snapshot older than 15 minutes');

-- Moderators ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('tests.snap_mod', public.admin_instance_stats()::text, true) IS NOT NULL AS read;
SELECT tests.clear_authentication();
SELECT ok(pg_temp.snap('mod') ?& ARRAY['users_total', 'users_local', 'users_federated', 'users_suspended',
                                        'instances_total', 'endpoints_dead'],
          'a moderator reads the account, instance and endpoint figures');
SELECT ok(NOT (pg_temp.snap('mod') ?| ARRAY['queue_pending', 'queue_delivered', 'queue_failed', 'db_size_bytes', 'db_connections']),
          'but not the delivery queue or the database figures');

-- Service role --------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT set_config('tests.service_refresh', public.refresh_admin_instance_stats()::text, true);
RESET role;
SELECT ok(current_setting('tests.service_refresh')::boolean, 'the service role refreshes');

-- Estimates -----------------------------------------------------------------------------------
ANALYZE public.profiles, public.posts, public.servers, public.federation_delivery_queue;
SELECT ok(public.refresh_admin_instance_stats(0), 'a refresh with a zero exact limit runs');
SELECT is((SELECT approximate FROM public.admin_instance_stats),
          ARRAY['users_total', 'users_local', 'users_federated', 'users_suspended', 'servers_total', 'posts_total',
                'queue_pending', 'queue_delivered', 'queue_failed'],
          'totals over tables above the limit are named approximate');
SELECT ok((SELECT users_total > 0 AND posts_total > 0 AND servers_total > 0 FROM public.admin_instance_stats),
          'and hold the planner''s estimates');
SELECT ok((SELECT users_new_24h = (pg_temp.snap('b') ->> 'users_new_24h')::bigint
                  AND posts_24h = (pg_temp.snap('b') ->> 'posts_24h')::bigint
                  AND servers_active_30d = (pg_temp.snap('b') ->> 'servers_active_30d')::bigint
             FROM public.admin_instance_stats),
          'window counts stay exact');

-- Single flight -------------------------------------------------------------------------------
SELECT ok(EXISTS (SELECT 1 FROM pg_locks l
                   WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.mode = 'ExclusiveLock'
                     AND l.objsubid = 1
                     AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('admin_instance_stats', 0)),
          'a refresh holds the admin_instance_stats advisory lock until its transaction ends');

-- Another session holding the lock makes the refresh answer false; stand in for it.
CREATE OR REPLACE FUNCTION public.refresh_admin_instance_stats(p_exact_limit bigint DEFAULT 2000000)
RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
UPDATE public.admin_instance_stats SET computed_at = computed_at - interval '61 seconds';
SELECT set_config('tests.before_busy', (SELECT computed_at::text FROM public.admin_instance_stats), true);
SELECT pg_temp.read_as_admin('busy', true);
SELECT is(pg_temp.snap('busy') -> 'refreshing_elsewhere', 'true'::jsonb,
          'with the lock busy elsewhere the read says so');
SELECT is((pg_temp.snap('busy') ->> 'computed_at')::timestamptz, current_setting('tests.before_busy')::timestamptz,
          'and returns the stored snapshot');
SELECT ok((pg_temp.snap('busy') ->> 'age_seconds')::numeric >= 61, 'with its age');

DELETE FROM public.admin_instance_stats;
SELECT pg_temp.read_as_admin('busy_empty', false);
SELECT ok(pg_temp.snap('busy_empty') ->> 'computed_at' IS NULL AND pg_temp.snap('busy_empty') ->> 'users_total' IS NULL
          AND (pg_temp.snap('busy_empty') -> 'refreshing_elsewhere') = 'true',
          'with no snapshot and the lock busy the figures are null');

SELECT * FROM finish();
ROLLBACK;
