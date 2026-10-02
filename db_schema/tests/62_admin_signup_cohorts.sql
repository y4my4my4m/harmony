-- get_signup_cohorts after 20261006200001_admin_signup_cohorts.sql.
--
-- Cohort M is the UTC month five months back; its accounts sign up on day 3 of M, so every
-- window has ended. t0 is that signup time. Fixture accounts move to 2001 so the current
-- cohort holds only u10.
--
--   u1   S1 member; C1 at t0+1h (answered by u2 at +30m) and t0+10d; webpush; follows u2
--   u2   S1 member; C1 at t0+1h30m, followed only by a bot and a system row; follow of u1 rejected
--   u3   nothing
--   u4   S1 pending; DM at t0+3d (answered by u1 at +5h); post at t0+40d; fcm push
--   u5   owns S2; post at t0+2h; boost at t0+10d; follow of u1 pending
--   u6   auth user with is_local false: not counted
--   u7   local profile without an auth user, writes in C9: not counted
--   u8   S1 member; system message at t0+2h only
--   u9   S1 member; C9 at t0+20h, answered in a thread on it at +20m; C9 at t0+31d
--   u10  S1 member, signed up two days ago; C1 one hour after signup, unanswered
--
-- Expected for M: signups 7, joined 5, joined another's 4, day 1 4/7, days 1-7 5/7,
-- days 8-30 1/7, days 31-90 2/7, answered within 1 h 2/4 and within 24 h 3/4, push 2,
-- follows 2.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(21);

UPDATE auth.users SET created_at = '2001-01-01 00:00:00+00' WHERE email LIKE '%@test.local';
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

CREATE TEMP TABLE ctx ON COMMIT DROP AS
SELECT (date_trunc('month', (now() AT TIME ZONE 'UTC') - interval '5 months') + interval '2 days')
           AT TIME ZONE 'UTC' AS t0,
       now() - interval '2 days' AS t10;
GRANT SELECT ON ctx TO PUBLIC;

INSERT INTO auth.users (id, instance_id, aud, role, email, created_at)
SELECT ('62000000-0000-0000-0000-0000000000a' || n)::uuid, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', 'u' || n || '@cohort.local',
       CASE WHEN n = 0 THEN ctx.t10 ELSE ctx.t0 + n * interval '1 minute' END
  FROM ctx, generate_series(0, 9) n
 WHERE n <> 7;

-- u0 is u10.
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain, created_at)
SELECT ('62000000-0000-0000-0000-0000000000b' || n)::uuid,
       CASE WHEN n = 7 THEN NULL ELSE ('62000000-0000-0000-0000-0000000000a' || n)::uuid END,
       'cohort_u' || n, 'Cohort ' || n, n <> 6, CASE WHEN n = 6 THEN 'remote.example' ELSE 'localhost' END,
       CASE WHEN n = 0 THEN ctx.t10 ELSE ctx.t0 END
  FROM ctx, generate_series(0, 9) n;

