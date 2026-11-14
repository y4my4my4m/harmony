-- Fourth review of 1.9.7.
--
--   signup_captcha_check          as 20261111100001 without remoteip: an address the sign-up chooses
--                                 made hCaptcha answer invalid-remoteip, a code 20261115700001 read
--                                 as no verdict, so the token was never judged.
--   signup_captcha_verdict        as 20261115700001 without the remoteip codes.
--   before_user_created_hook      as 20261115700001; the captcha call runs after the refusals that
--                                 need no provider (blocked network, domain, mailbox), so those
--                                 cost no outbound call, and before the advisory locks.
--   bridge_remote_optouts.erase_pending
--                                 an erase with rows left. Every erase batch sets it from more;
--                                 bot-gateway finishes pending erases (bridge_privacy_pending)
--                                 after a restart or a failed batch.
--   bridge_privacy_erase_core     as 20261115700001; one message statement per scope, each stating
--                                 its index's predicate (messages_discord_relayed_channel,
--                                 20261115800001); threads on the author's messages are renamed
--                                 again: Discord fills their title from the message.
--   bridge_privacy_erase_continue a removal's later batches, for a manager: none once a restore
--                                 lifted it. Each call of bridge_privacy_remove_remote_user put the
--                                 removal back.
--   bridge_privacy_purge_instance turns history import off and fails unfinished imports.
--   evict_copy_emojis             ranks the dropped rows before it filters them: rows that stay took
--                                 the places of rows that go, and rows past the window were never
--                                 read again.
--   discord_bridge_deleted_threads
--                                 Discord threads whose Harmony thread was deleted; bridge_import_thread
--                                 does not create them again (their mapping goes with the thread).

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.bridge_remote_optouts ADD COLUMN IF NOT EXISTS erase_pending boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_bridge_remote_optouts_erase_pending
    ON public.bridge_remote_optouts (created_at) WHERE erase_pending;

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

        -- A token comes with the retry of an asked sign-up. It is checked after the refusals that
        -- need no provider (a blocked network, domain or mailbox) and before the advisory locks:
        -- the provider may take up to 4 s, and concurrent sign-ups of one network wait on them.
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

