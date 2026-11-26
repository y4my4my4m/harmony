-- 20261126500001_signup_methods.sql: registration per sign-in method in the before-user-created
-- hook. Events carry the shape of NewBeforeUserCreatedInput (internal/hooks/v0hooks/v0hooks.go,
-- v2.197.0); an external provider's claims are user_metadata (structs.Map of provider.Claims), where
-- email_verified is always present. 203.0.113.0/24 is a documentation range and counts as public.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(62);

CREATE FUNCTION tests.ev405(email text, provider text DEFAULT 'email', verified jsonb DEFAULT NULL, ip text DEFAULT '203.0.113.5')
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object(
    'metadata', jsonb_build_object('uuid', gen_random_uuid(), 'time', now(), 'name', 'before-user-created', 'ip_address', ip),
    'user', jsonb_strip_nulls(jsonb_build_object(
      'email', email,
      'app_metadata', jsonb_build_object('provider', provider),
      'user_metadata', CASE WHEN verified IS NULL THEN NULL ELSE jsonb_build_object('email_verified', verified) END)))
$fn$;
CREATE FUNCTION tests.hook405(email text, provider text DEFAULT 'email', verified jsonb DEFAULT NULL, ip text DEFAULT '203.0.113.5')
RETURNS jsonb LANGUAGE sql AS $fn$ SELECT public.before_user_created_hook(tests.ev405(email, provider, verified, ip)) $fn$;
CREATE FUNCTION tests.code405(email text, provider text DEFAULT 'email', verified jsonb DEFAULT NULL, ip text DEFAULT '203.0.113.5')
RETURNS integer LANGUAGE sql AS $fn$ SELECT (tests.hook405(email, provider, verified, ip) #>> '{error,http_code}')::integer $fn$;
CREATE FUNCTION tests.msg405(email text, provider text DEFAULT 'email', verified jsonb DEFAULT NULL, ip text DEFAULT '203.0.113.5')
RETURNS text LANGUAGE sql AS $fn$ SELECT tests.hook405(email, provider, verified, ip) #>> '{error,message}' $fn$;
CREATE FUNCTION tests.policy405(p text) RETURNS void LANGUAGE sql AS $fn$
  DELETE FROM public.instance_config WHERE config_key = 'registration_policy';
  INSERT INTO public.instance_config (config_key, config_value) SELECT 'registration_policy', to_jsonb(p) WHERE p IS NOT NULL;
$fn$;
CREATE FUNCTION tests.providers405(v jsonb) RETURNS void LANGUAGE sql AS $fn$
  UPDATE public.instance_config SET config_value = v WHERE config_key = 'signup_providers';
$fn$;

-- The limits stay out of the way unless a test turns them on.
UPDATE public.instance_config SET config_value = 'false'::jsonb WHERE config_key = 'signup_limits_enabled';
DELETE FROM public.signup_invite_passes;
SELECT tests.policy405(NULL);

-- Shape and privileges. ---------------------------------------------------------------------------
SELECT has_function('public', 'before_user_created_hook', ARRAY['jsonb'], 'the hook exists');
SELECT has_function('public', 'signup_limits_check', ARRAY['jsonb'], 'the limits keep their own function');
SELECT has_function('public', 'signup_registration_refusal', ARRAY['jsonb'], 'the policy has its own function');
SELECT has_function('public', 'signup_invite_pass', ARRAY['text'], 'invite passes are issued by a function');

SELECT ok(has_function_privilege('supabase_auth_admin', 'public.before_user_created_hook(jsonb)', 'EXECUTE'),
  'the auth service runs the hook');
SELECT ok(NOT has_function_privilege('supabase_auth_admin', 'public.signup_limits_check(jsonb)', 'EXECUTE'),
  'and not the limits alone');
SELECT ok(NOT has_function_privilege('supabase_auth_admin', 'public.signup_registration_refusal(jsonb)', 'EXECUTE'),
  'nor the policy alone');
SELECT ok(NOT has_function_privilege('anon', 'public.before_user_created_hook(jsonb)', 'EXECUTE'), 'anon cannot run the hook');
SELECT ok(NOT has_function_privilege('authenticated', 'public.before_user_created_hook(jsonb)', 'EXECUTE'), 'nor authenticated');
SELECT ok(NOT has_function_privilege('service_role', 'public.before_user_created_hook(jsonb)', 'EXECUTE'), 'nor the service role');
SELECT ok(NOT has_function_privilege('authenticated', 'public.signup_registration_refusal(jsonb)', 'EXECUTE'),
  'authenticated cannot run the policy');
SELECT ok(NOT has_function_privilege('anon', 'public.signup_invite_pass(text)', 'EXECUTE'), 'anon cannot issue a pass');
SELECT ok(NOT has_function_privilege('authenticated', 'public.signup_invite_pass(text)', 'EXECUTE'), 'nor can an admin''s session');
SELECT ok(has_function_privilege('service_role', 'public.signup_invite_pass(text)', 'EXECUTE'), 'the service role can');
SELECT ok(NOT has_table_privilege('authenticated', 'public.signup_invite_passes', 'SELECT'), 'passes are not readable');
SELECT ok(NOT has_table_privilege('anon', 'public.signup_invite_passes', 'INSERT'), 'nor written by a client');

SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'signup_providers'), '{}'::jsonb,
  'no provider has a sign-up mode by default');
