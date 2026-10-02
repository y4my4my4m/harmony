-- Account security (migration 20261005400001): assurance enforcement, recovery codes,
-- sessions, security notices, data export and account deletion.
--
-- Fixture roles: alice enrols a verified TOTP factor and owns server_1 (bob is a member);
-- bob has a password and a remote follower. queue_federation_job is
-- replaced for the transaction so queued jobs can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(68);

CREATE TABLE tests.jobs55 (name text, data jsonb);
GRANT INSERT, SELECT ON tests.jobs55 TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs55 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

-- Claims as PostgREST v13 sets them. amr timestamps are epoch seconds.
CREATE OR REPLACE FUNCTION tests.as_user(p_uid uuid, p_aal text, p_sid uuid,
                                         p_amr jsonb DEFAULT '[]'::jsonb, p_path text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
      'sub', p_uid, 'role', 'authenticated', 'aal', p_aal,
      'session_id', p_sid, 'amr', p_amr)::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('request.path', p_path, true);
  PERFORM set_config('role', 'authenticated', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION tests.fresh(p_method text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('method', p_method,
                                              'timestamp', extract(epoch FROM now())::bigint));
$fn$;

CREATE OR REPLACE FUNCTION tests.stale(p_method text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('method', p_method,
                                              'timestamp', extract(epoch FROM now() - interval '1 hour')::bigint));
$fn$;

CREATE TEMP VIEW notices55 AS
SELECT user_id, data ->> 'event' AS event, data FROM public.notifications WHERE type = 'security';
GRANT SELECT ON notices55 TO authenticated;

-- Fixture -------------------------------------------------------------------------------
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal, user_agent, ip) VALUES
  ('a5a5a5a5-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', now(), now(), 'aal2', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', '203.0.113.7'),
  ('b5b5b5b5-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', now(), now(), 'aal1', 'Mozilla/5.0 (X11; Linux) Firefox/131.0', '198.51.100.4');
INSERT INTO auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) VALUES
  ('f0f0f0f0-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'totp', 'unverified', now(), now());
UPDATE auth.mfa_factors SET status = 'verified' WHERE id = 'f0f0f0f0-0000-0000-0000-000000000001';

UPDATE auth.users SET encrypted_password = extensions.crypt('bob-password', extensions.gen_salt('bf', 4))
 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000002';
UPDATE auth.users SET encrypted_password = extensions.crypt('alice-password', extensions.gen_salt('bf', 4))
 WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';

INSERT INTO public.profiles (id, username, display_name, is_local, domain, inbox_url, shared_inbox_url)
VALUES ('99999999-5555-0000-0000-000000000055', 'remote55', 'Remote', false, 'remote.test',
        'https://remote.test/users/remote55/inbox', 'https://remote.test/inbox');
INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('99999999-5555-0000-0000-000000000055', '22222222-0000-0000-0000-000000000002', 'accepted');
INSERT INTO public.user_private_keys (user_id, private_key)
VALUES ('22222222-0000-0000-0000-000000000002', 'test-private-key-55');
INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, session_id)
VALUES ('11111111-0000-0000-0000-000000000001', 'https://push.test/alice55', 'k', 'a',
        'a5a5a5a5-0000-0000-0000-000000000001');

-- Grants --------------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.enforce_request_assurance()', 'EXECUTE')
          AND has_function_privilege('anon', 'public.enforce_request_assurance()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.session_meets_aal()', 'EXECUTE'),
          'the request roles can run the pre-request hook and the policy predicate');
SELECT ok(NOT has_function_privilege('authenticated', 'public.assert_security_attempt_budget(uuid, text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.record_security_attempt(uuid, text, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.record_security_notice(uuid, text, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.mfa_enabled_for(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.hash_recovery_code(text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.on_auth_session_created()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.profile_handle(uuid)', 'EXECUTE'),
          'internal helpers are not callable by clients');
SELECT ok(NOT has_function_privilege('anon', 'public.generate_mfa_recovery_codes()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.list_my_sessions()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.revoke_my_session(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.request_my_data_export()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.delete_my_account(text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.redeem_recovery_code_and_disable_mfa(text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.verify_my_password(text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.delete_my_account(text)', 'EXECUTE'),
          'account RPCs are granted to authenticated only');
