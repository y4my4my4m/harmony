-- 20261107600001_instance_invite_acceptance.sql: an invitation is accepted once its account
-- chooses a password or makes a profile. GoTrue's invite verification stores a random password
-- for an account without one; that first hash is no acceptance. An account whose link was
-- fetched by something else (confirmed, signed in, random password, no profile) is still an
-- open invitation: listed pending, re-issued, revoked by deleting its auth user.
--
--   alice        fixture member (01_fixtures.sql), made an instance admin here
--   spent241     invited; a link preview's GET verifies it
--   pass241      invited, verified, then chooses a password; no profile yet
--   prof241      invited, makes a profile without a password
--   other241     GoTrue invitation without a record, spent by a link preview
--   chose241     GoTrue invitation without a record, verified, then chooses a password
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(24);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

-- Hashes stand in for bcrypt: GoTrue's random password at verification, then the chosen one.
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, invited_at, confirmation_sent_at,
                        recovery_sent_at, confirmed_at, last_sign_in_at, created_at, updated_at)
VALUES
  ('a2410000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'spent241@test.local', '', now() - interval '3 hours', now() - interval '3 hours', NULL,
   NULL, NULL, now() - interval '3 hours', now() - interval '3 hours'),
  ('a2410000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pass241@test.local', '', now() - interval '3 hours', now() - interval '3 hours', NULL,
   NULL, NULL, now() - interval '3 hours', now() - interval '3 hours'),
  ('a2410000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'prof241@test.local', '', now() - interval '3 hours', now() - interval '3 hours', NULL,
   now() - interval '2 hours', now() - interval '2 hours', now() - interval '3 hours', now() - interval '2 hours'),
  ('a2410000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'other241@test.local', '$2a$10$random-at-verification-other241', now() - interval '4 hours', now() - interval '4 hours', NULL,
   now() - interval '1 hour', now() - interval '1 hour', now() - interval '4 hours', now() - interval '1 hour'),
  ('a2410000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'chose241@test.local', '$2a$10$random-at-verification-chose241', now() - interval '5 hours', now() - interval '5 hours', NULL,
   now() - interval '1 hour', now() - interval '1 hour', now() - interval '5 hours', now() - interval '1 hour');

INSERT INTO public.instance_invites (email, auth_user_id, invited_by, source, delivery, created_at, link_issued_at)
VALUES
  ('spent241@test.local', 'a2410000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'admin', 'link',
   now() - interval '3 hours', now() - interval '3 hours'),
  ('pass241@test.local', 'a2410000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'admin', 'link',
   now() - interval '3 hours', now() - interval '3 hours'),
  ('prof241@test.local', 'a2410000-0000-0000-0000-000000000003', NULL, 'cli', 'link',
   now() - interval '3 hours', now() - interval '3 hours');

GRANT USAGE ON SCHEMA tests TO service_role;
CREATE TEMP TABLE r241 (k text PRIMARY KEY, v text);
GRANT ALL ON r241 TO anon, authenticated, service_role;

CREATE FUNCTION tests.as_service241() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('role', 'service_role', true);
END;
$fn$;

CREATE FUNCTION tests.list241() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  DELETE FROM r241 WHERE k LIKE 'status:%' OR k LIKE 'sent:%' OR k LIKE 'name:%';
  INSERT INTO r241 SELECT 'status:' || email, status FROM public.admin_instance_invites(500) WHERE email LIKE '%241@test.local';
  INSERT INTO r241 SELECT 'sent:' || email, link_sent_at::text FROM public.admin_instance_invites(500) WHERE email LIKE '%241@test.local';
  INSERT INTO r241 SELECT 'name:' || email, coalesce(account_username, 'none') FROM public.admin_instance_invites(500) WHERE email LIKE '%241@test.local';
END;
$fn$;
GRANT EXECUTE ON FUNCTION tests.list241() TO service_role;