SELECT ok(NOT ('signup_providers' = ANY (public.public_instance_config_keys())), 'provider modes are for admins');

-- No policy: GoTrue's switch decides. -------------------------------------------------------------
SELECT is(tests.hook405('new405@example.org'), '{}'::jsonb, 'without a policy an email sign-up passes the hook');
SELECT is(tests.hook405('new405@example.org', 'custom:school', 'true'), '{}'::jsonb, 'and a provider sign-up');

SELECT tests.policy405('open');
SELECT is(tests.hook405('new405@example.org'), '{}'::jsonb, 'open: an email sign-up passes');
SELECT is(tests.hook405('new405@example.org', 'discord', 'true'), '{}'::jsonb, 'open: a provider following it passes');

-- Closed. -----------------------------------------------------------------------------------------
SELECT tests.policy405('closed');
SELECT is(tests.code405('new405@example.org'), 403, 'closed: an email sign-up is refused');
SELECT is(tests.msg405('new405@example.org'), 'This instance is not taking new accounts.', 'with the closed text');
SELECT is(tests.code405('new405@example.org', ip => '10.1.2.3'), 403, 'from a private network too');
SELECT is(tests.code405(NULL), 403, 'an email sign-up without an address');
SELECT is(tests.code405(NULL, 'phone'), 403, 'a phone sign-up');
SELECT is(tests.code405('new405@example.org', 'custom:school', 'true'), 403, 'a provider following the policy');

SELECT tests.policy405('maybe');
SELECT is(tests.msg405('new405@example.org'), 'This instance is not taking new accounts.', 'an unknown policy refuses as closed');
SELECT tests.policy405('Invite');
SELECT is(tests.msg405('new405@example.org'), 'This instance takes new accounts by invitation only. Ask its admin for one.',
  'a policy is read without case');

-- Invite: passes. ---------------------------------------------------------------------------------
SELECT tests.policy405('invite');
SELECT is(tests.msg405('new405@example.org', 'custom:school', 'true'),
  'This instance takes new accounts by invitation only. Ask its admin for one.', 'invite: a provider following it is refused');

SELECT lives_ok($$ SELECT public.signup_invite_pass('  Invitee405@Example.org ') $$, 'a pass is issued');
SELECT ok((SELECT expires_at BETWEEN now() + interval '9 minutes' AND now() + interval '11 minutes'
             FROM public.signup_invite_passes WHERE email = 'invitee405@example.org'), 'for the lowercased address, 10 minutes');
SELECT is(tests.code405('other405@example.org'), 403, 'another address gains nothing from it');
SELECT is(tests.hook405('invitee405@example.org'), '{}'::jsonb, 'the invited address passes');
SELECT is((SELECT count(*)::integer FROM public.signup_invite_passes WHERE email = 'invitee405@example.org'), 0, 'which spends the pass');
SELECT is(tests.code405('invitee405@example.org'), 403, 'a second sign-up is refused');
SELECT is(tests.code405('invitee405@example.org', 'custom:school', 'true'), 403, 'a pass does not open a provider');

INSERT INTO public.signup_invite_passes (email, expires_at) VALUES ('late405@example.org', now() - interval '1 second');
SELECT is(tests.code405('late405@example.org'), 403, 'an expired pass is refused');
SELECT public.signup_invite_pass('next405@example.org');
SELECT is((SELECT count(*)::integer FROM public.signup_invite_passes WHERE email = 'late405@example.org'), 0, 'and purged by the next pass');
SELECT throws_ok($$ SELECT public.signup_invite_pass('not an address') $$, '22023', 'not an email address', 'a pass names an address');

