-- 20261109800001_admin_delete_accounts.sql: admins delete accounts and free their usernames.
--
--   adm252   instance admin              mod252   instance moderator
--   h1-h3    hoarded accounts            h1 holds a follow with bob and an empty server
--   own252   owns a server with another member
--   soft252  suspended by AdminService's 'delete': holds its username
--   rem252   remote account              sys252   local profile without a sign-in

-- A deleted_ name takes the first 12 hex digits of the profile id: these ids differ there.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(36);

INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, confirmed_at)
SELECT v.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v.email, now(), now()
  FROM (VALUES
    ('e2520000-0000-0000-0000-00000000000a', 'adm252@staff252.test'),
    ('e2520000-0000-0000-0000-00000000000b', 'mod252@staff252.test'),
    ('e2520000-0000-0000-0000-000000000001', 'h1@hoard252.test'),
    ('e2520000-0000-0000-0000-000000000002', 'h2@hoard252.test'),
    ('e2520000-0000-0000-0000-000000000003', 'h3@hoard252.test'),
    ('e2520000-0000-0000-0000-000000000004', 'own@hoard252.test'),
    ('e2520000-0000-0000-0000-000000000005', 'soft@hoard252.test')) AS v(id, email);

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin, is_moderator)
VALUES
  ('f252000a-0000-0000-0000-00000000000a', 'e2520000-0000-0000-0000-00000000000a', 'adm252', 'Adm', true, true, false),
  ('f252000b-0000-0000-0000-00000000000b', 'e2520000-0000-0000-0000-00000000000b', 'mod252', 'Mod', true, false, true),
  ('f2520001-0000-0000-0000-000000000001', 'e2520000-0000-0000-0000-000000000001', 'btc252', 'H1', true, false, false),
  ('f2520002-0000-0000-0000-000000000002', 'e2520000-0000-0000-0000-000000000002', 'ltc252', 'H2', true, false, false),
  ('f2520003-0000-0000-0000-000000000003', 'e2520000-0000-0000-0000-000000000003', 'xmr252', 'H3', true, false, false),
  ('f2520004-0000-0000-0000-000000000004', 'e2520000-0000-0000-0000-000000000004', 'own252', 'Own', true, false, false),
  ('f2520005-0000-0000-0000-000000000005', 'e2520000-0000-0000-0000-000000000005', 'soft252', 'Soft', true, false, false);

UPDATE public.profiles
   SET is_suspended = true, suspended_at = now(), suspension_reason = 'DELETED: Admin deletion'
 WHERE id = 'f2520005-0000-0000-0000-000000000005';

INSERT INTO public.profiles (id, username, display_name, is_local) VALUES
  ('f2520031-0000-0000-0000-000000000031', 'sys252', 'Sys', true);
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, inbox_url, is_local) VALUES
  ('f2520032-0000-0000-0000-000000000032', 'rem252', 'Rem', 'remote252.test',
   'https://remote252.test/users/rem252', 'https://remote252.test/users/rem252/inbox', false);

INSERT INTO public.servers (id, name, owner, public) VALUES
  ('f25200a1-0000-0000-0000-0000000000a1', 'empty252', 'f2520001-0000-0000-0000-000000000001', true),
  ('f25200a2-0000-0000-0000-0000000000a2', 'shared252', 'f2520004-0000-0000-0000-000000000004', true);

INSERT INTO public.user_servers (server_id, user_id, status) VALUES
  ('f25200a1-0000-0000-0000-0000000000a1', 'f2520001-0000-0000-0000-000000000001', 'accepted'),
  ('f25200a2-0000-0000-0000-0000000000a2', 'f2520004-0000-0000-0000-000000000004', 'accepted'),
  ('f25200a2-0000-0000-0000-0000000000a2', 'f2520002-0000-0000-0000-000000000002', 'accepted')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = 'accepted';

INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', 'f2520001-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT DO NOTHING;

-- Who runs it. ------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.admin_delete_accounts(uuid[], text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.admin_delete_accounts_preview(uuid[])', 'EXECUTE'),
          'anon executes neither');
SELECT ok(has_function_privilege('authenticated', 'public.admin_delete_accounts(uuid[], text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.admin_delete_accounts_preview(uuid[])', 'EXECUTE'),
          'authenticated reaches them; the caller check decides');
