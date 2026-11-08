-- Signup review for instance staff, bulk account suspension, a report reason for username hoarding.
--
--   staff_signup_daily(days)
--       One row per UTC day, zero days included: signups, how many are suspended, distinct email
--       domains, the largest domain's count, the busiest clock hour's count, signups refused, and
--       signups past an observing cap (signup_refusal_counts, all reasons).
--   staff_signup_groups(days, min_size)
--       Accounts sharing an email domain, and accounts that joined one server within an hour of
--       signing up. prior_count: for a domain, accounts on it before the window; for a server,
--       members who joined before the window. member_ids holds at most 500.
--   staff_recent_signups(days, search, status, profile_ids, limit, offset)
--       Newest first. Returns the email domain, never the address, and no IP.
--   staff_bulk_suspend_preview(profile_ids, suspended)
--       Per account: why it is skipped, if it is; its owned servers; the follows a suspension
--       removes.
--   staff_bulk_set_suspended(profile_ids, suspended, reason)
--       One transaction. One admin_audit_log row per account, action_type user_suspend or
--       user_unsuspend, as moderate_user, with action_details.bulk and batch_id.
--
--   signup_spike_status(burst, domain_min, domain_share, domain_prior_max, daily, refused)
--       Four rows for a host's watchdog, postgres only, counts only:
--         concentrated  largest count on one email domain in 6 hours, among domains with fewer than
--                       domain_prior_max accounts before those 6 hours; fires at domain_min and
--                       domain_share percent of the window's signups
--         burst         signups in 60 minutes; fires at burst
--         busy_day      signups in the current UTC day; fires at daily
--         refused       signups refused or past an observing cap in the current UTC day; fires at
--                       refused. Refused signups create no account, so the other rules miss them.
--       Defaults from prod's signups: about 5 a day; 56 on varied domains on 2026-11-05, legitimate;
--       74 on 2026-11-08, of which 54 in 2.5 h and 51 on one domain.
--
-- signup_refusal_counts is from 20261109100001. Every other count here is of accounts.
--
-- Admitted: instance admins and moderators that are not suspended (staff_caller). At most 200
-- accounts per call.
-- Skipped: the caller, instance staff, accounts of other instances, accounts without a sign-in,
-- deleted accounts (deleted_at, or a suspension_reason from AdminService's 'delete': 'DELETED: ').
-- Moderators and admins alike: moderate_user remains the path for acting on staff.
--
-- A suspension also deletes the account's auth.sessions rows. enforce_request_assurance answers
-- PT401 session_revoked for a token of a deleted session, so a held token stops at PostgREST.
-- A later unsuspension does not restore sessions. moderate_user leaves sessions in place.
--
-- A local account's suspension federates nothing and changes no owned server:
--   trigger_queue_profile_federation  is_suspended is not among its columns; no job.
--   serveLocalActor, WebFinger        answer as before.
--   handle_remote_user_suspension     runs for local accounts too. Deletes follows with local
--                                     profiles in both directions, voice presence and active
--                                     federated calls. Unsuspension restores none of these.
--   servers                           owner and suspended_at unchanged; members keep the server.
--
-- username_hoarding: category violation. The server Flag carries it as harmony:reason; the account
-- Flag carries no reason. create_federated_server_report before this migration stores an unknown
-- reason as 'other'.
--
-- Converges by state.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Internal
-- ---------------------------------------------------------------------------

-- Why p_profile cannot take the bulk action; null when it can. A row of nulls is a missing account.
CREATE OR REPLACE FUNCTION public.staff_bulk_skip_reason(
    p_caller uuid,
    p_profile public.profiles,
    p_suspended boolean)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN (p_profile).id IS NULL THEN 'not_found'
        WHEN (p_profile).id = p_caller THEN 'self'
        WHEN (p_profile).is_admin IS TRUE OR (p_profile).is_moderator IS TRUE THEN 'staff'
        WHEN (p_profile).is_local IS FALSE THEN 'remote'
        WHEN (p_profile).auth_user_id IS NULL THEN 'no_sign_in'
        WHEN (p_profile).deleted_at IS NOT NULL OR (p_profile).suspension_reason LIKE 'DELETED:%' THEN 'deleted'
        WHEN p_suspended AND (p_profile).is_suspended IS TRUE THEN 'already_suspended'
        WHEN NOT p_suspended AND (p_profile).is_suspended IS NOT TRUE THEN 'not_suspended'
    END;
$$;

CREATE OR REPLACE FUNCTION public.staff_bulk_check_ids(p_profile_ids uuid[])
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_profile_ids IS NULL OR cardinality(p_profile_ids) = 0 THEN
        RAISE EXCEPTION 'BULK_EMPTY: no accounts named' USING ERRCODE = '22023';
    END IF;
    IF cardinality(p_profile_ids) > 200 THEN
        RAISE EXCEPTION 'BULK_LIMIT: at most 200 accounts at a time' USING ERRCODE = '22023';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.signup_review_welcome_server()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT NULLIF(c.config_value #>> '{}', '')::uuid
      FROM public.instance_config c
     WHERE c.config_key = 'welcome_server_id';
$$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.staff_signup_daily(p_days integer DEFAULT 30)
RETURNS TABLE (
    day date,
    signups integer,
    suspended integer,
    email_domains integer,
    top_domain_count integer,
    peak_hour_count integer,
    refused integer,
    would_refuse integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 90);
    v_today date := (now() AT TIME ZONE 'UTC')::date;
    v_from date := v_today - (v_days - 1);
BEGIN
    PERFORM public.staff_caller(NULL);

    RETURN QUERY
    WITH s AS (
        SELECT x.at AT TIME ZONE 'UTC' AS at_utc,
               lower(substring(a.email from '@([^@]+)$')) AS domain,
               p.is_suspended IS TRUE AS is_suspended
          FROM public.profiles p
          JOIN auth.users a ON a.id = p.auth_user_id
          CROSS JOIN LATERAL (SELECT COALESCE(a.created_at, p.created_at) AS at) x
         WHERE p.is_local IS NOT FALSE
           AND x.at >= v_from::timestamp AT TIME ZONE 'UTC'
    ),
    per_day AS (
        SELECT s.at_utc::date AS d,
               count(*)::integer AS signups,
               count(*) FILTER (WHERE s.is_suspended)::integer AS suspended,
               count(DISTINCT s.domain)::integer AS email_domains
          FROM s
         GROUP BY 1
    ),
    top_domain AS (
        SELECT g.d, max(g.n)::integer AS n
          FROM (SELECT s.at_utc::date AS d, count(*) AS n
                  FROM s WHERE s.domain IS NOT NULL GROUP BY 1, s.domain) g
         GROUP BY 1
    ),
    peak_hour AS (
        SELECT g.d, max(g.n)::integer AS n
          FROM (SELECT s.at_utc::date AS d, count(*) AS n
                  FROM s GROUP BY 1, date_trunc('hour', s.at_utc)) g
         GROUP BY 1
    ),
    refusal AS (
        SELECT c.day AS d, sum(c.refusals)::integer AS refused_n, sum(c.would_refuse)::integer AS would_n
          FROM public.signup_refusal_counts c
         WHERE c.day >= v_from
         GROUP BY 1
    )
    SELECT g.d::date,
           COALESCE(pd.signups, 0),
           COALESCE(pd.suspended, 0),
           COALESCE(pd.email_domains, 0),
           COALESCE(td.n, 0),
           COALESCE(ph.n, 0),
           COALESCE(r.refused_n, 0),
           COALESCE(r.would_n, 0)
      FROM generate_series(v_from::timestamp, v_today::timestamp, interval '1 day') AS g(d)
      LEFT JOIN per_day pd ON pd.d = g.d::date
      LEFT JOIN top_domain td ON td.d = g.d::date
      LEFT JOIN peak_hour ph ON ph.d = g.d::date
      LEFT JOIN refusal r ON r.d = g.d::date
     ORDER BY 1 DESC;
END;
$$;

-- The welcome server is left out of first_server: every new account may join it unprompted.
-- Largest size against prior_count first.
CREATE OR REPLACE FUNCTION public.staff_signup_groups(
    p_days integer DEFAULT 7,
    p_min_size integer DEFAULT 3)
RETURNS TABLE (
    kind text,
    key text,
    label text,
    size integer,
    suspended integer,
    prior_count integer,
    first_at timestamptz,
    last_at timestamptz,
    member_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_since timestamptz := now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 90));
    v_min integer := LEAST(GREATEST(COALESCE(p_min_size, 3), 2), 50);
    v_welcome uuid := public.signup_review_welcome_server();
BEGIN
    PERFORM public.staff_caller(NULL);

    RETURN QUERY
    WITH accounts AS MATERIALIZED (
        SELECT p.id,
               COALESCE(a.created_at, p.created_at) AS signed_up,
               lower(substring(a.email from '@([^@]+)$')) AS domain,
               p.is_suspended IS TRUE AS is_suspended
          FROM public.profiles p
          JOIN auth.users a ON a.id = p.auth_user_id
         WHERE p.is_local IS NOT FALSE
    ),
    recent AS MATERIALIZED (
        SELECT * FROM accounts ac WHERE ac.signed_up >= v_since
    ),
    domains AS (
        SELECT 'email_domain'::text AS kind,
               r.domain AS key,
               r.domain AS label,
               count(*)::integer AS size,
               count(*) FILTER (WHERE r.is_suspended)::integer AS suspended,
               (SELECT count(*)::integer FROM accounts ac
                 WHERE ac.domain = r.domain AND ac.signed_up < v_since) AS prior_count,
               min(r.signed_up) AS first_at,
               max(r.signed_up) AS last_at,
               (array_agg(r.id ORDER BY r.signed_up, r.id))[1:500] AS member_ids
          FROM recent r
         WHERE r.domain IS NOT NULL
         GROUP BY r.domain
        HAVING count(*) >= v_min
    ),
    joins AS (
        SELECT us.server_id, r.id, r.signed_up, r.is_suspended
          FROM recent r
          JOIN public.user_servers us
            ON us.user_id = r.id
           AND us.status = 'accepted'
           AND us.created_at < r.signed_up + interval '1 hour'
         WHERE us.server_id IS DISTINCT FROM v_welcome
    ),
    servers AS (
        SELECT 'first_server'::text AS kind,
               j.server_id::text AS key,
               s.name AS label,
               count(*)::integer AS size,
               count(*) FILTER (WHERE j.is_suspended)::integer AS suspended,
               (SELECT count(*)::integer FROM public.user_servers us
                 WHERE us.server_id = j.server_id AND us.status = 'accepted'
                   AND us.created_at < v_since) AS prior_count,
               min(j.signed_up) AS first_at,
               max(j.signed_up) AS last_at,
               (array_agg(j.id ORDER BY j.signed_up, j.id))[1:500] AS member_ids
          FROM joins j
          JOIN public.servers s ON s.id = j.server_id
         GROUP BY j.server_id, s.name
        HAVING count(*) >= v_min
    )
    SELECT g.kind, g.key, g.label, g.size, g.suspended, g.prior_count, g.first_at, g.last_at, g.member_ids
      FROM (SELECT * FROM domains UNION ALL SELECT * FROM servers) g
     ORDER BY g.size::numeric / (g.prior_count + 1) DESC, g.size DESC, g.key;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_recent_signups(
    p_days integer DEFAULT 7,
    p_search text DEFAULT NULL,
    p_status text DEFAULT 'all',
    p_profile_ids uuid[] DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0)
RETURNS TABLE (
    id uuid,
    username text,
    display_name text,
    avatar_url text,
    signed_up_at timestamptz,
    email_domain text,
    email_confirmed boolean,
    last_sign_in_at timestamptz,
    is_staff boolean,
    is_suspended boolean,
    suspended_at timestamptz,
    suspension_reason text,
    post_count integer,
    message_count integer,
    server_count integer,
    owned_server_count integer,
    first_server_id uuid,
    first_server_name text,
    first_server_after_seconds integer,
    total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_since timestamptz := now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 90));
    v_status text := COALESCE(p_status, 'all');
    v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
    v_pattern text;
    v_welcome uuid := public.signup_review_welcome_server();
