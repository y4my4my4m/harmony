-- 20261009900001_instance_moderators.sql: admins grant the moderator flag; moderators
-- suspend, silence and force-sensitive accounts that are neither staff nor their own.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(18);

-- alice: admin. bob: promoted below. mallory: member. banned: another moderator.
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
UPDATE public.profiles SET is_moderator = true WHERE id = '44444444-0000-0000-0000-000000000004';
INSERT INTO public.profiles (id, username, display_name, domain, is_local)
VALUES ('f1020000-0000-0000-0000-0000000000e1', 'remote102', 'Remote', 'remote.example', false);

INSERT INTO public.reports (id, reporter_id, reported_user_id, reason, report_type, content_snapshot)
VALUES ('f1020000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000002',
        '33333333-0000-0000-0000-000000000003', 'spam', 'user', '{}'),
       ('f1020000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002',
        '11111111-0000-0000-0000-000000000001', 'spam', 'user', '{}');

-- Granting -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.admin_set_moderator('22222222-0000-0000-0000-000000000002', true), true,
          'an admin makes a local account a moderator');
SELECT throws_ok($q$SELECT public.admin_set_moderator('f1020000-0000-0000-0000-0000000000e1', true)$q$,
                 '22023', NULL, 'a remote account cannot be made a moderator');
SELECT tests.clear_authentication();

SELECT is((SELECT is_moderator FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'),
          true, 'the moderator flag is stored');
SELECT ok(EXISTS (SELECT 1 FROM public.admin_audit_log
                   WHERE action_type = 'user_promote_moderator'
                     AND target_id = '22222222-0000-0000-0000-000000000002'),
          'the promotion is audit-logged');

-- Moderator actions --------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.admin_set_moderator('33333333-0000-0000-0000-000000000003', true)$q$,
                 '42501', NULL, 'a moderator cannot make moderators');
SELECT lives_ok($q$SELECT public.moderate_user(NULL, '33333333-0000-0000-0000-000000000003', 'suspend', 'r102')$q$,
                'a moderator suspends a member');
SELECT lives_ok($q$SELECT public.moderate_user(NULL, '33333333-0000-0000-0000-000000000003', 'unsuspend')$q$,
                'a moderator lifts the suspension');
SELECT throws_ok($q$SELECT public.moderate_user(NULL, '11111111-0000-0000-0000-000000000001', 'silence')$q$,
                 '42501', 'Moderators cannot act on instance staff', 'a moderator cannot silence an admin');
SELECT throws_ok($q$SELECT public.moderate_user(NULL, '44444444-0000-0000-0000-000000000004', 'suspend')$q$,
                 '42501', 'Moderators cannot act on instance staff', 'a moderator cannot suspend another moderator');
SELECT throws_ok($q$SELECT public.moderate_user(NULL, '22222222-0000-0000-0000-000000000002', 'force_sensitive')$q$,
                 '42501', 'Cannot moderate your own account', 'a moderator cannot act on their own account');
SELECT throws_ok($q$UPDATE public.profiles SET is_admin = true WHERE id = '22222222-0000-0000-0000-000000000002'$q$,
                 '42501', NULL, 'a moderator cannot make themselves admin');

SELECT lives_ok($q$SELECT public.moderate_report('f1020000-0000-0000-0000-0000000000a1', 'silence_account', NULL, 'r102')$q$,
                'a moderator silences a member from a report');
SELECT throws_ok($q$SELECT public.moderate_report('f1020000-0000-0000-0000-0000000000a2', 'suspend_account')$q$,
                 '42501', 'Moderators cannot act on instance staff', 'a report action cannot reach an admin');
SELECT throws_ok($q$SELECT public.moderate_report('f1020000-0000-0000-0000-0000000000a2', 'limit_domain')$q$,
                 '42501', NULL, 'domain actions stay admin-only');
SELECT tests.clear_authentication();

SELECT is((SELECT is_silenced FROM public.profiles WHERE id = '33333333-0000-0000-0000-000000000003'),
          true, 'the report action silenced the member');

-- Members and admins -------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$UPDATE public.profiles SET is_moderator = true WHERE id = '33333333-0000-0000-0000-000000000003'$q$,
                 '42501', NULL, 'a member cannot make themselves a moderator');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.moderate_user(NULL, '22222222-0000-0000-0000-000000000002', 'silence')$q$,
                'an admin acts on a moderator');
SELECT tests.clear_authentication();

SELECT ok(pg_get_functiondef('public.notify_admins_on_pending_donation()'::regprocedure) !~ 'is_moderator',
          'pending-donation notifications go to admins only');

SELECT * FROM finish();
ROLLBACK;
