-- 20261109100001_signup_limits.sql: GoTrue's before-user-created hook. Events carry the shape
-- of NewBeforeUserCreatedInput (internal/hooks/v0hooks/v0hooks.go, v2.197.0). 203.0.113.0/24,
-- 198.51.100.0/24 and 2001:db8::/32 are documentation ranges and count as public here.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(152);

CREATE TEMP TABLE r246 (reason text, msg text);
CREATE FUNCTION tests.ev246(ip text, email text, provider text DEFAULT 'email') RETURNS jsonb
LANGUAGE sql AS $fn$
  SELECT jsonb_build_object(
    'metadata', jsonb_build_object('uuid', gen_random_uuid(), 'time', now(), 'name', 'before-user-created', 'ip_address', ip),
    'user', jsonb_build_object('email', email, 'app_metadata', jsonb_build_object('provider', provider)))
$fn$;
CREATE FUNCTION tests.gate246(ip text, email text, provider text DEFAULT 'email') RETURNS jsonb
LANGUAGE sql AS $fn$ SELECT public.before_user_created_hook(tests.ev246(ip, email, provider)) $fn$;
CREATE FUNCTION tests.code246(ip text, email text, provider text DEFAULT 'email') RETURNS integer
LANGUAGE sql AS $fn$ SELECT (tests.gate246(ip, email, provider) #>> '{error,http_code}')::integer $fn$;
CREATE FUNCTION tests.refused246(p_reason text) RETURNS integer
LANGUAGE sql AS $fn$ SELECT coalesce(sum(refusals), 0)::integer FROM public.signup_refusal_counts WHERE reason = p_reason $fn$;
CREATE FUNCTION tests.observed246(p_reason text) RETURNS integer
LANGUAGE sql AS $fn$ SELECT coalesce(sum(would_refuse), 0)::integer FROM public.signup_refusal_counts WHERE reason = p_reason $fn$;

DELETE FROM public.signup_ledger;
DELETE FROM public.signup_refusal_counts;

-- Defaults. ---------------------------------------------------------------------------------------
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_limits_enabled'), 'true'::jsonb,
  'limits are on by default');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_daily_ip_cap'), '5'::jsonb,
  'default network cap is 5 a day');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_mailbox_cap'), '5'::jsonb,
  'default inbox cap is 5 in 30 days');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_block_disposable_email'), 'true'::jsonb,
  'disposable domains are refused by default');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_daily_domain_cap'), '10'::jsonb,
  'default domain cap is 10 a day');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_enforce_caps'), 'false'::jsonb,
  'the network and domain caps observe by default');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_blocked_mail_hosts'), '[]'::jsonb,
  'no further mail host is refused by default');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_blocked_networks'), '[]'::jsonb,
  'no address is refused by default');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_trusted_email_domains'), '[]'::jsonb,
  'no domain is never-limited by default');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_limit_own_providers'), 'false'::jsonb,
  'an instance''s own providers are not counted by default');
SELECT ok(NOT 'signup_daily_ip_cap' = ANY (public.public_instance_config_keys()), 'the settings stay out of the public keys');
SELECT cmp_ok((SELECT count(*)::integer FROM public.signup_disposable_domains), '>', 10000, 'the domain list is seeded');
SELECT is((SELECT count(*)::integer FROM public.signup_common_email_domains c
             JOIN public.signup_disposable_domains d USING (domain)), 0,
  'no large provider is also listed as disposable');
SELECT is((SELECT count(*)::integer FROM public.signup_disposable_domains
             WHERE domain IN ('petchi.uk', 'tensi.org', 'send4.uk', 'erinn.biz', 'kuku.lu')), 5,
  'kuku.lu and its domains are listed');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.signup_disposable_domains
                       WHERE domain IN ('isot.se', 'britannia-driving-school.co.uk', 'enet.consulting', 'fcit.de',
                                        'dubaiapartmentcare.com', 'sportcornwall.org', 'trashmail.com', 'overdose.living',
                                        'discord.irish', 'vividus.sbs', 'mee.bar', 'nyan.christmas', 'auxesis.app')),
  'a domain with no direct evidence is not, a business on a public list or a domain only seen in a run');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.signup_disposable_mail_hosts WHERE host = 'trashmail.com'),
  'trashmail.com is not a listed host: it now serves a mail provider');
