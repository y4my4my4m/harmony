-- Fourth review of 1.9.7.
--
--   signup_captcha_check          as 20261111100001 without remoteip: an address the sign-up chooses
--                                 made hCaptcha answer invalid-remoteip, a code 20261115700001 read
--                                 as no verdict, so the token was never judged.
--   signup_captcha_verdict        as 20261115700001 without the remoteip codes.
--   before_user_created_hook      as 20261115700001; the captcha call runs after the refusals that
--                                 only read (blocked network, domain), so those cost no outbound
--                                 call, and before any row or advisory lock (the mail-host row, the
--                                 inbox, domain and network locks), so no sign-up waits on another's
--                                 provider call. The mailbox cap counts under a lock on the mailbox
--                                 hash, held to the ledger insert: concurrent sign-ups of one inbox
--                                 (+tag or dot forms) each counted none of the others.
--   purge_signup_ledger           as 20261111100001; skips rows another sign-up holds. Its delete of
--                                 a stale mail-host row waited on a sign-up that held the row and
--                                 waited on the purging sign-up's network lock: the deadlock's error
--                                 reached the hook's last handler, which lets the sign-up through.
--   bridge_remote_optouts.erase_pending
--                                 who asked for an erase with rows left: 'self' (the user's
--                                 /bridge-privacy erase) or 'manager' (a manager's or admin's
--                                 removal; the user's own request is kept over a manager's).
--                                 Every erase batch sets it from more; bot-gateway finishes pending
--                                 erases (bridge_privacy_pending) after a restart or a failed batch,
--                                 while a removal stands or, asked by the user, while they stay
--                                 opted out.
--   bridge_privacy_erase_core     as 20261115700001; one message statement per scope, each stating
--                                 its index's predicate (messages_discord_relayed_channel,
--                                 20261115800001); threads on the author's messages are renamed
--                                 again: Discord fills their title from the message; the AutoMod
--                                 alerts of erased events are deleted (messages_automod_alert_event);
--                                 `removed` counts every row a batch deleted, so a caller tells a
--                                 batch of reactions from one that found only locked rows.
--   bridge_privacy_erase_tail     continues a pending erase only while its asker's decision stands.
--   bridge_privacy_erase_continue a removal's later batches, for a manager: none once a restore
--                                 lifted the removal. Each call of bridge_privacy_remove_remote_user
--                                 put the removal back.
--   bridge_privacy_restore_remote_user
--                                 as 20261115500001; also ends the removal's pending erase.
--   bridge_privacy_purge_server   fails the server's unfinished imports, or they would bring the
--                                 content back, and resets their cursors (bridge_privacy_stop_imports):
--                                 a restart resumed past the purged history.
--   bridge_privacy_purge_instance turns history import off and does the same for every server.
--   set_category_permissions      as 20261026200001; a member row of someone no longer a member
--                                 passes when the template already holds a row for them. Every save
--                                 of a template holding such a row failed, and the editor offers no
--                                 way to remove it.
--   idx_emojis_instance_imported_from
--                                 the instance's imports by source image, for a copy's sync.
--   evict_copy_emojis             ranks the dropped rows before it filters them: rows that stay took
--                                 the places of rows that go, and rows past the window were never
--                                 read again.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.bridge_remote_optouts ADD COLUMN IF NOT EXISTS erase_pending text
    CONSTRAINT bridge_remote_optouts_erase_pending_check CHECK (erase_pending IN ('self', 'manager'));
CREATE INDEX IF NOT EXISTS idx_bridge_remote_optouts_erase_pending
    ON public.bridge_remote_optouts (created_at) WHERE erase_pending IS NOT NULL;
-- A copy's sync looks up the instance's imports of an image by their source (CopyMirrorService).
CREATE INDEX IF NOT EXISTS idx_emojis_instance_imported_from
    ON public.emojis (imported_from) WHERE scope = 'instance' AND imported_from IS NOT NULL;

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
        -- No remoteip: optional for both providers, and an address the sign-up chooses must not
        -- decide whether its token is judged (hCaptcha answers invalid-remoteip for some).
        v_body := 'secret=' || v_body;
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


