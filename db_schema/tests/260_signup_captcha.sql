-- 20261111100001_signup_captcha.sql: the sign-up check asked of suspect sign-ups. Events carry the
-- shape GoTrue v2.197.0 sends, user_metadata included. signup_captcha_verify is replaced by a stub
-- keyed on the token; siteverify answers below were captured from both providers' test keys.
-- 203.0.113.0/24, 198.51.100.0/24 and 2001:db8::/32 are documentation ranges and count as public.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(89);

CREATE FUNCTION tests.ev260(ip text, email text, token text DEFAULT NULL, provider text DEFAULT 'email') RETURNS jsonb
LANGUAGE sql AS $fn$
  SELECT jsonb_build_object(
    'metadata', jsonb_build_object('uuid', gen_random_uuid(), 'time', now(), 'name', 'before-user-created', 'ip_address', ip),
    'user', jsonb_build_object('email', email, 'app_metadata', jsonb_build_object('provider', provider),
                               'user_metadata', CASE WHEN token IS NULL THEN '{}'::jsonb
                                                     ELSE jsonb_build_object('captcha_token', token) END))
$fn$;
CREATE FUNCTION tests.gate260(ip text, email text, token text DEFAULT NULL, provider text DEFAULT 'email') RETURNS jsonb
LANGUAGE sql AS $fn$ SELECT public.before_user_created_hook(tests.ev260(ip, email, token, provider)) $fn$;
CREATE FUNCTION tests.code260(ip text, email text, token text DEFAULT NULL, provider text DEFAULT 'email') RETURNS integer
LANGUAGE sql AS $fn$ SELECT (tests.gate260(ip, email, token, provider) #>> '{error,http_code}')::integer $fn$;
CREATE FUNCTION tests.count260(p_col text) RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE v integer;
BEGIN
  EXECUTE format('SELECT coalesce(sum(%I), 0)::integer FROM public.signup_captcha_counts', p_col) INTO v;
  RETURN v;
END $fn$;
CREATE FUNCTION tests.set260(p_key text, p_value jsonb) RETURNS void
LANGUAGE sql AS $fn$ UPDATE public.instance_config SET config_value = p_value WHERE config_key = p_key $fn$;

-- A lookup on record: the domain is known, not new.
CREATE FUNCTION tests.known260(p_domain text) RETURNS void
LANGUAGE sql AS $fn$
  INSERT INTO public.signup_mail_hosts (domain, hosts, checked_at) VALUES (p_domain, ARRAY['mx.' || p_domain], now())
  ON CONFLICT (domain) DO UPDATE SET hosts = excluded.hosts, checked_at = excluded.checked_at, due_at = NULL
$fn$;

DELETE FROM public.signup_ledger;
DELETE FROM public.signup_refusal_counts;
DELETE FROM public.signup_captcha_counts;

-- Defaults and visibility. ------------------------------------------------------------------------
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_captcha_provider'), '"off"'::jsonb,
  'captcha is off by default');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_captcha_site_key'), '""'::jsonb,
  'no site key by default');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_captcha_secret'), '""'::jsonb,
  'no secret by default');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_captcha_mode'), '"suspect"'::jsonb,
  'the check is asked of suspect sign-ups by default');
SELECT ok('signup_captcha_provider' = ANY (public.public_instance_config_keys()), 'the provider is public');
SELECT ok('signup_captcha_site_key' = ANY (public.public_instance_config_keys()), 'the site key is public');
SELECT ok(NOT 'signup_captcha_secret' = ANY (public.public_instance_config_keys()), 'the secret is not');
SELECT ok(NOT 'signup_captcha_mode' = ANY (public.public_instance_config_keys()), 'the mode is not');

SELECT ok(NOT has_function_privilege('anon', 'public.signup_captcha_verify(text,text,text,text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.signup_captcha_verify(text,text,text,text)', 'EXECUTE')
      AND NOT has_function_privilege('service_role', 'public.signup_captcha_verify(text,text,text,text)', 'EXECUTE'),
  'no API role runs the verification');
SELECT ok(NOT has_function_privilege('anon', 'public.signup_captcha_verdict(integer,text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.signup_captcha_verdict(integer,text)', 'EXECUTE'),
  'nor the verdict');
SELECT ok(NOT has_function_privilege('anon', 'public.strip_signup_captcha_token()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.strip_signup_captcha_token()', 'EXECUTE'),
  'nor the metadata trigger');
SELECT is((SELECT n.nspname::text FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'http'),
  'harmony_http', 'http is installed in a schema of its own');