SELECT ok(EXISTS (SELECT 1 FROM public.signup_disposable_mail_hosts WHERE host = 'erinn.biz'), 'and the mail host behind three of them');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.signup_disposable_mail_hosts
                       WHERE host IN ('google.com', 'googlemail.com', 'outlook.com', 'cloudflare.net', 'mx.cloudflare.net',
                                      'protection.outlook.com', 'zoho.com', 'protonmail.ch', 'icloud.com', 'yahoodns.net',
                                      'simplelogin.co', 'amazonaws.com', 'sendgrid.net', 'messagingengine.com', 'tutanota.de')),
  'no shared mail service is listed as a mail host');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.signup_disposable_domains
                       WHERE domain IN ('ybb.ne.jp', 'rakuten.jp', 'nifty.com', 'biglobe.ne.jp', 'ocn.ne.jp', 'so-net.ne.jp',
                                        'simplelogin.com', 'simplelogin.co', 'duck.com', 'addy.io', 'passmail.net', 'tuta.com')),
  'no ISP mail or privacy alias service is on the list');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.signup_disposable_domains
                       WHERE domain IN ('dallas.gov', 'oxford.gov', 'apeejay.edu', 'aditya.ac.in', 'madrasah.kemenag.go.id')),
  'no campus or government domain from the imported list');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.signup_disposable_domains
                       WHERE domain IN ('gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
                                        'proton.me', 'protonmail.com', 'gmx.com', 'fastmail.com', 'yahoo.co.jp', 'qq.com', 'naver.com')),
  'no mainstream provider is on the list');

-- Grants. -----------------------------------------------------------------------------------------
SELECT ok(has_function_privilege('supabase_auth_admin', 'public.before_user_created_hook(jsonb)', 'EXECUTE'),
  'GoTrue''s role runs the hook');
SELECT ok(has_schema_privilege('supabase_auth_admin', 'public', 'USAGE'), 'and reaches its schema');
SELECT ok(NOT has_function_privilege('anon', 'public.before_user_created_hook(jsonb)', 'EXECUTE'), 'anon does not');
SELECT ok(NOT has_function_privilege('authenticated', 'public.before_user_created_hook(jsonb)', 'EXECUTE'), 'nor does authenticated');
SELECT ok(NOT has_function_privilege('anon', 'public.purge_signup_ledger()', 'EXECUTE'), 'anon cannot purge');
SELECT ok(NOT has_function_privilege('authenticated', 'public.signup_mailbox_hash(text)', 'EXECUTE'), 'nor hash addresses');
SELECT ok(NOT has_table_privilege('authenticated', 'public.signup_ledger', 'SELECT'), 'the ledger is closed to members');
SELECT ok(NOT has_table_privilege('anon', 'public.signup_ledger', 'SELECT'), 'and to anon');
SELECT ok(NOT has_table_privilege('authenticated', 'public.signup_refusal_counts', 'INSERT'), 'members cannot write counts');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'public.before_user_created_hook(jsonb)'::regprocedure), 'the hook is SECURITY DEFINER');

-- Observing: a campus shares one address and one domain. --------------------------------------
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'signup_daily_ip_cap';
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'signup_daily_domain_cap';
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'signup_mailbox_cap';
SELECT is(tests.gate246('203.0.113.90', 'one246@campus246.example'), '{}'::jsonb, 'observing, a first account passes');
SELECT is(tests.gate246('203.0.113.90', 'two246@campus246.example'), '{}'::jsonb, 'and one past both caps passes');
SELECT is(tests.gate246('203.0.113.90', 'three246@campus246.example'), '{}'::jsonb, 'and another');
SELECT is(tests.observed246('ip_cap'), 2, 'each is counted against the network cap');
SELECT is(tests.observed246('domain_cap'), 2, 'and against the domain cap');
SELECT is(tests.refused246('ip_cap') + tests.refused246('domain_cap'), 0, 'none is a refusal');
SELECT is((SELECT count(*)::integer FROM public.signup_ledger WHERE network = '203.0.113.90/32'), 3, 'all three enter the ledger');
SELECT is(tests.code246('203.0.113.91', 'one246@campus246.example'), 422, 'the inbox cap refuses while observing');
SELECT is(tests.code246('203.0.113.91', 'x246@mailinator.com'), 422, 'and so does the disposable list');
UPDATE public.instance_config SET config_value = '["blockedobserve246.example"]'::jsonb WHERE config_key = 'signup_blocked_email_domains';
SELECT is(tests.code246('203.0.113.91', 'x246@blockedobserve246.example'), 422, 'and an instance''s own blocked domain');
UPDATE public.instance_config SET config_value = '[]'::jsonb WHERE config_key = 'signup_blocked_email_domains';
UPDATE public.instance_config SET config_value = '5'::jsonb WHERE config_key = 'signup_mailbox_cap';
UPDATE public.instance_config SET config_value = '10'::jsonb WHERE config_key = 'signup_daily_domain_cap';
UPDATE public.instance_config SET config_value = '5'::jsonb WHERE config_key = 'signup_daily_ip_cap';
DELETE FROM public.signup_ledger;
DELETE FROM public.signup_refusal_counts;