-- Provider modes. ---------------------------------------------------------------------------------
SELECT tests.policy405('closed');
SELECT tests.providers405('{"custom:school": {"mode": "open"}}');
SELECT is(tests.hook405('new405@example.org', 'custom:school', 'false'), '{}'::jsonb, 'an open provider creates accounts while closed');
SELECT is(tests.code405('new405@example.org', 'discord', 'true'), 403, 'another provider still follows');
SELECT is(tests.code405('new405@example.org'), 403, 'and email sign-up stays closed');

SELECT tests.providers405('{"custom:school": {"mode": "domains", "domains": ["MySchool.edu", " @corp.example ", ""]}}');
SELECT is(tests.hook405('alice405@myschool.edu', 'custom:school', 'true'), '{}'::jsonb, 'a verified address at a listed domain passes');
SELECT is(tests.hook405('Bob405@CS.MySchool.edu', 'custom:school', 'true'), '{}'::jsonb, 'and at a subdomain of one');
SELECT is(tests.hook405('carol405@corp.example', 'custom:school', 'true'), '{}'::jsonb, 'a listed domain may carry @ and spaces');
SELECT is(tests.hook405('dave405@myschool.edu', 'custom:school', '"true"'), '{}'::jsonb, 'a verified flag sent as text counts');
SELECT is(tests.msg405('eve405@evilmyschool.edu', 'custom:school', 'true'),
  'New accounts through this sign-in are limited to some email domains, and this address is not at one of them.',
  'a domain that only ends with a listed name is refused');
SELECT is(tests.code405('eve405@myschool.edu.evil.example', 'custom:school', 'true'), 403, 'as is one that only starts with it');
SELECT is(tests.msg405('alice405@myschool.edu', 'custom:school', 'false'),
  'New accounts through this sign-in need an email address the sign-in provider has verified.', 'an unverified address is refused');
SELECT is(tests.code405('alice405@myschool.edu', 'custom:school'), 403, 'as is one without a verified flag');
SELECT is(tests.code405(NULL, 'custom:school', 'true'), 403, 'and a sign-in without an address');

SELECT tests.policy405('open');
SELECT is(tests.code405('eve405@example.org', 'custom:school', 'true'), 403, 'a domain list limits a provider on an open instance');
SELECT is(tests.hook405('eve405@example.org'), '{}'::jsonb, 'while email sign-up stays open');

SELECT tests.providers405('{"custom:school": {"mode": "domains", "domains": "myschool.edu"}}');
SELECT is(tests.code405('alice405@myschool.edu', 'custom:school', 'true'), 403, 'domains that are not a list admit no one');
SELECT tests.providers405('{"custom:school": {"mode": "everyone"}}');
SELECT tests.policy405('closed');
SELECT is(tests.code405('alice405@myschool.edu', 'custom:school', 'true'), 403, 'an unknown mode follows the policy');
SELECT tests.providers405('[]');
SELECT is(tests.code405('alice405@myschool.edu', 'custom:school', 'true'), 403, 'as does a setting that is not an object');

-- The policy refuses on its own failure; the limits still run after it. --------------------------
SELECT tests.policy405('invite');
ALTER TABLE public.signup_invite_passes RENAME TO signup_invite_passes_away405;
SELECT is(tests.code405('new405@example.org'), 503, 'a failing policy refuses');
ALTER TABLE public.signup_invite_passes_away405 RENAME TO signup_invite_passes;

UPDATE public.instance_config SET config_value = 'true'::jsonb WHERE config_key = 'signup_limits_enabled';
UPDATE public.instance_config SET config_value = '["203.0.113.0/24"]'::jsonb WHERE config_key = 'signup_blocked_networks';
CREATE TEMP TABLE ledger405 AS SELECT count(*) AS n FROM public.signup_ledger;
SELECT is(tests.msg405('new405@example.org'), 'This instance takes new accounts by invitation only. Ask its admin for one.',
  'the policy answers before the limits');
SELECT is((SELECT count(*) FROM public.signup_ledger), (SELECT n FROM ledger405), 'and a refused sign-up is not counted');
SELECT tests.policy405('open');
SELECT is(tests.msg405('new405@example.org'),
  'Sign-ups from this network are not available on this instance. Ask this instance''s admin for an invitation.',
  'an allowed sign-up meets the limits');

SELECT * FROM finish();
ROLLBACK;
