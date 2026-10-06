-- Daily partitions of realtime.messages, created when Realtime has not.
--
-- realtime.messages is range-partitioned by day on inserted_at with no default partition.
-- A row outside every partition fails, realtime.send reduces the failure to
-- `WARNING ErrorSendingBroadcastMessage`, and the broadcast is lost. Realtime v2.63.0 and
-- v2.76.5 create partitions in two places only: Tenants.Connect when a tenant connects, and
-- Janitor.MaintenanceTask every JANITOR_SCHEDULE_TIMER_IN_MS (4 h) when RUN_JANITOR is
-- set, after its sweep of old partitions succeeds. A tenant connection that stays up while
-- the janitor does not complete creates none: staging lost every broadcast from 2026-08-25
-- until 2026-10-02.
--
-- public.ensure_realtime_partitions mirrors Realtime.Tenants.Migrations.create_partitions:
-- UTC days yesterday through today+3, names realtime.messages_YYYY_MM_DD, bounds
-- ('YYYY-MM-DD') to the next day, the same CREATE TABLE IF NOT EXISTS ... PARTITION OF
-- statement. Deviations:
--   - a name already present is skipped before any DDL, so a run with nothing missing takes
--     no lock and emits nothing; IF NOT EXISTS would emit a NOTICE per day.
--   - lock_timeout bounds the ACCESS EXCLUSIVE lock CREATE TABLE ... PARTITION OF takes on
--     realtime.messages, behind which every realtime.send queues.
--   - a day that fails raises WARNING and the remaining days proceed.
-- Nothing is dropped. Realtime.Messages.delete_old_messages drops children older than 72 h
-- and raises on any child not named messages_YYYY_MM_DD, which also skips the partition
-- creation of that janitor run.
--
-- A partition belongs to the role that creates it. Realtime creates its own as DB_USER,
-- supabase_admin in the Supabase self-host compose; this function creates them as its
-- owner, supabase_admin where migrations are applied as supabase_admin. Owned by postgres,
-- it acts through postgres' membership in supabase_realtime_admin, the owner of
-- realtime.messages, which Realtime grants in 20240401105812.
--
-- Without realtime.messages, or with an unpartitioned one, the function returns 0.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.ensure_realtime_partitions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
    v_parent  regclass := pg_catalog.to_regclass('realtime.messages');
    v_today   date := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
    v_day     date;
    v_name    text;
    v_found   boolean;
    v_child   boolean;
    v_created integer := 0;
BEGIN
    IF v_parent IS NULL
       OR (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = v_parent) <> 'p' THEN
        RETURN 0;
    END IF;

    FOR i IN -1..3 LOOP
        v_day  := v_today + i;
        v_name := 'messages_' || pg_catalog.to_char(v_day::timestamp, 'YYYY_MM_DD');

        SELECT true,
               EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h
                        WHERE h.inhrelid = c.oid AND h.inhparent = v_parent)
          INTO v_found, v_child
          FROM pg_catalog.pg_class c
         WHERE c.relnamespace = (SELECT p.relnamespace FROM pg_catalog.pg_class p
                                  WHERE p.oid = v_parent)
           AND c.relname = v_name;

        IF v_found THEN
            IF NOT v_child THEN
                RAISE WARNING 'realtime.% exists and is not a partition of realtime.messages', v_name;
            END IF;
            CONTINUE;
        END IF;

        BEGIN
            EXECUTE pg_catalog.format(
                'CREATE TABLE IF NOT EXISTS realtime.%I PARTITION OF realtime.messages FOR VALUES FROM (%L) TO (%L)',
                v_name,
                pg_catalog.to_char(v_day::timestamp, 'YYYY-MM-DD'),
                pg_catalog.to_char((v_day + 1)::timestamp, 'YYYY-MM-DD'));
            v_created := v_created + 1;
        EXCEPTION
            WHEN duplicate_table THEN
                NULL;
            WHEN OTHERS THEN
                RAISE WARNING 'realtime.%: % (SQLSTATE %)', v_name, SQLERRM, SQLSTATE;
        END;
    END LOOP;

    RETURN v_created;
END;
$$;

COMMENT ON FUNCTION public.ensure_realtime_partitions() IS
'Creates the missing realtime.messages_YYYY_MM_DD partitions for UTC yesterday through today+3, as Realtime''s create_partitions does. Returns the number created.';

REVOKE ALL ON FUNCTION public.ensure_realtime_partitions() FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
    grantee text;
BEGIN
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.ensure_realtime_partitions() TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;

-- Schedule. The outer $do$ tag keeps the inner command string intact.
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN PERFORM cron.unschedule('realtime-partitions'); EXCEPTION WHEN OTHERS THEN NULL; END;
        PERFORM cron.schedule('realtime-partitions', '5 * * * *', 'SELECT public.ensure_realtime_partitions()');
    ELSE
        RAISE NOTICE 'pg_cron not available: ensure_realtime_partitions is not scheduled';
    END IF;
END
$do$;

DO $$
DECLARE
    v_kind "char" := (SELECT c.relkind FROM pg_class c WHERE c.oid = to_regclass('realtime.messages'));
BEGIN
    IF v_kind IS NULL THEN
        RAISE NOTICE 'realtime.messages absent: no partitions created';
    ELSIF v_kind <> 'p' THEN
        RAISE NOTICE 'realtime.messages not partitioned: no partitions created';
    ELSE
        RAISE NOTICE 'realtime.messages: % partition(s) created', public.ensure_realtime_partitions();
    END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
