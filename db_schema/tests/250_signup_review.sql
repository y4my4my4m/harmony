-- 20261109500001_signup_review.sql: signup review reads, bulk suspension, username_hoarding.
--
--   adm250   instance admin            mod250   instance moderator
--   h1-h4    @hoard250.test, signed up an hour ago; h1 owns hall250
--   h1-h3    join hall250 within an hour; h4 joins it two hours after signing up
--   w250     the welcome server; h1-h4 and g1 join at signup
--   g1-g3    @common250.test, recent; old250 on the same domain, signed up 40 days ago
--   rem250   remote account, follows h1
--   sys250   local profile without a sign-in
--   dead250  suspended by AdminService's 'delete'
--   bob      fixture, follows h1 and is followed by h1

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(68);

INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, confirmed_at, last_sign_in_at)
VALUES
  ('e2500000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'adm250@staff250.test', now() - interval '300 days', now(), now()),
  ('e2500000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mod250@staff250.test', now() - interval '300 days', now(), now()),
  ('e2500000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'secret.h1@hoard250.test', now() - interval '60 minutes', now(), now()),
  ('e2500000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'secret.h2@hoard250.test', now() - interval '59 minutes', now(), NULL),
  ('e2500000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'secret.h3@hoard250.test', now() - interval '58 minutes', NULL, NULL),
  ('e2500000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'secret.h4@HOARD250.test', now() - interval '3 hours', now(), NULL),
  ('e2500000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g1@common250.test', now() - interval '2 days', now(), NULL),
  ('e2500000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g2@common250.test', now() - interval '2 days', now(), NULL),
  ('e2500000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g3@common250.test', now() - interval '2 days', now(), NULL),
  ('e2500000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'old@common250.test', now() - interval '40 days', now(), NULL),
  ('e2500000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dead@other250.test', now() - interval '1 day', now(), NULL);

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin, is_moderator)
VALUES
  ('f2500000-0000-0000-0000-00000000000a', 'e2500000-0000-0000-0000-00000000000a', 'adm250', 'Adm', true, true, false),
  ('f2500000-0000-0000-0000-00000000000b', 'e2500000-0000-0000-0000-00000000000b', 'mod250', 'Mod', true, false, true),
  ('f2500000-0000-0000-0000-000000000001', 'e2500000-0000-0000-0000-000000000001', 'h1x250', 'H1', true, false, false),
  ('f2500000-0000-0000-0000-000000000002', 'e2500000-0000-0000-0000-000000000002', 'h2x250', 'H2', true, false, false),
  ('f2500000-0000-0000-0000-000000000003', 'e2500000-0000-0000-0000-000000000003', 'h3x250', 'H3', true, false, false),
  ('f2500000-0000-0000-0000-000000000004', 'e2500000-0000-0000-0000-000000000004', 'h4x250', 'H4', true, false, false),
  ('f2500000-0000-0000-0000-000000000011', 'e2500000-0000-0000-0000-000000000011', 'g1x250', 'G1', true, false, false),
  ('f2500000-0000-0000-0000-000000000012', 'e2500000-0000-0000-0000-000000000012', 'g2x250', 'G2', true, false, false),
  ('f2500000-0000-0000-0000-000000000013', 'e2500000-0000-0000-0000-000000000013', 'g3x250', 'G3', true, false, false),
  ('f2500000-0000-0000-0000-000000000014', 'e2500000-0000-0000-0000-000000000014', 'old250', 'Old', true, false, false),
  ('f2500000-0000-0000-0000-000000000021', 'e2500000-0000-0000-0000-000000000021', 'dead250', 'Dead', true, false, false);

UPDATE public.profiles
   SET is_suspended = true, suspended_at = now(), suspension_reason = 'DELETED: Admin deletion'
 WHERE id = 'f2500000-0000-0000-0000-000000000021';

INSERT INTO public.profiles (id, username, display_name, is_local) VALUES
  ('f2500000-0000-0000-0000-000000000031', 'sys250', 'Sys', true);
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, inbox_url, is_local) VALUES
  ('f2500000-0000-0000-0000-000000000032', 'rem250', 'Rem', 'remote250.test',
   'https://remote250.test/users/rem250', 'https://remote250.test/users/rem250/inbox', false);

INSERT INTO public.servers (id, name, owner, public) VALUES
  ('f2500000-0000-0000-0000-0000000000a1', 'hall250', 'f2500000-0000-0000-0000-000000000001', true),
  ('f2500000-0000-0000-0000-0000000000a2', 'welcome250', '11111111-0000-0000-0000-000000000001', true);

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('welcome_server_id', to_jsonb('f2500000-0000-0000-0000-0000000000a2'::text), 'test')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

INSERT INTO public.user_servers (server_id, user_id, status, created_at)
SELECT 'f2500000-0000-0000-0000-0000000000a1', v.id::uuid, 'accepted', v.at
  FROM (VALUES
    ('f2500000-0000-0000-0000-000000000001', now() - interval '60 minutes'),
    ('f2500000-0000-0000-0000-000000000002', now() - interval '50 minutes'),
    ('f2500000-0000-0000-0000-000000000003', now() - interval '40 minutes'),
    ('f2500000-0000-0000-0000-000000000004', now() - interval '1 hour'),
    ('f2500000-0000-0000-0000-000000000014', now() - interval '30 days')) AS v(id, at)
ON CONFLICT (user_id, server_id) DO UPDATE SET status = 'accepted', created_at = EXCLUDED.created_at;

INSERT INTO public.user_servers (server_id, user_id, status, created_at)
SELECT 'f2500000-0000-0000-0000-0000000000a2', p.id, 'accepted', a.created_at
  FROM public.profiles p JOIN auth.users a ON a.id = p.auth_user_id
 WHERE p.username IN ('h1x250', 'h2x250', 'h3x250', 'h4x250', 'g1x250')
ON CONFLICT (user_id, server_id) DO NOTHING;

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2500000-0000-0000-0000-0000000000c1', 'f2500000-0000-0000-0000-0000000000a1', 'general', 0);
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f2500000-0000-0000-0000-0000000000d1', 'f2500000-0000-0000-0000-0000000000c1', 'f2500000-0000-0000-0000-000000000001',
   '[{"type":"text","text":"hi"}]'::jsonb);
INSERT INTO public.posts (author_id, content, visibility) VALUES
  ('f2500000-0000-0000-0000-000000000001', '[{"type":"text","text":"mine"}]'::jsonb, 'public');

INSERT INTO public.follows (follower_id, following_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2500000-0000-0000-0000-000000000001'),
  ('f2500000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'),
  ('f2500000-0000-0000-0000-000000000032', 'f2500000-0000-0000-0000-000000000001');

INSERT INTO auth.sessions (id, user_id) VALUES
  ('f2500000-0000-0000-0000-0000000000e1', 'e2500000-0000-0000-0000-000000000001'),
  ('f2500000-0000-0000-0000-0000000000e2', 'e2500000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------
-- Admission
-- ---------------------------------------------------------------------------

SELECT ok(NOT has_function_privilege('anon', 'public.staff_recent_signups(integer, text, text, uuid[], integer, integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.staff_signup_groups(integer, integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.staff_signup_daily(integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.staff_bulk_suspend_preview(uuid[], boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.staff_bulk_set_suspended(uuid[], boolean, text)', 'EXECUTE'),
          'anon executes none of them');
SELECT ok(has_function_privilege('authenticated', 'public.staff_recent_signups(integer, text, text, uuid[], integer, integer)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.staff_bulk_set_suspended(uuid[], boolean, text)', 'EXECUTE'),
          'authenticated reaches them; staff_caller decides');
SELECT ok(NOT has_function_privilege('authenticated', 'public.staff_bulk_skip_reason(uuid, public.profiles, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.staff_bulk_check_ids(uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.signup_review_welcome_server()', 'EXECUTE'),
          'helpers are internal');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT * FROM public.staff_recent_signups()$q$, '42501', NULL, 'a member cannot list signups');
SELECT throws_ok($q$SELECT * FROM public.staff_signup_groups()$q$, '42501', NULL, 'a member cannot list groups');
SELECT throws_ok($q$SELECT * FROM public.staff_signup_daily()$q$, '42501', NULL, 'a member cannot read daily counts');
SELECT throws_ok($q$SELECT * FROM public.staff_bulk_suspend_preview(ARRAY['f2500000-0000-0000-0000-000000000002'::uuid])$q$,
    '42501', NULL, 'a member cannot preview');
SELECT throws_ok($q$SELECT public.staff_bulk_set_suspended(ARRAY['f2500000-0000-0000-0000-000000000002'::uuid], true, 'x')$q$,
    '42501', NULL, 'a member cannot suspend');
SELECT tests.clear_authentication();
SELECT is((SELECT is_suspended FROM public.profiles WHERE id = 'f2500000-0000-0000-0000-000000000002'), false,
    'the refused call changed nothing');

-- ---------------------------------------------------------------------------
-- Reads, as a moderator
-- ---------------------------------------------------------------------------

DELETE FROM public.signup_refusal_counts;
INSERT INTO public.signup_refusal_counts (day, reason, refusals, would_refuse)
VALUES ((now() AT TIME ZONE 'UTC')::date, 'ip_cap', 1, 3),
       ((now() AT TIME ZONE 'UTC')::date, 'blocked_domain', 2, 0);

SELECT tests.authenticate_as('e2500000-0000-0000-0000-00000000000b');

CREATE TEMP TABLE daily AS SELECT * FROM public.staff_signup_daily(30);
SELECT is((SELECT count(*)::integer FROM daily), 30, 'daily: one row per day, zero days included');
SELECT is((SELECT count(*)::integer FROM daily WHERE signups = 0 AND peak_hour_count = 0 AND top_domain_count = 0) > 0, true,
    'daily: a day without signups reads zero');
SELECT is((SELECT sum(signups)::integer FROM daily WHERE day >= (now() AT TIME ZONE 'UTC')::date - 2)
              >= 8, true, 'daily: the recent accounts are counted');
SELECT results_eq(
    $q$SELECT refused, would_refuse FROM daily WHERE day = (now() AT TIME ZONE 'UTC')::date$q$,
    $q$VALUES (3, 3)$q$,
    'daily: refusals and past-cap signups of all reasons, though no account exists for a refusal');

CREATE TEMP TABLE grp AS SELECT * FROM public.staff_signup_groups(7, 3);
SELECT results_eq(
    $q$SELECT size, suspended, prior_count, cardinality(member_ids) FROM grp WHERE kind = 'email_domain' AND key = 'hoard250.test'$q$,
    $q$VALUES (4, 0, 0, 4)$q$,
    'a domain group folds case and counts members, none suspended, none earlier');
SELECT results_eq(
    $q$SELECT size, prior_count FROM grp WHERE kind = 'email_domain' AND key = 'common250.test'$q$,
    $q$VALUES (3, 1)$q$,
    'prior_count holds the account on that domain before the window');
SELECT results_eq(
    $q$SELECT size, label, prior_count, member_ids[1] FROM grp WHERE kind = 'first_server' AND key = 'f2500000-0000-0000-0000-0000000000a1'$q$,
    $q$VALUES (3, 'hall250'::text, 1, 'f2500000-0000-0000-0000-000000000001'::uuid)$q$,
    'a server group holds joins within an hour of signup, oldest first; h4 joined two hours after');
SELECT is((SELECT count(*)::integer FROM grp WHERE key = 'f2500000-0000-0000-0000-0000000000a2'), 0,
    'the welcome server is no group');
SELECT is((SELECT count(*)::integer FROM public.staff_signup_groups(7, 4) WHERE key = 'common250.test'), 0,
    'p_min_size leaves smaller groups out');
SELECT is((SELECT count(*)::integer FROM public.staff_signup_groups(7, 3)
             WHERE key = 'staff250.test' OR key = 'other250.test'), 0, 'older and smaller domains make no group');

CREATE TEMP TABLE rec AS SELECT * FROM public.staff_recent_signups(7, NULL, 'all', NULL, 200, 0);
SELECT is((SELECT count(*)::integer FROM rec r WHERE to_jsonb(r)::text LIKE '%secret.h%' OR to_jsonb(r)::text LIKE '%@hoard250%'), 0,
    'no row carries an email address');
SELECT ok(NOT EXISTS (SELECT 1 FROM information_schema.routines
                       WHERE routine_name = 'staff_recent_signups'
                         AND routine_definition ~* 'sessions|\mip\M'),
    'the listing reads neither sessions nor an IP');
SELECT results_eq(
    $q$SELECT email_domain, email_confirmed, post_count, message_count, server_count, owned_server_count, first_server_name,
              first_server_after_seconds, is_staff, is_suspended
         FROM rec WHERE username = 'h1x250'$q$,
    $q$VALUES ('hoard250.test'::text, true, 1, 1, 2, 1, 'hall250'::text, 0, false, false)$q$,
    'a row holds domain, confirmation, activity counts and the first non-welcome server');
SELECT is((SELECT email_confirmed FROM rec WHERE username = 'h3x250'), false, 'an unconfirmed address reads false');
SELECT is((SELECT first_server_name FROM rec WHERE username = 'h4x250'), NULL, 'a join after the hour is no first server');
SELECT is((SELECT count(*)::integer FROM rec WHERE username = 'old250'), 0, 'older than the window');
SELECT is((SELECT count(*)::integer FROM public.staff_recent_signups(90, 'old250')), 1, 'in a longer window');
SELECT is((SELECT count(*)::integer FROM rec WHERE username = 'sys250' OR username = 'rem250'), 0,
    'accounts without a sign-in and remote accounts are not signups');
SELECT is((SELECT array_agg(username ORDER BY username) FROM public.staff_recent_signups(7, NULL, 'all',
              ARRAY['f2500000-0000-0000-0000-000000000002'::uuid, 'f2500000-0000-0000-0000-000000000003'::uuid])),
    ARRAY['h2x250', 'h3x250'], 'p_profile_ids narrows to a group');
SELECT is((SELECT count(*)::integer FROM public.staff_recent_signups(7, 'hoard250')), 4, 'search matches the email domain');
SELECT is((SELECT total_count::integer FROM public.staff_recent_signups(7, 'hoard250', 'all', NULL, 1, 0)), 4,
    'total_count is the whole match under a page');
SELECT is((SELECT count(*)::integer FROM public.staff_recent_signups(7, 'dead250', 'suspended')), 1, 'status suspended');
SELECT is((SELECT count(*)::integer FROM public.staff_recent_signups(7, 'dead250', 'active')), 0, 'status active');
SELECT throws_ok($q$SELECT * FROM public.staff_recent_signups(7, NULL, 'bogus')$q$, '22023', NULL, 'an unknown status is refused');

-- ---------------------------------------------------------------------------
-- Preview
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE prv AS SELECT * FROM public.staff_bulk_suspend_preview(ARRAY[
    'f2500000-0000-0000-0000-000000000001', 'f2500000-0000-0000-0000-00000000000a', 'f2500000-0000-0000-0000-00000000000b',
    'f2500000-0000-0000-0000-000000000031', 'f2500000-0000-0000-0000-000000000032', 'f2500000-0000-0000-0000-000000000021',
    'f2500000-0000-0000-0000-0000000000ff']::uuid[], true);
SELECT results_eq(
    $q$SELECT id, skip_reason FROM prv ORDER BY id$q$,
    $q$VALUES ('f2500000-0000-0000-0000-000000000001'::uuid, NULL::text),
              ('f2500000-0000-0000-0000-00000000000a'::uuid, 'staff'),
              ('f2500000-0000-0000-0000-00000000000b'::uuid, 'self'),
              ('f2500000-0000-0000-0000-000000000021'::uuid, 'deleted'),
              ('f2500000-0000-0000-0000-000000000031'::uuid, 'no_sign_in'),
              ('f2500000-0000-0000-0000-000000000032'::uuid, 'remote'),
              ('f2500000-0000-0000-0000-0000000000ff'::uuid, 'not_found')$q$,
    'each account says why it is skipped');
SELECT results_eq(
    $q$SELECT local_follows, remote_followers, post_count, message_count, jsonb_array_length(owned_servers),
              owned_servers->0->>'name', (owned_servers->0->>'member_count')::integer
         FROM prv WHERE id = 'f2500000-0000-0000-0000-000000000001'$q$,
    $q$VALUES (2, 1, 1, 1, 1, 'hall250'::text, 5)$q$,
    'the preview shows follows at stake, activity and owned servers');
SELECT is((SELECT id FROM prv LIMIT 1), 'f2500000-0000-0000-0000-000000000001'::uuid, 'eligible accounts come first');
SELECT is((SELECT skip_reason FROM public.staff_bulk_suspend_preview(ARRAY['f2500000-0000-0000-0000-000000000002'::uuid], false)),
    'not_suspended', 'unsuspending an active account is skipped');
SELECT throws_ok($q$SELECT * FROM public.staff_bulk_suspend_preview('{}'::uuid[])$q$, '22023', NULL, 'an empty list is refused');
SELECT throws_ok($q$SELECT * FROM public.staff_bulk_suspend_preview(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 201)))$q$,
    '22023', NULL, 'more than 200 is refused');

-- ---------------------------------------------------------------------------
-- Bulk action, as a moderator
-- ---------------------------------------------------------------------------

SELECT throws_ok($q$SELECT public.staff_bulk_set_suspended(ARRAY['f2500000-0000-0000-0000-000000000002'::uuid], true, '   ')$q$,
    '22023', NULL, 'a blank reason is refused');

CREATE TEMP TABLE jobs_before AS SELECT count(*) AS n FROM public.federation_delivery_queue;

CREATE TEMP TABLE res AS SELECT public.staff_bulk_set_suspended(ARRAY[
    'f2500000-0000-0000-0000-000000000001', 'f2500000-0000-0000-0000-000000000002', 'f2500000-0000-0000-0000-000000000002',
    'f2500000-0000-0000-0000-00000000000a', 'f2500000-0000-0000-0000-00000000000b']::uuid[],
    true, 'hoarding names') AS r;
SELECT tests.clear_authentication();

SELECT is((SELECT jsonb_array_length(r->'changed') FROM res), 2, 'two accounts change; a repeated id counts once');
SELECT results_eq(
    $q$SELECT e->>'username', e->>'reason' FROM res, jsonb_array_elements(r->'skipped') e ORDER BY 1$q$,
    $q$VALUES ('adm250'::text, 'staff'::text), ('mod250', 'self')$q$,
    'staff and the caller are skipped, for a moderator');
SELECT results_eq(
    $q$SELECT is_suspended, suspension_reason FROM public.profiles
        WHERE id IN ('f2500000-0000-0000-0000-000000000001', 'f2500000-0000-0000-0000-000000000002')$q$,
    $q$VALUES (true, 'hoarding names'::text), (true, 'hoarding names'::text)$q$,
    'both are suspended with the one reason');
SELECT is((SELECT is_suspended FROM public.profiles WHERE id = 'f2500000-0000-0000-0000-00000000000a'), false, 'the admin is not');
SELECT results_eq(
    $q$SELECT l.admin_id, l.action_type, l.target_type, l.action_details->>'reason', (l.action_details->>'bulk')::boolean,
              (l.action_details->>'batch_size')::integer
         FROM public.admin_audit_log l, res
        WHERE l.action_details->>'batch_id' = res.r->>'batch_id'
        ORDER BY l.target_id$q$,
    $q$VALUES ('f2500000-0000-0000-0000-00000000000b'::uuid, 'user_suspend'::text, 'user'::text, 'hoarding names'::text, true, 4),
              ('f2500000-0000-0000-0000-00000000000b'::uuid, 'user_suspend', 'user', 'hoarding names', true, 4)$q$,
    'one audit row per changed account under the batch id');
SELECT is((SELECT count(*)::integer FROM auth.sessions WHERE user_id = 'e2500000-0000-0000-0000-000000000001'), 0,
    'their sessions are deleted');
SELECT is((SELECT (r->>'sessions_revoked')::integer FROM res), 2, 'the result counts them');
SELECT results_eq(
    $q$SELECT owner, suspended_at FROM public.servers WHERE id = 'f2500000-0000-0000-0000-0000000000a1'$q$,
    $q$VALUES ('f2500000-0000-0000-0000-000000000001'::uuid, NULL::timestamptz)$q$,
    'the owned server keeps its owner and stays open');
SELECT is((SELECT count(*)::integer FROM public.user_servers
            WHERE server_id = 'f2500000-0000-0000-0000-0000000000a1' AND status = 'accepted'), 5, 'memberships stay');
SELECT is((SELECT count(*)::integer FROM public.follows
            WHERE follower_id = 'f2500000-0000-0000-0000-000000000001' OR following_id = 'f2500000-0000-0000-0000-000000000001'),
    1, 'follows with local accounts go, the remote follower stays');
SELECT is((SELECT count(*) FROM public.federation_delivery_queue), (SELECT n FROM jobs_before),
    'nothing is queued for federation');

-- ---------------------------------------------------------------------------
-- Unsuspend, as an admin
-- ---------------------------------------------------------------------------

SELECT tests.authenticate_as('e2500000-0000-0000-0000-00000000000a');
CREATE TEMP TABLE res2 AS SELECT public.staff_bulk_set_suspended(ARRAY[
    'f2500000-0000-0000-0000-000000000001', 'f2500000-0000-0000-0000-000000000003', 'f2500000-0000-0000-0000-000000000021',
    'f2500000-0000-0000-0000-00000000000b']::uuid[], false, 'false positive') AS r;
SELECT tests.clear_authentication();

SELECT results_eq(
    $q$SELECT e->>'id' FROM res2, jsonb_array_elements(r->'changed') e$q$,
    $q$VALUES ('f2500000-0000-0000-0000-000000000001'::text)$q$,
    'only the suspended account changes');
SELECT results_eq(
    $q$SELECT e->>'username', e->>'reason' FROM res2, jsonb_array_elements(r->'skipped') e ORDER BY 1$q$,
    $q$VALUES ('dead250'::text, 'deleted'::text), ('h3x250', 'not_suspended'), ('mod250', 'staff')$q$,
    'a deleted account stays deleted; staff are skipped for an admin too');
SELECT results_eq(
    $q$SELECT is_suspended, suspended_at, suspension_reason FROM public.profiles WHERE id = 'f2500000-0000-0000-0000-000000000001'$q$,
    $q$VALUES (false, NULL::timestamptz, NULL::text)$q$,
    'unsuspension clears the columns');
SELECT is((SELECT count(*)::integer FROM public.admin_audit_log l, res2
            WHERE l.action_details->>'batch_id' = res2.r->>'batch_id' AND l.action_type = 'user_unsuspend'
              AND l.action_details->>'reason' = 'false positive'), 1, 'the unsuspension is logged with its reason');

-- ---------------------------------------------------------------------------
-- A suspended admin
-- ---------------------------------------------------------------------------

UPDATE public.profiles SET is_suspended = true WHERE id = 'f2500000-0000-0000-0000-00000000000a';
SELECT tests.authenticate_as('e2500000-0000-0000-0000-00000000000a');
SELECT throws_ok($q$SELECT * FROM public.staff_recent_signups()$q$, '42501', NULL, 'suspended staff are refused');
SELECT tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- username_hoarding
-- ---------------------------------------------------------------------------

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
CREATE TEMP TABLE rep AS SELECT public.create_report('user',
    p_reported_user_id => 'f2500000-0000-0000-0000-000000000004',
    p_reason => 'username_hoarding') AS id;
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT r.reason, r.category FROM public.reports r JOIN rep ON rep.id = r.id$q$,
    $q$VALUES ('username_hoarding'::text, 'violation'::text)$q$,
    'a local report maps the reason to category violation');

CREATE TEMP TABLE fed AS SELECT public.create_federated_server_report(
    'https://peer250.test/flags/1/server', 'https://peer250.test/users/instance.actor', 'peer250.test',
    'f2500000-0000-0000-0000-0000000000a1', 'f2500000-0000-0000-0000-0000000000d1', 'names for sale', 'username_hoarding') AS r;
SELECT results_eq(
    $q$SELECT re.reason, re.category, re.source FROM public.reports re, fed WHERE re.id = (fed.r->>'report_id')::uuid$q$,
    $q$VALUES ('username_hoarding'::text, 'violation'::text, 'federation'::text)$q$,
    'a Group Flag naming the reason keeps it');
CREATE TEMP TABLE fed2 AS SELECT public.create_federated_server_report(
    'https://peer250.test/flags/2/server', 'https://peer250.test/users/instance.actor', 'peer250.test',
    'f2500000-0000-0000-0000-0000000000a1', 'f2500000-0000-0000-0000-0000000000d1', NULL, 'bogus') AS r;
SELECT results_eq(
    $q$SELECT re.reason, re.category FROM public.reports re, fed2 WHERE re.id = (fed2.r->>'report_id')::uuid$q$,
    $q$VALUES ('other'::text, 'other'::text)$q$,
    'an unknown reason is still other');

-- ---------------------------------------------------------------------------
-- signup_spike_status: h1-h4 are the only signups in 6 hours once the fixtures are moved back
-- ---------------------------------------------------------------------------

SELECT ok(NOT has_function_privilege('anon', 'public.signup_spike_status(integer, integer, integer, integer, integer, integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.signup_spike_status(integer, integer, integer, integer, integer, integer)', 'EXECUTE')
          AND NOT has_function_privilege('service_role', 'public.signup_spike_status(integer, integer, integer, integer, integer, integer)', 'EXECUTE')
          AND has_function_privilege('postgres', 'public.signup_spike_status(integer, integer, integer, integer, integer, integer)', 'EXECUTE'),
          'the spike status is for the host alone');

UPDATE auth.users SET created_at = now() - interval '300 days' WHERE email LIKE '%@test.local';

SELECT results_eq(
    $q$SELECT rule, fired, signups, window_signups, prior_signups FROM public.signup_spike_status() ORDER BY rule$q$,
    $q$VALUES ('burst'::text, false, 2, 2, NULL::integer),
              ('busy_day', false, (SELECT count(*)::integer FROM auth.users a WHERE a.created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC'),
                                  (SELECT count(*)::integer FROM auth.users a WHERE a.created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC'), NULL),
              ('concentrated', false, 4, 4, 0),
              ('refused', false, 6, 6, NULL)$q$,
    'nothing fires on four signups; the row holds counts');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.signup_spike_status() s WHERE to_jsonb(s)::text LIKE '%hoard250%'),
    'no domain leaves it');
SELECT is((SELECT fired FROM public.signup_spike_status(p_domain_min => 4) WHERE rule = 'concentrated'), true,
    'concentrated fires at its minimum');
SELECT is((SELECT fired FROM public.signup_spike_status(p_burst => 2) WHERE rule = 'burst'), true, 'burst fires at its minimum');
SELECT is((SELECT fired FROM public.signup_spike_status(p_daily => 1) WHERE rule = 'busy_day'), true, 'busy_day fires at its minimum');
SELECT is((SELECT fired FROM public.signup_spike_status(p_refused => 6) WHERE rule = 'refused'), true, 'refused fires at its minimum');

-- Five more on common250.test, which has four earlier accounts: a common provider, not concentrated.
INSERT INTO auth.users (id, instance_id, aud, role, email, created_at)
SELECT ('e2500000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', 'c' || i || '@common250.test', now() - interval '10 minutes'
  FROM generate_series(1, 5) i;
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
SELECT ('f2500000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid,
       ('e2500000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid, 'c' || i || 'x250', 'C', true
  FROM generate_series(1, 5) i;
SELECT results_eq(
    $q$SELECT fired, signups, window_signups, prior_signups FROM public.signup_spike_status(p_domain_min => 4, p_domain_prior_max => 4)
        WHERE rule = 'concentrated'$q$,
    $q$VALUES (false, 4, 9, 0)$q$,
    'a domain with earlier accounts is left out; the new domain is under half the window');
SELECT results_eq(
    $q$SELECT fired, signups, prior_signups FROM public.signup_spike_status(p_domain_min => 4, p_domain_prior_max => 5)
        WHERE rule = 'concentrated'$q$,
    $q$VALUES (true, 5, 4)$q$,
    'with a higher prior limit that domain counts');

SELECT finish();
ROLLBACK;