BEGIN
    PERFORM public.staff_caller(NULL);
    IF v_status NOT IN ('all', 'active', 'suspended') THEN
        RAISE EXCEPTION 'Invalid status: %', v_status USING ERRCODE = '22023';
    END IF;
    IF v_search IS NOT NULL THEN
        v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    END IF;

    RETURN QUERY
    WITH matched AS (
        SELECT p.id AS pid, a.id AS aid, x.at AS signed_up, count(*) OVER () AS total
          FROM public.profiles p
          JOIN auth.users a ON a.id = p.auth_user_id
          CROSS JOIN LATERAL (SELECT COALESCE(a.created_at, p.created_at) AS at) x
         WHERE p.is_local IS NOT FALSE
           AND x.at >= v_since
           AND (p_profile_ids IS NULL OR p.id = ANY (p_profile_ids))
           AND (v_status = 'all'
                OR (v_status = 'suspended' AND p.is_suspended IS TRUE)
                OR (v_status = 'active' AND p.is_suspended IS NOT TRUE))
           AND (v_search IS NULL
                OR p.username ILIKE v_pattern
                OR p.display_name ILIKE v_pattern
                OR lower(substring(a.email from '@([^@]+)$')) ILIKE v_pattern)
         ORDER BY x.at DESC, p.id
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
        OFFSET GREATEST(COALESCE(p_offset, 0), 0)
    )
    SELECT p.id, p.username, p.display_name, p.avatar_url,
           m.signed_up,
           lower(substring(a.email from '@([^@]+)$')),
           a.confirmed_at IS NOT NULL,
           a.last_sign_in_at,
           (p.is_admin IS TRUE OR p.is_moderator IS TRUE),
           p.is_suspended IS TRUE,
           p.suspended_at,
           p.suspension_reason,
           (SELECT count(*)::integer FROM public.posts po
             WHERE po.author_id = p.id AND po.is_deleted IS NOT TRUE),
           (SELECT count(*)::integer FROM public.messages msg
             WHERE msg.user_id = p.id AND msg.is_deleted IS NOT TRUE AND msg.is_system IS NOT TRUE),
           (SELECT count(*)::integer FROM public.user_servers us
             WHERE us.user_id = p.id AND us.status = 'accepted'),
           (SELECT count(*)::integer FROM public.servers s
             WHERE s.owner = p.id AND s.is_local_server IS NOT FALSE),
           fs.server_id,
           fs.name,
           fs.after_seconds,
           m.total
      FROM matched m
      JOIN public.profiles p ON p.id = m.pid
      JOIN auth.users a ON a.id = m.aid
      LEFT JOIN LATERAL (
          SELECT us.server_id, s.name,
                 GREATEST(EXTRACT(EPOCH FROM us.created_at - m.signed_up), 0)::integer AS after_seconds
            FROM public.user_servers us
            JOIN public.servers s ON s.id = us.server_id
           WHERE us.user_id = p.id
             AND us.status = 'accepted'
             AND us.created_at < m.signed_up + interval '1 hour'
             AND us.server_id IS DISTINCT FROM v_welcome
           ORDER BY us.created_at, us.server_id
           LIMIT 1) fs ON true
     ORDER BY m.signed_up DESC, p.id;