SELECT ok(NOT has_schema_privilege('anon', 'harmony_http', 'USAGE')
      AND NOT has_schema_privilege('authenticated', 'harmony_http', 'USAGE')
      AND NOT has_schema_privilege('service_role', 'harmony_http', 'USAGE'),
  'no API role can use it, so none fetches a URL from the database host');
SELECT is((SELECT count(*)::integer
             FROM pg_proc p
             JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
             JOIN pg_extension e ON e.oid = d.refobjid
            WHERE e.extname = 'http' AND p.pronamespace <> 'harmony_http'::regnamespace),
  0, 'every http function is in that schema');
SELECT ok(NOT has_table_privilege('anon', 'public.signup_captcha_counts', 'SELECT'), 'anon cannot read the counts');
SELECT ok(NOT has_table_privilege('authenticated', 'public.signup_captcha_counts', 'INSERT'), 'nor write them');

-- Verdicts on siteverify answers. -----------------------------------------------------------------
SELECT is(public.signup_captcha_verdict(200,
  '{"success":true,"challenge_ts":"2026-11-10T04:58:36.330Z","hostname":"example.com","error-codes":[],"action":"","cdata":"","metadata":{"result_with_testing_key":true}}'),
  'pass', 'Turnstile success passes');
SELECT is(public.signup_captcha_verdict(200,
  '{"error-codes":["invalid-input-response"],"success":false,"messages":[],"metadata":{"result_with_testing_key":true}}'),
  'fail', 'Turnstile invalid-input-response fails');
SELECT is(public.signup_captcha_verdict(200, '{"success":false,"error-codes":["timeout-or-duplicate"]}'),
  'fail', 'a reused or expired Turnstile token fails');
SELECT is(public.signup_captcha_verdict(200, '{"success":false,"error-codes":["invalid-input-secret"]}'),
  'error', 'a refused secret gives no verdict');
SELECT is(public.signup_captcha_verdict(200, '{"success":false,"error-codes":["internal-error"]}'),
  'error', 'a provider error gives no verdict');
SELECT is(public.signup_captcha_verdict(200,
  '{"success":true,"credit":false,"hostname":"dummy-key-pass","challenge_ts":"2026-11-10T05:00:36.438Z"}'),
  'pass', 'hCaptcha success passes');
SELECT is(public.signup_captcha_verdict(200, '{"success":false,"error-codes":["invalid-input-response"]}'),
  'fail', 'hCaptcha invalid-input-response fails');
SELECT is(public.signup_captcha_verdict(200, '{"success":false,"error-codes":["already-seen-response"]}'),
  'fail', 'a reused hCaptcha token fails');
-- 20261115500001: only the instance's keys and the provider's own failure give no verdict.
SELECT is(public.signup_captcha_verdict(200, '{"success":false,"error-codes":["sitekey-secret-mismatch"]}'),
  'fail', 'a token minted on another site key fails');
SELECT is(public.signup_captcha_verdict(200, '{"success":false,"error-codes":["invalid-input-response","bad-request"]}'),
  'fail', 'a token code beside a request code fails');
SELECT is(public.signup_captcha_verdict(200, '{"success":false}'), 'fail', 'a refusal without codes fails');
SELECT is(public.signup_captcha_verdict(503, '{"success":true}'), 'error', 'a non-200 answer gives no verdict');
SELECT is(public.signup_captcha_verdict(200, '<html>busy</html>'), 'error', 'nor does a page that is not JSON');
SELECT is(public.signup_captcha_verdict(200, '{"success":"true"}'), 'error', 'nor a success that is not a boolean');
SELECT is(public.signup_captcha_verdict(200, '[true]'), 'error', 'nor an answer that is not an object');
SELECT is(public.signup_captcha_verify('none', 'secret', 'token', '203.0.113.1'), 'error', 'an unknown provider gives no verdict');
SELECT is(public.signup_captcha_verify('turnstile', 'secret', '', '203.0.113.1'), 'fail', 'an empty token fails without a request');

-- The stub: verdict by token. ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.signup_captcha_verify(p_provider text, p_secret text, p_token text, p_remote_ip text)
RETURNS text LANGUAGE sql AS $fn$
  SELECT CASE p_token WHEN 'tok-pass' THEN 'pass' WHEN 'tok-fail' THEN 'fail' ELSE 'error' END
$fn$;