CREATE OR REPLACE FUNCTION public.bridge_privacy_mark_pending(
    p_server_id uuid, p_platform text, p_remote_user_id text, p_result jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.bridge_remote_optouts o
       SET erase_pending = COALESCE((p_result ->> 'more')::boolean, false)
     WHERE o.server_id = p_server_id AND o.platform = p_platform AND o.remote_user_id = p_remote_user_id
       AND o.erase_pending IS DISTINCT FROM COALESCE((p_result ->> 'more')::boolean, false);
    SELECT p_result;
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_mark_pending(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

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
    v_federated uuid[];
    v_found integer;
    v_more boolean;
    v_reactions integer;
    v_events integer;
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
        -- their messages, whose title Discord fills from the message, are renamed.
        UPDATE public.threads t
           SET name = 'Thread'
         WHERE t.parent_message_id = ANY (v_parents)
            OR t.id IN (SELECT CASE WHEN m.metadata ->> 'thread_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                    THEN (m.metadata ->> 'thread_id')::uuid END
                          FROM public.messages m
                         WHERE m.id = ANY (v_notices) AND m.metadata ->> 'type' = 'thread_created');

        PERFORM set_config('harmony.silent_content_update', 'true', true);
        UPDATE public.messages m
           SET metadata = (m.metadata - 'discord_user')
                          || CASE WHEN m.metadata ->> 'type' = 'thread_created'
                                  THEN jsonb_build_object('thread_name', 'Thread') ELSE '{}'::jsonb END
         WHERE m.id = ANY (v_notices);
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
            DELETE FROM public.automod_events e
             WHERE e.id IN (SELECT e2.id FROM public.automod_events e2
                             WHERE e2.details ? 'author_key'
                               AND (p_server_id IS NULL OR e2.server_id = p_server_id)
                               AND e2.details ->> 'author_key' = 'discord:' || p_remote_user_id
                             LIMIT v_limit);
        ELSE
            DELETE FROM public.automod_events e
             WHERE e.id IN (SELECT e2.id FROM public.automod_events e2
                             WHERE e2.details ? 'author_key'
                               AND (p_server_id IS NULL OR e2.server_id = p_server_id)
                               AND e2.details ->> 'author_key' LIKE 'discord:%'
                             LIMIT v_limit);
        END IF;
        GET DIAGNOSTICS v_events = ROW_COUNT;
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

    RETURN jsonb_build_object('erased', v_found, 'more', v_more);
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
           || public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id,
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
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_server_id IS NULL OR p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    -- The batches after the first: an opt-in meanwhile ends the erase, and is not undone.
    IF NOT EXISTS (SELECT 1 FROM public.bridge_remote_optouts o
                    WHERE o.server_id = p_server_id AND o.platform = p_platform
                      AND o.remote_user_id = p_remote_user_id) THEN
        RETURN jsonb_build_object('opted_out', false, 'erased', 0, 'more', false);
    END IF;
    RETURN jsonb_build_object('opted_out', true)
           || public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id,
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
    RETURN public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id,
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
    -- The batches after a removal's first: none once the user is no longer left out (a restore).
    IF NOT EXISTS (SELECT 1 FROM public.bridge_remote_optouts o
                    WHERE o.server_id = p_server_id AND o.platform = p_platform
                      AND o.remote_user_id = p_remote_user_id) THEN
        RETURN jsonb_build_object('erased', 0, 'more', false);
    END IF;
    RETURN public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id,
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
     WHERE o.erase_pending
     ORDER BY o.created_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_pending(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_privacy_pending(integer) TO service_role;

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
    UPDATE public.discord_bridge_imports i
       SET state = 'failed', error = 'instance_purged', updated_at = now(), finished_at = now()
     WHERE i.state IN ('queued', 'running', 'paused');
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


CREATE TABLE IF NOT EXISTS public.discord_bridge_deleted_threads (
    bridge_id uuid NOT NULL REFERENCES public.discord_bridges(id) ON DELETE CASCADE,
    discord_thread_id text NOT NULL,
    deleted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bridge_id, discord_thread_id)
);

ALTER TABLE public.discord_bridge_deleted_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS discord_bridge_deleted_threads_service_role ON public.discord_bridge_deleted_threads;
CREATE POLICY discord_bridge_deleted_threads_service_role ON public.discord_bridge_deleted_threads
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.discord_bridge_deleted_threads FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.discord_bridge_deleted_threads TO service_role;

COMMENT ON TABLE public.discord_bridge_deleted_threads IS
'Discord threads whose Harmony thread was deleted; bridge_import_thread does not create them again.';

-- Before the thread goes: its discord_bridge_threads row goes with it (ON DELETE CASCADE).
CREATE OR REPLACE FUNCTION public.remember_deleted_bridge_thread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.discord_bridge_deleted_threads (bridge_id, discord_thread_id)
    SELECT bt.bridge_id, bt.discord_thread_id
      FROM public.discord_bridge_threads bt
     WHERE bt.thread_id = OLD.id
    ON CONFLICT (bridge_id, discord_thread_id) DO NOTHING;
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.remember_deleted_bridge_thread() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_threads_remember_bridge_thread ON public.threads;
CREATE TRIGGER a_threads_remember_bridge_thread
    BEFORE DELETE ON public.threads
    FOR EACH ROW EXECUTE FUNCTION public.remember_deleted_bridge_thread();

CREATE OR REPLACE FUNCTION public.bridge_import_thread(p_bot_id uuid, p_import_id uuid, p_thread jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.discord_bridge_imports;
    v_did text := p_thread ->> 'discord_thread_id';
    v_name text := left(btrim(COALESCE(p_thread ->> 'name', '')), 100);
    v_created timestamptz;
    v_starter text := NULLIF(p_thread ->> 'starter_discord_message_id', '');
    v_user jsonb := p_thread -> 'discord_user';
    v_archived boolean := COALESCE((p_thread ->> 'archived')::boolean, false);
    v_locked boolean := COALESCE((p_thread ->> 'locked')::boolean, false);
    v_parent uuid;
    v_thread_id uuid;
    v_notice_id uuid;
    v_notice jsonb;
    v_opted boolean;
BEGIN
    v_job := public.bridge_import_guard(p_bot_id, p_import_id);
    IF v_job.state <> 'running' THEN
        RETURN NULL;
    END IF;
    IF p_thread IS NULL OR jsonb_typeof(p_thread) <> 'object' OR v_did IS NULL OR v_did !~ '^[0-9]{1,20}$'
       OR (p_thread ->> 'created_at') IS NULL THEN
        RAISE EXCEPTION 'invalid_thread' USING ERRCODE = '22023', DETAIL = COALESCE(v_did, '');
    END IF;
    IF v_name = '' THEN
        RAISE EXCEPTION 'Thread name must be 1 to 100 characters' USING ERRCODE = '22023';
    END IF;
    v_created := LEAST((p_thread ->> 'created_at')::timestamptz, now());

    PERFORM set_config('harmony.history_import', 'true', true);

    PERFORM pg_advisory_xact_lock(hashtext('bridge_thread:' || v_job.bridge_id::text || ':' || v_did));
    SELECT bt.thread_id INTO v_thread_id
      FROM public.discord_bridge_threads bt
     WHERE bt.bridge_id = v_job.bridge_id AND bt.discord_thread_id = v_did;
    IF v_thread_id IS NOT NULL THEN
        RETURN v_thread_id;
    END IF;
    -- A thread a moderator deleted stays deleted: an import does not create it again.
    IF EXISTS (SELECT 1 FROM public.discord_bridge_deleted_threads d
                WHERE d.bridge_id = v_job.bridge_id AND d.discord_thread_id = v_did) THEN
        RETURN NULL;
    END IF;

    -- An opted-out author's title is their text: the thread is imported under a plain name.
    v_opted := jsonb_typeof(v_user) = 'object' AND EXISTS (
        SELECT 1
          FROM public.bridge_remote_optouts o
          JOIN public.discord_bridges b ON b.server_id = o.server_id
         WHERE b.id = v_job.bridge_id AND o.platform = 'discord' AND o.remote_user_id = v_user ->> 'id');
    IF v_opted THEN
        v_name := 'Thread';
    END IF;

    v_notice := jsonb_build_object('type', 'thread_created', 'actor_bot_id', p_bot_id, 'thread_name', v_name,
                                   'bridge_source', 'discord', 'history_import', true, 'created_via', 'history_import');
    IF jsonb_typeof(v_user) = 'object' AND v_user ->> 'id' ~ '^[0-9]{1,20}$' AND NOT v_opted THEN
        v_notice := v_notice || jsonb_build_object('discord_user', jsonb_strip_nulls(jsonb_build_object(
            'id', v_user ->> 'id',
            'username', left(v_user ->> 'username', 100),
            'display_name', left(v_user ->> 'display_name', 100),
            'avatar_url', CASE WHEN v_user ->> 'avatar_url' ~ '^https://' THEN left(v_user ->> 'avatar_url', 2048) END)));
    END IF;

    IF v_starter IS NOT NULL THEN
        SELECT m.id INTO v_parent
          FROM public.messages m
         WHERE m.channel_id = v_job.harmony_channel_id
           AND m.metadata ? 'discord_message_id'
           AND m.metadata ->> 'discord_message_id' = v_starter
           AND m.is_deleted IS NOT TRUE
           AND m.thread_id IS NULL;
    END IF;

    IF v_parent IS NOT NULL THEN
        -- One thread per message; an existing one is paired and returned.
        PERFORM pg_advisory_xact_lock(hashtext('create_thread:' || v_parent::text));
        SELECT t.id INTO v_thread_id FROM public.threads t WHERE t.parent_message_id = v_parent;

        IF v_thread_id IS NULL THEN
            INSERT INTO public.threads (channel_id, parent_message_id, name, created_by, auto_archive_duration,
                                        created_at, updated_at, archived, archived_at, locked)
            VALUES (v_job.harmony_channel_id, v_parent, v_name, NULL, 1440, v_created, v_created,
                    v_archived, CASE WHEN v_archived THEN v_created END, v_locked)
            RETURNING id INTO v_thread_id;

            -- A system row has no author (messages_system_authorless); the bot is in metadata.
            INSERT INTO public.messages (created_at, channel_id, content, is_system, metadata)
            VALUES (v_created, v_job.harmony_channel_id,
                    '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                    v_notice || jsonb_build_object('thread_id', v_thread_id));
        END IF;
    ELSE
        v_thread_id := gen_random_uuid();
        INSERT INTO public.messages (created_at, channel_id, content, is_system, metadata)
        VALUES (v_created, v_job.harmony_channel_id,
                '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                v_notice || jsonb_build_object('thread_id', v_thread_id, 'standalone', true))
        RETURNING id INTO v_notice_id;

        INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, auto_archive_duration,
                                    created_at, updated_at, archived, archived_at, locked)
        VALUES (v_thread_id, v_job.harmony_channel_id, v_notice_id, v_name, NULL, 1440, v_created, v_created,
                v_archived, CASE WHEN v_archived THEN v_created END, v_locked);
    END IF;

    INSERT INTO public.discord_bridge_threads (thread_id, bridge_id, discord_thread_id)
    VALUES (v_thread_id, v_job.bridge_id, v_did)
    ON CONFLICT (thread_id) DO NOTHING;

    RETURN v_thread_id;
END;
$$;


COMMIT;

NOTIFY pgrst, 'reload schema';
