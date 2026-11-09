-- Instance-level sign-up limits: GoTrue's before-user-created hook.
--
-- GoTrue calls public.before_user_created_hook(event) before it creates an account
-- (internal/hooks/v0hooks/v0hooks.go, supabase/auth v2.197.0):
--   event    {"metadata": {"ip_address": text}, "user": {"email": text, "app_metadata": {"provider": text}}}
--   {}       the account is created
--   {"error": {"http_code": n, "message": text}}
--            refused; n and message reach the client. The hook's transaction commits first,
--            so a refusal keeps what it wrote.
--
-- Exempt:
--   address absent, unparsable or private
--            the instance itself (invitations, the harmony CLI, federation backend through
--            Kong) or its LAN. A public request carries the client's address in Sb-Forwarded-For.
--   provider custom:* or sso:*
--            the instance's own identity provider vouches for its people, an office behind one
--            address included. signup_limit_own_providers true counts them as below.
-- GoTrue calls the hook on /callback only for a sign-in that would create an account. Any other
-- provider (Google, GitHub, Twitch) meets ip_cap alone: its own account is the cost otherwise.
--
-- Rules, in order; refusals are counted per day in signup_refusal_counts.refusals. domain_cap and
-- ip_cap observe unless signup_enforce_caps is on: the account is allowed and
-- signup_refusal_counts.would_refuse counts it, because a campus or an office shares one address or
-- one domain. Setting one cap to 0 enforces the other alone.
--   blocked_domain (422)  address at a domain of signup_disposable_domains while
--                         signup_block_disposable_email is on, or of the JSON array
--                         signup_blocked_email_domains. A subdomain matches its parent.
--   mail_host (422)       a mail server (MX) of the address's domain is at a host of
--                         signup_disposable_mail_hosts while signup_block_disposable_email is on,
--                         or of the JSON array signup_blocked_mail_hosts. A listed host matches its
--                         subdomains. Not read for signup_common_email_domains.
--   mailbox_cap (422)     signup_mailbox_cap accounts per inbox in 30 days. An inbox is the
--                         address without its +tag; Gmail ignores dots and googlemail.com is
--                         gmail.com.
--   domain_cap (429)      signup_daily_domain_cap accounts per email domain in a rolling 24 hours,
--                         but for the domains of signup_common_email_domains. A subdomain is a
--                         domain of its own here.
--   ip_cap (429)          signup_daily_ip_cap accounts per network in a rolling 24 hours. A
--                         network is the IPv4 address or the IPv6 /56, which holds a host
--                         rotating within its /64. Not refused while five or more accounts have
--                         a session on that network in 30 days and no session is on any other
--                         public address: that is a proxy Caddy cannot see past, or one
--                         household, and no operator step is needed for either.
-- signup_trusted_email_domains (a subdomain matches its parent) are not counted and not refused by
-- signup_disposable_domains or a mail host. signup_blocked_email_domains still refuses them, and
-- mailbox_cap applies.
--
-- signup_mail_hosts holds the MX hosts of domains the hook has met. Postgres has no resolver: the
-- hook queues a signup-mail-host job and the federation worker writes the answer. Until it lands, a
-- sign-up on a new domain passes. A result older than 7 days queues a lookup at the next sign-up;
-- rows with no lookup for 30 days are purged.
-- A cap of 0 is no cap. signup_limits_enabled false allows everything. The keys stay out of
-- public_instance_config_keys(): admins read them. No instance-wide cap: 56 sign-ups on varied
-- domains in one day on prod (2026-11-05) were legitimate.
--
-- Measured case, prod 2026-11-08: 54 accounts in 2.5 hours, 54 of 58 POST /signup from one IPv6,
-- 51 distinct mailboxes on one domain, peak 28 an hour, each email confirmed in 10-15 s. GoTrue's
-- per-IP /signup limit (30 per 5 minutes) does not reach that pace.
--
-- Measured case, prod 2026-11-09: 30 accounts from one IPv4 in 45 s on six domains, then 372
-- addresses with one POST each in 9 minutes, then 7 accounts on those domains. No account sent
-- anything.
--
-- Measured, prod 2026-11-09, 591 accounts on 134 domains: 69 accounts on 3 domains take mail at
-- erinn.biz (kuku.lu), and none has sent a message.
--
-- signup_ledger holds one row per allowed account, with no link to it. network and email_domain
-- are erased after 24 hours, the row after 30 days, by purge_signup_ledger: hourly under pg_cron
-- and on every allowed sign-up.
--
-- An internal failure allows the account: these limits are abuse control, and an error here
-- would refuse every sign-up.
--
-- The hook runs once the auth service has GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED and _URI. Enabled
-- ahead of this migration, every sign-up answers 500.
--
-- 20261109100002 fills signup_disposable_domains and signup_disposable_mail_hosts.
--
-- guard_local_username: as 20261031900001, plus brand and platform names (src/utils/usernameRules.ts,
-- self-host/lib.sh). They read as official and are what a bulk creator takes first; the 2026-11-08
-- case took 14 of them. Rows written before this migration keep their names.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.signup_ledger (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    network cidr,
    mailbox_hash text,
    email_domain text
);
COMMENT ON TABLE public.signup_ledger IS
    'One row per account the sign-up hook allowed; no link to the account. network and email_domain erased after 24 hours, rows after 30 days.';