INSERT INTO public.servers (id, name, owner)
VALUES ('62000000-0000-0000-0000-0000000000c2', 'Cohort Own', '62000000-0000-0000-0000-0000000000b5');

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('62000000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('62000000-0000-0000-0000-0000000000b2', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('62000000-0000-0000-0000-0000000000b4', '55555555-0000-0000-0000-000000000005', 'pending'),
  ('62000000-0000-0000-0000-0000000000b5', '62000000-0000-0000-0000-0000000000c2', 'accepted'),
  ('62000000-0000-0000-0000-0000000000b8', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('62000000-0000-0000-0000-0000000000b9', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('62000000-0000-0000-0000-0000000000b0', '55555555-0000-0000-0000-000000000005', 'accepted')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = EXCLUDED.status;

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('62000000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'cohort-one', 0),
  ('62000000-0000-0000-0000-0000000000d9', '55555555-0000-0000-0000-000000000005', 'cohort-nine', 0);

INSERT INTO public.conversations (id, type) VALUES ('62000000-0000-0000-0000-0000000000e4', 'direct');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('62000000-0000-0000-0000-0000000000e4', '62000000-0000-0000-0000-0000000000b1'),
  ('62000000-0000-0000-0000-0000000000e4', '62000000-0000-0000-0000-0000000000b4');

INSERT INTO public.bots (id, username, owner_id)
VALUES ('62000000-0000-0000-0000-0000000000f1', 'cohort_bot', '62000000-0000-0000-0000-0000000000b1');

INSERT INTO public.messages (id, channel_id, conversation_id, user_id, bot_id, is_system, content, created_at)
SELECT v.id::uuid, v.ch::uuid, v.cv::uuid, v.uid::uuid, v.bot::uuid, v.sys, '[{"type":"text","text":"x"}]', ctx.t0 + v.off
  FROM ctx, (VALUES
    ('62000000-0000-0000-0000-000000000101', '62000000-0000-0000-0000-0000000000d1', NULL, '62000000-0000-0000-0000-0000000000b1', NULL, false, interval '1 hour'),
    ('62000000-0000-0000-0000-000000000102', '62000000-0000-0000-0000-0000000000d1', NULL, '62000000-0000-0000-0000-0000000000b1', NULL, false, interval '10 days'),
    ('62000000-0000-0000-0000-000000000201', '62000000-0000-0000-0000-0000000000d1', NULL, '62000000-0000-0000-0000-0000000000b2', NULL, false, interval '90 minutes'),
    ('62000000-0000-0000-0000-000000000202', '62000000-0000-0000-0000-0000000000d1', NULL, NULL, '62000000-0000-0000-0000-0000000000f1', false, interval '100 minutes'),
    ('62000000-0000-0000-0000-000000000801', '62000000-0000-0000-0000-0000000000d1', NULL, '62000000-0000-0000-0000-0000000000b8', NULL, true, interval '2 hours'),
    ('62000000-0000-0000-0000-000000000401', NULL, '62000000-0000-0000-0000-0000000000e4', '62000000-0000-0000-0000-0000000000b4', NULL, false, interval '3 days'),
    ('62000000-0000-0000-0000-000000000402', NULL, '62000000-0000-0000-0000-0000000000e4', '62000000-0000-0000-0000-0000000000b1', NULL, false, interval '3 days 5 hours'),
    ('62000000-0000-0000-0000-000000000901', '62000000-0000-0000-0000-0000000000d9', NULL, '62000000-0000-0000-0000-0000000000b9', NULL, false, interval '20 hours'),
    ('62000000-0000-0000-0000-000000000902', '62000000-0000-0000-0000-0000000000d9', NULL, '62000000-0000-0000-0000-0000000000b9', NULL, false, interval '31 days'),
    ('62000000-0000-0000-0000-000000000701', '62000000-0000-0000-0000-0000000000d9', NULL, '62000000-0000-0000-0000-0000000000b7', NULL, false, interval '5 days')
  ) AS v(id, ch, cv, uid, bot, sys, off);

INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, created_at)
SELECT '62000000-0000-0000-0000-0000000000f9', '62000000-0000-0000-0000-0000000000d9',
       '62000000-0000-0000-0000-000000000901', 'question', '62000000-0000-0000-0000-0000000000b1',
       ctx.t0 + interval '20 hours 10 minutes'
  FROM ctx;
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content, created_at)
SELECT '62000000-0000-0000-0000-000000000903', '62000000-0000-0000-0000-0000000000d9',
       '62000000-0000-0000-0000-0000000000f9', '62000000-0000-0000-0000-0000000000b1',
       '[{"type":"text","text":"answer"}]', ctx.t0 + interval '20 hours 20 minutes'
  FROM ctx;

INSERT INTO public.messages (channel_id, user_id, content, created_at)
SELECT '62000000-0000-0000-0000-0000000000d1', '62000000-0000-0000-0000-0000000000b0',
       '[{"type":"text","text":"hello"}]', ctx.t10 + interval '1 hour'
  FROM ctx;

INSERT INTO public.posts (author_id, content, reblog, created_at)
SELECT v.uid::uuid, v.content::jsonb, v.reblog::jsonb, ctx.t0 + v.off
  FROM ctx, (VALUES
    ('62000000-0000-0000-0000-0000000000b5', '[{"type":"text","text":"first post"}]', NULL, interval '2 hours'),
    ('62000000-0000-0000-0000-0000000000b5', '[]', '{"id":"x"}', interval '10 days'),
    ('62000000-0000-0000-0000-0000000000b4', '[{"type":"text","text":"later post"}]', NULL, interval '40 days')
  ) AS v(uid, content, reblog, off);

INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, transport) VALUES
  ('62000000-0000-0000-0000-0000000000b1', 'https://push.example/u1', 'k', 'a', 'webpush'),
  ('62000000-0000-0000-0000-0000000000b4', 'fcm-token-u4', NULL, NULL, 'fcm');

INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('62000000-0000-0000-0000-0000000000b1', '62000000-0000-0000-0000-0000000000b2', 'accepted'),
  ('62000000-0000-0000-0000-0000000000b5', '62000000-0000-0000-0000-0000000000b1', 'pending'),
  ('62000000-0000-0000-0000-0000000000b2', '62000000-0000-0000-0000-0000000000b1', 'rejected');

-- Surface --------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.get_signup_cohorts(integer, text)', 'EXECUTE')
          AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                           WHERE p.oid = 'public.get_signup_cohorts(integer, text)'::regprocedure
                             AND a.grantee = 0),
          'anon and PUBLIC hold no EXECUTE');
