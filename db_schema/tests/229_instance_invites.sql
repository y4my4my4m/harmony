-- 20261105980001_instance_invites.sql: instance_invites records who invited which address and
-- what became of it; the admin_* invitation functions are service-role only, record links,
-- list invitations with the auth user's state, and revoke an invitation by deleting a
-- never-used invited auth user, never an account with a chosen password or a profile
-- (20261107600001).
--
--   alice        fixture member (01_fixtures.sql), made an instance admin here
--   bob          fixture member, not an admin
--   new229       invited auth user, no profile
--   cli229       invited auth user, recorded from the command line
--   orphan229    invited auth user without a record (an invitation made outside Harmony)
--   joined229    invited auth user that has chosen a password
--   self229      auth user that signed up itself and never confirmed
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(34);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO auth.users (id, instance_id, aud, role, email, invited_at, confirmation_sent_at, confirmed_at, last_sign_in_at, created_at)
VALUES
  ('a2290000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'new229@test.local', now() - interval '1 hour', now() - interval '1 hour', NULL, NULL, now() - interval '1 hour'),
  ('a2290000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'cli229@test.local', now() - interval '2 hours', now() - interval '2 hours', NULL, NULL, now() - interval '2 hours'),
  ('a2290000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'orphan229@test.local', now() - interval '3 hours', now() - interval '3 hours', NULL, NULL, now() - interval '3 hours'),
  ('a2290000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'joined229@test.local', now() - interval '4 hours', now() - interval '4 hours', NULL, NULL, now() - interval '4 hours'),
  ('a2290000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'self229@test.local', NULL, now() - interval '5 hours', NULL, NULL, now() - interval '5 hours');

GRANT USAGE ON SCHEMA tests TO service_role;
CREATE TEMP TABLE r229 (k text PRIMARY KEY, v text);
GRANT ALL ON r229 TO anon, authenticated, service_role;

CREATE FUNCTION tests.as_service229() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('role', 'service_role', true);
END;
$fn$;

-- Grants. -----------------------------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('anon', 'public.instance_invites', 'SELECT'), 'anon reads no invitation');
SELECT ok(has_table_privilege('authenticated', 'public.instance_invites', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.instance_invites', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.instance_invites', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.instance_invites', 'DELETE'),
  'clients read the table and write nothing');
SELECT ok(NOT has_function_privilege('authenticated', 'public.admin_record_instance_invite(uuid, text, text, text, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.admin_revoke_instance_invite(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.admin_instance_invites(integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.admin_instance_invite_account(text, uuid)', 'EXECUTE'),
  'no invitation function is callable by a signed-in client');
SELECT ok(NOT has_function_privilege('anon', 'public.admin_revoke_instance_invite(uuid, uuid)', 'EXECUTE'),
  'nor by anon');
SELECT ok(has_function_privilege('service_role', 'public.admin_record_instance_invite(uuid, text, text, text, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.admin_revoke_instance_invite(uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.admin_instance_invites(integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.admin_instance_invite_account(text, uuid)', 'EXECUTE'),
  'the service role calls them');

-- Recording links. --------------------------------------------------------------------------------
SELECT tests.as_service229();
INSERT INTO r229 VALUES ('new', public.admin_record_instance_invite(
  'a2290000-0000-0000-0000-000000000001', 'New229@Test.local', 'link', 'create', '11111111-0000-0000-0000-000000000001')::text);
INSERT INTO r229 VALUES ('cli', public.admin_record_instance_invite(
  'a2290000-0000-0000-0000-000000000002', 'cli229@test.local', 'link', 'create', NULL)::text);
INSERT INTO r229 VALUES ('joined', public.admin_record_instance_invite(
  'a2290000-0000-0000-0000-000000000004', 'joined229@test.local', 'email', 'create', '11111111-0000-0000-0000-000000000001')::text);
SELECT tests.clear_authentication();

SELECT is((SELECT ARRAY[email, source, delivery, invited_by::text, links_issued::text]
             FROM public.instance_invites WHERE id = (SELECT v FROM r229 WHERE k = 'new')::uuid),
  ARRAY['new229@test.local', 'admin', 'link', '11111111-0000-0000-0000-000000000001', '1'],
  'an admin''s invitation records the address in lower case, its admin and a link');
SELECT is((SELECT ARRAY[source, coalesce(invited_by::text, 'none')]
             FROM public.instance_invites WHERE id = (SELECT v FROM r229 WHERE k = 'cli')::uuid),
  ARRAY['cli', 'none'], 'an invitation without an admin comes from the command line');
SELECT is((SELECT count(*)::int FROM public.admin_audit_log
            WHERE action_type = 'instance_invite_created' AND target_id = (SELECT v FROM r229 WHERE k = 'new')),
  1, 'the admin''s invitation is in the activity log');
SELECT is((SELECT count(*)::int FROM public.admin_audit_log
            WHERE target_id = (SELECT v FROM r229 WHERE k = 'cli')),
  0, 'the command line writes no activity row');

SELECT tests.as_service229();
SELECT throws_ok($$SELECT public.admin_record_instance_invite('a2290000-0000-0000-0000-000000000001', 'other@test.local', 'link', 'create', NULL)$$,
  'P0002', NULL, 'a record names the invited user''s own address');
SELECT throws_ok($$SELECT public.admin_record_instance_invite('a2290000-0000-0000-0000-000000000005', 'self229@test.local', 'link', 'create', NULL)$$,
  'P0002', NULL, 'an account made without an invitation is not recorded as one');
SELECT throws_ok($$SELECT public.admin_record_instance_invite('a2290000-0000-0000-0000-000000000001', 'new229@test.local', 'carrier pigeon', 'create', NULL)$$,
  '22023', NULL, 'delivery is link or email');
SELECT throws_ok($$SELECT public.admin_record_instance_invite('a2290000-0000-0000-0000-000000000001', 'new229@test.local', 'link', 'reissue', NULL)$$,
  '22023', NULL, 'a re-issue names its admin');

SELECT is(public.admin_record_instance_invite('a2290000-0000-0000-0000-000000000001', 'new229@test.local', 'email', 'reissue',
                                              '11111111-0000-0000-0000-000000000001')::text,
  (SELECT v FROM r229 WHERE k = 'new'), 'a re-issue keeps the invitation');
INSERT INTO r229 VALUES ('orphan', public.admin_record_instance_invite(
  'a2290000-0000-0000-0000-000000000003', 'orphan229@test.local', 'link', 'reissue', '11111111-0000-0000-0000-000000000001')::text);
SELECT tests.clear_authentication();

SELECT is((SELECT ARRAY[links_issued::text, delivery] FROM public.instance_invites WHERE id = (SELECT v FROM r229 WHERE k = 'new')::uuid),
  ARRAY['2', 'email'], 'a re-issue counts the link and records how it went out');
SELECT is((SELECT ARRAY[source, coalesce(invited_by::text, 'none'), links_issued::text]
             FROM public.instance_invites WHERE id = (SELECT v FROM r229 WHERE k = 'orphan')::uuid),
  ARRAY['other', 'none', '2'], 'a re-issued invitation without a record gets one, its admin unknown');
SELECT is((SELECT count(*)::int FROM public.admin_audit_log
            WHERE action_type = 'instance_invite_reissued'
              AND target_id IN (SELECT v FROM r229 WHERE k IN ('new', 'orphan'))),
  2, 'both re-issues are in the activity log');

-- Reading. ----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO r229 SELECT 'admin-reads', count(*)::text FROM public.instance_invites;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO r229 SELECT 'member-reads', count(*)::text FROM public.instance_invites;
SELECT tests.clear_authentication();
SELECT is((SELECT v FROM r229 WHERE k = 'admin-reads'), '4', 'an instance admin reads every invitation');
SELECT is((SELECT v FROM r229 WHERE k = 'member-reads'), '0', 'anyone else reads none');

-- joined229 follows the link: GoTrue confirms the address, signs in and stores a random password;
-- then the person chooses theirs.
UPDATE auth.users SET confirmed_at = now() - interval '30 minutes', last_sign_in_at = now() - interval '30 minutes',
                      confirmation_sent_at = NULL, encrypted_password = '$2a$10$random-at-verification-joined229'
 WHERE id = 'a2290000-0000-0000-0000-000000000004';
UPDATE auth.users SET encrypted_password = '$2a$10$chosen-by-the-person-joined229'
 WHERE id = 'a2290000-0000-0000-0000-000000000004';
INSERT INTO auth.users (id, instance_id, aud, role, email, invited_at, confirmation_sent_at, created_at)
VALUES ('a2290000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'outside229@test.local', now() - interval '10 minutes', now() - interval '10 minutes', now() - interval '10 minutes');

SELECT tests.as_service229();
INSERT INTO r229 SELECT 'status:' || email, status FROM public.admin_instance_invites(500)
 WHERE email LIKE '%229@test.local';
INSERT INTO r229 SELECT 'order', string_agg(status, ',' ORDER BY n)
  FROM public.admin_instance_invites(500) WITH ORDINALITY AS l(id, email, auth_user_id, source, delivery,
       invited_by_username, created_at, links_issued, link_sent_at, accepted_at, account_username, revoked_at,
       revoked_by_username, status, n)
 WHERE email LIKE '%229@test.local';
SELECT tests.clear_authentication();

SELECT is((SELECT v FROM r229 WHERE k = 'status:joined229@test.local'), 'accepted', 'an invitation whose account chose a password is accepted');
SELECT ok((SELECT accepted_at IS NOT NULL FROM public.instance_invites WHERE auth_user_id = 'a2290000-0000-0000-0000-000000000004'),
  'and its acceptance is recorded');
SELECT is((SELECT v FROM r229 WHERE k = 'status:new229@test.local'), 'pending', 'an unused invitation is pending');
SELECT is((SELECT v FROM r229 WHERE k = 'status:outside229@test.local'), 'pending',
  'a GoTrue invitation without a record is listed as pending');
SELECT is((SELECT v FROM r229 WHERE k = 'order'), 'pending,pending,pending,pending,accepted', 'open invitations come first');
SELECT ok(NOT EXISTS (SELECT 1 FROM r229 WHERE k = 'status:self229@test.local'), 'an account made by sign-up is no invitation');

-- Revoking. ---------------------------------------------------------------------------------------
SELECT tests.as_service229();
INSERT INTO r229 VALUES ('revoke-new', public.admin_revoke_instance_invite('a2290000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'));
INSERT INTO r229 VALUES ('revoke-joined', public.admin_revoke_instance_invite('a2290000-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001'));
INSERT INTO r229 VALUES ('revoke-alice', public.admin_revoke_instance_invite('aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'));
INSERT INTO r229 VALUES ('revoke-self', public.admin_revoke_instance_invite('a2290000-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001'));
INSERT INTO r229 VALUES ('revoke-again', public.admin_revoke_instance_invite('a2290000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'));
INSERT INTO r229 VALUES ('revoke-outside', public.admin_revoke_instance_invite('a2290000-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001'));
SELECT tests.clear_authentication();

SELECT is((SELECT v FROM r229 WHERE k = 'revoke-new'), 'revoked', 'an unused invitation is revoked');
SELECT ok(NOT EXISTS (SELECT 1 FROM auth.users WHERE id = 'a2290000-0000-0000-0000-000000000001'),
  'and its auth user is gone, so the link finds no one');
SELECT is((SELECT ARRAY[revoked_by::text, (revoked_at IS NOT NULL)::text] FROM public.instance_invites
            WHERE auth_user_id = 'a2290000-0000-0000-0000-000000000001'),
  ARRAY['11111111-0000-0000-0000-000000000001', 'true'], 'the record keeps who revoked it');
SELECT is((SELECT count(*)::int FROM public.admin_audit_log WHERE action_type = 'instance_invite_revoked'),
  2, 'each revoke is in the activity log');
SELECT is(ARRAY[(SELECT v FROM r229 WHERE k = 'revoke-joined'), (SELECT v FROM r229 WHERE k = 'revoke-alice')],
  ARRAY['accepted', 'accepted'], 'an account with a chosen password or a profile is not revoked');
SELECT ok(EXISTS (SELECT 1 FROM auth.users WHERE id = 'a2290000-0000-0000-0000-000000000004')
          AND EXISTS (SELECT 1 FROM auth.users WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'and both accounts remain');
SELECT is(ARRAY[(SELECT v FROM r229 WHERE k = 'revoke-self'), (SELECT v FROM r229 WHERE k = 'revoke-again')],
  ARRAY['not_invited', 'not_found'], 'an account made by sign-up stays; a revoked invitation is not found again');
SELECT is((SELECT ARRAY[source, (revoked_at IS NOT NULL)::text] FROM public.instance_invites
            WHERE auth_user_id = 'a2290000-0000-0000-0000-000000000006'),
  ARRAY['other', 'true'], 'revoking a GoTrue invitation without a record records it as revoked');

SELECT tests.as_service229();
SELECT throws_ok($$SELECT public.admin_record_instance_invite('a2290000-0000-0000-0000-000000000004', 'joined229@test.local', 'link', 'reissue', '11111111-0000-0000-0000-000000000001')$$,
  '55000', NULL, 'an accepted invitation takes no new link');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
