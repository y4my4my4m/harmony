-- 20261007800001_realtime_partition_fallback.sql: realtime.messages partitions for UTC
-- yesterday through today+3, created as Realtime's create_partitions creates them.
--
-- Partitions the migration built may belong to supabase_admin, which postgres cannot drop,
-- so the scenarios after the first block run against a realtime.messages rebuilt here.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(24);

CREATE TEMP TABLE rt82_days AS
SELECT i, d, 'messages_' || to_char(d::timestamp, 'YYYY_MM_DD') AS relname,
       format('FOR VALUES FROM (%L) TO (%L)', d::timestamp, (d + 1)::timestamp) AS bound
  FROM (SELECT i, (now() AT TIME ZONE 'UTC')::date + i AS d FROM generate_series(-1, 3) i) s;

CREATE TEMP VIEW rt82_parts AS
SELECT c.oid, c.relname, c.relowner, pg_get_expr(c.relpartbound, c.oid) AS bound
  FROM pg_inherits h JOIN pg_class c ON c.oid = h.inhrelid
 WHERE h.inhparent = to_regclass('realtime.messages');

-- Realtime's table shape, no partitions.
CREATE FUNCTION pg_temp.rt82_rebuild() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DROP TABLE IF EXISTS realtime.messages;
    CREATE TABLE realtime.messages (
        topic       text NOT NULL,
        extension   text NOT NULL,
        payload     jsonb,
        event       text,
        private     boolean DEFAULT false,
        updated_at  timestamp NOT NULL DEFAULT now(),
        inserted_at timestamp NOT NULL DEFAULT now(),
        id          uuid NOT NULL DEFAULT gen_random_uuid(),
        PRIMARY KEY (id, inserted_at)
    ) PARTITION BY RANGE (inserted_at);
END;
$$;

CREATE FUNCTION pg_temp.rt82_partition(p_name text, p_from timestamp, p_to timestamp)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('CREATE TABLE realtime.%I PARTITION OF realtime.messages FOR VALUES FROM (%L) TO (%L)',
                   p_name, p_from, p_to);
END;
$$;

-- The function. ---------------------------------------------------------------------------
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
             FROM pg_proc WHERE oid = 'public.ensure_realtime_partitions()'::regprocedure),
  'ensure_realtime_partitions is a definer with a pinned search_path');
SELECT ok(NOT has_function_privilege('anon', 'public.ensure_realtime_partitions()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.ensure_realtime_partitions()', 'EXECUTE')
          AND NOT has_function_privilege('service_role', 'public.ensure_realtime_partitions()', 'EXECUTE'),
  'anon, authenticated and service_role hold no EXECUTE');
SELECT ok(has_function_privilege('postgres', 'public.ensure_realtime_partitions()', 'EXECUTE')
          AND has_function_privilege('supabase_admin', 'public.ensure_realtime_partitions()', 'EXECUTE'),
  'postgres and supabase_admin hold EXECUTE');
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
  THEN is((SELECT count(*)::int FROM cron.job
            WHERE command = 'SELECT public.ensure_realtime_partitions()'), 1,
          'one job runs the fallback')
  ELSE pass('pg_cron absent; the fallback is not scheduled')
END;
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
  THEN ok(EXISTS (SELECT 1 FROM cron.job
                   WHERE jobname = 'realtime-partitions' AND schedule = '5 * * * *'
                     AND command = 'SELECT public.ensure_realtime_partitions()'),
          'it runs hourly as realtime-partitions')
  ELSE pass('pg_cron absent; the fallback is not scheduled')
END;

-- What the migration left. ----------------------------------------------------------------
SELECT is((SELECT relkind::text FROM pg_class WHERE oid = to_regclass('realtime.messages')), 'p',
  'realtime.messages is partitioned, as Realtime creates it');
SELECT set_eq($q$SELECT relname, bound FROM rt82_parts$q$,
              $q$SELECT relname, bound FROM rt82_days$q$,
  'the migration created yesterday through today+3 with day bounds');
SELECT is(public.ensure_realtime_partitions(), 0, 'nothing missing: nothing created');

-- Missing days are created; a present one is left alone. ----------------------------------
SELECT pg_temp.rt82_rebuild();