SELECT ok(has_function_privilege('authenticated', 'public.get_signup_cohorts(integer, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.get_signup_cohorts(integer, text)', 'EXECUTE'),
          'authenticated and service_role hold EXECUTE');
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']
             FROM pg_proc WHERE oid = 'public.get_signup_cohorts(integer, text)'::regprocedure),
          'SECURITY DEFINER with a pinned search_path');
SELECT is((SELECT array_agg(DISTINCT format_type(t, NULL) ORDER BY format_type(t, NULL))
             FROM pg_proc p, unnest(p.proallargtypes) WITH ORDINALITY AS a(t, i)
            WHERE p.oid = 'public.get_signup_cohorts(integer, text)'::regprocedure
              AND p.proargmodes[i] = 't'),
          ARRAY['date', 'integer'],
          'the result carries a period start and counts only');

-- Refusals -------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT * FROM public.get_signup_cohorts()$q$, '42501', NULL,
                 'a non-admin is refused');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT * FROM public.get_signup_cohorts()$q$, '42501', NULL,
                 'anon is refused');
SELECT tests.clear_authentication();
SELECT throws_ok($q$SELECT * FROM public.get_signup_cohorts()$q$, '42501', NULL,
                 'a session with no account is refused');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT * FROM public.get_signup_cohorts(12, 'day')$q$, '22023', NULL,
                 'periods are month and week');
SELECT throws_ok($q$SELECT * FROM public.get_signup_cohorts(0)$q$, '22023', NULL,
                 'the range is at least one month');
SELECT throws_ok($q$SELECT * FROM public.get_signup_cohorts(61)$q$, '22023', NULL,
                 'the range is at most sixty months');

-- Monthly --------------------------------------------------------------------------------
CREATE TEMP TABLE monthly ON COMMIT DROP AS SELECT * FROM public.get_signup_cohorts(6, 'month');

