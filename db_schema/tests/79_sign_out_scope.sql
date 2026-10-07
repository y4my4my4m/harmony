-- Signing out other devices (migration 20261007500001): sign_out_my_sessions and
-- revoke_my_session require aal2 when the account has a verified factor.
--
-- alice enrols a verified TOTP factor; bob has none; mallory's session is a bystander.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(24);

-- Claims as PostgREST v13 sets them.
CREATE OR REPLACE FUNCTION tests.as_user79(p_uid uuid, p_aal text, p_sid uuid)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
      'sub', p_uid, 'role', 'authenticated', 'aal', p_aal, 'session_id', p_sid)::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('role', 'authenticated', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION tests.sessions79(p_uid uuid) RETURNS uuid[]
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM auth.sessions WHERE user_id = p_uid;
$fn$;
GRANT EXECUTE ON FUNCTION tests.sessions79(uuid) TO authenticated, anon;

INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal) VALUES
  ('a7900000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', now(), now(), 'aal2'),
  ('a7900000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', now(), now(), 'aal2'),
  ('a7900000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', now(), now(), 'aal1'),
  ('b7900000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', now(), now(), 'aal1'),
  ('b7900000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', now(), now(), 'aal1'),
  ('c7900000-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003', now(), now(), 'aal1');
INSERT INTO auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) VALUES
  ('f7900000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'totp', 'unverified', now(), now());
UPDATE auth.mfa_factors SET status = 'verified' WHERE id = 'f7900000-0000-0000-0000-000000000001';
INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, session_id)
VALUES ('11111111-0000-0000-0000-000000000001', 'https://push.test/alice79', 'k', 'a',
        'a7900000-0000-0000-0000-000000000002');

-- Definition -----------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.sign_out_my_sessions(text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.sign_out_my_sessions(text)', 'EXECUTE'),
          'sign_out_my_sessions: authenticated may execute, anon may not');
SELECT ok(has_function_privilege('authenticated', 'public.revoke_my_session(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.revoke_my_session(uuid)', 'EXECUTE'),
          'revoke_my_session: authenticated may execute, anon may not');
SELECT is((SELECT count(*)::int FROM pg_proc p
            WHERE p.oid IN ('public.sign_out_my_sessions(text)'::regprocedure,
                            'public.revoke_my_session(uuid)'::regprocedure)
              AND p.prosecdef
              AND pg_get_userbyid(p.proowner) = 'postgres'
              AND p.proconfig = ARRAY['search_path=public, pg_temp']),
          2, 'both are postgres-owned definers with a pinned search_path');

-- anon ----------------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.sign_out_my_sessions('global')$q$, '42501', NULL,
                 'anon cannot call sign_out_my_sessions');