SELECT ok(NOT has_table_privilege('authenticated', 'public.account_security_attempts', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.account_data_exports', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.deleted_actors', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.deleted_actors', 'SELECT'),
          'attempt, export and deleted-actor tables are closed to clients');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname = 'delete_my_account'
             AND pronamespace = 'public'::regnamespace), 1,
          'the zero-argument delete_my_account is replaced, not overloaded');
SELECT is_empty(
    $q$SELECT p.oid::regprocedure::text FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('current_jwt_claims', 'mfa_enabled_for', 'session_meets_aal',
                            'enforce_request_assurance', 'generate_mfa_recovery_codes',
                            'save_recovery_codes', 'verify_recovery_code',
                            'redeem_recovery_code_and_disable_mfa', 'list_my_sessions',
                            'revoke_my_session', 'request_my_data_export', 'delete_my_account',
                            'on_auth_session_created', 'on_auth_mfa_factor_changed')
          AND pg_get_userbyid(p.proowner) <> 'postgres'$q$,
    'account-security functions are owned by postgres whatever role applied the migration');
SELECT ok((SELECT 'pgrst.db_pre_request=public.enforce_request_assurance' = ANY (rolconfig)
             FROM pg_roles WHERE rolname = 'authenticator'),
          'PostgREST runs enforce_request_assurance before every request');

-- Assurance -----------------------------------------------------------------------------
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal1', 'a5a5a5a5-0000-0000-0000-000000000001');
SELECT is(public.session_meets_aal(), false, 'an enrolled account at aal1 does not meet its assurance level');
SELECT throws_ok('SELECT public.enforce_request_assurance()', 'PT403', 'insufficient_aal',
                 'the pre-request hook refuses an aal1 session of an enrolled account');
SELECT is((SELECT count(*)::int FROM public.messages), 0,
          'messages are hidden from an aal1 session of an enrolled account');
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal1', 'a5a5a5a5-0000-0000-0000-000000000001',
                     '[]', '/rpc/redeem_recovery_code_and_disable_mfa');
SELECT lives_ok('SELECT public.enforce_request_assurance()',
                'recovery-code redemption stays reachable below aal2');
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal2', 'a5a5a5a5-0000-0000-0000-000000000001');
SELECT is(public.session_meets_aal(), true, 'aal2 meets the requirement');
SELECT lives_ok('SELECT public.enforce_request_assurance()', 'the hook admits aal2');
SELECT ok((SELECT count(*) FROM public.messages) > 0, 'messages are visible at aal2');
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal2', 'c0c0c0c0-0000-0000-0000-00000000dead');
SELECT throws_ok('SELECT public.enforce_request_assurance()', 'PT401', 'session_revoked',
                 'a token whose session no longer exists is refused');
SELECT tests.as_user('bbbbbbbb-0000-0000-0000-000000000002', 'aal1', 'b5b5b5b5-0000-0000-0000-000000000002');
SELECT is(public.session_meets_aal(), true, 'aal1 suffices without a verified factor');
SELECT tests.authenticate_as_anon();
SELECT lives_ok('SELECT public.enforce_request_assurance()', 'anonymous requests pass the hook');
SELECT tests.clear_authentication();

-- Recovery codes ------------------------------------------------------------------------
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal1', 'a5a5a5a5-0000-0000-0000-000000000001', tests.fresh('totp'));
SELECT throws_ok('SELECT public.generate_mfa_recovery_codes()', 'PT403', 'step_up_required',
                 'codes are not generated below aal2');
