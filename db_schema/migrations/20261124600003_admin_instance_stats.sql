-- Instance statistics of the admin panel, from a one-row snapshot.
--
-- Counting each figure per visit is about twelve concurrent PostgREST requests, each an exact count
-- through row-level security (not-deleted posts 1.2-1.3 s each on production, 2026-11-24): enough
-- to hold all ten pool connections, so other requests fail with PGRST003.
--
-- public.admin_instance_stats    The snapshot, one row (id true). No client policy or grant.
-- refresh_admin_instance_stats() Recomputes it without row-level security. Single-flight: false,
--                                nothing computed, while another refresh holds the lock. Service
--                                role only.
-- admin_instance_stats()         Instance staff. Returns the snapshot as one JSON object, refreshing
--                                it first when absent, older than 900 s, or older than 60 s with
--                                p_refresh. Adds age_seconds, refreshing_elsewhere (the lock was
--                                busy), refresh_failed and db_connections (live). A refresh that
--                                raises, or meets the caller's statement_timeout, leaves the stored
--                                snapshot to be returned; with none stored the error is the answer.
--                                Moderators get no queue_* or db_* fields: those were admin-only
--                                before.
-- pg_cron job admin-instance-stats refreshes every 5 minutes where pg_cron exists.
--
-- Cost. Every count over a table that grows with use is an index-only scan or an index range:
--   users_total, _local    one index-only pass of idx_profiles_is_local; is_local is the only
--                          column read, so one statement counts both from the same snapshot
--   users_federated        users_total - users_local: is_local false or null
--   users_suspended        idx_profiles_suspended (20261124600001, partial)
--   users_new_24h          idx_profiles_created_at (20261124600001)
--   posts_total            idx_posts_not_deleted (partial, is_deleted = false)
--   posts_24h              idx_posts_not_deleted, range on created_at
--   servers_active_30d     per channel of each server until one matches: one probe of
--                          idx_messages_channel_created_main; thread replies through
--                          idx_messages_thread_created (one hashed pass, or per thread)
--   queue_*                idx_federation_delivery_queue_status, one range per status
-- A FILTER aggregate naming a column outside one index reads the heap instead: 1.2 s for profiles
-- (is_local and created_at) on production against 23 ms for count(*) alone.
-- federated_instances and federation_endpoint_health hold one row per known remote instance or
-- inbox and are read in one pass each, always exact.
--
-- Estimates. A total over a table whose pg_class.reltuples exceeds p_exact_limit is the planner's row
-- estimate for the same predicate (reltuples scaled to the table's current size, times the
-- predicate's selectivity) and is named in approximate. Counts over the last 24 h and 30 d are
-- index ranges and always exact.
--
-- get_db_size() and get_db_connection_count() are dropped: the admin panel was their only caller.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.admin_instance_stats (
    id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
    computed_at          timestamptz NOT NULL,
    compute_ms           integer NOT NULL,
    users_total          bigint NOT NULL,
    users_local          bigint NOT NULL,
    users_federated      bigint NOT NULL,
    users_suspended      bigint NOT NULL,
    users_new_24h        bigint NOT NULL,
    servers_total        bigint NOT NULL,
    servers_active_30d   bigint NOT NULL,
    posts_total          bigint NOT NULL,
    posts_24h            bigint NOT NULL,
    instances_total      bigint NOT NULL,
    instances_blocked    bigint NOT NULL,
    instances_trusted    bigint NOT NULL,
    instances_active_7d  bigint NOT NULL,
    instances_new_24h    bigint NOT NULL,
    queue_pending        bigint NOT NULL,
    queue_delivered      bigint NOT NULL,
    queue_failed         bigint NOT NULL,
    endpoints_total      bigint NOT NULL,
    endpoints_dead       bigint NOT NULL,
    endpoints_healthy    bigint NOT NULL,
    endpoints_failing    bigint NOT NULL,
    endpoints_failures   bigint NOT NULL,
    endpoints_successes  bigint NOT NULL,
    db_size_bytes        bigint NOT NULL,
    approximate          text[] NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE public.admin_instance_stats IS
    'Snapshot of instance statistics for the admin panel; written by refresh_admin_instance_stats().';
COMMENT ON COLUMN public.admin_instance_stats.computed_at IS 'clock_timestamp() when the refresh began; windows end here.';
COMMENT ON COLUMN public.admin_instance_stats.users_total IS 'Every profile, local and remote.';
COMMENT ON COLUMN public.admin_instance_stats.users_federated IS 'Profiles with is_local false or null: users_total - users_local.';
COMMENT ON COLUMN public.admin_instance_stats.users_new_24h IS 'Profiles, local and remote, created in the 24 h before computed_at.';
COMMENT ON COLUMN public.admin_instance_stats.servers_active_30d IS 'Servers with a channel message, not deleted, in the 30 days before computed_at.';
COMMENT ON COLUMN public.admin_instance_stats.posts_total IS 'Posts with is_deleted false.';
COMMENT ON COLUMN public.admin_instance_stats.instances_active_7d IS 'federated_instances seen in the 7 days before computed_at.';
COMMENT ON COLUMN public.admin_instance_stats.endpoints_healthy IS 'Not dead, consecutive_failures 0.';
COMMENT ON COLUMN public.admin_instance_stats.endpoints_failing IS 'consecutive_failures above 0, dead ones included.';
COMMENT ON COLUMN public.admin_instance_stats.approximate IS 'Columns holding a planner estimate instead of an exact count.';

ALTER TABLE public.admin_instance_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_instance_stats FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_instance_stats TO service_role;

DROP POLICY IF EXISTS admin_instance_stats_service_role ON public.admin_instance_stats;
CREATE POLICY admin_instance_stats_service_role ON public.admin_instance_stats
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Rows of p_table, aliased t, matching p_where: count(*), or with p_estimate the planner's row
-- estimate. Predicates are constants of refresh_admin_instance_stats.
CREATE OR REPLACE FUNCTION harmony_private.stat_count(p_table regclass, p_where text, p_estimate boolean)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_plan json;
    v_n    bigint;
BEGIN
    IF p_estimate THEN
        EXECUTE format('EXPLAIN (FORMAT JSON) SELECT 1 FROM %s t WHERE %s', p_table, p_where) INTO v_plan;
        RETURN round((v_plan -> 0 -> 'Plan' ->> 'Plan Rows')::numeric);
    END IF;
    EXECUTE format('SELECT count(*) FROM %s t WHERE %s', p_table, p_where) INTO v_n;
    RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION harmony_private.stat_count(regclass, text, boolean) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_admin_instance_stats(p_exact_limit bigint DEFAULT 2000000)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
    v_at     timestamptz := clock_timestamp();
    v_day    timestamptz := v_at - interval '24 hours';
    v_week   timestamptz := v_at - interval '7 days';
    v_month  timestamptz := v_at - interval '30 days';
    v_limit  bigint := COALESCE(p_exact_limit, 2000000);
    v_est_profiles boolean;
    v_est_servers  boolean;
    v_est_posts    boolean;
    v_est_queue    boolean;
    s public.admin_instance_stats%ROWTYPE;
BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtextextended('admin_instance_stats', 0)) THEN
        RETURN false;
    END IF;

    SELECT bool_or(c.oid = 'public.profiles'::regclass AND c.reltuples > v_limit),
           bool_or(c.oid = 'public.servers'::regclass AND c.reltuples > v_limit),
           bool_or(c.oid = 'public.posts'::regclass AND c.reltuples > v_limit),
           bool_or(c.oid = 'public.federation_delivery_queue'::regclass AND c.reltuples > v_limit)
      INTO v_est_profiles, v_est_servers, v_est_posts, v_est_queue
      FROM pg_class c
     WHERE c.oid IN ('public.profiles'::regclass, 'public.servers'::regclass, 'public.posts'::regclass,
                     'public.federation_delivery_queue'::regclass);

    s.id := true;
    s.computed_at := v_at;

    IF v_est_profiles THEN
        s.users_total := harmony_private.stat_count('public.profiles', 'true', true);
        s.users_local := harmony_private.stat_count('public.profiles', 't.is_local', true);
    ELSE
        SELECT count(*), count(*) FILTER (WHERE p.is_local)
          INTO s.users_total, s.users_local
          FROM public.profiles p;
    END IF;
    s.users_federated := GREATEST(s.users_total - s.users_local, 0);
    s.users_suspended := harmony_private.stat_count('public.profiles', 't.is_suspended', v_est_profiles);
    SELECT count(*) INTO s.users_new_24h FROM public.profiles p WHERE p.created_at >= v_day;

    s.servers_total := harmony_private.stat_count('public.servers', 'true', v_est_servers);
    SELECT count(*) INTO s.servers_active_30d
      FROM public.servers sv
     WHERE EXISTS (
            SELECT 1
              FROM public.channels c
             WHERE c.server_id = sv.id
               AND (EXISTS (SELECT 1
                              FROM public.messages m
                             WHERE m.channel_id = c.id
                               AND m.thread_id IS NULL
                               AND (m.is_deleted IS NULL OR m.is_deleted = false)
                               AND m.created_at >= v_month)
                    OR EXISTS (SELECT 1
                                 FROM public.threads th
                                 JOIN public.messages m ON m.thread_id = th.id
                                WHERE th.channel_id = c.id
                                  AND m.created_at >= v_month
                                  AND m.is_deleted IS NOT TRUE)));

    s.posts_total := harmony_private.stat_count('public.posts', 't.is_deleted = false', v_est_posts);
    SELECT count(*) INTO s.posts_24h FROM public.posts p WHERE p.is_deleted = false AND p.created_at >= v_day;

    SELECT count(*),
           count(*) FILTER (WHERE fi.is_blocked),
           count(*) FILTER (WHERE fi.is_trusted),
           count(*) FILTER (WHERE fi.last_seen_at >= v_week),
           count(*) FILTER (WHERE fi.created_at >= v_day)
      INTO s.instances_total, s.instances_blocked, s.instances_trusted, s.instances_active_7d, s.instances_new_24h
      FROM public.federated_instances fi;

    s.queue_pending := harmony_private.stat_count('public.federation_delivery_queue', $w$t.status = 'pending'$w$, v_est_queue);
    s.queue_delivered := harmony_private.stat_count('public.federation_delivery_queue', $w$t.status = 'delivered'$w$, v_est_queue);
    s.queue_failed := harmony_private.stat_count('public.federation_delivery_queue', $w$t.status = 'failed'$w$, v_est_queue);

    SELECT count(*),
           count(*) FILTER (WHERE e.is_dead),
           count(*) FILTER (WHERE e.is_dead IS NOT TRUE AND e.consecutive_failures = 0),
           count(*) FILTER (WHERE e.consecutive_failures > 0),
           COALESCE(sum(e.total_failures), 0),
           COALESCE(sum(e.total_successes), 0)
      INTO s.endpoints_total, s.endpoints_dead, s.endpoints_healthy, s.endpoints_failing,
           s.endpoints_failures, s.endpoints_successes
      FROM public.federation_endpoint_health e;

    s.db_size_bytes := pg_database_size(current_database());

    s.approximate := array_remove(ARRAY[
        CASE WHEN v_est_profiles THEN 'users_total' END,
        CASE WHEN v_est_profiles THEN 'users_local' END,
        CASE WHEN v_est_profiles THEN 'users_federated' END,
        CASE WHEN v_est_profiles THEN 'users_suspended' END,
        CASE WHEN v_est_servers THEN 'servers_total' END,
        CASE WHEN v_est_posts THEN 'posts_total' END,
        CASE WHEN v_est_queue THEN 'queue_pending' END,
        CASE WHEN v_est_queue THEN 'queue_delivered' END,
        CASE WHEN v_est_queue THEN 'queue_failed' END
    ], NULL);
    s.compute_ms := ceil(extract(epoch FROM clock_timestamp() - v_at) * 1000);

    -- WHERE id: PostgREST sessions load safeupdate, which refuses a DELETE without a WHERE.
    DELETE FROM public.admin_instance_stats WHERE id;
    INSERT INTO public.admin_instance_stats VALUES (s.*);
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_admin_instance_stats(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_admin_instance_stats(bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_instance_stats(p_refresh boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_admin boolean := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' = 'service_role', false)
                       OR public.is_current_user_admin();
    v_row   public.admin_instance_stats%ROWTYPE;
    v_age   numeric;
    v_busy  boolean := false;
    v_failed boolean := false;
    v_out   jsonb;
BEGIN
    IF NOT v_admin AND NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Permission denied: instance staff required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM public.admin_instance_stats WHERE id;
    v_age := extract(epoch FROM clock_timestamp() - v_row.computed_at);
    IF v_row.id IS NULL OR v_age > 900 OR (p_refresh AND v_age > 60) THEN
        BEGIN
            v_busy := NOT public.refresh_admin_instance_stats();
        -- OTHERS excludes query_canceled, the statement_timeout.
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            IF v_row.id IS NULL THEN
                RAISE;
            END IF;
            v_failed := true;
            RAISE WARNING 'admin_instance_stats: refresh failed: % %', SQLSTATE, SQLERRM;
        END;
        SELECT * INTO v_row FROM public.admin_instance_stats WHERE id;
        v_age := extract(epoch FROM clock_timestamp() - v_row.computed_at);
    END IF;

    v_out := (to_jsonb(v_row) - 'id') || jsonb_build_object(
        'age_seconds', floor(v_age),
        'refreshing_elsewhere', v_busy,
        'refresh_failed', v_failed,
        'db_connections', (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = current_database()));
    IF NOT v_admin THEN
        v_out := v_out - ARRAY['queue_pending', 'queue_delivered', 'queue_failed', 'db_size_bytes', 'db_connections'];
    END IF;
    RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_instance_stats(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_instance_stats(boolean) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_db_size();
DROP FUNCTION IF EXISTS public.get_db_connection_count();

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN PERFORM cron.unschedule('admin-instance-stats'); EXCEPTION WHEN OTHERS THEN NULL; END;
        PERFORM cron.schedule('admin-instance-stats', '*/5 * * * *', 'SELECT public.refresh_admin_instance_stats()');
        RAISE NOTICE 'admin-instance-stats scheduled';
    ELSE
        RAISE NOTICE 'pg_cron not available; admin_instance_stats() refreshes a snapshot older than 15 minutes on read';
    END IF;
END
$do$;

-- As 20261110400001_bot_slash_commands.sql: definers belong to postgres where it exists. The
-- refresh counts every row only as a role that bypasses row-level security.
DO $$
DECLARE
    v_owner text := current_user;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres' AND (rolsuper OR rolbypassrls)) THEN
        v_owner := 'postgres';
    END IF;
    EXECUTE format('ALTER TABLE public.admin_instance_stats OWNER TO %I', v_owner);
    EXECUTE format('ALTER FUNCTION harmony_private.stat_count(regclass, text, boolean) OWNER TO %I', v_owner);
    EXECUTE format('ALTER FUNCTION public.refresh_admin_instance_stats(bigint) OWNER TO %I', v_owner);
    EXECUTE format('ALTER FUNCTION public.admin_instance_stats(boolean) OWNER TO %I', v_owner);
    EXECUTE format('GRANT USAGE ON SCHEMA harmony_private TO %I', v_owner);
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_owner AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'refresh_admin_instance_stats: owner % does not bypass row-level security', v_owner;
    END IF;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
