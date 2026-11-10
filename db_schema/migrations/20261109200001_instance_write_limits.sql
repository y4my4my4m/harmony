-- Instance limits on what one local account creates and how fast it writes.
--
-- Counts, instance_config scalars, 0 is no limit:
--   max_servers_per_user   100  local servers an account owns
--   max_bots_per_user       25  bots an account owns, except integration bots (channel webhooks, capped
--                               per channel and server) and bridge bots linked to discord_bridges
--                               (one per server)
--
-- Rates, keys of instance_config 'antispam', 0 is off. Rolling windows over automod_recent_activity:
--   account_messages_per_minute         120
--   account_posts_per_hour              100  boosts are not counted
--   account_reactions_per_minute        240  message reactions, post reactions, favourites
--   account_follows_per_hour            200
--   account_joins_per_hour               60  joins by the account itself
--   account_servers_per_hour             10
--   account_stranger_dms_per_hour        30
--   new_account_stranger_dms_per_hour     5  accounts younger than new_account_hours; 0 falls back to
--                                            account_stranger_dms_per_hour. Someone sharing only a
--                                            server counts for these accounts too.
--   bot_requests_per_minute             600  gateway REST, all routes of one bot
--   bridge_requests_per_minute         3000  same, a bot linked to discord_bridges
--
-- Refusals: ANTISPAM_RATE_LIMITED:<seconds>, SERVER_LIMIT_REACHED:<n>, BOT_LIMIT_REACHED:<n>,
-- DM_NOT_ALLOWED. A refused write rolls back, so it counts toward nothing.
--
-- Limits apply to a write made with the account's own JWT. Service role has no profile and is exempt:
-- federation, gateway, bridges, webhooks, cron. Instance admins, moderators and limit_exempt_accounts
-- are exempt from every limit. Direct messages from a user's dm_policy bind everyone but staff.
--
-- Stored antispam values are kept: new keys read their defaults from antispam_settings(). An instance
-- with no profile yet is a new install and receives the recommended new-account limits.
--
-- Messages written through a SECURITY DEFINER RPC (threads, polls, call notices) reach
-- automod_check_message as internal and are not counted, as for the new-account limits.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('max_servers_per_user', '100'::jsonb, 'Local servers one account can own. 0 is no limit.'),
       ('max_bots_per_user', '25'::jsonb, 'Bots one account can own. 0 is no limit.'),
       ('drive_instance_limit_mb', '0'::jsonb, 'Stored files across the instance, MB. Past it, uploads are refused. 0 is no limit.')
ON CONFLICT (config_key) DO NOTHING;

UPDATE public.instance_config
   SET config_value = config_value || '{"new_account_messages_per_minute": 20, "new_account_posts_per_hour": 20,
                                        "new_account_max_stranger_mentions": 5}'::jsonb
 WHERE config_key = 'antispam'
   AND jsonb_typeof(config_value) = 'object'
   AND NOT EXISTS (SELECT 1 FROM public.profiles);