SELECT ok(NOT has_function_privilege('authenticated', 'public.erase_account(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('service_role', 'public.erase_account(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.admin_delete_skip_reason(uuid, public.profiles)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.admin_delete_caller()', 'EXECUTE'),
          'helpers are internal');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.admin_delete_accounts(ARRAY['f2520003-0000-0000-0000-000000000003'::uuid], 'x')$q$,
    '42501', NULL, 'a member cannot delete');
SELECT throws_ok($q$SELECT * FROM public.admin_delete_accounts_preview(ARRAY['f2520003-0000-0000-0000-000000000003'::uuid])$q$,
    '42501', NULL, 'nor preview');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('e2520000-0000-0000-0000-00000000000b');
SELECT throws_ok($q$SELECT public.admin_delete_accounts(ARRAY['f2520003-0000-0000-0000-000000000003'::uuid], 'x')$q$,
    '42501', NULL, 'a moderator cannot delete');
SELECT throws_ok($q$SELECT * FROM public.admin_delete_accounts_preview(ARRAY['f2520003-0000-0000-0000-000000000003'::uuid])$q$,
    '42501', NULL, 'nor preview');
SELECT tests.clear_authentication();

UPDATE public.profiles SET is_suspended = true WHERE id = 'f252000a-0000-0000-0000-00000000000a';
SELECT tests.authenticate_as('e2520000-0000-0000-0000-00000000000a');
SELECT throws_ok($q$SELECT public.admin_delete_accounts(ARRAY['f2520003-0000-0000-0000-000000000003'::uuid], 'x')$q$,
    '42501', NULL, 'a suspended admin cannot delete');
SELECT tests.clear_authentication();
UPDATE public.profiles SET is_suspended = false WHERE id = 'f252000a-0000-0000-0000-00000000000a';

SELECT is((SELECT username FROM public.profiles WHERE id = 'f2520003-0000-0000-0000-000000000003'), 'xmr252',
    'the refused calls changed nothing');

-- Arguments. --------------------------------------------------------------------------------------
SELECT tests.authenticate_as('e2520000-0000-0000-0000-00000000000a');
SELECT throws_ok($q$SELECT public.admin_delete_accounts(ARRAY['f2520003-0000-0000-0000-000000000003'::uuid], '   ')$q$,
    '22023', NULL, 'a reason is required');
SELECT throws_ok($q$SELECT public.admin_delete_accounts('{}'::uuid[], 'x')$q$, '22023', NULL, 'an empty list is refused');
SELECT throws_ok($q$SELECT public.admin_delete_accounts(
        (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 201)), 'x')$q$,
    '22023', NULL, 'more than 200 accounts are refused');

-- Preview. ----------------------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT username, skip_reason FROM public.admin_delete_accounts_preview(ARRAY[
        'f2520001-0000-0000-0000-000000000001', 'f252000a-0000-0000-0000-00000000000a',
        'f252000b-0000-0000-0000-00000000000b', 'f2520004-0000-0000-0000-000000000004',
        'f2520005-0000-0000-0000-000000000005', 'f2520031-0000-0000-0000-000000000031',
        'f2520032-0000-0000-0000-000000000032']::uuid[]) ORDER BY username$q$,
    $q$VALUES ('adm252'::text, 'self'::text), ('btc252', NULL), ('mod252', 'staff'), ('own252', 'owns_server'),
              ('rem252', 'remote'), ('soft252', NULL), ('sys252', 'no_sign_in')$q$,
    'the preview names each account''s reason');
SELECT is((SELECT jsonb_array_length(owned_servers) FROM public.admin_delete_accounts_preview(
              ARRAY['f2520001-0000-0000-0000-000000000001']::uuid[])), 1, 'and the servers an account owns');

-- Delete. -----------------------------------------------------------------------------------------
CREATE TEMP TABLE res252 AS SELECT public.admin_delete_accounts(ARRAY[
    'f2520001-0000-0000-0000-000000000001', 'f2520003-0000-0000-0000-000000000003', 'f2520003-0000-0000-0000-000000000003',
    'f2520005-0000-0000-0000-000000000005', 'f252000a-0000-0000-0000-00000000000a',
    'f2520004-0000-0000-0000-000000000004']::uuid[],
    'hoarding names') AS r;
SELECT tests.clear_authentication();

SELECT is((SELECT jsonb_array_length(r->'deleted') FROM res252), 3, 'three accounts go; a repeated id counts once');
SELECT results_eq(
    $q$SELECT e->>'username', e->>'reason' FROM res252, jsonb_array_elements(r->'skipped') e ORDER BY 1$q$,
    $q$VALUES ('adm252'::text, 'self'::text), ('own252', 'owns_server')$q$,
    'the caller and a server owner with members stay');
SELECT is((SELECT count(*)::integer FROM auth.users
            WHERE id IN ('e2520000-0000-0000-0000-000000000001', 'e2520000-0000-0000-0000-000000000003',
                         'e2520000-0000-0000-0000-000000000005')), 0, 'their sign-ins are gone');
SELECT ok((SELECT auth_user_id IS NULL AND deleted_at IS NOT NULL AND display_name = 'Deleted User'
             FROM public.profiles WHERE id = 'f2520001-0000-0000-0000-000000000001'), 'the profile is anonymized');
SELECT is((SELECT count(*)::integer FROM public.profiles WHERE username IN ('btc252', 'xmr252', 'soft252')), 0,
    'their usernames are free, a staff-deleted account''s too');