-- Off. ---------------------------------------------------------------------------------------------
SELECT is(tests.gate260('203.0.113.10', 'a260@gmail.com'), '{}'::jsonb, 'captcha off: a first sign-up passes');
SELECT is(tests.gate260('203.0.113.10', 'b260@gmail.com'), '{}'::jsonb, 'captcha off: a second one from the network in the hour passes');
SELECT is(tests.count260('asked'), 0, 'and nothing is asked');

-- Configured. --------------------------------------------------------------------------------------
SELECT tests.set260('signup_captcha_provider', '"turnstile"');
SELECT tests.set260('signup_captcha_site_key', '"0x4AAAAAAA-site"');
SELECT tests.set260('signup_captcha_secret', '"0x4AAAAAAA-secret"');

SELECT is(tests.gate260('203.0.113.20', 'c260@gmail.com'), '{}'::jsonb, 'a first sign-up from a network on a large provider passes unasked');
SELECT is(tests.gate260('203.0.113.20', 'd260@gmail.com'),
  jsonb_build_object('error', jsonb_build_object('http_code', 428, 'message',
    'Complete the check to finish signing up. If no check appears, update the app or sign up on this instance''s website.')),
  'a second from that network in the hour is asked for the check');
SELECT is(tests.count260('asked'), 1, 'counted as asked');
SELECT is((SELECT count(*)::integer FROM public.signup_ledger WHERE network = '203.0.113.20/32'), 1,
  'an unanswered ask leaves no ledger row');
SELECT is(tests.gate260('203.0.113.20', 'd260@gmail.com', 'tok-fail'),
  jsonb_build_object('error', jsonb_build_object('http_code', 428, 'message', 'The check did not pass. Try it again.')),
  'a refused token is asked again');
SELECT is(tests.count260('failed'), 1, 'counted as failed');
SELECT is(tests.gate260('203.0.113.20', 'd260@gmail.com', 'tok-pass'), '{}'::jsonb, 'a passing token creates the account');
SELECT is(tests.count260('passed'), 1, 'counted as passed');
SELECT is((SELECT count(*)::integer FROM public.signup_ledger WHERE network = '203.0.113.20/32'), 2, 'and the ledger counts it');
SELECT is(tests.gate260('203.0.113.20', 'e260@gmail.com', 'tok-unreachable'), '{}'::jsonb,
  'no verdict from the provider creates the account');
SELECT is(tests.count260('unverified'), 1, 'counted as unverified');

SELECT ok(NOT EXISTS (SELECT 1 FROM public.signup_mail_hosts WHERE domain = 'new260.example'), 'the domain is unknown');
SELECT is(tests.code260('198.51.100.30', 'f260@new260.example'), 428, 'a first sign-up on a new domain is asked');
SELECT ok(EXISTS (SELECT 1 FROM public.signup_mail_hosts WHERE domain = 'new260.example'), 'its mail host lookup is still queued');
SELECT is(tests.code260('198.51.100.31', 'g260@new260.example'), 428, 'and asked while the lookup is pending');
SELECT tests.known260('new260.example');
SELECT is(tests.gate260('198.51.100.32', 'h260@new260.example'), '{}'::jsonb, 'a domain with a lookup on record passes unasked');
SELECT tests.set260('signup_trusted_email_domains', '["trusted260.example"]');
SELECT is(tests.gate260('198.51.100.33', 'i260@trusted260.example'), '{}'::jsonb, 'a trusted domain is not new');
SELECT tests.set260('signup_trusted_email_domains', '[]');

-- Past an observing cap. ---------------------------------------------------------------------------
SELECT tests.known260('cap260.example');
INSERT INTO public.signup_ledger (created_at, network, mailbox_hash, email_domain)
SELECT now() - interval '3 hours', ('198.51.100.' || (100 + g))::cidr, 'cap260-' || g, 'cap260.example' FROM generate_series(1, 10) g;
SELECT is(tests.code260('198.51.100.40', 'j260@cap260.example'), 428, 'past the observing domain cap, the check is asked');
SELECT is(tests.gate260('198.51.100.40', 'j260@cap260.example', 'tok-pass'), '{}'::jsonb, 'and a pass creates the account');
SELECT is((SELECT sum(would_refuse)::integer FROM public.signup_refusal_counts WHERE reason = 'domain_cap'), 1,
  'counted past the cap once, when allowed');