CREATE OR REPLACE FUNCTION public.antispam_settings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT '{"new_account_hours": 24, "new_account_messages_per_minute": 0, "new_account_posts_per_hour": 0,
             "new_account_max_stranger_mentions": 0, "new_account_block_links": false,
             "new_account_stranger_dms_per_hour": 5,
             "account_messages_per_minute": 120, "account_posts_per_hour": 100,
             "account_reactions_per_minute": 240, "account_follows_per_hour": 200,
             "account_joins_per_hour": 60, "account_servers_per_hour": 10,
             "account_stranger_dms_per_hour": 30,
             "bot_requests_per_minute": 600, "bridge_requests_per_minute": 3000,
             "federation_spam_mode": "flag", "federation_max_mentions": 15, "federation_new_actor_days": 7}'::jsonb
           || COALESCE((SELECT ic.config_value FROM public.instance_config ic
                         WHERE ic.config_key = 'antispam' AND jsonb_typeof(ic.config_value) = 'object'),
                       '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION public.update_instance_antispam_settings(p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    s jsonb := public.antispam_settings() || COALESCE(p_settings, '{}'::jsonb);
    v jsonb;
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Admin role required' USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(COALESCE(p_settings, '{}'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION 'ANTISPAM_INVALID_SETTINGS: settings must be an object' USING ERRCODE = '22023';
    END IF;
    IF s ->> 'federation_spam_mode' NOT IN ('off', 'flag', 'hold', 'reject') THEN
        RAISE EXCEPTION 'ANTISPAM_INVALID_SETTINGS: federation_spam_mode is off, flag, hold or reject' USING ERRCODE = '22023';
    END IF;

    v := jsonb_build_object(
        'new_account_hours', public.automod_int(s -> 'new_account_hours', 24, 1, 8760),
        'new_account_messages_per_minute', public.automod_int(s -> 'new_account_messages_per_minute', 0, 0, 600),
        'new_account_posts_per_hour', public.automod_int(s -> 'new_account_posts_per_hour', 0, 0, 1000),
        'new_account_max_stranger_mentions', public.automod_int(s -> 'new_account_max_stranger_mentions', 0, 0, 100),
        'new_account_block_links', COALESCE((s ->> 'new_account_block_links')::boolean, false),
        'new_account_stranger_dms_per_hour', public.automod_int(s -> 'new_account_stranger_dms_per_hour', 5, 0, 100000),
        'account_messages_per_minute', public.automod_int(s -> 'account_messages_per_minute', 120, 0, 100000),
        'account_posts_per_hour', public.automod_int(s -> 'account_posts_per_hour', 100, 0, 100000),
        'account_reactions_per_minute', public.automod_int(s -> 'account_reactions_per_minute', 240, 0, 100000),
        'account_follows_per_hour', public.automod_int(s -> 'account_follows_per_hour', 200, 0, 100000),
        'account_joins_per_hour', public.automod_int(s -> 'account_joins_per_hour', 60, 0, 100000),
        'account_servers_per_hour', public.automod_int(s -> 'account_servers_per_hour', 10, 0, 100000),
        'account_stranger_dms_per_hour', public.automod_int(s -> 'account_stranger_dms_per_hour', 30, 0, 100000),
        'bot_requests_per_minute', public.automod_int(s -> 'bot_requests_per_minute', 600, 0, 1000000),
        'bridge_requests_per_minute', public.automod_int(s -> 'bridge_requests_per_minute', 3000, 0, 1000000),
        'federation_spam_mode', s ->> 'federation_spam_mode',
        'federation_max_mentions', public.automod_int(s -> 'federation_max_mentions', 15, 2, 500),
        'federation_new_actor_days', public.automod_int(s -> 'federation_new_actor_days', 7, 0, 365));

    INSERT INTO public.instance_config (config_key, config_value, description, updated_at, updated_by)
    VALUES ('antispam', v, 'Instance anti-spam limits. 0/false disables a limit.', now(), public.get_current_profile_id())
    ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value, updated_at = now(), updated_by = EXCLUDED.updated_by;

    PERFORM public.log_admin_action(public.get_current_profile_id(), 'update_antispam_settings',
                                    'instance_config', 'antispam', v, NULL, NULL);
    RETURN v;
EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'ANTISPAM_INVALID_SETTINGS: malformed value' USING ERRCODE = '22023';
END;
$$;

-- 0 is no limit; absent or unreadable reads p_default. As server_emoji_limit.
CREATE OR REPLACE FUNCTION public.instance_count_cap(p_key text, p_default integer)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN (SELECT ic.config_value #>> '{}' FROM public.instance_config ic
               WHERE ic.config_key = p_key) ~ '^\s*0+\s*$' THEN 0
        ELSE public.get_instance_config_int(p_key, p_default, 2147483647)
    END
$$;

-- ---------------------------------------------------------------------------
-- Exempt accounts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.limit_exempt_accounts (
    profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    set_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.limit_exempt_accounts IS
    'Local accounts instance admins exempt from instance write limits. A bot follows its owner.';

ALTER TABLE public.limit_exempt_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS limit_exempt_accounts_select_admin ON public.limit_exempt_accounts;
CREATE POLICY limit_exempt_accounts_select_admin ON public.limit_exempt_accounts
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin()));

REVOKE ALL ON public.limit_exempt_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.limit_exempt_accounts TO authenticated;
GRANT ALL ON public.limit_exempt_accounts TO service_role;

CREATE OR REPLACE FUNCTION public.antispam_account_exempt(p_profile uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = p_profile AND (p.is_admin IS TRUE OR p.is_moderator IS TRUE))
        OR EXISTS (SELECT 1 FROM public.limit_exempt_accounts e WHERE e.profile_id = p_profile)
$$;

CREATE OR REPLACE FUNCTION public.admin_set_limit_exempt(p_profile uuid, p_exempt boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_profile AND p.is_local IS TRUE) THEN
        RAISE EXCEPTION 'Local accounts only' USING ERRCODE = '22023';
    END IF;

    IF p_exempt THEN
        INSERT INTO public.limit_exempt_accounts (profile_id, set_by)
        VALUES (p_profile, v_me)
        ON CONFLICT (profile_id) DO NOTHING;
    ELSE
        DELETE FROM public.limit_exempt_accounts WHERE profile_id = p_profile;
    END IF;

    PERFORM public.log_admin_action(v_me, 'limit_exempt', 'profile', p_profile::text,
                                    jsonb_build_object('exempt', p_exempt));
    RETURN p_exempt;