SELECT throws_ok($q$SELECT public.save_recovery_codes('aaaaaaaa-0000-0000-0000-000000000001', ARRAY['AAAAAAAAAA'])$q$,
                 'PT403', 'insufficient_aal', 'an aal1 session cannot plant codes for an enrolled account');
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal2', 'a5a5a5a5-0000-0000-0000-000000000001', tests.stale('totp'));
SELECT throws_ok('SELECT public.generate_mfa_recovery_codes()', 'PT403', 'step_up_required',
                 'codes need a TOTP verify within ten minutes');
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal2', 'a5a5a5a5-0000-0000-0000-000000000001', tests.fresh('totp'));
CREATE TEMP TABLE codes55 AS SELECT public.generate_mfa_recovery_codes() AS codes;
SELECT is((SELECT array_length(codes, 1) FROM codes55), 10, 'ten codes are generated');
SELECT ok((SELECT bool_and(c ~ '^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$') FROM codes55, unnest(codes) c),
          'codes are two groups of five Crockford base32 characters');
SELECT is((SELECT count(DISTINCT c)::int FROM codes55, unnest(codes) c), 10, 'codes are distinct');
SELECT is(public.get_mfa_recovery_status() ->> 'remaining', '10', 'status reports ten remaining');
SELECT throws_ok($q$SELECT public.save_recovery_codes('bbbbbbbb-0000-0000-0000-000000000002', ARRAY['AAAAAAAAAA'])$q$,
                 '42501', NULL, 'codes cannot be saved for another account');
SELECT is((SELECT count(*)::int FROM notices55 WHERE user_id = '11111111-0000-0000-0000-000000000001'
              AND event = 'recovery_codes_regenerated'), 1, 'regeneration leaves a security notice');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.mfa_recovery_codes r, codes55
            WHERE r.code_hash = ANY (codes55.codes)), 0, 'plaintext codes are not stored');
SELECT ok(NOT has_table_privilege('authenticated', 'public.mfa_recovery_codes', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.mfa_recovery_codes', 'SELECT')
          AND NOT has_table_privilege('service_role', 'public.mfa_recovery_codes', 'SELECT'),
          'recovery codes are reachable through the definer functions only');

SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal1', 'a5a5a5a5-0000-0000-0000-000000000001');
SELECT is(public.redeem_recovery_code_and_disable_mfa('not-a-code'), false, 'an unknown code is refused');
-- Lower case, a space instead of the dash, and O for 0 / I for 1 still match.
SELECT is(public.redeem_recovery_code_and_disable_mfa(
            (SELECT translate(lower(replace(codes[1], '-', ' ')), '01', 'oi') FROM codes55)),
          true, 'redemption normalises case, separators and look-alike characters');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM auth.mfa_factors WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
          0, 'redemption removes the factors');
SELECT is((SELECT count(*)::int FROM public.mfa_recovery_codes
            WHERE user_id IN ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001')), 0,
          'redemption removes the remaining codes');
SELECT is((SELECT data ->> 'reason' FROM notices55 WHERE user_id = '11111111-0000-0000-0000-000000000001'
             AND event = 'mfa_disabled'), 'recovery_code', 'the disable notice names the recovery code');
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal1', 'a5a5a5a5-0000-0000-0000-000000000001');
SELECT is(public.redeem_recovery_code_and_disable_mfa((SELECT codes[2] FROM codes55)), false,
          'remaining codes die with the factor');
SELECT tests.clear_authentication();

-- Codes issued by released clients: upper-case hex, SHA-256 of the raw string.
INSERT INTO public.mfa_recovery_codes (user_id, code_hash, batch_id)
VALUES (public.recovery_code_owner('bbbbbbbb-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002'),
        encode(extensions.digest('0A1B2C3D4E'::bytea, 'sha256'), 'hex'), gen_random_uuid());
SELECT tests.as_user('bbbbbbbb-0000-0000-0000-000000000002', 'aal1', 'b5b5b5b5-0000-0000-0000-000000000002');
SELECT is(public.verify_recovery_code('bbbbbbbb-0000-0000-0000-000000000002', '0a1b2c3d4e'), true,
          'a legacy hex code verifies');
SELECT is(public.verify_recovery_code('bbbbbbbb-0000-0000-0000-000000000002', '0A1B2C3D4E'), false,
          'a code verifies once');
SELECT throws_ok($q$SELECT public.verify_recovery_code('aaaaaaaa-0000-0000-0000-000000000001', 'X')$q$,
                 '42501', NULL, 'codes of another account cannot be tried');
SELECT public.verify_recovery_code('bbbbbbbb-0000-0000-0000-000000000002', 'WRONG' || g) FROM generate_series(1, 4) g;
SELECT throws_ok($q$SELECT public.verify_recovery_code('bbbbbbbb-0000-0000-0000-000000000002', 'WRONGAGAIN')$q$,
                 'PT429', 'too_many_attempts', 'five failures inside fifteen minutes stop further attempts');
SELECT tests.clear_authentication();

-- Sessions ------------------------------------------------------------------------------
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal1', 'a5a5a5a5-0000-0000-0000-000000000001');
SELECT results_eq('SELECT id, is_current, ip, push_transports FROM public.list_my_sessions()',
                  $q$VALUES ('a5a5a5a5-0000-0000-0000-000000000001'::uuid, true, '203.0.113.7'::text, ARRAY['webpush']::text[])$q$,
                  'list_my_sessions returns the caller''s sessions with the current one marked');
SELECT is(public.revoke_my_session('b5b5b5b5-0000-0000-0000-000000000002'), false,
          'another account''s session cannot be revoked');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM auth.sessions WHERE id = 'b5b5b5b5-0000-0000-0000-000000000002'), 1,
          'and it survives the attempt');