SELECT is((SELECT username FROM public.profiles WHERE id = 'f2520004-0000-0000-0000-000000000004'), 'own252',
    'a skipped account keeps its username');
SELECT is((SELECT count(*)::integer FROM public.servers WHERE id = 'f25200a1-0000-0000-0000-0000000000a1'), 0,
    'a server with no other member goes with its owner');
SELECT is((SELECT count(*)::integer FROM public.servers WHERE id = 'f25200a2-0000-0000-0000-0000000000a2'), 1,
    'a server with members stays');
SELECT is((SELECT count(*)::integer FROM public.follows WHERE following_id = 'f2520001-0000-0000-0000-000000000001'), 0,
    'follows go');
SELECT is((SELECT actor_uri LIKE '%/users/btc252' FROM public.deleted_actors
            WHERE profile_id = 'f2520001-0000-0000-0000-000000000001'), true, 'the tombstone keeps the old actor');
SELECT is((SELECT count(*)::integer FROM public.admin_audit_log
            WHERE action_type = 'user_delete' AND action_details->>'batch_id' = (SELECT r->>'batch_id' FROM res252)), 3,
    'one activity log row per account');
SELECT ok((SELECT bool_and(action_details->>'reason' = 'hoarding names' AND action_details->>'bulk' = 'true')
             FROM public.admin_audit_log
            WHERE action_type = 'user_delete' AND action_details->>'batch_id' = (SELECT r->>'batch_id' FROM res252)),
    'with the reason');
SELECT is((SELECT action_details->>'username' FROM public.admin_audit_log
            WHERE action_type = 'user_delete' AND target_id = 'f2520001-0000-0000-0000-000000000001'), 'btc252',
    'and the name it held');

-- A freed name. -----------------------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, confirmed_at)
VALUES ('e2520000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'new@other252.test', now(), now());
SELECT lives_ok($q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
    VALUES ('f2520009-0000-0000-0000-000000000009', 'e2520000-0000-0000-0000-000000000009', 'btc252', 'New', true)$q$,
    'someone else registers the freed name');

-- A second call finds nothing to do. --------------------------------------------------------------
SELECT tests.authenticate_as('e2520000-0000-0000-0000-00000000000a');
SELECT is((SELECT public.admin_delete_accounts(ARRAY['f2520003-0000-0000-0000-000000000003']::uuid[], 'again') -> 'skipped' -> 0 ->> 'reason'),
    'no_sign_in', 'an account already deleted is left out');
SELECT tests.clear_authentication();

-- delete_my_account runs the same deletion. -------------------------------------------------------
UPDATE auth.users SET encrypted_password = extensions.crypt('h2-password', extensions.gen_salt('bf', 4))
 WHERE id = 'e2520000-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('e2520000-0000-0000-0000-000000000002');
SELECT is((public.delete_my_account('wrong') ->> 'error'), 'invalid_password', 'delete_my_account keeps its password check');
SELECT is((public.delete_my_account('h2-password') ->> 'success'), 'true', 'and deletes');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::integer FROM auth.users WHERE id = 'e2520000-0000-0000-0000-000000000002'), 0, 'the sign-in is gone');
SELECT is((SELECT count(*)::integer FROM public.profiles WHERE username = 'ltc252'), 0, 'the name is free');
SELECT is((SELECT count(*)::integer FROM public.deleted_actors WHERE profile_id = 'f2520002-0000-0000-0000-000000000002'), 1, 'with a tombstone');

UPDATE auth.users SET encrypted_password = extensions.crypt('own-password', extensions.gen_salt('bf', 4))
 WHERE id = 'e2520000-0000-0000-0000-000000000004';
INSERT INTO public.user_servers (server_id, user_id, status)
VALUES ('f25200a2-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002', 'accepted')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = 'accepted';
SELECT tests.authenticate_as('e2520000-0000-0000-0000-000000000004');
SELECT is((public.delete_my_account('own-password') ->> 'error'), 'transfer_ownership_required',
    'and refuses an owner with members');
SELECT tests.clear_authentication();

SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN (VALUES ('public.erase_account(uuid)'::regprocedure, ARRAY['delete_my_account', 'admin_delete_accounts']),
                   ('public.admin_delete_skip_reason(uuid, public.profiles)'::regprocedure, ARRAY['admin_delete_accounts_preview', 'admin_delete_accounts']),
                   ('public.admin_delete_caller()'::regprocedure, ARRAY['admin_delete_accounts_preview', 'admin_delete_accounts'])
           ) AS h(helper, callers) ON p.proname = ANY (h.callers)
     WHERE p.pronamespace = 'public'::regnamespace
       AND NOT has_function_privilege(p.proowner, h.helper, 'EXECUTE')),
    'the owner of every caller can run the deletion helpers');

SELECT * FROM finish();
ROLLBACK;