END;
$$;

-- ---------------------------------------------------------------------------
-- Rate limits on an account's writes
-- ---------------------------------------------------------------------------

ALTER TABLE public.automod_recent_activity DROP CONSTRAINT IF EXISTS automod_recent_activity_kind_check;
ALTER TABLE public.automod_recent_activity ADD CONSTRAINT automod_recent_activity_kind_check
    CHECK (kind IN ('message', 'post', 'reaction', 'follow', 'join', 'server', 'stranger_dm'));

-- Raises ANTISPAM_RATE_LIMITED:<seconds until the oldest counted write leaves the window>. The caller
-- records an accepted write. automod_purge keeps an hour of rows, the longest window here.
CREATE OR REPLACE FUNCTION public.antispam_rate_check(
    p_user uuid, p_kind text, p_limit integer, p_window_seconds integer, p_hint text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_window interval := make_interval(secs => p_window_seconds);
    v_count integer;
    v_oldest timestamptz;
BEGIN
    SELECT count(*), min(x.created_at) INTO v_count, v_oldest
      FROM (SELECT ra.created_at FROM public.automod_recent_activity ra
             WHERE ra.user_id = p_user AND ra.created_at > now() - v_window AND ra.kind = p_kind
             ORDER BY ra.created_at DESC LIMIT p_limit) x;
    IF v_count >= p_limit THEN
        RAISE EXCEPTION 'ANTISPAM_RATE_LIMITED:%',
            GREATEST(1, ceil(extract(epoch FROM (v_oldest + v_window - now()))))::integer
            USING ERRCODE = 'P0001', HINT = p_hint;
    END IF;
END;
$$;

-- Limits for a local author. Raises ANTISPAM_* on a breach. Returns true when a rate limit applies, so
-- the caller records the accepted write in automod_recent_activity; false when every limit is off or
-- the author is remote or exempt. Rates count the account's own writes only, as 20261005100001 did not:
-- a backend write on behalf of a new account is not the account flooding. Links and stranger mentions
-- stand whoever writes.
CREATE OR REPLACE FUNCTION public.antispam_check_local_author(
    p_author uuid, p_kind text, p_content jsonb, p_op text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cfg jsonb := public.antispam_settings();
    v_post boolean := p_kind = 'post';
    v_window integer := CASE WHEN p_kind = 'post' THEN 3600 ELSE 60 END;
    v_self boolean := public.get_current_profile_id() = p_author;
    v_account_rate integer := 0;
    v_rate integer := 0;
    v_stranger integer;
    v_links boolean;
    v_hours integer;
    v_created timestamptz;
    v_local boolean;
    v_count integer;
    v_text text;
    v_urls text[];
BEGIN
    IF v_self THEN
        v_rate := public.antispam_int(v_cfg -> CASE WHEN v_post THEN 'new_account_posts_per_hour'
                                                    ELSE 'new_account_messages_per_minute' END, 0);
        IF p_op = 'INSERT' THEN
            v_account_rate := public.antispam_int(
                v_cfg -> CASE WHEN v_post THEN 'account_posts_per_hour' ELSE 'account_messages_per_minute' END, 0);
        END IF;
    END IF;
    v_stranger := CASE WHEN v_post
                       THEN public.antispam_int(v_cfg -> 'new_account_max_stranger_mentions', 0) ELSE 0 END;
    v_links := jsonb_typeof(v_cfg -> 'new_account_block_links') = 'boolean'
               AND (v_cfg ->> 'new_account_block_links')::boolean;
    IF v_account_rate <= 0 AND v_rate <= 0 AND v_stranger <= 0 AND NOT v_links THEN
        RETURN false;
    END IF;

    v_hours := GREATEST(public.antispam_int(v_cfg -> 'new_account_hours', 24), 1);
    SELECT p.created_at, p.is_local INTO v_created, v_local
      FROM public.profiles p WHERE p.id = p_author;
    IF v_local IS NOT TRUE OR public.antispam_account_exempt(p_author) THEN
        RETURN false;
    END IF;

    IF v_account_rate > 0 THEN
        PERFORM public.antispam_rate_check(p_author, p_kind, v_account_rate, v_window,
            CASE WHEN v_post THEN 'An account can post a limited number of times per hour.'
                 ELSE 'An account can send a limited number of messages per minute.' END);
    END IF;

    IF v_created <= now() - make_interval(hours => v_hours) THEN
        RETURN v_account_rate > 0;
    END IF;

    IF p_op = 'INSERT' AND v_rate > 0 THEN
        PERFORM public.antispam_rate_check(p_author, p_kind, v_rate, v_window,
            CASE WHEN v_post THEN 'New accounts can post a limited number of times per hour.'
                 ELSE 'New accounts can send a limited number of messages per minute.' END);
    END IF;

    IF v_links THEN
        SELECT string_agg(e ->> 'text', E'\n') FILTER (WHERE e ->> 'type' = 'text'),
               array_agg(e ->> 'url') FILTER (WHERE e ->> 'type' IN ('url', 'embed') AND e ->> 'url' IS NOT NULL)
          INTO v_text, v_urls
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_content) = 'array' THEN p_content ELSE '[]'::jsonb END) e;
        IF (v_text IS NOT NULL OR v_urls IS NOT NULL)
           AND cardinality(public.automod_link_hosts(v_text, v_urls)) > 0 THEN
            RAISE EXCEPTION 'ANTISPAM_LINKS_BLOCKED'
                USING ERRCODE = 'P0001', HINT = format('Accounts younger than %s hours cannot post links.', v_hours);
        END IF;
    END IF;

    IF v_stranger > 0 THEN
        SELECT count(DISTINCT target.id) INTO v_count
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_content) = 'array' THEN p_content ELSE '[]'::jsonb END) e
          JOIN LATERAL (
              SELECT p.id FROM public.profiles p
               WHERE (e ->> 'userId' IS NOT NULL AND p.id::text = e ->> 'userId')
                  OR (e ->> 'userId' IS NULL AND p.username = e ->> 'username'
                      AND p.domain = COALESCE(NULLIF(e ->> 'domain', ''), p.domain))
               LIMIT 1) target ON true
         WHERE e ->> 'type' = 'mention'
           AND target.id <> p_author
           AND NOT EXISTS (SELECT 1 FROM public.follows f
                            WHERE f.follower_id = target.id AND f.following_id = p_author AND f.status = 'accepted');
        IF v_count > v_stranger THEN
            RAISE EXCEPTION 'ANTISPAM_STRANGER_MENTIONS:%', v_stranger
                USING ERRCODE = 'P0001',
                      HINT = format('New accounts can mention at most %s people who do not follow them.', v_stranger);
        END IF;
    END IF;
    RETURN v_rate > 0 OR v_account_rate > 0;
