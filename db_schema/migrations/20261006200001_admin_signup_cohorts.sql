-- get_signup_cohorts: signup-cohort retention for instance admins.
--
-- Cohort. Local profiles with an auth.users row, grouped by the UTC calendar month or ISO week
-- of auth.users.created_at (profiles.created_at where that is null). p_months months of cohorts
-- end with the current one; every period in range is returned, empty ones as zeros. Bots are
-- public.bots rows with no profile or auth user, and their messages carry bot_id with a null
-- user_id, so they are neither cohort members nor answers.
--
-- Wrote. A message with is_system false, or a post with reblog null, at or after signup.
-- Windows from signup: day 1 [0, 1 d), days 1-7 [0, 7 d), days 8-30 [7 d, 30 d), days 31-90
-- [30 d, 90 d). A window counts an account only once it has ended, and *_eligible is that
-- denominator: a cohort still inside a window reports 0 of 0, not a low rate.
--
-- Answered. The account's first message is followed within 1 h or 24 h by a message from
-- another account: top level in the same channel or conversation, in the same thread, or in a
-- thread started on it. Deleted and system messages are not answers. first_message_eligible
-- counts first messages whose 24 h window has ended.
--
-- Current state, not history: an accepted membership of any server and of one the account does
-- not own, a push_subscriptions row of any transport, a follow that is not rejected.
--
-- Cost. messages is read in one hash-joined pass from the first cohort's start, grouped by
-- author; a second pass fetches each author's first message, by idx_messages_created where it
-- exists (fresh installs) and a hashed scan where it does not (production). Answers are LIMIT 1
-- probes on idx_messages_channel_created_main, idx_messages_conversation_created,
-- idx_messages_thread_created and idx_threads_parent_message, present on both; each probe
-- repeats its index predicate. Plans are always custom: a generic plan cannot see the range
-- bound, and with 10,002 accounts and 593k messages, no parallel workers, it ran at a median
-- 510 ms against 400 ms.
--
-- Instance admins and the service role only (42501). Rows are per cohort; no account
-- identifier leaves the function.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname = 'get_signup_cohorts'
    LOOP
        EXECUTE format('DROP FUNCTION %s', fn);
        RAISE NOTICE 'dropped %', fn;
    END LOOP;
END;
$$;