CREATE INDEX IF NOT EXISTS signup_ledger_network_idx ON public.signup_ledger (network, created_at)
    WHERE network IS NOT NULL;
CREATE INDEX IF NOT EXISTS signup_ledger_email_domain_idx ON public.signup_ledger (email_domain, created_at)
    WHERE email_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS signup_ledger_mailbox_idx ON public.signup_ledger (mailbox_hash, created_at);
CREATE INDEX IF NOT EXISTS signup_ledger_created_at_idx ON public.signup_ledger (created_at);

REVOKE ALL ON public.signup_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.signup_ledger TO service_role;
ALTER TABLE public.signup_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_ledger_service_role ON public.signup_ledger;
CREATE POLICY signup_ledger_service_role ON public.signup_ledger
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.signup_refusal_counts (
    day date NOT NULL,
    reason text NOT NULL CONSTRAINT signup_refusal_counts_reason_check
        CHECK (reason IN ('blocked_domain', 'mail_host', 'mailbox_cap', 'domain_cap', 'ip_cap')),
    refusals integer NOT NULL DEFAULT 0,
    would_refuse integer NOT NULL DEFAULT 0,
    PRIMARY KEY (day, reason)
);
COMMENT ON TABLE public.signup_refusal_counts IS
    'Sign-ups the hook refused (refusals) and those past an observing cap it allowed (would_refuse), per UTC day and reason. Kept 90 days.';

REVOKE ALL ON public.signup_refusal_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.signup_refusal_counts TO authenticated;
GRANT ALL ON public.signup_refusal_counts TO service_role;
ALTER TABLE public.signup_refusal_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_refusal_counts_admin_read ON public.signup_refusal_counts;
CREATE POLICY signup_refusal_counts_admin_read ON public.signup_refusal_counts
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin()));

CREATE TABLE IF NOT EXISTS public.signup_disposable_domains (
    domain text PRIMARY KEY
);
COMMENT ON TABLE public.signup_disposable_domains IS
    'Disposable email domains signup_block_disposable_email refuses. An instance adds its own in signup_blocked_email_domains.';

REVOKE ALL ON public.signup_disposable_domains FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.signup_disposable_domains TO service_role;
ALTER TABLE public.signup_disposable_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_disposable_domains_service_role ON public.signup_disposable_domains;
CREATE POLICY signup_disposable_domains_service_role ON public.signup_disposable_domains
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.signup_disposable_mail_hosts (
    host text PRIMARY KEY
);
COMMENT ON TABLE public.signup_disposable_mail_hosts IS
    'Mail hosts of disposable email services. A domain whose MX is at one, or under one, is refused while signup_block_disposable_email is on.';