-- The switch: from here on the two caps refuse. --------------------------------------------------
UPDATE public.instance_config SET config_value = 'true'::jsonb WHERE config_key = 'signup_enforce_caps';

-- Network cap. ------------------------------------------------------------------------------------
UPDATE public.instance_config SET config_value = '0'::jsonb WHERE config_key = 'signup_daily_domain_cap';
UPDATE public.instance_config SET config_value = '2'::jsonb WHERE config_key = 'signup_daily_ip_cap';
SELECT is(tests.gate246('203.0.113.10', 'first246@example.org'), '{}'::jsonb, 'a first account passes');
SELECT is(tests.gate246('203.0.113.10', 'second246@example.org'), '{}'::jsonb, 'a second account on one network passes');
SELECT is(tests.code246('203.0.113.10', 'third246@example.org'), 429, 'past the cap the network is refused');
SELECT is(tests.gate246('203.0.113.10', 'third246@example.org') #>> '{error,message}',
  'Too many accounts were created from this network today. Try again tomorrow, or ask this instance''s admin for an invitation.',
  'with the text src/utils/signupLimits.ts maps');
SELECT is(tests.gate246('203.0.113.11', 'third246@example.org'), '{}'::jsonb, 'another network still passes');
SELECT is(tests.refused246('ip_cap'), 2, 'each refusal is counted');
SELECT is(tests.observed246('ip_cap'), 0, 'and is no would-be refusal');
SELECT is((SELECT count(*)::integer FROM public.signup_ledger WHERE network = '203.0.113.10/32'), 2, 'a refusal adds no ledger row');

UPDATE public.signup_ledger SET created_at = now() - interval '25 hours' WHERE network = '203.0.113.10/32';
SELECT is(tests.gate246('203.0.113.10', 'later246@example.org'), '{}'::jsonb, 'the 24 hours roll');

UPDATE public.instance_config SET config_value = '"1"'::jsonb WHERE config_key = 'signup_daily_ip_cap';
SELECT is(tests.code246('203.0.113.10', 'quoted246@example.org'), 429, 'a cap stored as a string applies');
UPDATE public.instance_config SET config_value = '0'::jsonb WHERE config_key = 'signup_daily_ip_cap';
SELECT is(tests.gate246('203.0.113.10', 'nocap246@example.org'), '{}'::jsonb, 'a cap of 0 is no cap');

UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'signup_daily_ip_cap';
SELECT is(tests.gate246('2001:db8:aa:bb00::1', 'v6one246@example.org'), '{}'::jsonb, 'an IPv6 client passes');
SELECT is(tests.code246('2001:db8:aa:bbff::2', 'v6two246@example.org'), 429, 'and shares its /56');
SELECT is(tests.gate246('2001:db8:aa:cc00::1', 'v6three246@example.org'), '{}'::jsonb, 'the next /56 is another network');
UPDATE public.instance_config SET config_value = '5'::jsonb WHERE config_key = 'signup_daily_ip_cap';

-- Exempt. -----------------------------------------------------------------------------------------
DELETE FROM public.signup_ledger;
SELECT is(tests.gate246('172.18.0.5', 'internal246@mailinator.com'), '{}'::jsonb, 'a private address is the instance itself');
SELECT is(tests.gate246(NULL, 'noaddress246@mailinator.com'), '{}'::jsonb, 'no address is exempt');
SELECT is(tests.gate246('not-an-address', 'garbage246@mailinator.com'), '{}'::jsonb, 'an unparsable address is exempt');
SELECT is(tests.gate246('203.0.113.20', 'idp246@mailinator.com', 'custom:authentik'), '{}'::jsonb, 'an instance''s own provider is exempt');
SELECT is(tests.gate246('203.0.113.20', 'saml246@mailinator.com', 'sso:00000000-0000-0000-0000-000000000246'), '{}'::jsonb, 'and its SSO');
SELECT is((SELECT count(*)::integer FROM public.signup_ledger), 0, 'none of them enters the ledger');