END;
$$;

-- Rate limit on one kind of write. Arguments: kind, antispam key, window in seconds, and optionally the
-- column that must name the writer for the row to count. Depth above 1 is another trigger's row.
CREATE OR REPLACE FUNCTION public.antispam_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_limit integer;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    v_actor := public.get_current_profile_id();
    IF v_actor IS NULL
       OR (TG_NARGS > 3 AND to_jsonb(NEW) ->> TG_ARGV[3] IS DISTINCT FROM v_actor::text)
       OR public.antispam_account_exempt(v_actor) THEN
        RETURN NEW;
    END IF;
    v_limit := public.antispam_int(public.antispam_settings() -> TG_ARGV[1], 0);
    IF v_limit <= 0 THEN
        RETURN NEW;
    END IF;
    PERFORM public.antispam_rate_check(v_actor, TG_ARGV[0], v_limit, TG_ARGV[2]::integer,
                                       format('Limit reached: %s.', TG_ARGV[1]));
    INSERT INTO public.automod_recent_activity (user_id, kind) VALUES (v_actor, TG_ARGV[0]);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS z_reactions_rate_limit ON public.reactions;
CREATE TRIGGER z_reactions_rate_limit
    BEFORE INSERT ON public.reactions
    FOR EACH ROW EXECUTE FUNCTION public.antispam_write_guard('reaction', 'account_reactions_per_minute', '60');

DROP TRIGGER IF EXISTS z_post_interactions_rate_limit ON public.post_interactions;
CREATE TRIGGER z_post_interactions_rate_limit
    BEFORE INSERT ON public.post_interactions
    FOR EACH ROW WHEN (NEW.interaction_type IN ('favorite', 'emoji_reaction'))
    EXECUTE FUNCTION public.antispam_write_guard('reaction', 'account_reactions_per_minute', '60');

DROP TRIGGER IF EXISTS z_follows_rate_limit ON public.follows;
CREATE TRIGGER z_follows_rate_limit
    BEFORE INSERT ON public.follows
    FOR EACH ROW EXECUTE FUNCTION public.antispam_write_guard('follow', 'account_follows_per_hour', '3600');