REVOKE ALL ON public.signup_disposable_mail_hosts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.signup_disposable_mail_hosts TO service_role;
ALTER TABLE public.signup_disposable_mail_hosts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_disposable_mail_hosts_service_role ON public.signup_disposable_mail_hosts;
CREATE POLICY signup_disposable_mail_hosts_service_role ON public.signup_disposable_mail_hosts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.signup_mail_hosts (
    domain text PRIMARY KEY,
    hosts text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    checked_at timestamptz,
    due_at timestamptz DEFAULT now()
);
COMMENT ON TABLE public.signup_mail_hosts IS
    'MX hosts of email domains the sign-up hook has met. due_at: a lookup is owed. Purged 30 days after the last lookup.';

CREATE INDEX IF NOT EXISTS signup_mail_hosts_due_idx ON public.signup_mail_hosts (due_at) WHERE due_at IS NOT NULL;

REVOKE ALL ON public.signup_mail_hosts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.signup_mail_hosts TO service_role;
ALTER TABLE public.signup_mail_hosts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_mail_hosts_service_role ON public.signup_mail_hosts;
CREATE POLICY signup_mail_hosts_service_role ON public.signup_mail_hosts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.signup_common_email_domains (
    domain text PRIMARY KEY
);
COMMENT ON TABLE public.signup_common_email_domains IS
    'Large mail providers, ISP mail and privacy alias services. signup_daily_domain_cap does not count them and the mail host lists do not read them: many unrelated people share them.';

REVOKE ALL ON public.signup_common_email_domains FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.signup_common_email_domains TO service_role;
ALTER TABLE public.signup_common_email_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_common_email_domains_service_role ON public.signup_common_email_domains;
CREATE POLICY signup_common_email_domains_service_role ON public.signup_common_email_domains
    FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.signup_common_email_domains (domain)
SELECT d FROM unnest(ARRAY[
    '126.com', '163.com', 'aol.com', 'au.com', 'daum.net', 'disroot.org',
    'docomo.ne.jp', 'ezweb.ne.jp', 'fastmail.com', 'foxmail.com', 'free.fr', 'gmail.com',
    'gmx.at', 'gmx.ch', 'gmx.com', 'gmx.de', 'gmx.net', 'googlemail.com',
    'hanmail.net', 'hey.com', 'hotmail.co.jp', 'hotmail.co.uk', 'hotmail.com', 'hotmail.de',
    'hotmail.fr', 'i.softbank.jp', 'icloud.com', 'kakao.com', 'laposte.net', 'live.com',
    'live.jp', 'mac.com', 'mail.com', 'mail.ru', 'mailbox.org', 'me.com',
    'msn.com', 'naver.com', 'orange.fr', 'outlook.com', 'outlook.de', 'outlook.fr',
    'outlook.jp', 'pm.me', 'posteo.de', 'proton.me', 'protonmail.com', 'qq.com',
    'riseup.net', 'rocketmail.com', 'sina.com', 'softbank.ne.jp', 't-online.de', 'tuta.com',
    'tuta.io', 'tutamail.com', 'tutanota.com', 'web.de', 'yahoo.co.jp', 'yahoo.co.uk',
    'yahoo.com', 'yahoo.de', 'yahoo.fr', 'yandex.com', 'yandex.ru', 'ymail.com',
    'zoho.com',
    -- ISP mail, national providers and privacy alias services: many unrelated people share them.
    '21cn.com', 'addy.io', 'aleeas.com', 'anonaddy.com', 'anonaddy.me', 'att.net', 'biglobe.ne.jp', 'btinternet.com',
    'comcast.net', 'cox.net', 'duck.com', 'gmx.fr', 'hotmail.it', 'libero.it', 'live.co.uk', 'mozmail.com', 'nifty.com',
    'ocn.ne.jp', 'outlook.it', 'passinbox.com', 'passmail.net', 'protonmail.ch', 'rakuten.jp', 'rediffmail.com',
    'sbcglobal.net', 'seznam.cz', 'simplelogin.co', 'simplelogin.com', 'sky.com', 'slmail.me', 'so-net.ne.jp',
    'uol.com.br', 'verizon.net', 'wp.pl', 'yahoo.ca', 'yahoo.in', 'ybb.ne.jp', 'yeah.net'
]) AS d
ON CONFLICT (domain) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
INSERT INTO public.instance_config (config_key, config_value, description) VALUES
    ('signup_limits_enabled', 'true'::jsonb, 'Whether the sign-up hook applies its limits'),
    ('signup_daily_ip_cap', '5'::jsonb, 'Accounts per network (IPv4 address, IPv6 /56) in a rolling 24 hours; 0 is no cap'),
    ('signup_mailbox_cap', '5'::jsonb, 'Accounts per email inbox in 30 days, +tags and Gmail dots folded; 0 is no cap'),
    ('signup_daily_domain_cap', '10'::jsonb, 'Accounts per email domain in a rolling 24 hours, large mail providers apart; 0 is no cap'),
    ('signup_enforce_caps', 'false'::jsonb, 'Whether accounts past the network and domain caps are refused rather than allowed and counted'),
    ('signup_trusted_email_domains', '[]'::jsonb, 'Email domains the domain cap, the disposable list and the mail host lists do not limit'),
    ('signup_limit_own_providers', 'false'::jsonb, 'Whether sign-ups through this instance''s own identity providers count toward the network cap'),
    ('signup_block_disposable_email', 'true'::jsonb, 'Whether sign-up refuses the domains in signup_disposable_domains'),
    ('signup_blocked_email_domains', '[]'::jsonb, 'Further email domains sign-up refuses'),
    ('signup_blocked_mail_hosts', '[]'::jsonb, 'Further mail hosts sign-up refuses: a domain whose MX is at one, or under one')