SELECT realtime.send('{"probe": 1}'::jsonb, 'probe', 'probe:82', true);
SELECT is((SELECT count(*)::int FROM realtime.messages WHERE topic = 'probe:82'), 0,
  'without a partition for today the broadcast is lost');

SELECT pg_temp.rt82_partition(relname, d::timestamp, (d + 1)::timestamp) FROM rt82_days WHERE i = 2;
DO $$
BEGIN
    EXECUTE format('COMMENT ON TABLE realtime.%I IS %L',
                   (SELECT relname FROM rt82_days WHERE i = 2), 'present before the run');
END;
$$;
INSERT INTO realtime.messages (topic, extension, inserted_at)
SELECT 'kept:82', 'broadcast', d + time '12:00' FROM rt82_days WHERE i = 2;
CREATE TEMP TABLE rt82_before AS SELECT oid, relname FROM rt82_parts;

SELECT is(public.ensure_realtime_partitions(), 4, 'the four missing days are created');
SELECT set_eq($q$SELECT relname, bound FROM rt82_parts$q$,
              $q$SELECT relname, bound FROM rt82_days$q$,
  'yesterday through today+3 are partitions with day bounds');
SELECT ok((SELECT p.oid = b.oid AND obj_description(p.oid, 'pg_class') = 'present before the run'
             FROM rt82_parts p JOIN rt82_before b USING (relname)),
  'the partition that existed is the same relation');
SELECT is_empty(
    $q$SELECT relname FROM rt82_parts
        WHERE relname NOT IN (SELECT relname FROM rt82_before)
          AND relowner <> (SELECT proowner FROM pg_proc
                            WHERE oid = 'public.ensure_realtime_partitions()'::regprocedure)$q$,
  'each partition it created belongs to the function owner');
SELECT is((SELECT count(*)::int FROM realtime.messages WHERE topic = 'kept:82'), 1,
  'its rows remain');

SELECT realtime.send('{"probe": 2}'::jsonb, 'probe', 'probe:82', true);
SELECT is((SELECT count(*)::int FROM realtime.messages WHERE topic = 'probe:82'), 1,
  'the broadcast lands once today has a partition');

SELECT is(public.ensure_realtime_partitions(), 0, 'a second run creates nothing');
SELECT is((SELECT count(*)::int FROM rt82_parts), 5, 'five partitions, none duplicated');

-- Days it cannot create. ------------------------------------------------------------------
SELECT pg_temp.rt82_rebuild();
DO $$
BEGIN
    EXECUTE format('CREATE TABLE realtime.%I (id int)', (SELECT relname FROM rt82_days WHERE i = 0));
END;
$$;
SELECT pg_temp.rt82_partition('messages_overlap_82', d + time '12:00', d + 1 + time '12:00')
  FROM rt82_days WHERE i = 1;

SELECT is(public.ensure_realtime_partitions(), 2,
  'a taken name and two overlapped days are skipped, the other two days created');
SELECT set_eq($q$SELECT relname FROM rt82_parts$q$,
              $q$SELECT relname FROM rt82_days WHERE i IN (-1, 3)
                 UNION ALL SELECT 'messages_overlap_82'$q$,
  'yesterday and today+3 are created beside the existing partition');
SELECT ok((SELECT c.relkind = 'r' AND NOT c.relispartition
             FROM pg_class c JOIN rt82_days d ON d.relname = c.relname AND d.i = 0
            WHERE c.relnamespace = 'realtime'::regnamespace),
  'the table holding today''s name is left as it was');

-- Without a partitioned realtime.messages. ------------------------------------------------
DROP TABLE realtime.messages;
SELECT is(public.ensure_realtime_partitions(), 0, 'absent realtime.messages: nothing created');
CREATE TABLE realtime.messages (id int);
SELECT is(public.ensure_realtime_partitions(), 0, 'unpartitioned realtime.messages: nothing created');
SELECT is((SELECT count(*)::int FROM pg_class
            WHERE relnamespace = 'realtime'::regnamespace AND relname LIKE 'messages\_2%'), 1,
  'only the table holding today''s name remains');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.ensure_realtime_partitions()$q$, '42501', NULL,
  'anon cannot run the fallback');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