-- Security notices ----------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM notices55 WHERE user_id = '11111111-0000-0000-0000-000000000001'
             AND event = 'mfa_enabled'), 1, 'verifying a factor leaves a notice');
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal, user_agent, ip)
VALUES ('a5a5a5a5-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', now(), now(),
        'aal1', 'Mozilla/5.0 (iPhone) Safari/604.1', '192.0.2.9');
SELECT is((SELECT data ->> 'ip' FROM notices55 WHERE user_id = '11111111-0000-0000-0000-000000000001'
             AND event = 'new_sign_in'), '192.0.2.9', 'a sign-in beside an existing session leaves a notice');
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal)
VALUES ('c5c5c5c5-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000003', now(), now(), 'aal1');
SELECT is((SELECT count(*)::int FROM notices55 WHERE user_id = '33333333-0000-0000-0000-000000000003'), 0,
          'a first session leaves none');
UPDATE auth.users SET encrypted_password = extensions.crypt('alice-password-2', extensions.gen_salt('bf', 4))
 WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM notices55 WHERE user_id = '11111111-0000-0000-0000-000000000001'
             AND event = 'password_changed'), 1, 'a password change leaves a notice');
DELETE FROM auth.sessions WHERE id = 'a5a5a5a5-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM public.push_subscriptions WHERE endpoint = 'https://push.test/alice55'), 0,
          'a deleted session takes its push targets');

-- Export --------------------------------------------------------------------------------
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal1', 'a5a5a5a5-0000-0000-0000-000000000003');
CREATE TEMP TABLE export55 AS SELECT public.request_my_data_export() AS doc;
SELECT is((SELECT doc ->> 'message_count' FROM export55), '2', 'the export counts the caller''s messages');
SELECT is((SELECT jsonb_array_length(doc -> 'conversations' -> 0 -> 'participants') FROM export55), 2,
          'DM metadata lists the participants');
SELECT ok((SELECT doc::text !~ '(private_key|code_hash|p256dh|encrypted_password|session_token)' FROM export55),
          'the export carries no key material, hashes or push keys');
SELECT throws_ok('SELECT public.request_my_data_export()', 'PT429', 'export_rate_limited',
                 'a second export inside ten minutes is refused');
SELECT results_eq(
    $q$SELECT (m ->> 'id')::uuid FROM jsonb_array_elements(
         public.export_my_messages((SELECT (doc ->> 'export_id')::uuid FROM export55)) -> 'messages') m
       ORDER BY 1$q$,
    $q$VALUES ('88888888-0000-0000-0000-000000000008'::uuid), ('99999999-0000-0000-0000-000000000009'::uuid)$q$,
    'export_my_messages pages the caller''s own channel and DM messages');