-- Grants and definitions. -------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.admin_instance_invite_account(text, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.admin_revoke_instance_invite(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.admin_instance_invites(integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.admin_instance_invites(integer)', 'EXECUTE'),
  'the redefined functions stay closed to clients');
SELECT ok(has_function_privilege('service_role', 'public.admin_instance_invite_account(text, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.admin_revoke_instance_invite(uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.admin_instance_invites(integer)', 'EXECUTE'),
  'the service role calls them');
SELECT ok(NOT has_function_privilege('anon', 'public.on_invited_password_chosen()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.on_invited_password_chosen()', 'EXECUTE'),
  'the trigger function is no endpoint');
SELECT is((SELECT count(*)::int FROM pg_proc
            WHERE oid IN ('public.admin_instance_invite_account(text, uuid)'::regprocedure,
                          'public.admin_revoke_instance_invite(uuid, uuid)'::regprocedure,
                          'public.admin_instance_invites(integer)'::regprocedure,
                          'public.on_invited_password_chosen()'::regprocedure)
              AND prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']),
  4, 'each is SECURITY DEFINER with its search_path set');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'harmony_invite_password_chosen'
                   AND tgrelid = 'auth.users'::regclass AND NOT tgisinternal),
  'the trigger watches auth.users');

-- A link preview's GET: GoTrue confirms, signs in and stores a random password in one go.
UPDATE auth.users SET encrypted_password = '$2a$10$random-at-verification-spent241',
                      confirmed_at = now() - interval '2 hours', last_sign_in_at = now() - interval '2 hours',
                      updated_at = now() - interval '2 hours'
 WHERE id = 'a2410000-0000-0000-0000-000000000001';
SELECT ok((SELECT accepted_at IS NULL FROM public.instance_invites WHERE auth_user_id = 'a2410000-0000-0000-0000-000000000001'),
  'the password GoTrue stores at verification is no acceptance');

-- pass241 opens the page: verification, then the password it chooses.
UPDATE auth.users SET encrypted_password = '$2a$10$random-at-verification-pass241',
                      confirmed_at = now() - interval '20 minutes', last_sign_in_at = now() - interval '20 minutes'
 WHERE id = 'a2410000-0000-0000-0000-000000000002';
UPDATE auth.users SET encrypted_password = '$2a$10$chosen-by-the-person-pass241'
 WHERE id = 'a2410000-0000-0000-0000-000000000002';
-- chose241, invited outside Harmony, does the same.
UPDATE auth.users SET encrypted_password = '$2a$10$chosen-by-the-person-chose241'
 WHERE id = 'a2410000-0000-0000-0000-000000000005';
-- prof241 makes a profile (signed in through a provider).
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES ('a2410000-0000-0000-0000-000000000003', 'a2410000-0000-0000-0000-000000000003', 'prof241', 'Prof', true);

SELECT ok((SELECT accepted_at = now() FROM public.instance_invites WHERE auth_user_id = 'a2410000-0000-0000-0000-000000000002'),
  'a chosen password records acceptance as it is stored');
SELECT is((SELECT ARRAY[source, (accepted_at IS NOT NULL)::text] FROM public.instance_invites
            WHERE auth_user_id = 'a2410000-0000-0000-0000-000000000005'),
  ARRAY['other', 'true'], 'a GoTrue invitation without a record gets one, accepted');

-- What an account is to its invitation. ------------------------------------------------------------
SELECT tests.as_service241();
INSERT INTO r241 SELECT 'account:' || email, accepted::text || ',' || has_profile::text
  FROM public.admin_instance_invite_account(NULL, 'a2410000-0000-0000-0000-000000000001');
INSERT INTO r241 SELECT 'account:' || email, accepted::text || ',' || has_profile::text
  FROM public.admin_instance_invite_account('PASS241@test.local', NULL);
INSERT INTO r241 SELECT 'account:' || email, accepted::text || ',' || has_profile::text
  FROM public.admin_instance_invite_account(NULL, 'a2410000-0000-0000-0000-000000000003');
SELECT tests.list241();
SELECT tests.clear_authentication();

SELECT is((SELECT v FROM r241 WHERE k = 'account:spent241@test.local'), 'false,false',
  'an account verified by a fetched link, with no chosen password, is not accepted');
SELECT is(ARRAY[(SELECT v FROM r241 WHERE k = 'account:pass241@test.local'), (SELECT v FROM r241 WHERE k = 'account:prof241@test.local')],
  ARRAY['true,false', 'true,true'], 'a chosen password or a profile makes the account accepted');

-- Listing. -----------------------------------------------------------------------------------------
SELECT is((SELECT v FROM r241 WHERE k = 'status:spent241@test.local'), 'pending',
  'an invitation spent by a link preview is listed as pending');
SELECT ok((SELECT accepted_at IS NULL FROM public.instance_invites WHERE auth_user_id = 'a2410000-0000-0000-0000-000000000001'),
  'and the listing records no acceptance for it');
SELECT is((SELECT v FROM r241 WHERE k = 'status:other241@test.local'), 'pending',
  'a GoTrue invitation without a record, spent the same way, is listed as pending');
SELECT is(ARRAY[(SELECT v FROM r241 WHERE k = 'status:pass241@test.local'), (SELECT v FROM r241 WHERE k = 'name:pass241@test.local')],
  ARRAY['accepted', 'none'], 'an account with a chosen password and no username yet is accepted');
SELECT is(ARRAY[(SELECT v FROM r241 WHERE k = 'status:prof241@test.local'), (SELECT v FROM r241 WHERE k = 'name:prof241@test.local')],
  ARRAY['accepted', 'prof241'], 'an account with a profile is accepted under its username');

-- A new link for the spent invitation. --------------------------------------------------------------
SELECT tests.as_service241();
INSERT INTO r241 VALUES ('reissue', public.admin_record_instance_invite(
  'a2410000-0000-0000-0000-000000000001', 'spent241@test.local', 'link', 'reissue', '11111111-0000-0000-0000-000000000001')::text);
SELECT tests.clear_authentication();
SELECT is((SELECT links_issued FROM public.instance_invites WHERE auth_user_id = 'a2410000-0000-0000-0000-000000000001'),
  2, 'the spent invitation takes a new link');

-- GoTrue makes it a recovery token: recovery_sent_at, not confirmation_sent_at, moves.
UPDATE auth.users SET recovery_sent_at = now() - interval '1 minute' WHERE id = 'a2410000-0000-0000-0000-000000000001';
SELECT tests.as_service241();
SELECT tests.list241();
SELECT tests.clear_authentication();
SELECT is((SELECT v FROM r241 WHERE k = 'sent:spent241@test.local')::timestamptz, now() - interval '1 minute',
  'its expiry runs from the recovery token');
SELECT is((SELECT v FROM r241 WHERE k = 'sent:other241@test.local')::timestamptz, now() - interval '4 hours',
  'an invitation link expires from its confirmation token');

-- A later password change of an account with a profile records nothing.
UPDATE public.instance_invites SET accepted_at = NULL WHERE auth_user_id = 'a2410000-0000-0000-0000-000000000003';
UPDATE auth.users SET encrypted_password = '$2a$10$first-prof241' WHERE id = 'a2410000-0000-0000-0000-000000000003';
UPDATE auth.users SET encrypted_password = '$2a$10$second-prof241' WHERE id = 'a2410000-0000-0000-0000-000000000003';
SELECT ok((SELECT accepted_at IS NULL FROM public.instance_invites WHERE auth_user_id = 'a2410000-0000-0000-0000-000000000003'),
  'the trigger leaves an account with a profile to the listing');

-- Revoking. -----------------------------------------------------------------------------------------
SELECT tests.as_service241();
INSERT INTO r241 VALUES ('revoke-spent', public.admin_revoke_instance_invite('a2410000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'));
INSERT INTO r241 VALUES ('revoke-other', public.admin_revoke_instance_invite('a2410000-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001'));
INSERT INTO r241 VALUES ('revoke-pass', public.admin_revoke_instance_invite('a2410000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001'));
INSERT INTO r241 VALUES ('revoke-prof', public.admin_revoke_instance_invite('a2410000-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001'));
SELECT tests.clear_authentication();

SELECT is(ARRAY[(SELECT v FROM r241 WHERE k = 'revoke-spent'), (SELECT v FROM r241 WHERE k = 'revoke-other')],
  ARRAY['revoked', 'revoked'], 'a spent invitation without a chosen password or profile is revoked');
SELECT ok(NOT EXISTS (SELECT 1 FROM auth.users WHERE id IN ('a2410000-0000-0000-0000-000000000001', 'a2410000-0000-0000-0000-000000000004')),
  'and its auth user is gone');
SELECT is((SELECT ARRAY[revoked_by::text, (accepted_at IS NULL)::text] FROM public.instance_invites
            WHERE auth_user_id = 'a2410000-0000-0000-0000-000000000001'),
  ARRAY['11111111-0000-0000-0000-000000000001', 'true'], 'the record names who revoked it');
SELECT is(ARRAY[(SELECT v FROM r241 WHERE k = 'revoke-pass'), (SELECT v FROM r241 WHERE k = 'revoke-prof')],
  ARRAY['accepted', 'accepted'], 'an account with a chosen password or a profile is not revoked');
SELECT ok(EXISTS (SELECT 1 FROM auth.users WHERE id = 'a2410000-0000-0000-0000-000000000002')
          AND EXISTS (SELECT 1 FROM auth.users WHERE id = 'a2410000-0000-0000-0000-000000000003'),
  'and both accounts remain');

SELECT * FROM finish();
ROLLBACK;