-- Refusals come first. -----------------------------------------------------------------------------
SELECT tests.set260('signup_enforce_caps', 'true');
SELECT is(tests.code260('198.51.100.41', 'k260@cap260.example', 'tok-pass'), 429, 'an enforced cap refuses, token or not');
SELECT tests.set260('signup_enforce_caps', 'false');
SELECT tests.set260('signup_blocked_email_domains', '["blocked260.example"]');
SELECT is(tests.code260('198.51.100.42', 'l260@blocked260.example', 'tok-pass'), 422, 'a blocked domain refuses, token or not');
SELECT tests.set260('signup_blocked_email_domains', '[]');

-- Who is asked. ------------------------------------------------------------------------------------
SELECT is(tests.gate260('203.0.113.20', 'm260@gmail.com', NULL, 'google'), '{}'::jsonb,
  'a provider sign-up is never asked: no widget runs on its callback');
SELECT is(tests.gate260('10.1.2.3', 'n260@gmail.com'), '{}'::jsonb, 'a private address is exempt');
SELECT tests.set260('signup_captcha_mode', '"always"');
SELECT is(tests.code260('203.0.113.50', 'o260@gmail.com'), 428, 'mode always asks a first sign-up');
SELECT is(tests.gate260('10.1.2.4', 'p260@gmail.com'), '{}'::jsonb, 'but not from a private address');
SELECT tests.set260('signup_limits_enabled', 'false');
SELECT is(tests.gate260('203.0.113.51', 'q260@gmail.com'), '{}'::jsonb, 'limits off: nothing is asked');
SELECT tests.set260('signup_limits_enabled', 'true');
SELECT tests.set260('signup_captcha_secret', '""');
SELECT is(tests.gate260('203.0.113.52', 'r260@gmail.com'), '{}'::jsonb, 'without a secret, captcha is off');
SELECT tests.set260('signup_captcha_secret', '"0x4AAAAAAA-secret"');
SELECT tests.set260('signup_captcha_site_key', '"  "');
SELECT is(tests.gate260('203.0.113.53', 's260@gmail.com'), '{}'::jsonb, 'without a site key, captcha is off');
SELECT tests.set260('signup_captcha_site_key', '"10000000-ffff-ffff-ffff-000000000001"');
SELECT tests.set260('signup_captcha_provider', '"hcaptcha"');
SELECT is(tests.code260('203.0.113.54', 't260@gmail.com'), 428, 'hcaptcha asks the same way');
SELECT tests.set260('signup_captcha_provider', '"recaptcha"');
SELECT is(tests.gate260('203.0.113.55', 'u260@gmail.com'), '{}'::jsonb, 'an unknown provider is off');
SELECT tests.set260('signup_captcha_provider', '"turnstile"');
SELECT tests.set260('signup_captcha_mode', '"suspect"');

-- An internal failure allows. ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.signup_captcha_verify(p_provider text, p_secret text, p_token text, p_remote_ip text)
RETURNS text LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'boom'; END $fn$;
SELECT is(tests.gate260('203.0.113.20', 'v260@gmail.com', 'tok-pass'), '{}'::jsonb, 'a failing verification allows the account');