END;
$$;

-- Accounts that can take the action first, then by username.
CREATE OR REPLACE FUNCTION public.staff_bulk_suspend_preview(
    p_profile_ids uuid[],
    p_suspended boolean DEFAULT true)
RETURNS TABLE (
    id uuid,
    username text,
    display_name text,
    avatar_url text,
    skip_reason text,
    post_count integer,
    message_count integer,
    local_follows integer,
    remote_followers integer,
    owned_servers jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.staff_caller(NULL);
BEGIN
    PERFORM public.staff_bulk_check_ids(p_profile_ids);
    IF p_suspended IS NULL THEN
        RAISE EXCEPTION 'p_suspended is required' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH requested AS (
        SELECT DISTINCT u.pid FROM unnest(p_profile_ids) AS u(pid)
    ),
    rows AS (
        SELECT r.pid, p, public.staff_bulk_skip_reason(v_me, p, p_suspended) AS skip
          FROM requested r
          LEFT JOIN public.profiles p ON p.id = r.pid
    )
    SELECT r.pid, (r.p).username, (r.p).display_name, (r.p).avatar_url, r.skip,
           (SELECT count(*)::integer FROM public.posts po
             WHERE po.author_id = r.pid AND po.is_deleted IS NOT TRUE),
           (SELECT count(*)::integer FROM public.messages msg
             WHERE msg.user_id = r.pid AND msg.is_deleted IS NOT TRUE AND msg.is_system IS NOT TRUE),
           (SELECT count(*)::integer FROM public.follows f
              JOIN public.profiles o ON o.id = CASE WHEN f.follower_id = r.pid THEN f.following_id ELSE f.follower_id END
             WHERE (f.follower_id = r.pid OR f.following_id = r.pid) AND o.is_local IS TRUE),
           (SELECT count(*)::integer FROM public.follows f
              JOIN public.profiles o ON o.id = f.follower_id
             WHERE f.following_id = r.pid AND o.is_local IS FALSE),
           COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                          'id', s.id, 'name', s.name, 'suspended', s.suspended_at IS NOT NULL,
                          'member_count', mc.members, 'remote_member_count', mc.remote)
                      ORDER BY mc.members DESC, s.name)
                 FROM public.servers s
                 LEFT JOIN LATERAL (
                     SELECT count(*)::integer AS members,
                            count(*) FILTER (WHERE mp.is_local IS FALSE)::integer AS remote
                       FROM public.user_servers us
                       JOIN public.profiles mp ON mp.id = us.user_id
                      WHERE us.server_id = s.id AND us.status = 'accepted') mc ON true
                WHERE s.owner = r.pid AND s.is_local_server IS NOT FALSE), '[]'::jsonb)
      FROM rows r
     ORDER BY r.skip IS NOT NULL, (r.p).username, r.pid;