DROP TRIGGER IF EXISTS z_user_servers_rate_limit ON public.user_servers;
CREATE TRIGGER z_user_servers_rate_limit
    BEFORE INSERT ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.antispam_write_guard('join', 'account_joins_per_hour', '3600', 'user_id');

DROP TRIGGER IF EXISTS z_servers_rate_limit ON public.servers;
CREATE TRIGGER z_servers_rate_limit
    BEFORE INSERT ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.antispam_write_guard('server', 'account_servers_per_hour', '3600');

-- ---------------------------------------------------------------------------
-- Counts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_max_servers_per_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid := public.get_current_profile_id();
    v_max integer;
BEGIN
    IF v_actor IS NULL OR public.antispam_account_exempt(v_actor) THEN
        RETURN NEW;
    END IF;
    v_max := public.instance_count_cap('max_servers_per_user', 100);
    IF v_max > 0 AND (SELECT count(*) FROM public.servers s
                       WHERE s.owner = v_actor AND s.is_local_server IS TRUE) >= v_max THEN
        RAISE EXCEPTION 'SERVER_LIMIT_REACHED:%', v_max
            USING ERRCODE = 'P0001', HINT = format('An account can own at most %s servers.', v_max);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS y_servers_owner_cap ON public.servers;
CREATE TRIGGER y_servers_owner_cap
    BEFORE INSERT ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.enforce_max_servers_per_user();

