-- Sign-up captcha: a check asked only of sign-ups that look automated.
--
-- Providers: Cloudflare Turnstile and hCaptcha. Both verify a widget token with
--   POST <siteverify> secret=<secret>&response=<token>&remoteip=<address>
--   turnstile  https://challenges.cloudflare.com/turnstile/v0/siteverify
--   hcaptcha   https://api.hcaptcha.com/siteverify
--   answer     {"success": bool, "error-codes": [text]}, HTTP 200
-- A token is single-use and expires within minutes at the provider.
--
-- Settings (instance_config):
--   signup_captcha_provider  "off" (default), "turnstile" or "hcaptcha". Public.
--   signup_captcha_site_key  the widget's site key. Public.
--   signup_captcha_secret    the provider's secret key. Admins read it.
--   signup_captcha_mode      "suspect" (default) or "always".
-- The check runs once the provider is set and both keys are non-empty.
--
-- before_user_created_hook, as 20261109100001 plus the check. A refusal there is unchanged and
-- comes first. Then, for provider email or phone, the check is asked when:
--   mode is "always";
--   the sign-up is past an observing network or domain cap (would_refuse);
--   the network (IPv4 address or IPv6 /56) had an allowed sign-up in the last hour;
--   the email domain is new to the instance: neither a large provider, trusted, nor with a mail
--   host lookup on record.
-- Measured cases this answers: prod 2026-11-08, 54 accounts in 2.5 hours from one IPv6 on one domain;
-- 2026-11-09, 30 accounts from one IPv4 in 45 s on six new domains, each domain new.
-- Not asked of other providers (Google, GitHub, Twitch, the instance's own): GoTrue calls the hook on
-- their /callback, where no widget can run.
--
-- The client sends the token as user_metadata.captcha_token of POST /signup (options.data in
-- supabase-js); GoTrue passes user_metadata in the event (v2.197.0, probed 2026-11-10).
--   no token           {"error": {"http_code": 428, "message": <CAPTCHA_ASKED>}}
--   provider refuses   {"error": {"http_code": 428, "message": <CAPTCHA_FAILED>}}
--   provider passes    the account is created
--   provider unusable  the account is created: unreachable, non-200, or an answer naming the secret,
--                      site key, request or provider (error-codes outside TOKEN_ERRORS). These
--                      limits are abuse control; an outage must not refuse every sign-up. Counted as
--                      unverified.
-- GoTrue relays http_code and message: {"code": 428, "error_code": "unknown", "msg": text}. A client
-- that predates this shows the text.
-- GoTrue waits for the hook past 6 s (probed); http.timeout_msec is 4000.
--
-- signup_captcha_counts: per UTC day, asked (428 without a token), passed, failed (428 with a refused
-- token), unverified. Kept 90 days by purge_signup_ledger.
--
-- admin_test_signup_captcha(provider, token, secret): the admin panel verifies a widget token with the
-- entered or stored secret through the hook's own path before it saves the keys. harmony doctor
-- calls signup_captcha_check with a dummy token: a working secret answers invalid-input-response, a
-- wrong one invalid-input-secret (Turnstile and hCaptcha).
--
-- set_instance_config and batch_set_instance_config log a key ending in _secret as "set" or "empty";
-- rows already logged are rewritten the same way.
--
-- strip_signup_captcha_token, BEFORE INSERT OR UPDATE on auth.users, removes captcha_token from
-- raw_user_meta_data. GoTrue's /signup inserts the user, then updates the row six times, five
-- carrying the token from its in-memory copy (probed, v2.197.0): an INSERT trigger alone keeps it.
--
-- http (pgsql-http) is created in schema harmony_http where the image ships it (Supabase's Postgres
-- images, 1.6 in 15.8.1.060). Without it signup_captcha_verify answers 'error' and every check is
-- unverified. Its functions carry EXECUTE for PUBLIC, granted by supabase_admin, which supautils
-- creates them as; postgres, not superuser in that image, cannot revoke it (probed 2026-11-10).
-- harmony_http grants USAGE to no API role, so none can fetch a URL from the database host.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE SCHEMA IF NOT EXISTS harmony_http;
REVOKE ALL ON SCHEMA harmony_http FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'http') THEN
        CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA harmony_http;
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'http extension skipped: %', SQLERRM;
END;
$$;