SELECT throws_ok($q$SELECT public.revoke_my_session('a7900000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'anon cannot call revoke_my_session');
SELECT tests.clear_authentication();

-- Enrolled account at aal1 ----------------------------------------------------------------
SELECT tests.as_user79('aaaaaaaa-0000-0000-0000-000000000001', 'aal1', 'a7900000-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.sign_out_my_sessions('others')$q$, 'PT403', 'insufficient_aal',
                 'aal1 of an enrolled account cannot sign out other devices');
SELECT throws_ok($q$SELECT public.sign_out_my_sessions('global')$q$, 'PT403', 'insufficient_aal',
                 'aal1 of an enrolled account cannot sign out every device');
SELECT throws_ok($q$SELECT public.revoke_my_session('a7900000-0000-0000-0000-000000000001')$q$,
                 'PT403', 'insufficient_aal', 'aal1 of an enrolled account cannot revoke a session');
SELECT is(tests.sessions79('aaaaaaaa-0000-0000-0000-000000000001'),
          ARRAY['a7900000-0000-0000-0000-000000000001', 'a7900000-0000-0000-0000-000000000002',
                'a7900000-0000-0000-0000-000000000003']::uuid[],
          'every session of the enrolled account survives');

-- Arguments -----------------------------------------------------------------------------
SELECT tests.as_user79('aaaaaaaa-0000-0000-0000-000000000001', 'aal2', 'a7900000-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.sign_out_my_sessions('local')$q$, '22023', 'invalid_scope',
                 'scopes other than others and global are refused');
SELECT throws_ok($q$SELECT public.sign_out_my_sessions(NULL)$q$, '22023', 'invalid_scope',
                 'a null scope is refused');
SELECT tests.as_user79('aaaaaaaa-0000-0000-0000-000000000001', 'aal2', NULL);
SELECT throws_ok($q$SELECT public.sign_out_my_sessions('others')$q$, '22023', 'session_required',
                 'others without a session in the token is refused rather than signing out all');
SELECT is(cardinality(tests.sessions79('aaaaaaaa-0000-0000-0000-000000000001')), 3,
          'refused calls delete nothing');

-- Enrolled account at aal2 ----------------------------------------------------------------
SELECT tests.as_user79('aaaaaaaa-0000-0000-0000-000000000001', 'aal2', 'a7900000-0000-0000-0000-000000000001');
SELECT is(public.sign_out_my_sessions(), 2, 'the default scope is others and reports the count');
SELECT is(tests.sessions79('aaaaaaaa-0000-0000-0000-000000000001'),
          ARRAY['a7900000-0000-0000-0000-000000000001']::uuid[],
          'aal2 removes the other sessions and keeps the current one');
SELECT tests.clear_authentication();
-- Schema-only dumps of public carry no triggers on auth.sessions.
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_trigger
                          WHERE tgrelid = 'auth.sessions'::regclass AND tgname = 'harmony_session_deleted')
  THEN is((SELECT count(*)::int FROM public.push_subscriptions WHERE endpoint = 'https://push.test/alice79'),
          0, 'a removed session takes its push target')
  ELSE skip('auth.sessions carries no harmony_session_deleted trigger', 1) END;
SELECT is(tests.sessions79('bbbbbbbb-0000-0000-0000-000000000002')
            || tests.sessions79('cccccccc-0000-0000-0000-000000000003'),
          ARRAY['b7900000-0000-0000-0000-000000000001', 'b7900000-0000-0000-0000-000000000002',
                'c7900000-0000-0000-0000-000000000001']::uuid[],
          'other accounts keep their sessions');

INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal) VALUES
  ('a7900000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', now(), now(), 'aal2');
SELECT tests.as_user79('aaaaaaaa-0000-0000-0000-000000000001', 'aal2', 'a7900000-0000-0000-0000-000000000001');
SELECT is(public.revoke_my_session('a7900000-0000-0000-0000-000000000004'), true,
          'aal2 revokes one of its own sessions');
SELECT is(public.revoke_my_session('c7900000-0000-0000-0000-000000000001'), false,
          'another account''s session is not revoked');
SELECT is(public.sign_out_my_sessions('global'), 1, 'global at aal2 deletes the current session too');
SELECT is(cardinality(tests.sessions79('aaaaaaaa-0000-0000-0000-000000000001')), 0,
          'no session of the enrolled account remains');
SELECT tests.clear_authentication();

-- Account without a factor at aal1 --------------------------------------------------------
SELECT tests.as_user79('bbbbbbbb-0000-0000-0000-000000000002', 'aal1', 'b7900000-0000-0000-0000-000000000001');
SELECT is(public.sign_out_my_sessions('others'), 1, 'aal1 suffices without a verified factor');
SELECT is(tests.sessions79('bbbbbbbb-0000-0000-0000-000000000002'),
          ARRAY['b7900000-0000-0000-0000-000000000001']::uuid[],
          'the current session of the account without a factor stays');
SELECT tests.clear_authentication();
SELECT is(tests.sessions79('cccccccc-0000-0000-0000-000000000003'),
          ARRAY['c7900000-0000-0000-0000-000000000001']::uuid[],
          'the bystander account keeps its session');

SELECT * FROM finish();
ROLLBACK;
