-- Follow-ups of 1.9.7 review: report alerts, sign-up captcha, emoji lookups, profile metadata.
--
--   notify_report_moderators   as 20261111600001; has_permission runs only for the members a role
--                              could give MANAGE_MESSAGES or ADMINISTRATOR, not for every member of
--                              the server inside the reporter's insert.
--   before_user_created_hook   as 20261111100001; a captcha token is checked before the per-domain
--                              and per-network advisory locks, which the provider's answer (4 s at
--                              most) held for every concurrent sign-up of one network.
--   idx_emojis_url             hash index: inbound reactions and copies find emoji rows by image url.
--                              Hash, not btree: a btree entry is limited to about 2.7 KB, a url
--                              may be longer.
--   profiles.federation_metadata
--                              rows stored as a JSON-encoded string (Update(Person) before 1.9.7)
--                              become the object they encode; readers use -> on an object. A string
--                              that does not encode an object becomes {}. Triggers stay off for it.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.notify_report_moderators()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ids uuid[];
    v_server_name text;
BEGIN
    IF NEW.scope_server_id IS NOT NULL THEN
        SELECT s.name INTO v_server_name FROM public.servers s WHERE s.id = NEW.scope_server_id;
        -- has_permission runs for the members a role could give MANAGE_MESSAGES or ADMINISTRATOR
        -- (bits 21 and 0, 2097153): every accepted member when @everyone holds one of them.
        SELECT array_agg(u) INTO v_ids
          FROM (SELECT s.owner AS u FROM public.servers s WHERE s.id = NEW.scope_server_id
                UNION
                SELECT c.user_id
                  FROM (SELECT us.user_id
                          FROM public.user_servers us
                         WHERE us.server_id = NEW.scope_server_id
                           AND us.status = 'accepted'
                           AND EXISTS (SELECT 1 FROM public.server_roles sr
                                        WHERE sr.server_id = NEW.scope_server_id AND sr.is_default IS TRUE
                                          AND (COALESCE(sr.permissions, 0) & 2097153) <> 0)
                        UNION
                        SELECT ur.user_id
                          FROM public.user_roles ur
                          JOIN public.server_roles sr ON sr.id = ur.role_id
                         WHERE ur.server_id = NEW.scope_server_id
                           AND sr.server_id = NEW.scope_server_id
                           AND (COALESCE(sr.permissions, 0) & 2097153) <> 0) c
                 WHERE public.has_permission(c.user_id, NEW.scope_server_id, 'MANAGE_MESSAGES', NULL)) m;
    ELSE
        SELECT array_agg(p.id) INTO v_ids
          FROM public.profiles p
         WHERE p.is_admin IS TRUE OR p.is_moderator IS TRUE;
    END IF;

    v_ids := public.report_alert_recipients(COALESCE(v_ids, '{}'::uuid[]), NEW);
    IF cardinality(v_ids) = 0 THEN
        RETURN NULL;
    END IF;

    -- p_server_id stays NULL: a muted server does not hide its reports from its moderators.
    PERFORM public.send_notification(
        'report_created',
        v_ids,
        jsonb_strip_nulls(jsonb_build_object(
            'report_id', NEW.id,
            'report_type', NEW.report_type,
            'category', NEW.category,
            'reason', NEW.reason,
            'source', NEW.source,
            'source_instance', NEW.source_instance,
            'scope', CASE WHEN NEW.scope_server_id IS NULL THEN 'instance' ELSE 'server' END,
            'report_server_id', NEW.scope_server_id,
            'report_server_name', v_server_name)));
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_report_moderators: report %: %', NEW.id, SQLERRM;
    RETURN NULL;
END;
$$;


REVOKE ALL ON FUNCTION public.notify_report_moderators() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_report_moderators() TO service_role;

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

    -- A token comes with the retry of an asked sign-up. It is checked before the advisory locks
    -- below: the provider may take up to 4 s, and concurrent sign-ups of one network wait on them.
    IF v_captcha_on THEN
        v_token := nullif(btrim(event #>> '{user,user_metadata,captcha_token}'), '');
        IF v_token IS NOT NULL THEN
            v_verdict := public.signup_captcha_verify(v_captcha_provider, v_captcha_secret, v_token, host(v_ip));
        END IF;
    END IF;

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

CREATE INDEX IF NOT EXISTS idx_emojis_url ON public.emojis USING hash (url);

DO $$
DECLARE
    r record;
    v jsonb;
    v_quiet boolean := false;
BEGIN
    -- The rows convert with their triggers off (session_replication_role replica, superuser only):
    -- broadcast_profile_change would send profile:updated to every server of each profile, and
    -- clients would read each one again. Without a superuser the triggers run.
    BEGIN
        PERFORM set_config('session_replication_role', 'replica', true);
        v_quiet := true;
    EXCEPTION WHEN insufficient_privilege THEN
        v_quiet := false;
    END;
    FOR r IN
        SELECT p.id, p.federation_metadata #>> '{}' AS encoded
          FROM public.profiles p
         WHERE jsonb_typeof(p.federation_metadata) = 'string'
    LOOP
        -- Any string that does not parse (\u0000 escapes raise 22P05, deep nesting 54001) becomes {}.
        BEGIN
            v := r.encoded::jsonb;
        EXCEPTION WHEN OTHERS THEN
            v := NULL;
        END;
        UPDATE public.profiles
           SET federation_metadata = CASE WHEN jsonb_typeof(v) = 'object' THEN v ELSE '{}'::jsonb END
         WHERE id = r.id;
    END LOOP;
    IF v_quiet THEN
        PERFORM set_config('session_replication_role', 'origin', true);
    END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