-- Metadata. ----------------------------------------------------------------------------------------
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND tgname = 'harmony_strip_captcha_token'
                    AND tgtype & 2 = 2 AND tgtype & 4 = 4 AND tgtype & 16 = 16),
  'a BEFORE INSERT OR UPDATE trigger on auth.users removes the token');
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
VALUES ('26026026-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'w260@gmail.com', '{"captcha_token":"tok-pass","display_name":"W"}');
SELECT ok(NOT (SELECT raw_user_meta_data FROM auth.users WHERE id = '26026026-0000-4000-8000-000000000001') ? 'captcha_token',
  'the stored metadata has no token');
SELECT is((SELECT raw_user_meta_data ->> 'display_name' FROM auth.users WHERE id = '26026026-0000-4000-8000-000000000001'), 'W',
  'and keeps the rest');
-- GoTrue writes its in-memory metadata back after the INSERT.
UPDATE auth.users SET raw_user_meta_data = '{"captcha_token":"tok-pass","display_name":"W","sub":"x"}'
 WHERE id = '26026026-0000-4000-8000-000000000001';
SELECT is((SELECT raw_user_meta_data FROM auth.users WHERE id = '26026026-0000-4000-8000-000000000001'),
  '{"display_name":"W","sub":"x"}'::jsonb, 'an UPDATE carrying the token is stripped too');

-- Retention. ---------------------------------------------------------------------------------------
INSERT INTO public.signup_captcha_counts (day, asked) VALUES (current_date - 91, 3), (current_date - 89, 2)
ON CONFLICT (day) DO NOTHING;
SELECT public.purge_signup_ledger();
SELECT is((SELECT count(*)::integer FROM public.signup_captcha_counts WHERE day < current_date - 90), 0, 'counts go after 90 days');
SELECT is((SELECT asked FROM public.signup_captcha_counts WHERE day = current_date - 89), 2, 'and stay until then');

-- One siteverify call, without a request. ----------------------------------------------------------
SELECT is(public.signup_captcha_check('recaptcha', 's', 't', NULL) ->> 'detail', 'provider', 'an unknown provider is named');
SELECT is(public.signup_captcha_check('turnstile', 's', '', NULL) - 'codes',
  '{"verdict":"fail","detail":"token"}'::jsonb, 'an empty token fails before any request');

SELECT ok(NOT has_function_privilege('anon', 'public.signup_captcha_check(text,text,text,text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.signup_captcha_check(text,text,text,text)', 'EXECUTE')
      AND NOT has_function_privilege('service_role', 'public.signup_captcha_check(text,text,text,text)', 'EXECUTE'),
  'no API role calls siteverify directly');
SELECT ok(has_function_privilege('authenticated', 'public.admin_test_signup_captcha(text,text,text)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.admin_test_signup_captcha(text,text,text)', 'EXECUTE'),
  'the admin test is open to signed-in callers; its own check decides');
SELECT ok(NOT has_function_privilege('authenticated', 'public.config_audit_value(text,jsonb)', 'EXECUTE'),
  'the audit redaction is internal');

-- Audit redaction. ---------------------------------------------------------------------------------
SELECT is(public.config_audit_value('signup_captcha_secret', '"0x4AAA-secret"'), '"set"'::jsonb, 'a secret is logged as set');
SELECT is(public.config_audit_value('signup_captcha_secret', '""'), '"empty"'::jsonb, 'an empty one as empty');
SELECT is(public.config_audit_value('signup_captcha_secret', NULL), '"empty"'::jsonb, 'and an absent one');
SELECT is(public.config_audit_value('signup_captcha_site_key', '"0x4AAA-site"'), '"0x4AAA-site"'::jsonb,
  'any other key keeps its value');

INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, confirmed_at)
VALUES ('26026026-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'adm260@staff260.test', now(), now()),
       ('26026026-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'usr260@staff260.test', now(), now());
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin)
VALUES ('f260000a-0000-4000-8000-00000000000a', '26026026-0000-4000-8000-00000000000a', 'adm260', 'Adm', true, true),
       ('f260000b-0000-4000-8000-00000000000b', '26026026-0000-4000-8000-00000000000b', 'usr260', 'Usr', true, false);
SELECT tests.set260('signup_captcha_secret', '""');

SELECT tests.authenticate_as('26026026-0000-4000-8000-00000000000b');
SELECT throws_ok($$ SELECT public.admin_test_signup_captcha('turnstile', 'tok', 'secret') $$, '42501', NULL,
  'a member cannot run the admin test');
SELECT tests.authenticate_as('26026026-0000-4000-8000-00000000000a');
SELECT throws_ok($$ SELECT public.admin_test_signup_captcha('recaptcha', 'tok', 'secret') $$, '22023', NULL,
  'an unknown provider is refused');
SELECT is(public.admin_test_signup_captcha('turnstile', 'tok', '  ') ->> 'detail', 'no_secret',
  'with no secret entered or stored, the test says so');
SELECT public.batch_set_instance_config(ARRAY['signup_captcha_secret', 'signup_captcha_site_key'],
                                        ARRAY['"0x4AAA-secret-260"'::jsonb, '"0x4AAA-site-260"'::jsonb]);
SELECT tests.clear_authentication();

SELECT is((SELECT action_details - 'key' FROM public.admin_audit_log
            WHERE action_type = 'config_change' AND action_details ->> 'key' = 'signup_captcha_secret'
            ORDER BY created_at DESC LIMIT 1),
  '{"old_value":"empty","new_value":"set"}'::jsonb, 'the audit log records that a secret was set, not its value');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_captcha_secret'),
  '"0x4AAA-secret-260"'::jsonb, 'the secret itself is stored');
SELECT is((SELECT action_details -> 'new_value' FROM public.admin_audit_log
            WHERE action_type = 'config_change' AND action_details ->> 'key' = 'signup_captcha_site_key'
            ORDER BY created_at DESC LIMIT 1),
  '"0x4AAA-site-260"'::jsonb, 'the site key is logged as written');

SELECT * FROM finish();
ROLLBACK;