END;
$$;

-- ---------------------------------------------------------------------------
-- Action
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.staff_bulk_set_suspended(
    p_profile_ids uuid[],
    p_suspended boolean,
    p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.staff_caller(NULL);
    v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 512), '');
    v_batch uuid := gen_random_uuid();
    v_size integer;
    v_id uuid;
    v_row public.profiles%ROWTYPE;
    v_skip text;
    v_changed jsonb := '[]'::jsonb;
    v_skipped jsonb := '[]'::jsonb;
    v_sessions integer := 0;
    v_count integer;
BEGIN
    PERFORM public.staff_bulk_check_ids(p_profile_ids);
    IF p_suspended IS NULL THEN
        RAISE EXCEPTION 'p_suspended is required' USING ERRCODE = '22023';
    END IF;
    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'REASON_REQUIRED: a reason is required' USING ERRCODE = '22023';
    END IF;

    SELECT count(DISTINCT u.pid)::integer INTO v_size FROM unnest(p_profile_ids) AS u(pid);

    -- Ascending id: two overlapping batches lock in one order.
    FOR v_id IN SELECT DISTINCT u.pid FROM unnest(p_profile_ids) AS u(pid) ORDER BY 1 LOOP
        v_row := NULL;
        SELECT * INTO v_row FROM public.profiles p WHERE p.id = v_id FOR UPDATE;
        v_skip := public.staff_bulk_skip_reason(v_me, v_row, p_suspended);
        IF v_skip IS NOT NULL THEN
            v_skipped := v_skipped || jsonb_build_object('id', v_id, 'username', v_row.username, 'reason', v_skip);
            CONTINUE;
        END IF;

        IF p_suspended THEN
            UPDATE public.profiles p
               SET is_suspended = true, suspended_at = now(), suspension_reason = v_reason
             WHERE p.id = v_id;
            IF to_regclass('auth.sessions') IS NOT NULL THEN
                DELETE FROM auth.sessions s WHERE s.user_id = v_row.auth_user_id;
                GET DIAGNOSTICS v_count = ROW_COUNT;
                v_sessions := v_sessions + v_count;
            END IF;
        ELSE
            UPDATE public.profiles p
               SET is_suspended = false, suspended_at = NULL, suspension_reason = NULL
             WHERE p.id = v_id;
        END IF;

        PERFORM public.log_admin_action(v_me,
            CASE WHEN p_suspended THEN 'user_suspend' ELSE 'user_unsuspend' END,
            'user', v_id::text,
            jsonb_build_object('reason', v_reason, 'username', v_row.username,
                               'bulk', true, 'batch_id', v_batch, 'batch_size', v_size));

        v_changed := v_changed || jsonb_build_object('id', v_id, 'username', v_row.username);
    END LOOP;

    RETURN jsonb_build_object(
        'batch_id', v_batch,
        'suspended', p_suspended,
        'changed', v_changed,
        'skipped', v_skipped,
        'sessions_revoked', v_sessions);