-- A third-party provider meets the network cap alone. ---------------------------------------------
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'signup_daily_ip_cap';
SELECT is(tests.gate246('203.0.113.25', 'oauth246@mailinator.com', 'google'), '{}'::jsonb, 'a Google sign-up skips the address rules');
SELECT is((SELECT network FROM public.signup_ledger WHERE mailbox_hash IS NULL), '203.0.113.25/32'::cidr, 'and enters the ledger by network alone');
SELECT is(tests.code246('203.0.113.25', 'oauth2246@example.org', 'github'), 429, 'the next provider sign-up from that network is refused');
SELECT is(tests.code246('203.0.113.25', 'mail246@example.org'), 429, 'and so is a password sign-up');
UPDATE public.instance_config SET config_value = 'true'::jsonb WHERE config_key = 'signup_limit_own_providers';
SELECT is(tests.code246('203.0.113.25', 'idp2246@example.org', 'custom:authentik'), 429, 'signup_limit_own_providers counts an instance''s own provider');
SELECT is(tests.gate246('203.0.113.26', 'idp3246@mailinator.com', 'sso:00000000-0000-0000-0000-000000000246'), '{}'::jsonb, 'by network alone');
UPDATE public.instance_config SET config_value = 'false'::jsonb WHERE config_key = 'signup_limit_own_providers';
UPDATE public.instance_config SET config_value = '5'::jsonb WHERE config_key = 'signup_daily_ip_cap';

-- Blocked domains. --------------------------------------------------------------------------------
SELECT is(tests.code246('203.0.113.21', 'a246@mailinator.com'), 422, 'a disposable domain is refused');
SELECT is(tests.code246('203.0.113.21', 'a246@sub.MAILINATOR.com'), 422, 'and its subdomains, in any case');
SELECT is(tests.gate246('203.0.113.21', 'a246@notmailinator-246.example'), '{}'::jsonb, 'another domain ending alike passes');
UPDATE public.instance_config SET config_value = 'false'::jsonb WHERE config_key = 'signup_block_disposable_email';
SELECT is(tests.gate246('203.0.113.22', 'a246@mailinator.com'), '{}'::jsonb, 'the list can be turned off');
UPDATE public.instance_config SET config_value = '["Blocked246.Example"]'::jsonb WHERE config_key = 'signup_blocked_email_domains';
SELECT is(tests.code246('203.0.113.22', 'a246@blocked246.example'), 422, 'an instance''s own domain is refused with the list off');
UPDATE public.instance_config SET config_value = 'true'::jsonb WHERE config_key = 'signup_block_disposable_email';
UPDATE public.instance_config SET config_value = '[]'::jsonb WHERE config_key = 'signup_blocked_email_domains';

-- Inbox cap: a legitimate second account on an alias passes; a farm of aliases does not. -----------
DELETE FROM public.signup_ledger;
UPDATE public.instance_config SET config_value = '2'::jsonb WHERE config_key = 'signup_mailbox_cap';
SELECT is(tests.gate246('203.0.113.30', 'farm.246@gmail.com'), '{}'::jsonb, 'an inbox opens an account');
SELECT is(tests.gate246('203.0.113.31', 'farm246+test@googlemail.com'), '{}'::jsonb, 'and a second on an alias');
SELECT is(tests.code246('203.0.113.32', 'f.a.r.m.246+three@gmail.com'), 422, 'dots, tags and googlemail fold into one inbox');
SELECT is(tests.gate246('203.0.113.33', 'farm.246@example.org'), '{}'::jsonb, 'dots matter outside Gmail');
UPDATE public.instance_config SET config_value = '5'::jsonb WHERE config_key = 'signup_mailbox_cap';

-- Domain cap: distinct mailboxes on rotating networks, one domain. --------------------------------
DELETE FROM public.signup_ledger;
UPDATE public.instance_config SET config_value = '2'::jsonb WHERE config_key = 'signup_daily_domain_cap';
SELECT is(tests.gate246('203.0.113.60', 'a246@operator246.example'), '{}'::jsonb, 'a first account on a domain passes');
SELECT is(tests.gate246('203.0.113.61', 'b246@Operator246.example'), '{}'::jsonb, 'and a second, in any case, from another network');
SELECT is(tests.code246('203.0.113.62', 'c246@operator246.example'), 429, 'past the cap the domain is refused from any network');
SELECT is(tests.gate246('203.0.113.62', 'c246@operator246.example') #>> '{error,message}',
  'Too many accounts were created with this email domain today. Try again tomorrow, or ask this instance''s admin for an invitation.',
  'with the text src/utils/signupLimits.ts maps');