SELECT tests.as_user('bbbbbbbb-0000-0000-0000-000000000002', 'aal1', 'b5b5b5b5-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.export_my_messages((SELECT (doc ->> 'export_id')::uuid FROM export55))$q$,
                 'PT410', 'export_expired', 'an export id is bound to the account that requested it');

-- Deletion ------------------------------------------------------------------------------
SELECT is(public.verify_my_password('bob-password'), true, 'verify_my_password accepts the current password');
SELECT is(public.verify_my_password('nope'), false, 'and refuses another');
SELECT is(public.delete_my_account() ->> 'error', 'password_required', 'a password account must re-enter it');
SELECT is(public.delete_my_account('wrong') ->> 'error', 'invalid_password', 'a wrong password is refused');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.account_security_attempts
            WHERE auth_user_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND kind = 'password' AND NOT succeeded),
          2, 'password failures are counted across both checks');

INSERT INTO auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
VALUES ('f0f0f0f0-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'totp', 'verified', now(), now());
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal2', 'a5a5a5a5-0000-0000-0000-000000000003', tests.stale('totp'));
SELECT is(public.delete_my_account('alice-password-2') ->> 'error', 'mfa_required',
          'an enrolled account needs a recent TOTP verify');
SELECT tests.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'aal2', 'a5a5a5a5-0000-0000-0000-000000000003', tests.fresh('totp'));
SELECT is(public.delete_my_account('alice-password-2') ->> 'error', 'transfer_ownership_required',
          'a server with other members blocks deletion');

SELECT tests.as_user('bbbbbbbb-0000-0000-0000-000000000002', 'aal1', 'b5b5b5b5-0000-0000-0000-000000000002');
SELECT is(public.delete_my_account('bob-password') ->> 'success', 'true', 'bob deletes his account');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT display_name, auth_user_id IS NULL, deleted_at IS NOT NULL, username LIKE 'deleted\_%'
         FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'$q$,
    $q$VALUES ('Deleted User'::text, true, true, true)$q$,
    'the profile remains as a tombstone');
SELECT is((SELECT count(*)::int FROM auth.users WHERE id = 'bbbbbbbb-0000-0000-0000-000000000002'), 0,
          'the auth user is gone');
SELECT is((SELECT user_id FROM public.messages WHERE id = '88888888-0000-0000-0000-000000000008'),
          '11111111-0000-0000-0000-000000000001'::uuid, 'other users'' content is untouched');
-- profiles.domain defaults to the instance domain, which differs between installs.
SELECT results_eq(
    $q$SELECT username, actor_uri, private_key, inboxes FROM public.deleted_actors
        WHERE profile_id = '22222222-0000-0000-0000-000000000002'$q$,
    $q$SELECT 'bob'::text, 'https://' || domain || '/users/bob', 'test-private-key-55'::text,
              ARRAY['https://remote.test/inbox']::text[]
         FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'$q$,
    'the actor''s key and remote inboxes are kept for the Delete');
SELECT is((SELECT data ->> 'profile_id' FROM tests.jobs55 WHERE name = 'account-deleted'),
          '22222222-0000-0000-0000-000000000002', 'an account-deleted job is queued');
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE user_id = '22222222-0000-0000-0000-000000000002')
          + (SELECT count(*)::int FROM public.follows WHERE following_id = '22222222-0000-0000-0000-000000000002')
          + (SELECT count(*)::int FROM public.user_private_keys WHERE user_id = '22222222-0000-0000-0000-000000000002'),
          0, 'memberships, follows and the key row are purged');
SELECT is((SELECT count(*)::int FROM tests.jobs55 WHERE name = 'federate-profile'
             AND data ->> 'profile_id' = '22222222-0000-0000-0000-000000000002'), 0,
          'the tombstone is not federated as a profile update');

-- Profile guards ------------------------------------------------------------------------
SELECT tests.as_user('cccccccc-0000-0000-0000-000000000003', 'aal1', 'c5c5c5c5-0000-0000-0000-000000000003');
SELECT throws_ok($q$UPDATE public.profiles SET deleted_at = now() WHERE id = '33333333-0000-0000-0000-000000000003'$q$,
                 '42501', NULL, 'a client cannot mark its own profile deleted');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