END;
$$;

-- ---------------------------------------------------------------------------
-- Spike status
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.signup_spike_status(
    p_burst integer DEFAULT 12,
    p_domain_min integer DEFAULT 8,
    p_domain_share integer DEFAULT 50,
    p_domain_prior_max integer DEFAULT 5,
    p_daily integer DEFAULT 30,
    p_refused integer DEFAULT 10)
RETURNS TABLE (
    rule text,
    fired boolean,
    signups integer,
    window_signups integer,
    prior_signups integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now timestamptz := now();
    v_since_6h timestamptz := v_now - interval '6 hours';
    v_window integer;
    v_hour integer;
    v_day integer;
    v_top integer := 0;
    v_prior integer := 0;
    v_refused integer := 0;
BEGIN
    SELECT COALESCE(sum(c.refusals + c.would_refuse), 0)::integer INTO v_refused
      FROM public.signup_refusal_counts c
     WHERE c.day = (v_now AT TIME ZONE 'UTC')::date;

    WITH accounts AS MATERIALIZED (
        SELECT COALESCE(a.created_at, p.created_at) AS signed_up,
               lower(substring(a.email from '@([^@]+)$')) AS domain
          FROM public.profiles p
          JOIN auth.users a ON a.id = p.auth_user_id
         WHERE p.is_local IS NOT FALSE
    ),
    per_domain AS (
        SELECT ac.domain,
               count(*) FILTER (WHERE ac.signed_up > v_since_6h)::integer AS recent,
               count(*) FILTER (WHERE ac.signed_up <= v_since_6h)::integer AS prior
          FROM accounts ac
         WHERE ac.domain IS NOT NULL
         GROUP BY ac.domain
    )
    SELECT (SELECT count(*)::integer FROM accounts ac WHERE ac.signed_up > v_since_6h),
           (SELECT count(*)::integer FROM accounts ac WHERE ac.signed_up > v_now - interval '60 minutes'),
           (SELECT count(*)::integer FROM accounts ac
             WHERE ac.signed_up >= (date_trunc('day', v_now AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC'),
           COALESCE(t.recent, 0),
           COALESCE(t.prior, 0)
      INTO v_window, v_hour, v_day, v_top, v_prior
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (
          SELECT d.recent, d.prior FROM per_domain d
           WHERE d.recent > 0 AND d.prior < p_domain_prior_max
           ORDER BY d.recent DESC, d.prior
           LIMIT 1) t ON true;

    RETURN QUERY VALUES
        ('concentrated'::text,
         v_top >= p_domain_min AND v_top * 100 >= p_domain_share * v_window,
         v_top, v_window, v_prior),
        ('burst'::text, v_hour >= p_burst, v_hour, v_hour, NULL::integer),
        ('busy_day'::text, v_day >= p_daily, v_day, v_day, NULL::integer),
        ('refused'::text, v_refused >= p_refused, v_refused, v_refused, NULL::integer);
END;
$$;

-- ---------------------------------------------------------------------------
-- Report reason
-- ---------------------------------------------------------------------------

-- As 20261031200001, with username_hoarding.
CREATE OR REPLACE FUNCTION public.create_report(
    p_report_type text,
    p_reported_user_id uuid DEFAULT NULL,
    p_reported_post_id uuid DEFAULT NULL,
    p_reported_message_id uuid DEFAULT NULL,
    p_reported_server_id uuid DEFAULT NULL,
    p_reason text DEFAULT 'other',
    p_category text DEFAULT NULL,
    p_comment text DEFAULT NULL,
    p_forward boolean DEFAULT false,
    p_evidence_text text DEFAULT NULL,
    p_forward_to_server boolean DEFAULT NULL,
    p_reported_sticker_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_caller_name text;
    v_target uuid := p_reported_user_id;
    v_target_local boolean;
    v_target_domain text;
    v_post_id uuid;
    v_message_id uuid;
    v_server_id uuid;
    v_sticker public.stickers;
    v_sticker_id uuid;
    v_author uuid;
    v_visibility text;
    v_content jsonb;
    v_channel uuid;
    v_conversation uuid;
    v_encrypted boolean := false;
    v_scope uuid;
    v_copy public.servers%ROWTYPE;
    v_to_server boolean := false;
    v_forward boolean;
    v_category text;
    v_snapshot jsonb;
    v_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT p.username INTO v_caller_name
      FROM public.profiles p
     WHERE p.id = v_caller AND NOT COALESCE(p.is_suspended, false);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Suspended accounts cannot report' USING ERRCODE = '42501';
    END IF;

    v_category := COALESCE(p_category,
        CASE p_reason
            WHEN 'spam' THEN 'spam'
            WHEN 'illegal_content' THEN 'legal'
            WHEN 'harassment' THEN 'violation'
            WHEN 'impersonation' THEN 'violation'
            WHEN 'nsfw' THEN 'violation'
            WHEN 'username_hoarding' THEN 'violation'
            ELSE 'other'
        END);
    IF v_category NOT IN ('spam', 'legal', 'violation', 'other') THEN
        RAISE EXCEPTION 'Invalid report category: %', v_category USING ERRCODE = '22023';
    END IF;

    IF p_reported_sticker_id IS NOT NULL AND p_report_type IS DISTINCT FROM 'sticker' THEN
        RAISE EXCEPTION 'Only a sticker report names a sticker' USING ERRCODE = '22023';
    END IF;

    IF p_report_type = 'post' THEN
        IF p_reported_post_id IS NULL OR p_reported_message_id IS NOT NULL THEN
            RAISE EXCEPTION 'A post report names one post' USING ERRCODE = '22023';
        END IF;
        SELECT po.author_id, po.visibility, po.content
          INTO v_author, v_visibility, v_content
          FROM public.posts po
         WHERE po.id = p_reported_post_id
           AND NOT COALESCE(po.is_deleted, false);
        IF NOT FOUND OR (
            v_author <> v_caller
            AND NOT (
                v_visibility IN ('public', 'unlisted')
                OR (v_visibility = 'followers' AND EXISTS (
                        SELECT 1 FROM public.follows f
                         WHERE f.follower_id = v_caller AND f.following_id = v_author
                           AND f.status = 'accepted'))
                OR EXISTS (SELECT 1 FROM public.timeline_entries te
                            WHERE te.user_id = v_caller AND te.post_id = p_reported_post_id)
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_content) part
                            WHERE part->>'type' = 'mention'
                              AND (part->>'userId' = v_caller::text
                                   OR part->>'user_id' = v_caller::text
                                   OR lower(part->>'username') = lower(v_caller_name)))
            )
        ) THEN
            RAISE EXCEPTION 'Post not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_target IS NOT NULL AND v_target <> v_author THEN
            RAISE EXCEPTION 'Reported account is not the post author' USING ERRCODE = '22023';
        END IF;
        v_target := v_author;
        v_post_id := p_reported_post_id;

    ELSIF p_report_type = 'message' THEN
        IF p_reported_message_id IS NULL OR p_reported_post_id IS NOT NULL THEN
            RAISE EXCEPTION 'A message report names one message' USING ERRCODE = '22023';
        END IF;
        SELECT m.user_id, m.channel_id, m.conversation_id, COALESCE(m.encrypted, false)
          INTO v_author, v_channel, v_conversation, v_encrypted
          FROM public.messages m
         WHERE m.id = p_reported_message_id
           AND NOT COALESCE(m.is_deleted, false);
        IF NOT FOUND OR NOT (
            (v_channel IS NOT NULL AND public.can_view_channel(v_caller, v_channel))
            OR (v_conversation IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = v_conversation AND cp.user_id = v_caller))
        ) THEN
            RAISE EXCEPTION 'Message not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_target IS NOT NULL AND v_target IS DISTINCT FROM v_author THEN
            RAISE EXCEPTION 'Reported account is not the message author' USING ERRCODE = '22023';
        END IF;
        v_target := v_author;
        v_message_id := p_reported_message_id;
        IF v_channel IS NOT NULL THEN
            SELECT s.id INTO v_scope
              FROM public.channels c
              JOIN public.servers s ON s.id = c.server_id
             WHERE c.id = v_channel AND COALESCE(s.is_local_server, true);
            SELECT s.* INTO v_copy
              FROM public.channels c
              JOIN public.servers s ON s.id = c.server_id
             WHERE c.id = v_channel AND s.is_local_server IS FALSE AND s.ap_id IS NOT NULL;
            v_to_server := v_copy.id IS NOT NULL AND COALESCE(p_forward_to_server, true);
        END IF;

    ELSIF p_report_type = 'user' THEN
        IF v_target IS NULL OR p_reported_post_id IS NOT NULL OR p_reported_message_id IS NOT NULL THEN
            RAISE EXCEPTION 'A user report names one account' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_target) THEN
            RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0002';
        END IF;

    ELSIF p_report_type = 'server' THEN
        IF p_reported_server_id IS NULL OR p_reported_post_id IS NOT NULL OR p_reported_message_id IS NOT NULL THEN
            RAISE EXCEPTION 'A server report names one server' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_reported_server_id) THEN
            RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
        END IF;
        v_server_id := p_reported_server_id;
        v_target := NULL;

    ELSIF p_report_type = 'sticker' THEN
        IF p_reported_sticker_id IS NULL OR p_reported_post_id IS NOT NULL OR p_reported_server_id IS NOT NULL THEN
            RAISE EXCEPTION 'A sticker report names one sticker' USING ERRCODE = '22023';
        END IF;
        SELECT st.* INTO v_sticker FROM public.stickers st WHERE st.id = p_reported_sticker_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Sticker not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_target IS NOT NULL AND v_target IS DISTINCT FROM v_sticker.owner_id THEN
            RAISE EXCEPTION 'Reported account is not the sticker owner' USING ERRCODE = '22023';
        END IF;
        v_target := v_sticker.owner_id;
        v_sticker_id := v_sticker.id;
        -- The message the sticker was seen in: visible to the reporter and, unless encrypted,
        -- carrying this sticker as a part of this instance.
        IF p_reported_message_id IS NOT NULL THEN
            SELECT m.channel_id, m.conversation_id INTO v_channel, v_conversation
              FROM public.messages m
             WHERE m.id = p_reported_message_id
               AND NOT COALESCE(m.is_deleted, false)
               AND (COALESCE(m.encrypted, false) OR EXISTS (
                       SELECT 1 FROM jsonb_array_elements(
                                         CASE WHEN jsonb_typeof(m.content) = 'array' THEN m.content ELSE '[]'::jsonb END) e
                        WHERE e ->> 'type' = 'sticker'
                          AND e ->> 'id' = v_sticker.id::text
                          AND NULLIF(btrim(e ->> 'domain'), '') IS NULL));
            IF NOT FOUND OR NOT (
                (v_channel IS NOT NULL AND public.can_view_channel(v_caller, v_channel))
                OR (v_conversation IS NOT NULL AND EXISTS (
                        SELECT 1 FROM public.conversation_participants cp
                         WHERE cp.conversation_id = v_conversation AND cp.user_id = v_caller))
            ) THEN
                RAISE EXCEPTION 'Message not found' USING ERRCODE = 'P0002';
            END IF;
            v_message_id := p_reported_message_id;
        END IF;

    ELSE
        RAISE EXCEPTION 'Invalid report type: %', p_report_type USING ERRCODE = '22023';
    END IF;

    IF v_target = v_caller THEN
        RAISE EXCEPTION 'Cannot report yourself' USING ERRCODE = '22023';
    END IF;

    SELECT r.id INTO v_id
      FROM public.reports r
     WHERE r.reporter_id = v_caller
       AND r.status IN ('pending', 'investigating')
       AND r.report_type = p_report_type
       AND r.reported_user_id IS NOT DISTINCT FROM v_target
       AND r.reported_post_id IS NOT DISTINCT FROM v_post_id
       AND r.reported_message_id IS NOT DISTINCT FROM v_message_id
       AND r.reported_server_id IS NOT DISTINCT FROM v_server_id
       AND r.reported_sticker_id IS NOT DISTINCT FROM v_sticker_id
     LIMIT 1;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    IF (SELECT count(*) FROM public.reports r
         WHERE r.reporter_id = v_caller AND r.created_at > now() - interval '1 hour') >= 20 THEN
        RAISE EXCEPTION 'Report rate limit exceeded' USING ERRCODE = 'PT429';
    END IF;

    SELECT COALESCE(p.is_local, true), lower(p.domain) INTO v_target_local, v_target_domain
      FROM public.profiles p WHERE p.id = v_target;

    v_forward := COALESCE(p_forward, false) AND v_target_local IS FALSE
                 AND NOT (v_to_server AND v_target_domain IS NOT DISTINCT FROM public.server_host_domain(v_copy));

    v_snapshot := public.report_content_snapshot(
        v_target,
        CASE WHEN v_post_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[v_post_id] END,
        v_message_id,
        v_server_id);
    IF v_encrypted AND NULLIF(btrim(COALESCE(p_evidence_text, '')), '') IS NOT NULL THEN
        v_snapshot := jsonb_set(v_snapshot, '{message}',
            (v_snapshot->'message') || jsonb_build_object(
                'evidence_text', left(p_evidence_text, 4000),
                'evidence_source', 'reporter'));
    END IF;
    IF v_sticker_id IS NOT NULL THEN
        v_snapshot := COALESCE(v_snapshot, '{}'::jsonb) || jsonb_build_object('sticker', jsonb_build_object(
            'id', v_sticker.id,
            'scope', v_sticker.scope,
            'server_id', v_sticker.server_id,
            'server_name', (SELECT s.name FROM public.servers s WHERE s.id = v_sticker.server_id),
            'owner_id', v_sticker.owner_id,
            'uploader', v_sticker.uploader,
            'name', v_sticker.name,
            'description', v_sticker.description,
            'url', v_sticker.url,
            'path', v_sticker.path));
    END IF;

    INSERT INTO public.reports (
        reporter_id, reported_user_id, reported_post_id, reported_message_id, reported_server_id,
        reported_sticker_id, report_type, reason, category, comment, status, source, forward,
        content_snapshot, scope_server_id, forward_to_server)
    VALUES (
        v_caller, v_target, v_post_id, v_message_id, v_server_id,
        v_sticker_id, p_report_type, left(COALESCE(NULLIF(btrim(p_reason), ''), 'other'), 200), v_category,
        NULLIF(left(btrim(COALESCE(p_comment, '')), 1000), ''), 'pending', 'local',
        v_forward, v_snapshot, v_scope, v_to_server)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- As 20261027400001, with username_hoarding.