ON CONFLICT (config_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.signup_mailbox_hash(p_email text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_temp
AS $$
DECLARE
    v_email text := lower(btrim(p_email));
    v_domain text := substring(v_email from '@([^@]+)$');
    v_local text;
BEGIN
    IF v_domain IS NULL THEN
        RETURN NULL;
    END IF;
    v_local := split_part(left(v_email, length(v_email) - length(v_domain) - 1), '+', 1);
    IF v_domain IN ('gmail.com', 'googlemail.com') THEN
        v_domain := 'gmail.com';
        v_local := replace(v_local, '.', '');
    END IF;
    RETURN encode(extensions.digest(convert_to(v_local || '@' || v_domain, 'UTF8'), 'sha256'), 'hex');
END;
$$;

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
    DELETE FROM public.signup_mail_hosts WHERE coalesce(checked_at, created_at) < now() - interval '30 days';
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
    -- RFC 1918, RFC 6598 (CGNAT, Tailscale), loopback, link-local, RFC 4193.
    v_private CONSTANT inet[] := ARRAY[
        '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8',
        '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'
    ]::inet[];
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
                          'signup_blocked_email_domains', 'signup_trusted_email_domains', 'signup_blocked_mail_hosts');

    IF btrim(v_config ->> 'signup_limits_enabled', '"') = 'false' THEN
        RETURN '{}'::jsonb;
    END IF;
    v_enforce := btrim(v_config ->> 'signup_enforce_caps', '"') = 'true';
    v_network := network(set_masklen(v_ip, CASE family(v_ip) WHEN 6 THEN 56 ELSE 32 END));

    IF (v_provider LIKE 'custom:%' OR v_provider LIKE 'sso:%')
       AND btrim(v_config ->> 'signup_limit_own_providers', '"') IS DISTINCT FROM 'true' THEN
        RETURN '{}'::jsonb;
    END IF;

    IF coalesce(v_provider, 'email') IN ('email', 'phone') THEN
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
                    INSERT INTO public.signup_mail_hosts (domain) VALUES (v_domain) ON CONFLICT (domain) DO NOTHING;
                    PERFORM public.queue_federation_job('signup-mail-host', jsonb_build_object('domain', v_domain), 5, 3, 3600);
                ELSIF v_hosts_due IS NULL AND v_hosts_checked < now() - interval '7 days' THEN
                    UPDATE public.signup_mail_hosts m SET due_at = now() WHERE m.domain = v_domain;
                    PERFORM public.queue_federation_job('signup-mail-host', jsonb_build_object('domain', v_domain), 5, 3, 3600);
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

REVOKE ALL ON FUNCTION public.signup_mailbox_hash(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_signup_ledger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_signup_ledger() TO service_role;
REVOKE ALL ON FUNCTION public.before_user_created_hook(jsonb) FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
        GRANT EXECUTE ON FUNCTION public.before_user_created_hook(jsonb) TO supabase_auth_admin;
    END IF;
END;
$$;

-- The outer $do$ tag keeps the inner command string intact.
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN PERFORM cron.unschedule('signup-ledger-purge'); EXCEPTION WHEN OTHERS THEN NULL; END;
        PERFORM cron.schedule('signup-ledger-purge', '17 * * * *', 'SELECT public.purge_signup_ledger()');
        RAISE NOTICE 'signup-ledger-purge scheduled';
    ELSE
        RAISE NOTICE 'pg_cron not available: purge_signup_ledger runs on sign-up only';
    END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- Backfill: accounts of the last 30 days count toward their inbox, of the last 24 hours toward
-- their domain.
-- ---------------------------------------------------------------------------
INSERT INTO public.signup_ledger (created_at, mailbox_hash, email_domain)
SELECT u.created_at, public.signup_mailbox_hash(u.email),
       CASE WHEN u.created_at > now() - interval '24 hours'
             AND lower(substring(u.email from '@([^@]+)$')) NOT IN (SELECT c.domain FROM public.signup_common_email_domains c)
            THEN lower(substring(u.email from '@([^@]+)$')) END
  FROM auth.users u
 WHERE u.email IS NOT NULL
   AND u.created_at > now() - interval '30 days'
   AND coalesce(u.raw_app_meta_data ->> 'provider', 'email') = 'email'
   AND NOT EXISTS (SELECT 1 FROM public.signup_ledger);

-- Domains of the last 30 days get a lookup from the worker's sweep.
INSERT INTO public.signup_mail_hosts (domain)
SELECT DISTINCT lower(substring(u.email from '@([^@]+)$'))
  FROM auth.users u
 WHERE u.email IS NOT NULL
   AND u.created_at > now() - interval '30 days'
   AND lower(substring(u.email from '@([^@]+)$')) IS NOT NULL
   AND lower(substring(u.email from '@([^@]+)$')) NOT IN (SELECT c.domain FROM public.signup_common_email_domains c)
ON CONFLICT (domain) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Reserved usernames
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_local_username()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_labels text[];
BEGIN
    IF NEW.is_local IS FALSE OR NEW.username IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.username IS NOT DISTINCT FROM OLD.username
       AND OLD.is_local IS NOT FALSE THEN
        RETURN NEW;
    END IF;
    IF NEW.username !~ '^[a-z0-9_]{3,24}$' THEN
        RAISE EXCEPTION 'Usernames are 3 to 24 characters: lowercase letters, digits and _'
            USING ERRCODE = '23514';
    END IF;
    IF lower(NEW.username) = ANY (ARRAY[
        'everyone', 'here', 'system', 'harmony',
        'admin', 'admins', 'administrator',
        'mod', 'mods', 'moderator', 'moderators',
        'staff', 'root',
        'discord', 'google', 'apple', 'microsoft', 'openai', 'chatgpt', 'gemini', 'grok',
        'meta', 'amazon', 'android', 'windows', 'ios', 'linux', 'facebook', 'instagram',
        'youtube', 'twitter', 'tiktok', 'whatsapp', 'telegram', 'reddit', 'github', 'paypal',
        'netflix', 'spotify', 'samsung', 'nintendo', 'playstation', 'xbox', 'anthropic',
        'cloudflare', 'mastodon', 'bluesky', 'twitch'
    ]) THEN
        RAISE EXCEPTION 'The username % is reserved', NEW.username
            USING ERRCODE = '23514';
    END IF;
    -- Host without port, split into labels; the last label is the top-level domain unless it is
    -- the only one.
    v_labels := string_to_array(lower(split_part(public.get_instance_domain(), ':', 1)), '.');
    IF cardinality(v_labels) > 1 THEN
        v_labels := v_labels[1:cardinality(v_labels) - 1];
    END IF;
    IF lower(NEW.username) = ANY (v_labels) THEN
        RAISE EXCEPTION 'The username % is reserved', NEW.username
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