-- An http installed before this migration stays in its schema. Revoking there takes effect only
-- for its owner or a superuser.
DO $$
DECLARE
    f record;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
          JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
          JOIN pg_extension e ON e.oid = d.refobjid
         WHERE e.extname = 'http'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
INSERT INTO public.instance_config (config_key, config_value, description) VALUES
    ('signup_captcha_provider', '"off"'::jsonb, 'Captcha for suspect sign-ups: off, turnstile or hcaptcha'),
    ('signup_captcha_site_key', '""'::jsonb, 'Site key of the captcha widget'),
    ('signup_captcha_secret', '""'::jsonb, 'Secret key the sign-up hook verifies captcha tokens with'),
    ('signup_captcha_mode', '"suspect"'::jsonb, 'suspect: only sign-ups that look automated; always: every sign-up with an email or phone')
ON CONFLICT (config_key) DO NOTHING;

DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
    v_key text;
BEGIN
    FOREACH v_key IN ARRAY ARRAY['signup_captcha_provider', 'signup_captcha_site_key'] LOOP
        IF NOT (v_key = ANY (v_keys)) THEN
            v_keys := v_keys || v_key;
        END IF;
    END LOOP;
    EXECUTE format(
        'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
        'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
        format('SELECT %L::text[]', v_keys));
END;
$do$;

-- ---------------------------------------------------------------------------
-- Counts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.signup_captcha_counts (
    day date PRIMARY KEY,
    asked integer NOT NULL DEFAULT 0,
    passed integer NOT NULL DEFAULT 0,
    failed integer NOT NULL DEFAULT 0,
    unverified integer NOT NULL DEFAULT 0
);
COMMENT ON TABLE public.signup_captcha_counts IS
    'Sign-up captcha per UTC day: asked (no token), passed, failed (token refused), unverified (provider unusable, allowed). Kept 90 days.';

REVOKE ALL ON public.signup_captcha_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.signup_captcha_counts TO authenticated;
GRANT ALL ON public.signup_captcha_counts TO service_role;
ALTER TABLE public.signup_captcha_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_captcha_counts_admin_read ON public.signup_captcha_counts;
CREATE POLICY signup_captcha_counts_admin_read ON public.signup_captcha_counts
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin()));

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_signup_ledger()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.signup_ledger SET network = NULL, email_domain = NULL
     WHERE (network IS NOT NULL OR email_domain IS NOT NULL) AND created_at <= now() - interval '24 hours';
    DELETE FROM public.signup_ledger WHERE created_at <= now() - interval '30 days';
    DELETE FROM public.signup_refusal_counts WHERE day < current_date - 90;
    DELETE FROM public.signup_captcha_counts WHERE day < current_date - 90;
    DELETE FROM public.signup_mail_hosts WHERE coalesce(checked_at, created_at) < now() - interval '30 days';
END;
$$;

-- Verdict on a siteverify answer: 'pass', 'fail' (the provider refused the token) or 'error' (no
-- verdict on the token).
CREATE OR REPLACE FUNCTION public.signup_captcha_verdict(p_status integer, p_content text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_temp
AS $$
DECLARE
    -- Codes about the token alone. Anything else is about the request or the keys.
    TOKEN_ERRORS CONSTANT text[] := ARRAY[
        'missing-input-response', 'invalid-input-response', 'timeout-or-duplicate',
        'expired-input-response', 'already-seen-response', 'invalid-or-already-seen-response',
        'not-using-dummy-passcode'];
    v_answer jsonb;
    v_codes text[];
BEGIN
    IF p_status IS DISTINCT FROM 200 THEN
        RETURN 'error';
    END IF;
    BEGIN
        v_answer := p_content::jsonb;
    EXCEPTION WHEN OTHERS THEN
        RETURN 'error';
    END;
    IF jsonb_typeof(v_answer) <> 'object' OR jsonb_typeof(v_answer -> 'success') IS DISTINCT FROM 'boolean' THEN
        RETURN 'error';
    END IF;
    IF (v_answer ->> 'success')::boolean THEN
        RETURN 'pass';
    END IF;
    SELECT coalesce(array_agg(e.c), '{}') INTO v_codes
      FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(v_answer -> 'error-codes') = 'array' THEN v_answer -> 'error-codes' ELSE '[]'::jsonb END) AS e(c);
    IF v_codes <@ TOKEN_ERRORS THEN
        RETURN 'fail';
    END IF;
    RETURN 'error';