CREATE OR REPLACE FUNCTION public.create_federated_server_report(
    p_ap_id text,
    p_actor text,
    p_source_domain text,
    p_server_id uuid,
    p_message_id uuid,
    p_comment text DEFAULT NULL,
    p_reason text DEFAULT NULL,
    p_object_uris text[] DEFAULT '{}'::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(COALESCE(p_source_domain, '')));
    v_reason text := CASE WHEN p_reason IN ('spam', 'harassment', 'illegal_content', 'impersonation', 'nsfw', 'username_hoarding', 'other')
                          THEN p_reason ELSE 'other' END;
    v_author uuid;
    v_id uuid;
BEGIN
    IF p_ap_id IS NULL OR v_domain = '' OR p_server_id IS NULL OR p_message_id IS NULL THEN
        RAISE EXCEPTION 'ap_id, source domain, server and message are required' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (SELECT 1 FROM public.federated_instances fi WHERE fi.domain = v_domain AND fi.is_blocked) THEN
        RETURN jsonb_build_object('status', 'blocked');
    END IF;
    IF EXISTS (SELECT 1 FROM public.federated_instances fi WHERE fi.domain = v_domain AND fi.reject_reports) THEN
        RETURN jsonb_build_object('status', 'ignored');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND COALESCE(s.is_local_server, true)) THEN
        RETURN jsonb_build_object('status', 'not_local');
    END IF;

    SELECT m.user_id INTO v_author
      FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
     WHERE m.id = p_message_id
       AND c.server_id = p_server_id
       AND NOT COALESCE(m.is_deleted, false);
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'not_found');
    END IF;

    SELECT r.id INTO v_id
      FROM public.reports r
     WHERE r.ap_id = p_ap_id AND r.source = 'federation' AND r.metadata->>'flag_target' = 'group';
    IF v_id IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'duplicate', 'report_id', v_id);
    END IF;

    IF (SELECT count(*) FROM public.reports r
         WHERE r.source = 'federation'
           AND r.source_instance = v_domain
           AND r.created_at > now() - interval '1 hour') >= 30 THEN
        RETURN jsonb_build_object('status', 'rate_limited');
    END IF;

    INSERT INTO public.reports (
        reporter_id, reported_user_id, reported_message_id, report_type, reason, category, comment,
        status, source, source_instance, ap_id, metadata, forward, content_snapshot, scope_server_id)
    VALUES (
        NULL, v_author, p_message_id, 'message', v_reason,
        CASE v_reason
            WHEN 'spam' THEN 'spam'
            WHEN 'illegal_content' THEN 'legal'
            WHEN 'harassment' THEN 'violation'
            WHEN 'impersonation' THEN 'violation'
            WHEN 'nsfw' THEN 'violation'
            WHEN 'username_hoarding' THEN 'violation'
            ELSE 'other'
        END,
        NULLIF(left(btrim(COALESCE(p_comment, '')), 1000), ''),
        'pending', 'federation', v_domain, p_ap_id,
        jsonb_build_object('actor', p_actor,
                           'flag_target', 'group',
                           'object_uris', to_jsonb(COALESCE(p_object_uris[1:50], '{}'::text[]))),
        false,
        public.report_content_snapshot(v_author, '{}'::uuid[], p_message_id, NULL),
        p_server_id)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT r.id INTO v_id
          FROM public.reports r
         WHERE r.ap_id = p_ap_id AND r.source = 'federation' AND r.metadata->>'flag_target' = 'group';
        RETURN jsonb_build_object('status', 'duplicate', 'report_id', v_id);
    END IF;

    RETURN jsonb_build_object('status', 'created', 'report_id', v_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('staff_signup_daily', 'staff_signup_groups', 'staff_recent_signups',
                             'staff_bulk_suspend_preview', 'staff_bulk_set_suspended')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('staff_bulk_skip_reason', 'staff_bulk_check_ids', 'signup_review_welcome_server')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.signup_spike_status(integer, integer, integer, integer, integer, integer)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.signup_spike_status(integer, integer, integer, integer, integer, integer) TO postgres;

COMMENT ON FUNCTION public.staff_signup_daily(integer) IS
    'Instance staff: signups per UTC day with domain and hourly peaks, refusals and past-cap counts.';
COMMENT ON FUNCTION public.staff_signup_groups(integer, integer) IS
    'Instance staff: recent accounts grouped by email domain and by a server joined within an hour of signup.';
COMMENT ON FUNCTION public.staff_recent_signups(integer, text, text, uuid[], integer, integer) IS
    'Instance staff: recent local accounts with activity counts. Email domain only, no address, no IP.';
COMMENT ON FUNCTION public.signup_spike_status(integer, integer, integer, integer, integer, integer) IS
    'Host watchdog: which signup spike rules fire now. Counts only, no domain and no account.';
COMMENT ON FUNCTION public.staff_bulk_suspend_preview(uuid[], boolean) IS
    'Instance staff: what staff_bulk_set_suspended would do to each named account.';
COMMENT ON FUNCTION public.staff_bulk_set_suspended(uuid[], boolean, text) IS
    'Instance staff: suspend or unsuspend up to 200 local accounts with one reason; never staff.';

COMMIT;

NOTIFY pgrst, 'reload schema';