SELECT is(tests.refused246('domain_cap'), 2, 'each refusal is counted');
SELECT is(tests.gate246('203.0.113.62', 'c246@other246.example'), '{}'::jsonb, 'another domain still passes');
SELECT is(tests.gate246('203.0.113.63', 'one.246@gmail.com'), '{}'::jsonb, 'a large provider is not counted');
SELECT is(tests.gate246('203.0.113.64', 'two.246@gmail.com'), '{}'::jsonb, 'nor a second account on it');
SELECT is(tests.gate246('203.0.113.65', 'three.246@gmail.com'), '{}'::jsonb, 'nor a third');
SELECT is((SELECT count(*)::integer FROM public.signup_ledger WHERE email_domain = 'gmail.com'), 0, 'and enters no domain in the ledger');
UPDATE public.signup_ledger SET created_at = now() - interval '25 hours' WHERE email_domain = 'operator246.example';
SELECT is(tests.gate246('203.0.113.66', 'd246@operator246.example'), '{}'::jsonb, 'the 24 hours roll');
UPDATE public.instance_config SET config_value = '0'::jsonb WHERE config_key = 'signup_daily_domain_cap';
SELECT is(tests.gate246('203.0.113.67', 'e246@operator246.example'), '{}'::jsonb, 'a cap of 0 is no cap');

-- A proxy Caddy cannot see past: every active account on one public address. ----------------------
DELETE FROM public.signup_ledger;
DELETE FROM auth.sessions;
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'signup_daily_ip_cap';
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
SELECT ('a2460000-0000-0000-0000-00000000000' || i)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'proxy' || i || '246@test.local', '', now(), now()
  FROM generate_series(1, 6) AS i;
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, ip)
SELECT gen_random_uuid(), ('a2460000-0000-0000-0000-00000000000' || i)::uuid, now(), now(), '203.0.113.80'
  FROM generate_series(1, 4) AS i;
INSERT INTO public.signup_ledger (network) VALUES ('203.0.113.80/32');
SELECT is(tests.code246('203.0.113.80', 'proxy246@example.org'), 429, 'four accounts on one address: an ordinary network, refused');
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, ip)
VALUES (gen_random_uuid(), 'a2460000-0000-0000-0000-000000000005', now(), now(), '203.0.113.80');
SELECT is(tests.gate246('203.0.113.80', 'proxy2246@example.org'), '{}'::jsonb, 'five accounts and no other address: a proxy, not refused');
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, ip)
VALUES (gen_random_uuid(), 'a2460000-0000-0000-0000-000000000006', now(), now(), '10.0.0.9');
SELECT is(tests.gate246('203.0.113.80', 'proxy3246@example.org'), '{}'::jsonb, 'a private session is no other address');
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, ip)
VALUES (gen_random_uuid(), 'a2460000-0000-0000-0000-000000000006', now() - interval '31 days', now() - interval '31 days', '198.51.100.80');
SELECT is(tests.gate246('203.0.113.80', 'proxy4246@example.org'), '{}'::jsonb, 'nor is a session idle for 30 days');
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, ip)
VALUES (gen_random_uuid(), 'a2460000-0000-0000-0000-000000000006', now(), now(), '198.51.100.80');
SELECT is(tests.code246('203.0.113.80', 'proxy5246@example.org'), 429, 'one person elsewhere: a bulk creator among others, refused');
UPDATE public.instance_config SET config_value = '5'::jsonb WHERE config_key = 'signup_daily_ip_cap';

-- Groups, with enforcement off as on a new instance. No rule reads how networks and domains combine.
DELETE FROM public.signup_ledger;
DELETE FROM public.signup_refusal_counts;
DELETE FROM public.signup_mail_hosts;
UPDATE public.instance_config SET config_value = 'false'::jsonb WHERE config_key = 'signup_enforce_caps';
UPDATE public.instance_config SET config_value = '10'::jsonb WHERE config_key = 'signup_daily_domain_cap';
SELECT is((SELECT count(*)::integer FROM generate_series(1, 30) AS i
            WHERE tests.gate246('203.0.113.120', 's' || i || '246@campus-group246.example') = '{}'::jsonb), 30,
  'a campus of thirty on one network and one domain passes');
SELECT is((SELECT count(*)::integer FROM generate_series(1, 30) AS i
            WHERE tests.gate246('203.0.113.121', 's' || i || '246@dept' || i || '.campus-group246.example') = '{}'::jsonb), 30,
  'on thirty department subdomains');