-- As 20260930000001, with max_bots_per_user. create_bot is the client's one way to make a bot: a cap
-- here holds only with direct INSERT revoked.
REVOKE INSERT ON public.bots FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_bot(
    p_username text,
    p_display_name text DEFAULT NULL,
    p_bio text DEFAULT NULL,
    p_bot_type text DEFAULT 'bot',
    p_is_public boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_owner uuid := public.get_current_profile_id();
    v_max integer;
    v_bot public.bots;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF p_bot_type IS NULL OR p_bot_type NOT IN ('bot', 'bridge') THEN
        RAISE EXCEPTION 'Unsupported bot type: %', p_bot_type USING ERRCODE = '22023';
    END IF;

    v_max := public.instance_count_cap('max_bots_per_user', 25);
    IF v_max > 0 AND NOT public.antispam_account_exempt(v_owner)
       AND (SELECT count(*) FROM public.bots b
             WHERE b.owner_id = v_owner
               AND b.bot_type <> 'integration'
               AND NOT EXISTS (SELECT 1 FROM public.discord_bridges d WHERE d.bot_id = b.id)) >= v_max THEN
        RAISE EXCEPTION 'BOT_LIMIT_REACHED:%', v_max
            USING ERRCODE = 'P0001', HINT = format('An account can own at most %s bots.', v_max);
    END IF;

    INSERT INTO public.bots (username, display_name, bio, bot_type, is_public, owner_id)
    VALUES (p_username,
            COALESCE(NULLIF(btrim(p_display_name), ''), p_username),
            NULLIF(btrim(p_bio), ''),
            p_bot_type,
            COALESCE(p_is_public, true),
            v_owner)
    RETURNING * INTO v_bot;

    RETURN jsonb_build_object('bot', to_jsonb(v_bot))
        || public.issue_bot_token(v_bot.id, 'Default Token');
END;
$$;

-- ---------------------------------------------------------------------------
-- Bot REST
-- ---------------------------------------------------------------------------

-- One bucket of bot_rate_limits, counted atomically. Returns the seconds left in the bucket's window
-- when the count passes p_limit, else 0.
CREATE OR REPLACE FUNCTION public.bot_rate_limit_take(
    p_bot_id uuid, p_bucket text, p_limit integer, p_window_seconds integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
    v_resets_at timestamptz;
BEGIN
    INSERT INTO public.bot_rate_limits (
        bot_id, bucket,
        request_count, window_start, window_duration_seconds, max_requests, resets_at
    )
    VALUES (
        p_bot_id, p_bucket,
        1, NOW(), p_window_seconds, p_limit,
        NOW() + make_interval(secs => p_window_seconds)
    )
    ON CONFLICT (bot_id, bucket) DO UPDATE
        SET
            request_count = CASE
                WHEN public.bot_rate_limits.resets_at < NOW() THEN 1
                ELSE public.bot_rate_limits.request_count + 1
            END,
            window_start = CASE
                WHEN public.bot_rate_limits.resets_at < NOW() THEN NOW()
                ELSE public.bot_rate_limits.window_start
            END,
            window_duration_seconds = p_window_seconds,
            max_requests = p_limit,
            resets_at = CASE
                WHEN public.bot_rate_limits.resets_at < NOW() THEN NOW() + make_interval(secs => p_window_seconds)
                ELSE public.bot_rate_limits.resets_at
            END
    RETURNING request_count, resets_at INTO v_count, v_resets_at;

    IF v_count <= p_limit THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(1, ceil(extract(epoch FROM (v_resets_at - NOW()))))::integer;
END;
$$;

-- The caller's route bucket, then the bot's 'overall' bucket of 60 s, whose limit comes from antispam
-- settings. Route buckets start with '/' or read 'unmatched', so 'overall' cannot collide. Overall never
-- reads below the route limit per minute: an operator's raised RATE_LIMIT_MAX_REQUESTS is not undercut.
-- A bot whose owner is exempt has no overall limit. Returns the seconds to wait; 0 admits the request.
-- A gateway reading the older boolean result sees no refusal.
DROP FUNCTION IF EXISTS public.check_and_increment_bot_rate_limit(uuid, text, integer, integer);
CREATE FUNCTION public.check_and_increment_bot_rate_limit(
    p_bot_id uuid,
    p_bucket text,
    p_limit integer DEFAULT 100,
    p_window_seconds integer DEFAULT 60
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wait integer := public.bot_rate_limit_take(p_bot_id, p_bucket, p_limit, p_window_seconds);
    v_overall integer;
BEGIN
    SELECT public.antispam_int(
               public.antispam_settings() -> CASE WHEN EXISTS (SELECT 1 FROM public.discord_bridges d WHERE d.bot_id = b.id)
                                                  THEN 'bridge_requests_per_minute'
                                                  ELSE 'bot_requests_per_minute' END, 0)
      INTO v_overall
      FROM public.bots b
     WHERE b.id = p_bot_id
       AND NOT public.antispam_account_exempt(b.owner_id);

    IF v_overall > 0 THEN
        v_wait := GREATEST(v_wait, public.bot_rate_limit_take(
            p_bot_id, 'overall',
            GREATEST(v_overall, ceil(p_limit * 60.0 / GREATEST(p_window_seconds, 1))::integer), 60));
    END IF;
    RETURN v_wait;
END;
$$;

COMMENT ON FUNCTION public.check_and_increment_bot_rate_limit(uuid, text, integer, integer) IS
    'Counts one bot request in its route bucket and the bot''s overall bucket. Returns the seconds to wait; 0 admits.';

-- ---------------------------------------------------------------------------
-- Direct messages
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS dm_policy text NOT NULL DEFAULT 'everyone';

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_dm_policy_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_dm_policy_check
    CHECK (dm_policy IN ('everyone', 'known', 'following'));

COMMENT ON COLUMN public.profiles.dm_policy IS
    'Who can start a conversation with this account: everyone; known (server members and people it follows); following.';

-- What p_recipient knows of p_sender, closest first:
--   conversation  a conversation holds both and the recipient has not left it
--   following     the recipient follows the sender
--   server        both are accepted members of one server
--   stranger      none of these
CREATE OR REPLACE FUNCTION public.dm_relation(p_sender uuid, p_recipient uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN EXISTS (SELECT 1 FROM public.conversation_participants a
                       JOIN public.conversation_participants b ON b.conversation_id = a.conversation_id
                      WHERE a.user_id = p_sender AND b.user_id = p_recipient AND b.left_at IS NULL)
            THEN 'conversation'
        WHEN EXISTS (SELECT 1 FROM public.follows f
                      WHERE f.follower_id = p_recipient AND f.following_id = p_sender AND f.status = 'accepted')
            THEN 'following'
        WHEN EXISTS (SELECT 1 FROM public.user_servers a
                       JOIN public.user_servers b ON b.server_id = a.server_id
                      WHERE a.user_id = p_sender AND a.status = 'accepted'
                        AND b.user_id = p_recipient AND b.status = 'accepted')
            THEN 'server'
        ELSE 'stranger'
    END
$$;

-- The recipient's dm_policy applied to a relation.
CREATE OR REPLACE FUNCTION public.dm_policy_allows(p_recipient uuid, p_relation text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE COALESCE((SELECT p.dm_policy FROM public.profiles p WHERE p.id = p_recipient), 'everyone')
        WHEN 'everyone' THEN true
        WHEN 'known' THEN p_relation <> 'stranger'
        ELSE p_relation IN ('conversation', 'following')
    END
$$;

-- Checked before a client adds someone to a new or existing conversation. Staff pass. A limit-exempt
-- account passes the rate, not the recipient's own setting. Raises DM_NOT_ALLOWED or
-- ANTISPAM_RATE_LIMITED:<seconds>.
CREATE OR REPLACE FUNCTION public.dm_start_guard(p_sender uuid, p_recipient uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_relation text;
    v_cfg jsonb;
    v_new boolean;
    v_limit integer;
BEGIN
    IF EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = p_sender AND (p.is_admin IS TRUE OR p.is_moderator IS TRUE)) THEN
        RETURN;
    END IF;

    v_relation := public.dm_relation(p_sender, p_recipient);
    IF NOT public.dm_policy_allows(p_recipient, v_relation) THEN
        RAISE EXCEPTION 'DM_NOT_ALLOWED'
            USING ERRCODE = 'P0001', HINT = 'This person limits who can start a conversation with them.';
    END IF;
    IF v_relation IN ('conversation', 'following') OR public.antispam_account_exempt(p_sender) THEN
        RETURN;
    END IF;

    v_cfg := public.antispam_settings();
    SELECT p.created_at > now() - make_interval(hours => GREATEST(public.antispam_int(v_cfg -> 'new_account_hours', 24), 1))
      INTO v_new
      FROM public.profiles p WHERE p.id = p_sender;
    -- A public server's members are one join away, so a shared server counts for a new account.
    IF v_relation = 'server' AND v_new IS NOT TRUE THEN
        RETURN;
    END IF;
    v_limit := public.antispam_int(v_cfg -> 'account_stranger_dms_per_hour', 0);
    IF v_new IS TRUE AND public.antispam_int(v_cfg -> 'new_account_stranger_dms_per_hour', 0) > 0 THEN
        v_limit := public.antispam_int(v_cfg -> 'new_account_stranger_dms_per_hour', 0);
    END IF;
    IF v_limit <= 0 THEN
        RETURN;
    END IF;

    PERFORM public.antispam_rate_check(p_sender, 'stranger_dm', v_limit, 3600,
                                       'An account can start a limited number of new conversations per hour.');
    INSERT INTO public.automod_recent_activity (user_id, kind) VALUES (p_sender, 'stranger_dm');
END;
$$;

-- Federation: the recipients whose setting admits a remote sender.
CREATE OR REPLACE FUNCTION public.dm_recipients_allowing(p_sender uuid, p_recipients uuid[])
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_agg(r), '{}'::uuid[])
      FROM unnest(p_recipients) r
     WHERE public.dm_policy_allows(r, public.dm_relation(p_sender, r))
$$;

-- As 20260101000000_baseline.sql, with dm_start_guard when a conversation is created.
CREATE OR REPLACE FUNCTION public.create_or_get_direct_conversation(user1_uuid uuid, user2_uuid uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    conversation_uuid UUID;
    caller_profile_id UUID;
BEGIN
    SELECT id INTO caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();

    IF caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF caller_profile_id != user1_uuid AND caller_profile_id != user2_uuid THEN
        RAISE EXCEPTION 'Unauthorized: You can only create conversations you are a participant of';
    END IF;

    SELECT c.id INTO conversation_uuid
    FROM conversations c
    WHERE c.type = 'direct'
      AND EXISTS (
          SELECT 1 FROM conversation_participants cp1
          WHERE cp1.conversation_id = c.id
            AND cp1.user_id = user1_uuid
            AND cp1.left_at IS NULL
      )
      AND EXISTS (
          SELECT 1 FROM conversation_participants cp2
          WHERE cp2.conversation_id = c.id
            AND cp2.user_id = user2_uuid
            AND cp2.left_at IS NULL
      );

    IF conversation_uuid IS NULL THEN
        IF user1_uuid <> user2_uuid THEN
            PERFORM public.dm_start_guard(
                caller_profile_id,
                CASE WHEN caller_profile_id = user1_uuid THEN user2_uuid ELSE user1_uuid END);
        END IF;

        INSERT INTO conversations (type, created_by)
        VALUES ('direct', user1_uuid)
        RETURNING id INTO conversation_uuid;

        INSERT INTO conversation_participants (conversation_id, user_id, role)
        VALUES (conversation_uuid, user1_uuid, 'member')
        ON CONFLICT (conversation_id, user_id) DO NOTHING;

        INSERT INTO conversation_participants (conversation_id, user_id, role)
        VALUES (conversation_uuid, user2_uuid, 'member')
        ON CONFLICT (conversation_id, user_id) DO NOTHING;
    END IF;

    RETURN conversation_uuid;
END;
$$;

-- As 20260101000000_baseline.sql, with dm_start_guard per participant.
CREATE OR REPLACE FUNCTION public.create_group_conversation(
    p_creator_user_id uuid,
    p_participant_ids uuid[] DEFAULT '{}',
    p_conversation_name text DEFAULT NULL,
    p_is_private boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_conversation_id uuid;
    v_participant_id uuid;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_creator_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: You can only create conversations as yourself';
    END IF;

    INSERT INTO conversations (type, name, created_by, metadata)
    VALUES (
        'group',
        p_conversation_name,
        p_creator_user_id,
        jsonb_build_object('is_private', p_is_private)
    )
    RETURNING id INTO v_conversation_id;

    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (v_conversation_id, p_creator_user_id, 'admin');

    IF p_participant_ids IS NOT NULL THEN
        FOREACH v_participant_id IN ARRAY p_participant_ids
        LOOP
            IF v_participant_id != p_creator_user_id THEN
                PERFORM public.dm_start_guard(p_creator_user_id, v_participant_id);

                INSERT INTO conversation_participants (conversation_id, user_id, role)
                VALUES (v_conversation_id, v_participant_id, 'member')
                ON CONFLICT (conversation_id, user_id) DO NOTHING;
            END IF;
        END LOOP;
    END IF;

    RETURN v_conversation_id;
END;
$$;

-- As 20261005900001_security_hotfix_client_definers.sql, with dm_start_guard on the client path.
CREATE OR REPLACE FUNCTION public.add_user_to_conversation(
    conversation_uuid uuid,
    user_uuid uuid,
    user_role text DEFAULT 'member'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    participant_id uuid;
    v_caller uuid;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        v_caller := public.get_current_profile_id();
        IF v_caller IS NULL THEN
            RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
        END IF;
        IF NOT EXISTS (
            SELECT 1
              FROM conversations c
              JOIN conversation_participants cp ON cp.conversation_id = c.id
             WHERE c.id = conversation_uuid
               AND c.type = 'group'
               AND cp.user_id = v_caller
               AND cp.left_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Only participants of a group conversation can add members'
                USING ERRCODE = '42501';
        END IF;

        PERFORM public.dm_start_guard(v_caller, user_uuid);

        INSERT INTO conversation_participants (conversation_id, user_id, role)
        VALUES (conversation_uuid, user_uuid, 'member')
        ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL
        RETURNING id INTO participant_id;
        RETURN participant_id;
    END IF;

    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (conversation_uuid, user_uuid, user_role)
    ON CONFLICT (conversation_id, user_id)
    DO UPDATE SET left_at = NULL, role = user_role
    RETURNING id INTO participant_id;

    RETURN participant_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Drive
-- ---------------------------------------------------------------------------

-- As 20261106500001_drive_switch.sql, with drive_instance_limit_mb. Counts every stored file: storage
-- holds one copy per upload, whatever the per-account quota counts once.
CREATE OR REPLACE FUNCTION public.drive_can_upload()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
    v_instance_limit bigint;
BEGIN
    IF v_profile IS NULL OR NOT public.drive_enabled() THEN
        RETURN true;
    END IF;
    v_instance_limit := (public.drive_setting('drive_instance_limit_mb', 0) * 1048576)::bigint;
    IF v_instance_limit > 0
       AND NOT public.antispam_account_exempt(v_profile)
       AND (SELECT coalesce(sum(f.size_bytes), 0) FROM public.drive_files f WHERE f.state <> 'gone') >= v_instance_limit THEN
        RETURN false;
    END IF;
    IF public.drive_used_bytes(v_profile) < public.drive_quota_bytes(v_profile) THEN
        RETURN true;
    END IF;
    RETURN public.drive_ephemeral_recent_bytes(v_profile)
         < (public.drive_setting('drive_ephemeral_daily_mb', 2048) * 1048576)::bigint;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.check_and_increment_bot_rate_limit(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_increment_bot_rate_limit(uuid, text, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.admin_set_limit_exempt(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_limit_exempt(uuid, boolean) TO authenticated, service_role;

DO $do$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.instance_count_cap(text, integer)'::regprocedure,
        'public.antispam_account_exempt(uuid)'::regprocedure,
        'public.antispam_rate_check(uuid, text, integer, integer, text)'::regprocedure,
        'public.antispam_write_guard()'::regprocedure,
        'public.enforce_max_servers_per_user()'::regprocedure,
        'public.bot_rate_limit_take(uuid, text, integer, integer)'::regprocedure,
        'public.dm_relation(uuid, uuid)'::regprocedure,
        'public.dm_policy_allows(uuid, text)'::regprocedure,
        'public.dm_start_guard(uuid, uuid)'::regprocedure,
        'public.dm_recipients_allowing(uuid, uuid[])'::regprocedure
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$do$;

COMMIT;