END;
$$;

-- One siteverify call: {verdict, codes, detail, http_status, message}.
--   verdict  signup_captcha_verdict's answer
--   codes    the answer's error-codes
--   detail   'answer' (the provider answered), 'provider' (unknown provider), 'token' (empty or over
--            4096 characters, no request), 'no_http' (pgsql-http absent), 'network' (the request
--            raised: DNS, connect, TLS, timeout; message holds the error)
-- Calls go through EXECUTE, qualified by http's schema: the function compiles where http is absent.
CREATE OR REPLACE FUNCTION public.signup_captcha_check(p_provider text, p_secret text, p_token text, p_remote_ip text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_url text := CASE p_provider
        WHEN 'turnstile' THEN 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
        WHEN 'hcaptcha' THEN 'https://api.hcaptcha.com/siteverify'
    END;
    v_schema text;
    v_body text;
    v_status integer;
    v_content text;
    v_codes jsonb := '[]'::jsonb;
BEGIN
    IF v_url IS NULL THEN
        RETURN jsonb_build_object('verdict', 'error', 'codes', v_codes, 'detail', 'provider');
    END IF;
    IF p_token IS NULL OR p_token = '' OR length(p_token) > 4096 THEN
        RETURN jsonb_build_object('verdict', 'fail', 'codes', v_codes, 'detail', 'token');
    END IF;
    SELECT n.nspname INTO v_schema
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'http';
    IF v_schema IS NULL THEN
        RETURN jsonb_build_object('verdict', 'error', 'codes', v_codes, 'detail', 'no_http');
    END IF;
    BEGIN
        EXECUTE format('SELECT %1$I.urlencode($1::varchar) || ''&response='' || %1$I.urlencode($2::varchar)', v_schema)
            INTO v_body USING coalesce(p_secret, ''), p_token;
        v_body := 'secret=' || v_body;
        IF p_remote_ip IS NOT NULL THEN
            v_body := v_body || '&remoteip=' || p_remote_ip;
        END IF;
        PERFORM set_config('http.timeout_msec', '4000', true);
        EXECUTE format('SELECT status, content FROM %I.http_post($1::varchar, $2::varchar, ''application/x-www-form-urlencoded''::varchar)', v_schema)
            INTO v_status, v_content USING v_url, v_body;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'signup_captcha_check: %', SQLERRM;
        RETURN jsonb_build_object('verdict', 'error', 'codes', v_codes, 'detail', 'network', 'message', left(SQLERRM, 300));
    END;
    BEGIN
        IF jsonb_typeof(v_content::jsonb -> 'error-codes') = 'array' THEN
            v_codes := v_content::jsonb -> 'error-codes';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_codes := '[]'::jsonb;
    END;
    RETURN jsonb_build_object('verdict', public.signup_captcha_verdict(v_status, v_content), 'codes', v_codes,
                              'detail', 'answer', 'http_status', v_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.signup_captcha_verify(p_provider text, p_secret text, p_token text, p_remote_ip text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN coalesce(public.signup_captcha_check(p_provider, p_secret, p_token, p_remote_ip) ->> 'verdict', 'error');
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup_captcha_verify: %', SQLERRM;
    RETURN 'error';
END;
$$;

-- Admin test of provider and keys before saving: the token from a widget rendered with the entered
-- site key, verified with p_secret, or the stored secret when p_secret is empty. Answers
-- signup_captcha_check's object, the secret never in it; detail 'no_secret' when neither is set.
CREATE OR REPLACE FUNCTION public.admin_test_signup_captcha(p_provider text, p_token text, p_secret text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_secret text := nullif(btrim(coalesce(p_secret, '')), '');
BEGIN
    IF NOT coalesce(public.is_current_user_admin(), false) THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    IF p_provider IS NULL OR p_provider NOT IN ('turnstile', 'hcaptcha') THEN
        RAISE EXCEPTION 'unknown captcha provider' USING ERRCODE = '22023';
    END IF;
    IF v_secret IS NULL THEN
        SELECT nullif(btrim(ic.config_value #>> '{}', '" '), '') INTO v_secret
          FROM public.instance_config ic WHERE ic.config_key = 'signup_captcha_secret';
    END IF;
    IF v_secret IS NULL THEN
        RETURN jsonb_build_object('verdict', 'error', 'codes', '[]'::jsonb, 'detail', 'no_secret');
    END IF;
    RETURN public.signup_captcha_check(p_provider, v_secret, p_token, NULL);
END;
$$;

-- ---------------------------------------------------------------------------
-- Instance config writers: as 20261006750001, but a key ending in _secret is logged as "set" or
-- "empty", never its value. admin_audit_log is kept and read by every admin.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.config_audit_value(p_key text, p_value jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_temp
AS $$
    SELECT CASE
        WHEN p_key NOT LIKE '%\_secret' THEN p_value
        WHEN p_value IS NULL OR p_value = 'null'::jsonb OR btrim(p_value #>> '{}', '" ') = '' THEN '"empty"'::jsonb
        ELSE '"set"'::jsonb
    END
$$;

CREATE OR REPLACE FUNCTION public.set_instance_config(
    p_key text,
    p_value jsonb,
    p_user_id uuid DEFAULT NULL,
    p_description text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_old jsonb;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(btrim(p_key), '') IS NULL THEN
        RAISE EXCEPTION 'p_key is required' USING ERRCODE = '22023';
    END IF;

    SELECT ic.config_value INTO v_old FROM public.instance_config ic WHERE ic.config_key = p_key;

    INSERT INTO public.instance_config (config_key, config_value, description, updated_at, updated_by)
    VALUES (p_key, p_value, p_description, now(), v_me)
    ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value,
           description = COALESCE(EXCLUDED.description, instance_config.description),
           updated_at = now(),
           updated_by = EXCLUDED.updated_by;

    PERFORM public.log_admin_action(v_me, 'config_change', 'config', p_key,
        jsonb_build_object('key', p_key, 'old_value', public.config_audit_value(p_key, v_old),
                           'new_value', public.config_audit_value(p_key, p_value)));
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.batch_set_instance_config(p_keys text[], p_values jsonb[])
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_old jsonb;
    i integer;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    IF cardinality(p_keys) IS DISTINCT FROM cardinality(p_values) THEN
        RAISE EXCEPTION 'Keys and values arrays must have the same length' USING ERRCODE = '22023';
    END IF;

    FOR i IN 1 .. COALESCE(cardinality(p_keys), 0) LOOP
        IF NULLIF(btrim(p_keys[i]), '') IS NULL THEN
            RAISE EXCEPTION 'p_keys[%] is empty', i USING ERRCODE = '22023';
        END IF;

        SELECT ic.config_value INTO v_old FROM public.instance_config ic WHERE ic.config_key = p_keys[i];

        INSERT INTO public.instance_config (config_key, config_value, updated_at, updated_by)
        VALUES (p_keys[i], p_values[i], now(), v_me)
        ON CONFLICT (config_key) DO UPDATE
           SET config_value = EXCLUDED.config_value,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by;

        IF v_old IS DISTINCT FROM p_values[i] THEN
            PERFORM public.log_admin_action(v_me, 'config_change', 'config', p_keys[i],
                jsonb_build_object('key', p_keys[i], 'old_value', public.config_audit_value(p_keys[i], v_old),
                                   'new_value', public.config_audit_value(p_keys[i], p_values[i])));
        END IF;
    END LOOP;

    RETURN true;
END;
$$;

-- Rows written before this migration.
UPDATE public.admin_audit_log l
   SET action_details = l.action_details
       || jsonb_build_object('old_value', public.config_audit_value(l.action_details ->> 'key', l.action_details -> 'old_value'),
                             'new_value', public.config_audit_value(l.action_details ->> 'key', l.action_details -> 'new_value'))
 WHERE l.action_type = 'config_change'
   AND l.action_details ->> 'key' LIKE '%\_secret'
   AND (l.action_details -> 'old_value' IS DISTINCT FROM public.config_audit_value(l.action_details ->> 'key', l.action_details -> 'old_value')
        OR l.action_details -> 'new_value' IS DISTINCT FROM public.config_audit_value(l.action_details ->> 'key', l.action_details -> 'new_value'));

CREATE OR REPLACE FUNCTION public.strip_signup_captcha_token()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_temp
AS $$
BEGIN
    IF NEW.raw_user_meta_data ? 'captcha_token' THEN
        NEW.raw_user_meta_data := NEW.raw_user_meta_data - 'captcha_token';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.before_user_created_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_provider text := event #>> '{user,app_metadata,provider}';
    v_email text := lower(nullif(btrim(event #>> '{user,email}'), ''));
    v_domain text := substring(v_email from '@([^@]+)$');
    v_domains text[];
    v_counted_domain text;
    v_config jsonb;
    v_ip inet;
    v_network cidr;
    v_mailbox text;
    v_cap integer;
    v_users_here bigint;
    v_sessions_elsewhere bigint;
    v_enforce boolean;
    v_trusted boolean := false;
    v_block_disposable boolean;
    v_mail_hosts text[];
    v_hosts_checked timestamptz;
    v_hosts_due timestamptz;
    v_past_ip_cap boolean;
    v_one_address boolean := false;
    v_observed text[] := '{}';
    v_new_domain boolean := false;
    v_captcha_provider text;
    v_captcha_secret text;
    v_captcha_on boolean;
    v_ask boolean := false;
    v_token text;
    v_verdict text;
    -- RFC 1918, RFC 6598 (CGNAT, Tailscale), loopback, link-local, RFC 4193.
    v_private CONSTANT inet[] := ARRAY[
        '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8',
        '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'
    ]::inet[];
    CAPTCHA_ASKED CONSTANT text :=
        'Complete the check to finish signing up. If no check appears, update the app or sign up on this instance''s website.';
    CAPTCHA_FAILED CONSTANT text := 'The check did not pass. Try it again.';
    v_reason text;
    v_code integer;
    v_message text;
BEGIN
    BEGIN
        v_ip := (event #>> '{metadata,ip_address}')::inet;
    EXCEPTION WHEN invalid_text_representation THEN
        v_ip := NULL;
    END;
    IF v_ip IS NULL OR v_ip <<= ANY (v_private) THEN
        RETURN '{}'::jsonb;
    END IF;

    SELECT coalesce(jsonb_object_agg(config_key, config_value), '{}'::jsonb) INTO v_config
      FROM public.instance_config
     WHERE config_key IN ('signup_limits_enabled', 'signup_daily_ip_cap', 'signup_mailbox_cap', 'signup_daily_domain_cap',
                          'signup_enforce_caps', 'signup_limit_own_providers', 'signup_block_disposable_email',
                          'signup_blocked_email_domains', 'signup_trusted_email_domains', 'signup_blocked_mail_hosts',
                          'signup_blocked_networks', 'signup_captcha_provider', 'signup_captcha_site_key',
                          'signup_captcha_secret', 'signup_captcha_mode');

    IF btrim(v_config ->> 'signup_limits_enabled', '"') = 'false' THEN
        RETURN '{}'::jsonb;
    END IF;
    v_enforce := btrim(v_config ->> 'signup_enforce_caps', '"') = 'true';
    v_network := network(set_masklen(v_ip, CASE family(v_ip) WHEN 6 THEN 56 ELSE 32 END));

    IF (v_provider LIKE 'custom:%' OR v_provider LIKE 'sso:%')
       AND btrim(v_config ->> 'signup_limit_own_providers', '"') IS DISTINCT FROM 'true' THEN
        RETURN '{}'::jsonb;
    END IF;

    v_captcha_provider := btrim(v_config ->> 'signup_captcha_provider', '" ');
    v_captcha_secret := btrim(v_config ->> 'signup_captcha_secret', '" ');
    v_captcha_on := v_captcha_provider IN ('turnstile', 'hcaptcha')
        AND coalesce(btrim(v_config ->> 'signup_captcha_site_key', '" '), '') <> ''
        AND coalesce(v_captcha_secret, '') <> ''
        AND coalesce(v_provider, 'email') IN ('email', 'phone');

    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(
                   CASE WHEN jsonb_typeof(v_config -> 'signup_blocked_networks') = 'array'
                        THEN v_config -> 'signup_blocked_networks' ELSE '[]'::jsonb END) AS n(entry)
         WHERE public.signup_network_contains(n.entry, v_ip))
    THEN
        v_reason := 'blocked_network';
        v_code := 403;
        v_message := 'Sign-ups from this network are not available on this instance. Ask this instance''s admin for an invitation.';
    END IF;

    IF v_reason IS NULL AND coalesce(v_provider, 'email') IN ('email', 'phone') THEN
        IF v_domain IS NOT NULL THEN
            SELECT array_agg(array_to_string(p.parts[i:], '.')) INTO v_domains
              FROM (SELECT string_to_array(v_domain, '.') AS parts) p, generate_subscripts(p.parts, 1) AS i;

            v_trusted := EXISTS (
                SELECT 1
                  FROM jsonb_array_elements_text(
                           CASE WHEN jsonb_typeof(v_config -> 'signup_trusted_email_domains') = 'array'
                                THEN v_config -> 'signup_trusted_email_domains' ELSE '[]'::jsonb END) AS t(domain)
                 WHERE lower(btrim(t.domain)) = ANY (v_domains));
            v_block_disposable := btrim(v_config ->> 'signup_block_disposable_email', '"') IS DISTINCT FROM 'false';

            IF (NOT v_trusted
                AND v_block_disposable
                AND EXISTS (SELECT 1 FROM public.signup_disposable_domains d WHERE d.domain = ANY (v_domains)))
               OR EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements_text(
                               CASE WHEN jsonb_typeof(v_config -> 'signup_blocked_email_domains') = 'array'
                                    THEN v_config -> 'signup_blocked_email_domains' ELSE '[]'::jsonb END) AS b(domain)
                     WHERE lower(btrim(b.domain)) = ANY (v_domains))
            THEN
                v_reason := 'blocked_domain';
                v_code := 422;
                v_message := 'This email provider cannot be used to sign up on this instance. Use another address.';
            ELSIF NOT v_trusted
                  AND NOT EXISTS (SELECT 1 FROM public.signup_common_email_domains c WHERE c.domain = ANY (v_domains)) THEN
                v_counted_domain := v_domain;

                SELECT m.hosts, m.checked_at, m.due_at INTO v_mail_hosts, v_hosts_checked, v_hosts_due
                  FROM public.signup_mail_hosts m
                 WHERE m.domain = v_domain;
                IF NOT FOUND THEN
                    v_new_domain := true;
                    INSERT INTO public.signup_mail_hosts (domain) VALUES (v_domain) ON CONFLICT (domain) DO NOTHING;
                    PERFORM public.queue_federation_job('signup-mail-host', jsonb_build_object('domain', v_domain), 5, 3, 3600);
                ELSE
                    v_new_domain := v_hosts_checked IS NULL;
                    IF v_hosts_due IS NULL AND v_hosts_checked < now() - interval '7 days' THEN
                        UPDATE public.signup_mail_hosts m SET due_at = now() WHERE m.domain = v_domain;
                        PERFORM public.queue_federation_job('signup-mail-host', jsonb_build_object('domain', v_domain), 5, 3, 3600);
                    END IF;
                END IF;

                IF EXISTS (
                    SELECT 1
                      FROM unnest(v_mail_hosts) AS h(host)
                     CROSS JOIN LATERAL (
                         SELECT array_to_string(p.parts[i:], '.') AS name
                           FROM (SELECT string_to_array(h.host, '.') AS parts) p, generate_subscripts(p.parts, 1) AS i
                     ) s
                     WHERE (v_block_disposable
                            AND EXISTS (SELECT 1 FROM public.signup_disposable_mail_hosts d WHERE d.host = s.name))
                        OR s.name IN (
                            SELECT lower(btrim(b.host))
                              FROM jsonb_array_elements_text(
                                       CASE WHEN jsonb_typeof(v_config -> 'signup_blocked_mail_hosts') = 'array'
                                            THEN v_config -> 'signup_blocked_mail_hosts' ELSE '[]'::jsonb END) AS b(host))
                ) THEN
                    v_reason := 'mail_host';
                    v_code := 422;
                    v_message := 'This email provider cannot be used to sign up on this instance. Use another address.';
                END IF;
            END IF;
        END IF;

        IF v_reason IS NULL AND v_email IS NOT NULL THEN
            v_mailbox := public.signup_mailbox_hash(v_email);
            v_cap := coalesce(nullif(btrim(v_config ->> 'signup_mailbox_cap', '"'), '')::integer, 5);
            IF v_cap > 0 AND (SELECT count(*) FROM public.signup_ledger l
                               WHERE l.mailbox_hash = v_mailbox
                                 AND l.created_at > now() - interval '30 days') >= v_cap THEN
                v_reason := 'mailbox_cap';
                v_code := 422;
                v_message := 'This email inbox has reached the limit of accounts on this instance.';
            END IF;
        END IF;

        IF v_reason IS NULL AND v_counted_domain IS NOT NULL THEN
            -- Concurrent sign-ups of one domain count in turn. Domain before network, as below.
            PERFORM pg_advisory_xact_lock(hashtextextended('before_user_created_hook:domain:' || v_domain, 0));
            v_cap := coalesce(nullif(btrim(v_config ->> 'signup_daily_domain_cap', '"'), '')::integer, 10);
            IF v_cap > 0 AND (SELECT count(*) FROM public.signup_ledger l
                               WHERE l.email_domain = v_domain
                                 AND l.created_at > now() - interval '24 hours') >= v_cap THEN
                IF v_enforce THEN
                    v_reason := 'domain_cap';
                    v_code := 429;
                    v_message := 'Too many accounts were created with this email domain today. Try again tomorrow, or ask this instance''s admin for an invitation.';
                ELSE
                    v_observed := v_observed || 'domain_cap'::text;
                END IF;
            END IF;
        END IF;
    END IF;

    IF v_reason IS NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('before_user_created_hook:network:' || v_network::text, 0));

        v_cap := coalesce(nullif(btrim(v_config ->> 'signup_daily_ip_cap', '"'), '')::integer, 5);
        v_past_ip_cap := v_cap > 0 AND (SELECT count(*) FROM public.signup_ledger l
                                         WHERE l.network = v_network
                                           AND l.created_at > now() - interval '24 hours') >= v_cap;

        IF v_past_ip_cap THEN
            BEGIN
                SELECT count(DISTINCT s.user_id) FILTER (WHERE s.ip <<= v_network),
                       count(*) FILTER (WHERE NOT s.ip <<= v_network AND NOT s.ip <<= ANY (v_private))
                  INTO v_users_here, v_sessions_elsewhere
                  FROM auth.sessions s
                 WHERE s.ip IS NOT NULL AND s.updated_at > now() - interval '30 days';
                v_one_address := v_users_here >= 5 AND v_sessions_elsewhere = 0;
            EXCEPTION WHEN insufficient_privilege THEN
                v_one_address := false;
            END;
        END IF;

        IF v_reason IS NULL AND v_past_ip_cap AND NOT v_one_address THEN
            IF v_enforce THEN
                v_reason := 'ip_cap';
                v_code := 429;
                v_message := 'Too many accounts were created from this network today. Try again tomorrow, or ask this instance''s admin for an invitation.';
            ELSE
                v_observed := v_observed || 'ip_cap'::text;
            END IF;
        END IF;
    END IF;

    IF v_reason IS NOT NULL THEN
        INSERT INTO public.signup_refusal_counts AS c (day, reason, refusals)
        VALUES ((now() AT TIME ZONE 'UTC')::date, v_reason, 1)
        ON CONFLICT (day, reason) DO UPDATE SET refusals = c.refusals + 1;
        RETURN jsonb_build_object('error', jsonb_build_object('http_code', v_code, 'message', v_message));
    END IF;

    IF v_captcha_on THEN
        v_ask := btrim(v_config ->> 'signup_captcha_mode', '" ') = 'always'
            OR cardinality(v_observed) > 0
            OR v_new_domain
            OR EXISTS (SELECT 1 FROM public.signup_ledger l
                        WHERE l.network = v_network AND l.created_at > now() - interval '1 hour');
    END IF;

    IF v_ask THEN
        v_token := nullif(btrim(event #>> '{user,user_metadata,captcha_token}'), '');
        IF v_token IS NULL THEN
            INSERT INTO public.signup_captcha_counts AS c (day, asked)
            VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
            ON CONFLICT (day) DO UPDATE SET asked = c.asked + 1;
            RETURN jsonb_build_object('error', jsonb_build_object('http_code', 428, 'message', CAPTCHA_ASKED));
        END IF;
        v_verdict := public.signup_captcha_verify(v_captcha_provider, v_captcha_secret, v_token, host(v_ip));
        IF v_verdict = 'fail' THEN
            INSERT INTO public.signup_captcha_counts AS c (day, failed)
            VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
            ON CONFLICT (day) DO UPDATE SET failed = c.failed + 1;
            RETURN jsonb_build_object('error', jsonb_build_object('http_code', 428, 'message', CAPTCHA_FAILED));
        END IF;
        INSERT INTO public.signup_captcha_counts AS c (day, passed, unverified)
        VALUES ((now() AT TIME ZONE 'UTC')::date, (v_verdict = 'pass')::integer, (v_verdict <> 'pass')::integer)
        ON CONFLICT (day) DO UPDATE SET passed = c.passed + excluded.passed, unverified = c.unverified + excluded.unverified;
    END IF;

    INSERT INTO public.signup_refusal_counts AS c (day, reason, would_refuse)
    SELECT (now() AT TIME ZONE 'UTC')::date, o.reason, 1 FROM unnest(v_observed) AS o(reason)
    ON CONFLICT (day, reason) DO UPDATE SET would_refuse = c.would_refuse + 1;

    PERFORM public.purge_signup_ledger();
    INSERT INTO public.signup_ledger (network, mailbox_hash, email_domain) VALUES (v_network, v_mailbox, v_counted_domain);
    RETURN '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'before_user_created_hook: %', SQLERRM;
    RETURN '{}'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.signup_captcha_verdict(integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.signup_captcha_check(text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.signup_captcha_verify(text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_test_signup_captcha(text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_test_signup_captcha(text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.config_audit_value(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_instance_config(text, jsonb, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.batch_set_instance_config(text[], jsonb[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_instance_config(text, jsonb, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.batch_set_instance_config(text[], jsonb[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.strip_signup_captcha_token() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_signup_ledger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_signup_ledger() TO service_role;
REVOKE ALL ON FUNCTION public.before_user_created_hook(jsonb) FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT EXECUTE ON FUNCTION public.before_user_created_hook(jsonb) TO supabase_auth_admin;
    END IF;
END;
$$;

DO $$
BEGIN
    DROP TRIGGER IF EXISTS harmony_strip_captcha_token ON auth.users;
    CREATE TRIGGER harmony_strip_captcha_token BEFORE INSERT OR UPDATE ON auth.users
        FOR EACH ROW WHEN (NEW.raw_user_meta_data ? 'captcha_token')
        EXECUTE FUNCTION public.strip_signup_captcha_token();
    RAISE NOTICE 'auth.users captcha token trigger installed';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'auth.users captcha token trigger skipped: %', SQLERRM;
END;
$$;

COMMIT;