SELECT is((SELECT count(*)::integer FROM generate_series(1, 50) AS i
            WHERE tests.gate246('198.51.100.' || i, 'h' || i || '246@studio-home246.example') = '{}'::jsonb), 50,
  'a company at home on fifty networks and one domain');
SELECT is((SELECT count(*)::integer FROM generate_series(1, 40) AS i
            WHERE tests.gate246('203.0.113.122', 'c' || i || '246@company' || i || '246.example') = '{}'::jsonb), 40,
  'a conference on one network and forty domains');
SELECT is(tests.refused246('ip_cap') + tests.refused246('domain_cap'), 0, 'nothing is refused');

-- Mail hosts. The federation worker writes signup_mail_hosts; these rows stand in for its answer. --
DELETE FROM public.signup_ledger;
DELETE FROM public.signup_refusal_counts;
DELETE FROM public.signup_mail_hosts;
SELECT is(tests.gate246('203.0.113.130', 'a246@fresh246.example'), '{}'::jsonb, 'a domain not yet looked up passes');
SELECT is((SELECT checked_at IS NULL AND due_at IS NOT NULL FROM public.signup_mail_hosts WHERE domain = 'fresh246.example'), true,
  'and is owed a lookup');
UPDATE public.signup_mail_hosts
   SET hosts = ARRAY['recv-fresh246.erinn.biz'], checked_at = now(), due_at = NULL
 WHERE domain = 'fresh246.example';
SELECT is(tests.code246('203.0.113.131', 'b246@fresh246.example'), 422, 'a mail server under a listed host is refused');
SELECT is(tests.gate246('203.0.113.131', 'b246@fresh246.example') #>> '{error,message}',
  'This email provider cannot be used to sign up on this instance. Use another address.',
  'with the text src/utils/signupLimits.ts maps');
SELECT is(tests.refused246('mail_host'), 2, 'each refusal is counted');
SELECT is((SELECT count(*)::integer FROM public.signup_ledger WHERE network = '203.0.113.131/32'), 0, 'a refusal adds no ledger row');
INSERT INTO public.signup_mail_hosts (domain, hosts, checked_at, due_at) VALUES
    ('exact246.example', ARRAY['erinn.biz'], now(), NULL),
    ('alike246.example', ARRAY['noterinn.biz'], now(), NULL),
    ('one-of-two246.example', ARRAY['mx.clean246.example', 'recv1.erinn.biz'], now(), NULL),
    ('shared246.example', ARRAY['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'], now(), NULL),
    ('nomx246.example', '{}', now(), NULL),
    ('gmail.com', ARRAY['recv1.erinn.biz'], now(), NULL),
    ('panel246.example', ARRAY['mx1.panel-host246.example'], now(), NULL);
SELECT is(tests.code246('203.0.113.132', 'a246@exact246.example'), 422, 'the listed host itself is refused');
SELECT is(tests.code246('203.0.113.132', 'a246@one-of-two246.example'), 422, 'one listed mail server of two is enough');
SELECT is(tests.gate246('203.0.113.132', 'a246@alike246.example'), '{}'::jsonb, 'a host that only ends alike passes');
SELECT is(tests.gate246('203.0.113.132', 'a246@shared246.example'), '{}'::jsonb, 'a shared mail service passes');
SELECT is(tests.gate246('203.0.113.132', 'a246@nomx246.example'), '{}'::jsonb, 'a domain without a mail server passes');
SELECT is(tests.gate246('203.0.113.132', 'host246@gmail.com'), '{}'::jsonb, 'a large provider is not read');
SELECT is(tests.gate246('203.0.113.132', 'a246@panel246.example'), '{}'::jsonb, 'a host not listed passes');
UPDATE public.instance_config SET config_value = '["Panel-Host246.Example"]'::jsonb WHERE config_key = 'signup_blocked_mail_hosts';
SELECT is(tests.code246('203.0.113.133', 'b246@panel246.example'), 422, 'a host the panel lists is refused, in any case, with its subdomains');
UPDATE public.instance_config SET config_value = 'false'::jsonb WHERE config_key = 'signup_block_disposable_email';
SELECT is(tests.code246('203.0.113.133', 'c246@panel246.example'), 422, 'and with the disposable list off');
SELECT is(tests.gate246('203.0.113.133', 'b246@exact246.example'), '{}'::jsonb, 'the disposable list off leaves the built-in hosts off');
UPDATE public.instance_config SET config_value = 'true'::jsonb WHERE config_key = 'signup_block_disposable_email';
UPDATE public.instance_config SET config_value = '["panel246.example"]'::jsonb WHERE config_key = 'signup_trusted_email_domains';
SELECT is(tests.gate246('203.0.113.133', 'd246@panel246.example'), '{}'::jsonb, 'a never-limited domain skips the mail host lists');
UPDATE public.instance_config SET config_value = '[]'::jsonb WHERE config_key = 'signup_trusted_email_domains';
UPDATE public.instance_config SET config_value = '[]'::jsonb WHERE config_key = 'signup_blocked_mail_hosts';
SELECT is(tests.gate246('10.0.0.5', 'a246@exact246.example'), '{}'::jsonb, 'the instance''s own request is not read');
SELECT is(tests.gate246('203.0.113.134', 'a246@exact246.example', 'google'), '{}'::jsonb, 'a sign-up through Google is not read');