SELECT is((SELECT count(*)::integer FROM monthly), 6, 'six months give six rows');
SELECT is((SELECT array_agg(cohort_start ORDER BY cohort_start) FROM monthly),
          (SELECT array_agg(d::date ORDER BY d)
             FROM generate_series(date_trunc('month', (now() AT TIME ZONE 'UTC') - interval '5 months'),
                                  date_trunc('month', now() AT TIME ZONE 'UTC'), interval '1 month') d),
          'rows are consecutive UTC months ending with the current one');
SELECT is((SELECT sum(signups)::integer FROM monthly), 8,
          'eight accounts in range, one row per month rather than per account');

SELECT results_eq(
    $q$SELECT signups, joined_server, joined_other_server,
              day1_eligible, wrote_day1, days1_7_eligible, active_days1_7,
              days8_30_eligible, active_days8_30, days31_90_eligible, active_days31_90,
              first_message_eligible, answered_1h, answered_24h, has_push, follows_anyone
         FROM monthly
        WHERE cohort_start = (SELECT (t0 AT TIME ZONE 'UTC')::date - 2 FROM ctx)$q$,
    $q$VALUES (7, 5, 4, 7, 4, 7, 5, 7, 1, 7, 2, 4, 2, 3, 2, 2)$q$,
    'cohort M counts');

SELECT results_eq(
    $q$SELECT signups, joined_server, joined_other_server,
              day1_eligible, wrote_day1, days1_7_eligible, active_days1_7,
              days8_30_eligible, active_days8_30, days31_90_eligible, active_days31_90,
              first_message_eligible, answered_1h, answered_24h, has_push, follows_anyone
         FROM monthly
        WHERE cohort_start = (SELECT date_trunc('month', t10 AT TIME ZONE 'UTC')::date FROM ctx)$q$,
    $q$VALUES (1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0)$q$,
    'a two-day-old account counts toward day 1 only');

SELECT is((SELECT count(*)::integer FROM monthly
            WHERE signups = 0
              AND joined_server + day1_eligible + first_message_eligible + has_push + follows_anyone = 0),
          (SELECT 6 - count(DISTINCT c)::integer
             FROM ctx, LATERAL (VALUES (date_trunc('month', t0 AT TIME ZONE 'UTC')),
                                       (date_trunc('month', t10 AT TIME ZONE 'UTC'))) AS v(c)),
          'months without signups are zero rows');

-- Weekly ---------------------------------------------------------------------------------
CREATE TEMP TABLE weekly ON COMMIT DROP AS SELECT * FROM public.get_signup_cohorts(1, 'week');

SELECT ok((SELECT bool_and(extract(isodow FROM cohort_start) = 1) FROM weekly)
          AND (SELECT max(cohort_start) - min(cohort_start) = 7 * (count(*) - 1) FROM weekly)
          AND (SELECT max(cohort_start) FROM weekly) = date_trunc('week', now() AT TIME ZONE 'UTC')::date,
          'weekly rows are consecutive ISO weeks ending with the current one');
SELECT is((SELECT signups FROM weekly
            WHERE cohort_start = (SELECT date_trunc('week', t10 AT TIME ZONE 'UTC')::date FROM ctx)),
          1, 'the two-day-old account falls in its ISO week');
SELECT is((SELECT sum(signups)::integer FROM weekly), 1, 'cohort M lies outside a one-month range');

SELECT tests.clear_authentication();

-- Service role ---------------------------------------------------------------------------
-- service_role has no USAGE on the tests schema; the result is asserted after RESET ROLE.
CREATE TEMP TABLE as_service (n integer) ON COMMIT DROP;
GRANT ALL ON as_service TO PUBLIC;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SET LOCAL ROLE service_role;
INSERT INTO as_service SELECT sum(signups)::integer FROM public.get_signup_cohorts(6, 'month');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT is((SELECT n FROM as_service), 8, 'the service role passes the admin check');

-- An admin flag elsewhere does not admit a non-admin caller.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT * FROM public.get_signup_cohorts(6, 'week')$q$, '42501', NULL,
                 'a member of the admin''s server is refused');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