CREATE FUNCTION public.get_signup_cohorts(
    p_months integer DEFAULT 12,
    p_period text DEFAULT 'month'
)
RETURNS TABLE (
    cohort_start date,
    signups integer,
    joined_server integer,
    joined_other_server integer,
    day1_eligible integer,
    wrote_day1 integer,
    days1_7_eligible integer,
    active_days1_7 integer,
    days8_30_eligible integer,
    active_days8_30 integer,
    days31_90_eligible integer,
    active_days31_90 integer,
    first_message_eligible integer,
    answered_1h integer,
    answered_24h integer,
    has_push integer,
    follows_anyone integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
    v_role text := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
    v_now timestamp with time zone := now();
    v_step interval;
    v_first timestamp without time zone;
    v_last timestamp without time zone;
    v_from timestamp with time zone;
BEGIN
    IF v_role IS DISTINCT FROM 'service_role' AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Permission denied: instance admin required' USING ERRCODE = '42501';
    END IF;
    IF p_period IS NULL OR p_period NOT IN ('month', 'week') THEN
        RAISE EXCEPTION 'Invalid period: %', p_period USING ERRCODE = '22023';
    END IF;
    IF p_months IS NULL OR p_months < 1 OR p_months > 60 THEN
        RAISE EXCEPTION 'Invalid range: % months', p_months USING ERRCODE = '22023';
    END IF;

    -- Period starts are UTC wall-clock timestamps.
    v_step := ('1 ' || p_period)::interval;
    v_last := date_trunc(p_period, v_now AT TIME ZONE 'UTC');
    v_first := date_trunc(p_period, (v_now AT TIME ZONE 'UTC') - make_interval(months => p_months) + v_step);
    v_from := v_first AT TIME ZONE 'UTC';

    RETURN QUERY
    -- Inlined at each use: a materialized CTE carries no statistics, and the planner then
    -- hashes messages instead of the cohort.
    WITH cu AS NOT MATERIALIZED (
        SELECT p.id AS uid,
               x.at AS signed_up,
               x.at + interval '1 day' AS b1,
               x.at + interval '7 days' AS b7,
               x.at + interval '30 days' AS b30,
               x.at + interval '90 days' AS b90
          FROM public.profiles p
          JOIN auth.users a ON a.id = p.auth_user_id
          CROSS JOIN LATERAL (SELECT COALESCE(a.created_at, p.created_at) AS at) x
         WHERE COALESCE(p.is_local, true)
           AND (a.created_at >= v_from OR (a.created_at IS NULL AND p.created_at >= v_from))
           AND x.at <= v_now
    ),
    ma AS (
        SELECT m.user_id AS uid,
               min(m.created_at) AS first_at,
               bool_or(m.created_at < cu.b1) AS w_d1,
               bool_or(m.created_at < cu.b7) AS w_d7,
               bool_or(m.created_at >= cu.b7 AND m.created_at < cu.b30) AS w_d30,
               bool_or(m.created_at >= cu.b30 AND m.created_at < cu.b90) AS w_d90
          FROM public.messages m
          JOIN cu ON cu.uid = m.user_id AND m.created_at >= cu.signed_up
         WHERE m.created_at >= v_from
           AND NOT COALESCE(m.is_system, false)
         GROUP BY m.user_id
    ),
    pa AS (
        SELECT po.author_id AS uid,
               bool_or(po.created_at < cu.b1) AS w_d1,
               bool_or(po.created_at < cu.b7) AS w_d7,
               bool_or(po.created_at >= cu.b7 AND po.created_at < cu.b30) AS w_d30,
               bool_or(po.created_at >= cu.b30 AND po.created_at < cu.b90) AS w_d90
          FROM public.posts po
          JOIN cu ON cu.uid = po.author_id AND po.created_at >= cu.signed_up
         WHERE po.created_at >= v_from
           AND po.reblog IS NULL
         GROUP BY po.author_id
    ),
    -- IN makes ma the hashed side; as a plain join the planner hashed messages, ma carrying no
    -- statistics. DISTINCT ON breaks created_at ties between an author's first messages.
    fm AS (
        SELECT DISTINCT ON (m.user_id)
               m.user_id AS uid,
               m.id AS mid,
               m.channel_id AS ch,
               m.conversation_id AS cv,
               m.thread_id AS th,
               m.created_at AS at
          FROM public.messages m
         WHERE (m.user_id, m.created_at) IN (
                   SELECT ma.uid, ma.first_at FROM ma
                    WHERE ma.first_at <= v_now - interval '24 hours')
           AND m.created_at >= v_from
           AND NOT COALESCE(m.is_system, false)
         ORDER BY m.user_id, m.id
    ),
    ans AS (
        SELECT fm.uid,
               LEAST(c.at, d.at, t.at, s.at) - fm.at AS delay
          FROM fm
          LEFT JOIN LATERAL (
              SELECT r.created_at AS at
                FROM public.messages r
               WHERE fm.th IS NULL
                 AND r.channel_id = fm.ch
                 AND r.thread_id IS NULL
                 AND (r.is_deleted IS NULL OR r.is_deleted = false)
                 AND r.created_at > fm.at
                 AND r.created_at < fm.at + interval '24 hours'
                 AND r.user_id <> fm.uid
                 AND NOT COALESCE(r.is_system, false)
               ORDER BY r.created_at
               LIMIT 1
          ) c ON true
          LEFT JOIN LATERAL (
              SELECT r.created_at AS at
                FROM public.messages r
               WHERE fm.th IS NULL
                 AND r.conversation_id = fm.cv
                 AND r.conversation_id IS NOT NULL
                 AND r.thread_id IS NULL
                 AND (r.is_deleted IS NULL OR r.is_deleted = false)
                 AND r.created_at > fm.at
                 AND r.created_at < fm.at + interval '24 hours'
                 AND r.user_id <> fm.uid
                 AND NOT COALESCE(r.is_system, false)
               ORDER BY r.created_at
               LIMIT 1
          ) d ON true
          LEFT JOIN LATERAL (
              SELECT r.created_at AS at
                FROM public.messages r
               WHERE r.thread_id = fm.th
                 AND r.thread_id IS NOT NULL
                 AND r.created_at > fm.at
                 AND r.created_at < fm.at + interval '24 hours'
                 AND r.user_id <> fm.uid
                 AND NOT COALESCE(r.is_system, false)
                 AND (r.is_deleted IS NULL OR r.is_deleted = false)
               ORDER BY r.created_at
               LIMIT 1
          ) t ON true
          LEFT JOIN LATERAL (
              SELECT r.created_at AS at
                FROM public.threads tr
                JOIN public.messages r ON r.thread_id = tr.id
               WHERE tr.parent_message_id = fm.mid
                 AND r.thread_id IS NOT NULL
                 AND r.created_at > fm.at
                 AND r.created_at < fm.at + interval '24 hours'
                 AND r.user_id <> fm.uid
                 AND NOT COALESCE(r.is_system, false)
                 AND (r.is_deleted IS NULL OR r.is_deleted = false)
               ORDER BY r.created_at
               LIMIT 1
          ) s ON true
    ),
    sv AS (
        SELECT us.user_id AS uid,
               bool_or(s.owner IS DISTINCT FROM us.user_id) AS other
          FROM public.user_servers us
          JOIN cu ON cu.uid = us.user_id
          JOIN public.servers s ON s.id = us.server_id
         WHERE us.status = 'accepted'
         GROUP BY us.user_id
    ),
    ps AS (
        SELECT DISTINCT x.user_id AS uid
          FROM public.push_subscriptions x
          JOIN cu ON cu.uid = x.user_id
    ),
    fo AS (
        SELECT DISTINCT f.follower_id AS uid
          FROM public.follows f
          JOIN cu ON cu.uid = f.follower_id
         WHERE f.status IS DISTINCT FROM 'rejected'
    ),
    pu AS (
        SELECT date_trunc(p_period, cu.signed_up AT TIME ZONE 'UTC') AS period,
               cu.b1 <= v_now AS e_d1,
               cu.b7 <= v_now AS e_d7,
               cu.b30 <= v_now AS e_d30,
               cu.b90 <= v_now AS e_d90,
               COALESCE(ma.w_d1, false) OR COALESCE(pa.w_d1, false) AS x_d1,
               COALESCE(ma.w_d7, false) OR COALESCE(pa.w_d7, false) AS x_d7,
               COALESCE(ma.w_d30, false) OR COALESCE(pa.w_d30, false) AS x_d30,
               COALESCE(ma.w_d90, false) OR COALESCE(pa.w_d90, false) AS x_d90,
               fm.uid IS NOT NULL AS x_first,
               COALESCE(ans.delay < interval '1 hour', false) AS x_1h,
               COALESCE(ans.delay < interval '24 hours', false) AS x_24h,
               sv.uid IS NOT NULL AS x_srv,
               COALESCE(sv.other, false) AS x_other,
               ps.uid IS NOT NULL AS x_push,
               fo.uid IS NOT NULL AS x_follow
          FROM cu
          LEFT JOIN ma ON ma.uid = cu.uid
          LEFT JOIN pa ON pa.uid = cu.uid
          LEFT JOIN fm ON fm.uid = cu.uid
          LEFT JOIN ans ON ans.uid = cu.uid
          LEFT JOIN sv ON sv.uid = cu.uid
          LEFT JOIN ps ON ps.uid = cu.uid
          LEFT JOIN fo ON fo.uid = cu.uid
    )
    SELECT g.period::date,
           count(pu.period)::integer,
           count(*) FILTER (WHERE pu.x_srv)::integer,
           count(*) FILTER (WHERE pu.x_other)::integer,
           count(*) FILTER (WHERE pu.e_d1)::integer,
           count(*) FILTER (WHERE pu.e_d1 AND pu.x_d1)::integer,
           count(*) FILTER (WHERE pu.e_d7)::integer,
           count(*) FILTER (WHERE pu.e_d7 AND pu.x_d7)::integer,
           count(*) FILTER (WHERE pu.e_d30)::integer,
           count(*) FILTER (WHERE pu.e_d30 AND pu.x_d30)::integer,
           count(*) FILTER (WHERE pu.e_d90)::integer,
           count(*) FILTER (WHERE pu.e_d90 AND pu.x_d90)::integer,
           count(*) FILTER (WHERE pu.x_first)::integer,
           count(*) FILTER (WHERE pu.x_first AND pu.x_1h)::integer,
           count(*) FILTER (WHERE pu.x_first AND pu.x_24h)::integer,
           count(*) FILTER (WHERE pu.x_push)::integer,
           count(*) FILTER (WHERE pu.x_follow)::integer
      FROM generate_series(v_first, v_last, v_step) AS g(period)
      LEFT JOIN pu ON pu.period = g.period
     GROUP BY g.period
     ORDER BY g.period;
END;
$$;

REVOKE ALL ON FUNCTION public.get_signup_cohorts(integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_signup_cohorts(integer, text) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