UPDATE public.signup_mail_hosts SET checked_at = now() - interval '8 days' WHERE domain = 'exact246.example';
SELECT is(tests.code246('203.0.113.134', 'c246@exact246.example'), 422, 'a result past seven days still refuses');
SELECT ok((SELECT due_at IS NOT NULL FROM public.signup_mail_hosts WHERE domain = 'exact246.example'), 'and is owed a new lookup');
SELECT ok((SELECT due_at IS NULL FROM public.signup_mail_hosts WHERE domain = 'alike246.example'), 'a recent result is not');
INSERT INTO public.signup_mail_hosts (domain, hosts, created_at, checked_at, due_at) VALUES
    ('old246.example', '{}', now() - interval '40 days', now() - interval '31 days', NULL);
SELECT public.purge_signup_ledger();
SELECT is((SELECT count(*)::integer FROM public.signup_mail_hosts WHERE domain = 'old246.example'), 0, 'a row with no lookup in 30 days is purged');
SELECT ok(has_table_privilege('service_role', 'public.signup_mail_hosts', 'UPDATE'), 'the worker writes lookups');
SELECT ok(NOT has_table_privilege('authenticated', 'public.signup_mail_hosts', 'SELECT'), 'members read none');
SELECT ok(NOT has_table_privilege('anon', 'public.signup_mail_hosts', 'SELECT'), 'nor does anon');
SELECT ok(NOT has_table_privilege('authenticated', 'public.signup_disposable_mail_hosts', 'SELECT'), 'nor the host list');

-- Refused addresses. --------------------------------------------------------------------------------
DELETE FROM public.signup_ledger;
DELETE FROM public.signup_refusal_counts;
UPDATE public.instance_config SET config_value = '["203.0.113.60", "198.51.100.0/24", "2001:db8:60::/64", "not an address", "203.0.113.61/99"]'::jsonb
 WHERE config_key = 'signup_blocked_networks';
SELECT is(tests.code246('203.0.113.60', 'a246@gmail.com'), 403, 'a listed address is refused, at a large provider too');
SELECT is(tests.gate246('203.0.113.60', 'a246@gmail.com') #>> '{error,message}',
  'Sign-ups from this network are not available on this instance. Ask this instance''s admin for an invitation.',
  'with the text src/utils/signupLimits.ts maps');
SELECT is(tests.code246('198.51.100.77', 'b246@network246.example'), 403, 'an address in a listed range is refused');
SELECT is(tests.code246('2001:db8:60::abcd', 'c246@network246.example'), 403, 'and in an IPv6 range');
SELECT is(tests.code246('203.0.113.60', 'oauth246@gmail.com', 'google'), 403, 'a sign-up through Google too');
SELECT is(tests.gate246('203.0.113.59', 'd246@network246.example'), '{}'::jsonb, 'the next address is not');
SELECT is(tests.gate246('2001:db8:61::1', 'e246@network246.example'), '{}'::jsonb, 'nor another IPv6 range');
SELECT is(tests.gate246('203.0.113.61', 'f246@network246.example'), '{}'::jsonb, 'a malformed entry matches nothing and breaks nothing');
SELECT is(tests.gate246('203.0.113.60', 'idp246@network246.example', 'custom:authentik'), '{}'::jsonb, 'an instance''s own identity provider is not read');
SELECT is(tests.gate246('10.0.0.9', 'invite246@network246.example'), '{}'::jsonb, 'nor the instance''s own request');
SELECT is(tests.refused246('blocked_network'), 5, 'each refusal is counted');
SELECT is((SELECT count(*)::integer FROM public.signup_ledger WHERE network = '203.0.113.60/32'), 0, 'a refusal adds no ledger row');
SELECT ok(NOT has_function_privilege('authenticated', 'public.signup_network_contains(text, inet)', 'EXECUTE'), 'the helper is internal');
UPDATE public.instance_config SET config_value = '"not an array"'::jsonb WHERE config_key = 'signup_blocked_networks';
SELECT is(tests.gate246('203.0.113.60', 'g246@network246.example'), '{}'::jsonb, 'a stored value that is not a list refuses nothing');
UPDATE public.instance_config SET config_value = '[]'::jsonb WHERE config_key = 'signup_blocked_networks';