REVOKE ALL ON FUNCTION public.signup_captcha_check(text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.signup_captcha_verdict(p_status integer, p_content text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_temp
AS $$
DECLARE
    -- Codes about the instance's keys or the provider itself: no verdict on the token. Turnstile:
    -- invalid-widget-id, invalid-parsed-secret (the secret). No remoteip is sent
    -- (signup_captcha_check), so an answer about one is about nothing this instance chose.
    KEY_ERRORS CONSTANT text[] := ARRAY['missing-input-secret', 'invalid-input-secret', 'internal-error',
                                        'invalid-widget-id', 'invalid-parsed-secret'];
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
    IF v_codes && KEY_ERRORS THEN
        RETURN 'error';
    END IF;
    RETURN 'fail';
END;
$$;


REVOKE ALL ON FUNCTION public.signup_captcha_verdict(integer, text) FROM PUBLIC, anon, authenticated, service_role;

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
            END IF;
        END IF;

        -- A token comes with the retry of an asked sign-up. It is checked after the refusals that
        -- read only (a blocked network or domain) and before any row or advisory lock: the provider
        -- may take up to 4 s, and concurrent sign-ups of one domain, inbox or network would wait.
        IF v_reason IS NULL AND v_captcha_on THEN
            v_token := nullif(btrim(event #>> '{user,user_metadata,captcha_token}'), '');
            IF v_token IS NOT NULL THEN
                -- A failed call (no EXECUTE for this function's owner, among others) is no verdict
                -- on the token; the checks below still run. The handler at the end would let the
                -- sign-up through with none of them.
                BEGIN
                    v_verdict := public.signup_captcha_verify(v_captcha_provider, v_captcha_secret, v_token, host(v_ip));
                EXCEPTION WHEN OTHERS THEN
                    RAISE WARNING 'before_user_created_hook: captcha check: %', SQLERRM;
                    v_verdict := 'error';
                END;
            END IF;
        END IF;

        IF v_reason IS NULL AND v_domain IS NOT NULL THEN
            IF NOT v_trusted
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
            -- Concurrent sign-ups of one inbox count in turn, to the ledger insert. Mailbox before
            -- domain before network, in every sign-up.
            PERFORM pg_advisory_xact_lock(hashtextextended('before_user_created_hook:mailbox:' || coalesce(v_mailbox, ''), 0));
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
        IF v_token IS NULL THEN
            INSERT INTO public.signup_captcha_counts AS c (day, asked)
            VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
            ON CONFLICT (day) DO UPDATE SET asked = c.asked + 1;
            RETURN jsonb_build_object('error', jsonb_build_object('http_code', 428, 'message', CAPTCHA_ASKED));
        END IF;
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


REVOKE ALL ON FUNCTION public.before_user_created_hook(jsonb) FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT EXECUTE ON FUNCTION public.before_user_created_hook(jsonb) TO supabase_auth_admin;
    END IF;
END;
$$;

-- Records an erase batch's outcome: who asked ('self' or 'manager') while rows are left, NULL
-- after. The user's own request stays recorded over a manager's: a restore does not end it.
CREATE OR REPLACE FUNCTION public.bridge_privacy_mark_pending(
    p_server_id uuid, p_platform text, p_remote_user_id text, p_asker text, p_result jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.bridge_remote_optouts o
       SET erase_pending = v.pending
      FROM (SELECT CASE WHEN NOT COALESCE((p_result ->> 'more')::boolean, false) THEN NULL
                        WHEN p_asker = 'self' OR o2.erase_pending = 'self' THEN 'self'
                        ELSE 'manager' END AS pending
              FROM public.bridge_remote_optouts o2
             WHERE o2.server_id = p_server_id AND o2.platform = p_platform
               AND o2.remote_user_id = p_remote_user_id) v
     WHERE o.server_id = p_server_id AND o.platform = p_platform AND o.remote_user_id = p_remote_user_id
       AND o.erase_pending IS DISTINCT FROM v.pending;
    SELECT p_result;
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_mark_pending(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- A pending erase continues while a manager's or admin's removal stands, or, asked by the user,
-- while the user stays opted out.
CREATE OR REPLACE FUNCTION public.bridge_privacy_erase_stands(p_row public.bridge_remote_optouts)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT p_row.erase_pending IS NOT NULL
           AND (p_row.source IN ('manager', 'admin') OR (p_row.erase_pending = 'self' AND p_row.self_opted_out));
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_erase_stands(public.bridge_remote_optouts) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bridge_privacy_erase_core(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
    v_channels uuid[];
    v_ids uuid[];
    v_notices uuid[];
    v_parents uuid[];
    v_renamed uuid[];
    v_renamed_more uuid[];
    v_federated uuid[];
    v_found integer;
    v_more boolean;
    v_reactions integer := 0;
    v_events integer := 0;
    v_event_ids uuid[];
    v_alerts integer := 0;
    v_alerts_deleted integer := 0;
    v_prev text := current_setting('harmony.silent_content_update', true);
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);

    IF p_server_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[]) INTO v_channels
          FROM public.channels c WHERE c.server_id = p_server_id;
    END IF;

    -- One statement per scope, each stating its index's predicate: messages_discord_author_idx
    -- (20261112600002) for one author, messages_discord_relayed_channel (20261115800001) for a
    -- server's relayed rows.
    IF p_remote_user_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
          FROM (SELECT m.id
                  FROM public.messages m
                 WHERE m.metadata ? 'discord_user'
                   AND m.metadata #>> '{discord_user,id}' = p_remote_user_id
                   AND (p_server_id IS NULL OR m.channel_id = ANY (v_channels))
                 LIMIT v_limit
                   FOR UPDATE SKIP LOCKED) s;
    ELSIF p_server_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
          FROM (SELECT m.id
                  FROM public.messages m
                 WHERE m.metadata ? 'discord_user'
                   AND m.channel_id = ANY (v_channels)
                 LIMIT v_limit
                   FOR UPDATE SKIP LOCKED) s;
    ELSE
        SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
          FROM (SELECT m.id
                  FROM public.messages m
                 WHERE m.metadata ? 'discord_user'
                 LIMIT v_limit
                   FOR UPDATE SKIP LOCKED) s;
    END IF;
    v_found := cardinality(v_ids);

    IF v_found > 0 THEN
        SELECT COALESCE(array_agg(m.id) FILTER (WHERE m.is_system IS TRUE), ARRAY[]::uuid[]),
               COALESCE(array_agg(m.id) FILTER (WHERE m.is_system IS NOT TRUE AND EXISTS (
                            SELECT 1 FROM public.threads t WHERE t.parent_message_id = m.id)), ARRAY[]::uuid[]),
               COALESCE(array_agg(m.id) FILTER (WHERE m.is_system IS NOT TRUE
                            AND m.is_deleted IS NOT TRUE
                            AND m.federation_status IS DISTINCT FROM 'skipped'
                            AND COALESCE(m.metadata ->> 'history_import', '') <> 'true'), ARRAY[]::uuid[])
          INTO v_notices, v_parents, v_federated
          FROM public.messages m
         WHERE m.id = ANY (v_ids);

        -- A thread's title may be the author's text: the threads they started, and the threads on
        -- their messages, whose title Discord fills from the message, are renamed. Two statements,
        -- each on an index (threads.parent_message_id, the primary key); under one OR the planner
        -- read every thread.
        WITH r AS (
            UPDATE public.threads t
               SET name = 'Thread'
             WHERE t.parent_message_id = ANY (v_parents)
            RETURNING t.id)
        SELECT COALESCE(array_agg(r.id), ARRAY[]::uuid[]) INTO v_renamed FROM r;
        WITH r AS (
            UPDATE public.threads t
               SET name = 'Thread'
             WHERE t.id IN (SELECT CASE WHEN m.metadata ->> 'thread_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                        THEN (m.metadata ->> 'thread_id')::uuid END
                              FROM public.messages m
                             WHERE m.id = ANY (v_notices) AND m.metadata ->> 'type' = 'thread_created')
            RETURNING t.id)
        SELECT COALESCE(array_agg(r.id), ARRAY[]::uuid[]) INTO v_renamed_more FROM r;
        v_renamed := v_renamed || v_renamed_more;

        PERFORM set_config('harmony.silent_content_update', 'true', true);
        UPDATE public.messages m
           SET metadata = (m.metadata - 'discord_user')
                          || CASE WHEN m.metadata ->> 'type' = 'thread_created'
                                  THEN jsonb_build_object('thread_name', 'Thread') ELSE '{}'::jsonb END
         WHERE m.id = ANY (v_notices);
        -- The notices of the renamed threads others started repeat the title
        -- (messages_thread_created_notice).
        IF cardinality(v_renamed) > 0 THEN
            UPDATE public.messages m
               SET metadata = m.metadata || jsonb_build_object('thread_name', 'Thread')
             WHERE m.metadata ->> 'type' = 'thread_created'
               AND m.metadata ->> 'thread_id' = ANY (SELECT x::text FROM unnest(v_renamed) x)
               AND m.metadata ->> 'thread_name' IS DISTINCT FROM 'Thread';
        END IF;
        PERFORM set_config('harmony.silent_content_update', COALESCE(v_prev, ''), true);

        -- Notifications quoting an erased message carry its text and its author's name and picture
        -- (idx_notifications_message_id).
        DELETE FROM public.notifications n
         WHERE n.data ? 'message_id'
           AND n.data ->> 'message_id' = ANY (
                   SELECT x::text FROM unnest(v_ids) x WHERE NOT (x = ANY (v_notices)));

        -- Queues the federated Delete of each row that federated.
        UPDATE public.messages m
           SET is_deleted = true
         WHERE m.id = ANY (v_federated);

        UPDATE public.messages m
           SET is_deleted = true,
               content = '[{"type": "text", "text": ""}]'::jsonb,
               metadata = jsonb_build_object('bridge_erased', true)
                          || jsonb_strip_nulls(jsonb_build_object(
                                 'bot', m.metadata -> 'bot',
                                 'created_via', m.metadata -> 'created_via',
                                 'history_import', m.metadata -> 'history_import'))
         WHERE m.id = ANY (v_parents);

        DELETE FROM public.messages m
         WHERE m.id = ANY (v_ids)
           AND NOT (m.id = ANY (v_notices))
           AND NOT (m.id = ANY (v_parents));
    END IF;

    -- SKIP LOCKED passes over a row another transaction holds: a short batch is the last only
    -- when no row of the author is left.
    v_more := v_found >= v_limit;
    IF NOT v_more THEN
        IF p_remote_user_id IS NOT NULL THEN
            v_more := EXISTS (SELECT 1 FROM public.messages m
                               WHERE m.metadata ? 'discord_user'
                                 AND m.metadata #>> '{discord_user,id}' = p_remote_user_id
                                 AND (p_server_id IS NULL OR m.channel_id = ANY (v_channels)));
        ELSIF p_server_id IS NOT NULL THEN
            v_more := EXISTS (SELECT 1 FROM public.messages m
                               WHERE m.metadata ? 'discord_user' AND m.channel_id = ANY (v_channels));
        ELSE
            v_more := EXISTS (SELECT 1 FROM public.messages m WHERE m.metadata ? 'discord_user');
        END IF;
    END IF;

    -- Reactions and AutoMod events once the messages are gone, `limit` of each per call. Each
    -- statement states the predicate of idx_reactions_discord_author or
    -- idx_automod_events_author_key (20261115600001), so a batch reads the author's rows only.
    IF NOT v_more THEN
        IF p_remote_user_id IS NOT NULL AND p_server_id IS NOT NULL THEN
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? 'discord_user'
                               AND r2.channel_id = ANY (v_channels)
                               AND r2.metadata #>> '{discord_user,id}' = p_remote_user_id
                             LIMIT v_limit);
        ELSIF p_remote_user_id IS NOT NULL THEN
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? 'discord_user'
                               AND r2.metadata #>> '{discord_user,id}' = p_remote_user_id
                             LIMIT v_limit);
        ELSIF p_server_id IS NOT NULL THEN
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? 'discord_user'
                               AND r2.channel_id = ANY (v_channels)
                             LIMIT v_limit);
        ELSE
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? 'discord_user'
                             LIMIT v_limit);
        END IF;
        GET DIAGNOSTICS v_reactions = ROW_COUNT;

        IF p_remote_user_id IS NOT NULL THEN
            WITH gone AS (
                DELETE FROM public.automod_events e
                 WHERE e.id IN (SELECT e2.id FROM public.automod_events e2
                                 WHERE e2.details ? 'author_key'
                                   AND (p_server_id IS NULL OR e2.server_id = p_server_id)
                                   AND e2.details ->> 'author_key' = 'discord:' || p_remote_user_id
                                 LIMIT v_limit)
                RETURNING e.id)
            SELECT COALESCE(array_agg(gone.id), ARRAY[]::uuid[]) INTO v_event_ids FROM gone;
        ELSE
            WITH gone AS (
                DELETE FROM public.automod_events e
                 WHERE e.id IN (SELECT e2.id FROM public.automod_events e2
                                 WHERE e2.details ? 'author_key'
                                   AND (p_server_id IS NULL OR e2.server_id = p_server_id)
                                   AND e2.details ->> 'author_key' LIKE 'discord:%'
                                 LIMIT v_limit)
                RETURNING e.id)
            SELECT COALESCE(array_agg(gone.id), ARRAY[]::uuid[]) INTO v_event_ids FROM gone;
        END IF;
        v_events := cardinality(v_event_ids);
        -- The alerts AutoMod posted for these events quote the author's name and text
        -- (automod_post_alert; messages_automod_alert_event). An alert a thread starts on stays as
        -- an empty deleted row, so the thread and its replies stay; the others go.
        IF v_events > 0 THEN
            UPDATE public.messages m
               SET is_deleted = true,
                   content = '[{"type": "text", "text": ""}]'::jsonb,
                   metadata = jsonb_build_object('bridge_erased', true)
             WHERE m.metadata ->> 'type' = 'automod_alert'
               AND m.metadata #>> '{automod,event_id}' = ANY (SELECT x::text FROM unnest(v_event_ids) x)
               AND EXISTS (SELECT 1 FROM public.threads t WHERE t.parent_message_id = m.id);
            GET DIAGNOSTICS v_alerts = ROW_COUNT;
            DELETE FROM public.messages m
             WHERE m.metadata ->> 'type' = 'automod_alert'
               AND m.metadata #>> '{automod,event_id}' = ANY (SELECT x::text FROM unnest(v_event_ids) x);
            GET DIAGNOSTICS v_alerts_deleted = ROW_COUNT;
            v_alerts := v_alerts + v_alerts_deleted;
        END IF;
        v_more := v_reactions >= v_limit OR v_events >= v_limit;

        IF NOT v_more THEN
            UPDATE public.discord_bridge_imports i
               SET requested_by_remote = NULL
             WHERE i.requested_by_remote IS NOT NULL
               AND (p_remote_user_id IS NULL OR i.requested_by_remote ->> 'id' = p_remote_user_id)
               AND (p_server_id IS NULL OR i.bridge_id IN (
                        SELECT b.id FROM public.discord_bridges b WHERE b.server_id = p_server_id));
        END IF;
    END IF;

    -- erased: messages; removed: every row deleted or emptied, reactions, events and alerts too.
    RETURN jsonb_build_object('erased', v_found, 'more', v_more,
                              'removed', v_found + v_reactions + v_events + v_alerts);
END;
$$;


REVOKE ALL ON FUNCTION public.bridge_privacy_erase_core(uuid, text, text, integer)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bridge_privacy_erase(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_server_id IS NULL OR p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.bridge_remote_optouts AS o (server_id, platform, remote_user_id, source, self_opted_out)
    VALUES (p_server_id, p_platform, p_remote_user_id, 'self', true)
    ON CONFLICT (server_id, platform, remote_user_id)
        DO UPDATE SET self_opted_out = true WHERE NOT o.self_opted_out;
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN jsonb_build_object('opted_out', true)
           || public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id, 'self',
                  public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, p_limit));
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_erase_tail(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.bridge_remote_optouts;
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_server_id IS NULL OR p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    -- The batches after the first, while the asker's decision stands: an opt-in or a restore
    -- meanwhile ends the erase, and is not undone.
    SELECT o.* INTO v_row FROM public.bridge_remote_optouts o
     WHERE o.server_id = p_server_id AND o.platform = p_platform AND o.remote_user_id = p_remote_user_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('opted_out', false, 'erased', 0, 'more', false);
    END IF;
    IF NOT public.bridge_privacy_erase_stands(v_row) THEN
        UPDATE public.bridge_remote_optouts o
           SET erase_pending = NULL
         WHERE o.server_id = p_server_id AND o.platform = p_platform
           AND o.remote_user_id = p_remote_user_id AND o.erase_pending IS NOT NULL;
        RETURN jsonb_build_object('opted_out', true, 'erased', 0, 'more', false);
    END IF;
    RETURN jsonb_build_object('opted_out', true)
           || public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id, v_row.erase_pending,
                  public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, p_limit));
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_remove_remote_user(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_admin boolean := public.is_current_user_admin();
BEGIN
    IF NOT (v_admin OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can remove a bridged user' USING ERRCODE = '42501';
    END IF;
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    -- The row records the manager's removal beside the user's own opt-out (self_opted_out), which
    -- stays: each is lifted by its own side.
    INSERT INTO public.bridge_remote_optouts AS o (server_id, platform, remote_user_id, source, created_by)
    VALUES (p_server_id, p_platform, p_remote_user_id,
            CASE WHEN public.can_manage_discord_bridge(p_server_id) THEN 'manager' ELSE 'admin' END,
            public.get_current_profile_id())
    ON CONFLICT (server_id, platform, remote_user_id)
        DO UPDATE SET source = EXCLUDED.source, created_by = EXCLUDED.created_by WHERE o.source = 'self';
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id, 'manager',
               public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, 200));
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_erase_continue(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT (public.is_current_user_admin() OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can remove a bridged user' USING ERRCODE = '42501';
    END IF;
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    -- The batches after a removal's first, while the removal stands: a restore ends them, and a
    -- user who only opted out is not erased from here.
    IF NOT EXISTS (SELECT 1 FROM public.bridge_remote_optouts o
                    WHERE o.server_id = p_server_id AND o.platform = p_platform
                      AND o.remote_user_id = p_remote_user_id AND o.source IN ('manager', 'admin')) THEN
        RETURN jsonb_build_object('erased', 0, 'more', false);
    END IF;
    RETURN public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id, 'manager',
               public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, 200));
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_erase_continue(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.bridge_privacy_erase_continue(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.bridge_privacy_pending(p_limit integer DEFAULT 50)
RETURNS TABLE (server_id uuid, platform text, remote_user_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT o.server_id, o.platform, o.remote_user_id
      FROM public.bridge_remote_optouts o
     WHERE o.erase_pending IS NOT NULL
       AND public.bridge_privacy_erase_stands(o)
     ORDER BY o.created_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_pending(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_privacy_pending(integer) TO service_role;

-- After a purge (p_server_id NULL: every server): unfinished imports fail with p_error, or they
-- would bring the content back, and every import that is not done starts over at its next start:
-- its cursors marked the purged history as imported. A done import starts over anyway
-- (discord_bridge_import_start_internal).
CREATE OR REPLACE FUNCTION public.bridge_privacy_stop_imports(p_server_id uuid, p_error text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.discord_bridge_imports i
       SET state = CASE WHEN i.state IN ('queued', 'running', 'paused') THEN 'failed' ELSE i.state END,
           error = CASE WHEN i.state IN ('queued', 'running', 'paused') THEN p_error ELSE i.error END,
           finished_at = CASE WHEN i.state IN ('queued', 'running', 'paused') THEN now() ELSE i.finished_at END,
           phase = 'messages',
           cancel_requested = false,
           start_discord_message_id = NULL,
           start_at = NULL,
           reached_discord_message_id = NULL,
           reached_at = NULL,
           channel_created_at = NULL,
           threads_total = NULL,
           threads_done = 0,
           thread_cursor = NULL,
           imported_count = 0,
           skipped_count = 0,
           pins_skipped = 0,
           authors_skipped = 0,
           automod_skipped = 0,
           updated_at = now()
     WHERE i.state <> 'done'
       AND (p_server_id IS NULL
            OR i.bridge_id IN (SELECT b.id FROM public.discord_bridges b WHERE b.server_id = p_server_id))
       AND (i.state IN ('queued', 'running', 'paused') OR i.phase <> 'messages'
            OR i.reached_discord_message_id IS NOT NULL OR i.start_discord_message_id IS NOT NULL
            OR i.thread_cursor IS NOT NULL OR i.imported_count <> 0);
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_stop_imports(uuid, text) FROM PUBLIC, anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.bridge_privacy_restore_remote_user(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
    v_kept integer;
BEGIN
    IF NOT (public.is_current_user_admin() OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can restore a bridged user' USING ERRCODE = '42501';
    END IF;
    -- Lifts the manager's or admin's removal and its pending erase; the user's own opt-out stays as
    -- a self row, with an erase the user asked for.
    DELETE FROM public.bridge_remote_optouts o
     WHERE o.server_id = p_server_id AND o.platform = p_platform
       AND o.remote_user_id = p_remote_user_id AND o.source <> 'self' AND NOT o.self_opted_out;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    UPDATE public.bridge_remote_optouts o
       SET source = 'self', created_by = NULL,
           erase_pending = NULLIF(o.erase_pending, 'manager')
     WHERE o.server_id = p_server_id AND o.platform = p_platform
       AND o.remote_user_id = p_remote_user_id AND o.source <> 'self' AND o.self_opted_out;
    GET DIAGNOSTICS v_kept = ROW_COUNT;
    IF v_count > 0 THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN v_count + v_kept > 0;
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_purge_server(p_server_id uuid, p_platform text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_server_id IS NULL
       OR NOT (public.is_current_user_admin() OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can remove its bridged messages' USING ERRCODE = '42501';
    END IF;
    PERFORM public.bridge_privacy_stop_imports(p_server_id, 'server_purged');
    RETURN public.bridge_privacy_erase_core(p_server_id, p_platform, NULL, 200);
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_purge_instance(p_platform text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Only instance admins can remove every bridged message' USING ERRCODE = '42501';
    END IF;
    -- The instance stops holding Discord content: history import goes off and every unfinished
    -- import fails, or it would bring the content back.
    UPDATE public.instance_config c
       SET config_value = '"off"'::jsonb
     WHERE c.config_key = 'bridge_history_import' AND c.config_value IS DISTINCT FROM '"off"'::jsonb;
    PERFORM public.bridge_privacy_stop_imports(NULL, 'instance_purged');
    RETURN public.bridge_privacy_erase_core(NULL, p_platform, NULL, 200);
END;
$$;


CREATE OR REPLACE FUNCTION public.evict_copy_emojis(p_server_id uuid, p_keep integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server IS FALSE) THEN
        RETURN 0;
    END IF;
    -- Emojis the copy's list dropped (deleted_by NULL), past the most recent p_keep, at most 1000 a
    -- call. A row inserted within the hour stays, so the copy's hourly insert count holds; a row
    -- something names (a reaction, a post reaction, a sound, an import) stays, as rows a copy took
    -- over from the activity cache are named elsewhere. Rows are ranked first and filtered after,
    -- so rows that stay do not take the places of rows that go.
    WITH ranked AS (
        SELECT e.id, e.created_at,
               row_number() OVER (ORDER BY e.deleted_at DESC, e.id) AS rn
          FROM public.emojis e
         WHERE e.server_id = p_server_id AND e.ap_id IS NOT NULL
           AND e.deleted_at IS NOT NULL AND e.deleted_by IS NULL
    ),
    evictable AS (
        SELECT r.id
          FROM ranked r
         WHERE r.rn > GREATEST(COALESCE(p_keep, 0), 0)
           AND r.created_at < now() - interval '1 hour'
           AND NOT EXISTS (SELECT 1 FROM public.reactions x WHERE x.emoji_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM public.post_interactions pi WHERE pi.emoji_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM public.server_sounds ss WHERE ss.emoji_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM public.remote_emojis_cache c WHERE c.imported_as = r.id)
         LIMIT 1000
    )
    DELETE FROM public.emojis e
     USING evictable v
     WHERE e.id = v.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;


CREATE OR REPLACE FUNCTION public.set_category_permissions(p_category_id uuid, p_overrides jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_server uuid;
    v_local boolean;
    v_outranks boolean;
    v_rows jsonb := '[]'::jsonb;
    v_seen text[] := '{}';
    v_el jsonb;
    v_type text;
    v_role uuid;
    v_user uuid;
    v_allow bigint;
    v_deny bigint;
    v_key text;
    v_bits bigint;
    v_synced uuid[];
    v_channel uuid;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT k.server_id, s.is_local_server INTO v_server, v_local
      FROM public.channel_categories k
      JOIN public.servers s ON s.id = k.server_id
     WHERE k.id = p_category_id;
    IF v_server IS NULL THEN
        RAISE EXCEPTION 'CATEGORY_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_local IS FALSE THEN
        RAISE EXCEPTION 'CATEGORY_REMOTE: a remote server''s category takes no permissions here'
            USING ERRCODE = '22023';
    END IF;

    v_outranks := public.caller_outranks_all(v_server);
    IF NOT v_outranks
       AND NOT public.has_permission(v_me, v_server, 'MANAGE_ROLES')
       AND NOT public.has_permission(v_me, v_server, 'MANAGE_CHANNELS') THEN
        RAISE EXCEPTION 'CATEGORY_NOT_MANAGEABLE: MANAGE_CHANNELS or MANAGE_ROLES required'
            USING ERRCODE = '42501';
    END IF;

    IF jsonb_typeof(p_overrides) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'overrides is an array' USING ERRCODE = '22023';
    END IF;

    FOR v_el IN SELECT e.value FROM jsonb_array_elements(p_overrides) e LOOP
        IF jsonb_typeof(v_el) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'an override is an object' USING ERRCODE = '22023';
        END IF;
        v_type := v_el->>'target_type';
        BEGIN
            v_role := NULLIF(v_el->>'role_id', '')::uuid;
            v_user := NULLIF(v_el->>'user_id', '')::uuid;
            v_allow := COALESCE(NULLIF(v_el->>'allow_permissions', ''), '0')::bigint;
            v_deny := COALESCE(NULLIF(v_el->>'deny_permissions', ''), '0')::bigint;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RAISE EXCEPTION 'an override names a uuid target and integer masks' USING ERRCODE = '22023';
        END;

        IF v_type = 'role' THEN
            IF v_role IS NULL OR v_user IS NOT NULL THEN
                RAISE EXCEPTION 'a role override names role_id alone' USING ERRCODE = '22023';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM public.server_roles r
                            WHERE r.id = v_role AND r.server_id = v_server) THEN
                RAISE EXCEPTION 'Role % is not a role of this server', v_role USING ERRCODE = '22023';
            END IF;
            v_key := 'role:' || v_role;
        ELSIF v_type = 'user' THEN
            IF v_user IS NULL OR v_role IS NOT NULL THEN
                RAISE EXCEPTION 'a member override names user_id alone' USING ERRCODE = '22023';
            END IF;
            -- A row of someone who left stays as the template holds it, or changes: the editor sends
            -- the whole template, and dropping it would lift a deny if they came back. Only a new
            -- row needs a member.
            IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                            WHERE us.user_id = v_user AND us.server_id = v_server AND us.status = 'accepted')
               AND NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = v_server AND s.owner = v_user)
               AND NOT EXISTS (SELECT 1 FROM public.channel_category_permission_overrides t
                                WHERE t.category_id = p_category_id AND t.user_id = v_user) THEN
                RAISE EXCEPTION 'User % is not a member of this server', v_user USING ERRCODE = '22023';
            END IF;
            v_key := 'user:' || v_user;
        ELSE
            RAISE EXCEPTION 'target_type is role or user' USING ERRCODE = '22023';
        END IF;

        IF v_allow < 0 OR v_deny < 0 OR (v_allow & v_deny) <> 0 THEN
            RAISE EXCEPTION 'allow and deny are non-negative masks with no bit in both' USING ERRCODE = '22023';
        END IF;
        IF v_key = ANY (v_seen) THEN
            RAISE EXCEPTION 'one override per role or member' USING ERRCODE = '22023';
        END IF;
        v_seen := v_seen || v_key;
        CONTINUE WHEN v_allow = 0 AND v_deny = 0;

        v_rows := v_rows || jsonb_build_object(
            'target_type', v_type, 'role_id', v_role, 'user_id', v_user,
            'allow_permissions', v_allow, 'deny_permissions', v_deny);
    END LOOP;

    -- Allowed bits new to the template, against the caller's server permissions.
    IF NOT v_outranks THEN
        SELECT COALESCE(bit_or(x.allow_permissions & ~COALESCE(t.allow_permissions, 0)), 0) INTO v_bits
          FROM jsonb_to_recordset(v_rows) AS x(role_id uuid, user_id uuid, allow_permissions bigint)
          LEFT JOIN public.channel_category_permission_overrides t
            ON t.category_id = p_category_id
           AND t.role_id IS NOT DISTINCT FROM x.role_id
           AND t.user_id IS NOT DISTINCT FROM x.user_id;
        PERFORM public.assert_grantable_bits(public.get_user_permissions(v_me, v_server), v_bits);
    END IF;

    SELECT COALESCE(array_agg(c.id ORDER BY c."order", c.id), '{}'::uuid[]) INTO v_synced
      FROM public.channels c
     WHERE c.category = p_category_id
       AND public.channel_permissions_synced(c.id) IS TRUE;

    FOREACH v_channel IN ARRAY v_synced LOOP
        PERFORM public.assert_category_template_writable(v_channel, p_category_id, v_rows);
    END LOOP;

    DELETE FROM public.channel_category_permission_overrides t
     WHERE t.category_id = p_category_id
       AND NOT EXISTS (
            SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(role_id uuid, user_id uuid)
             WHERE x.role_id IS NOT DISTINCT FROM t.role_id
               AND x.user_id IS NOT DISTINCT FROM t.user_id);

    UPDATE public.channel_category_permission_overrides t
       SET allow_permissions = x.allow_permissions,
           deny_permissions = x.deny_permissions,
           updated_at = now()
      FROM jsonb_to_recordset(v_rows) AS x(role_id uuid, user_id uuid, allow_permissions bigint, deny_permissions bigint)
     WHERE t.category_id = p_category_id
       AND x.role_id IS NOT DISTINCT FROM t.role_id
       AND x.user_id IS NOT DISTINCT FROM t.user_id
       AND (t.allow_permissions, t.deny_permissions) IS DISTINCT FROM (x.allow_permissions, x.deny_permissions);

    INSERT INTO public.channel_category_permission_overrides
           (category_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
    SELECT p_category_id, x.target_type, x.role_id, x.user_id, x.allow_permissions, x.deny_permissions
      FROM jsonb_to_recordset(v_rows)
           AS x(target_type text, role_id uuid, user_id uuid, allow_permissions bigint, deny_permissions bigint)
     WHERE NOT EXISTS (
            SELECT 1 FROM public.channel_category_permission_overrides t
             WHERE t.category_id = p_category_id
               AND t.role_id IS NOT DISTINCT FROM x.role_id
               AND t.user_id IS NOT DISTINCT FROM x.user_id);

    FOREACH v_channel IN ARRAY v_synced LOOP
        PERFORM public.apply_category_permissions(v_channel, p_category_id);
    END LOOP;

    RETURN jsonb_build_object('category_id', p_category_id, 'synced_channel_ids', to_jsonb(v_synced));
END;
$$;


CREATE OR REPLACE FUNCTION public.purge_signup_ledger()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- SKIP LOCKED: a sign-up in flight holds rows (its mail-host row) while it waits on advisory
    -- locks the caller holds. What is skipped goes at a later purge.
    UPDATE public.signup_ledger l SET network = NULL, email_domain = NULL
     WHERE l.ctid IN (SELECT x.ctid FROM public.signup_ledger x
                       WHERE (x.network IS NOT NULL OR x.email_domain IS NOT NULL)
                         AND x.created_at <= now() - interval '24 hours'
                         FOR UPDATE SKIP LOCKED);
    DELETE FROM public.signup_ledger l
     WHERE l.ctid IN (SELECT x.ctid FROM public.signup_ledger x
                       WHERE x.created_at <= now() - interval '30 days'
                         FOR UPDATE SKIP LOCKED);
    DELETE FROM public.signup_refusal_counts WHERE day < current_date - 90;
    DELETE FROM public.signup_captcha_counts WHERE day < current_date - 90;
    DELETE FROM public.signup_mail_hosts m
     WHERE m.ctid IN (SELECT x.ctid FROM public.signup_mail_hosts x
                       WHERE coalesce(x.checked_at, x.created_at) < now() - interval '30 days'
                         FOR UPDATE SKIP LOCKED);
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