-- Never limited. ----------------------------------------------------------------------------------
DELETE FROM public.signup_ledger;
UPDATE public.instance_config SET config_value = '["Trusted246.Example", "mailinator.com"]'::jsonb WHERE config_key = 'signup_trusted_email_domains';
SELECT is(tests.gate246('203.0.113.150', 'a246@trusted246.example'), '{}'::jsonb, 'a never-limited domain passes');
SELECT is(tests.gate246('203.0.113.151', 'b246@sub.trusted246.example'), '{}'::jsonb, 'and its subdomains, on a further network');
SELECT is((SELECT count(*)::integer FROM public.signup_ledger WHERE email_domain LIKE '%trusted246.example'), 0, 'and it enters no domain in the ledger');
SELECT is(tests.gate246('203.0.113.152', 'a246@mailinator.com'), '{}'::jsonb, 'it skips the disposable list');
UPDATE public.instance_config SET config_value = '["trusted246.example"]'::jsonb WHERE config_key = 'signup_blocked_email_domains';
SELECT is(tests.code246('203.0.113.153', 'c246@trusted246.example'), 422, 'a domain listed to refuse stays refused');
UPDATE public.instance_config SET config_value = '[]'::jsonb WHERE config_key = 'signup_blocked_email_domains';
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'signup_mailbox_cap';
SELECT is(tests.code246('203.0.113.154', 'a246@trusted246.example'), 422, 'and the inbox cap applies');
UPDATE public.instance_config SET config_value = '5'::jsonb WHERE config_key = 'signup_mailbox_cap';
UPDATE public.instance_config SET config_value = '[]'::jsonb WHERE config_key = 'signup_trusted_email_domains';

-- Reserved usernames. -----------------------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
    VALUES ('a2460000-0000-0000-0000-000000000001', 'a2460000-0000-0000-0000-000000000001', 'discord', 'x', true, 'localhost')$$,
  '23514', NULL, 'a brand name is reserved');
SELECT throws_ok(
  $$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
    VALUES ('a2460000-0000-0000-0000-000000000002', 'a2460000-0000-0000-0000-000000000002', 'linux', 'x', true, 'localhost')$$,
  '23514', NULL, 'a platform name is reserved');
SELECT lives_ok(
  $$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
    VALUES ('a2460000-0000-0000-0000-000000000003', 'a2460000-0000-0000-0000-000000000003', 'discord_fan', 'x', true, 'localhost')$$,
  'a name that contains one is not');

-- Master switch. ----------------------------------------------------------------------------------
UPDATE public.instance_config SET config_value = 'false'::jsonb WHERE config_key = 'signup_limits_enabled';
SELECT is(tests.gate246('203.0.113.40', 'off246@mailinator.com'), '{}'::jsonb, 'signup_limits_enabled false allows everything');
UPDATE public.instance_config SET config_value = 'true'::jsonb WHERE config_key = 'signup_limits_enabled';

-- Retention. --------------------------------------------------------------------------------------
DELETE FROM public.signup_ledger;
INSERT INTO public.signup_ledger (created_at, network, mailbox_hash, email_domain) VALUES
  (now() - interval '25 hours', '203.0.113.50/32', 'keep246', 'keep246.example'),
  (now() - interval '31 days', '203.0.113.51/32', 'gone246', 'gone246.example');
SELECT public.purge_signup_ledger();
SELECT is((SELECT network FROM public.signup_ledger WHERE mailbox_hash = 'keep246'), NULL::cidr, 'an address is erased after 24 hours');
SELECT is((SELECT email_domain FROM public.signup_ledger WHERE mailbox_hash = 'keep246'), NULL::text, 'and its domain');
SELECT is((SELECT count(*)::integer FROM public.signup_ledger WHERE mailbox_hash = 'gone246'), 0, 'a row after 30 days');

SELECT * FROM finish();
ROLLBACK;
