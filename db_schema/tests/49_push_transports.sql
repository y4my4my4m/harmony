-- Push transports (migration 20261004100001): the transport column and its key rules,
-- one account per FCM token, get_user_push_subscriptions reporting transport, and the read
-- fan-out queued for users with an app transport.
--
-- Fixture roles: bob holds an FCM token, mallory a UnifiedPush endpoint, alice only a
-- browser subscription. queue_federation_job is replaced for the transaction so queued
-- jobs can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(20);

CREATE TABLE tests.jobs49 (name text, data jsonb);
GRANT INSERT, SELECT, DELETE ON tests.jobs49 TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs49 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

CREATE TEMP VIEW dismissals49 AS
SELECT data FROM tests.jobs49 WHERE name = 'dismiss-push-notifications';

-- Grants --------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.get_user_push_subscriptions(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_user_push_subscriptions(uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.get_user_push_subscriptions(uuid)', 'EXECUTE'),
          'the recreated get_user_push_subscriptions stays service-side');
SELECT ok(NOT has_function_privilege('authenticated', 'public.queue_push_dismissal(uuid, uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.queue_push_dismissal(uuid, uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.queue_push_dismissal_on_read()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.queue_push_dismissal_on_delete()', 'EXECUTE'),
          'clients cannot queue dismissals or call the trigger functions');

-- Transport column ----------------------------------------------------------------------
INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
VALUES ('11111111-0000-0000-0000-000000000001', 'https://push.test/browser49', 'k', 'a');
SELECT is((SELECT transport FROM public.push_subscriptions WHERE endpoint = 'https://push.test/browser49'),
          'webpush', 'rows written without a transport are browser subscriptions');

SELECT throws_ok(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, transport)
       VALUES ('11111111-0000-0000-0000-000000000001', 'https://up.test/nokeys', 'unifiedpush')$q$,
    '23514', NULL, 'a UnifiedPush endpoint needs Web Push keys');
SELECT throws_ok(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, transport)
       VALUES ('11111111-0000-0000-0000-000000000001', 'https://x.test/1', 'k', 'a', 'apns')$q$,
    '23514', NULL, 'unknown transports are rejected');

INSERT INTO public.push_subscriptions (user_id, endpoint, transport) VALUES
  ('22222222-0000-0000-0000-000000000002', 'tok-bob-49', 'fcm');
INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, transport) VALUES
  ('33333333-0000-0000-0000-000000000003', 'https://ntfy.test/up49', 'k3', 'a3', 'unifiedpush');

SELECT throws_ok(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, transport)
       VALUES ('11111111-0000-0000-0000-000000000001', 'tok-bob-49', 'fcm')$q$,
    '23505', NULL, 'an FCM token belongs to one account');
SELECT lives_ok(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ('22222222-0000-0000-0000-000000000002', 'https://push.test/browser49', 'k2', 'a2')$q$,
    'a browser endpoint may still be registered by several accounts');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.push_subscriptions), 0,
          'clients read no push targets, not even their own FCM token');
RESET role;

SELECT results_eq(
    $q$SELECT endpoint, transport, p256dh IS NULL
         FROM public.get_user_push_subscriptions('22222222-0000-0000-0000-000000000002')
        ORDER BY transport$q$,
    $q$VALUES ('tok-bob-49'::text, 'fcm'::text, true),
              ('https://push.test/browser49'::text, 'webpush'::text, false)$q$,
    'get_user_push_subscriptions reports each target''s transport');

-- Read fan-out --------------------------------------------------------------------------
INSERT INTO public.notifications (id, type, user_id, data) VALUES
  ('49000000-0000-0000-0000-000000000001', 'dm', '22222222-0000-0000-0000-000000000002', '{}'),
  ('49000000-0000-0000-0000-000000000002', 'dm', '22222222-0000-0000-0000-000000000002', '{}'),
  ('49000000-0000-0000-0000-000000000003', 'dm', '22222222-0000-0000-0000-000000000002', '{}'),
  ('49000000-0000-0000-0000-00000000000a', 'dm', '11111111-0000-0000-0000-000000000001', '{}'),
  ('49000000-0000-0000-0000-00000000000c', 'dm', '33333333-0000-0000-0000-000000000003', '{}');
DELETE FROM tests.jobs49;

UPDATE public.notifications SET is_read = true WHERE id = '49000000-0000-0000-0000-000000000001';
SELECT is((SELECT jsonb_agg(data) FROM dismissals49),
          jsonb_build_array(jsonb_build_object(
              'user_id', '22222222-0000-0000-0000-000000000002',
              'ids', jsonb_build_array('49000000-0000-0000-0000-000000000001'),
              'all', false)),
          'reading a notification queues its dismissal for the owner''s app');
DELETE FROM tests.jobs49;

UPDATE public.notifications SET is_read = true WHERE id = '49000000-0000-0000-0000-00000000000a';
SELECT is_empty($q$SELECT 1 FROM dismissals49$q$, 'a browser-only user queues nothing');

UPDATE public.notifications SET is_clicked = true WHERE id = '49000000-0000-0000-0000-000000000002';
SELECT is_empty($q$SELECT 1 FROM dismissals49$q$, 'an update that leaves is_read alone queues nothing');

UPDATE public.notifications SET is_read = true WHERE id = '49000000-0000-0000-0000-000000000001';
SELECT is_empty($q$SELECT 1 FROM dismissals49$q$, 'a row already read queues nothing');

UPDATE public.notifications SET is_read = true
 WHERE id IN ('49000000-0000-0000-0000-000000000002', '49000000-0000-0000-0000-00000000000c');
SELECT set_eq(
    $q$SELECT data->>'user_id' AS user_id, data->'ids' AS ids FROM dismissals49$q$,
    $q$VALUES ('22222222-0000-0000-0000-000000000002', '["49000000-0000-0000-0000-000000000002"]'::jsonb),
              ('33333333-0000-0000-0000-000000000003', '["49000000-0000-0000-0000-00000000000c"]'::jsonb)$q$,
    'one statement queues one dismissal per user, for FCM and UnifiedPush alike');
DELETE FROM tests.jobs49;

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.mark_all_notifications_read('22222222-0000-0000-0000-000000000002');
RESET role;
SELECT is((SELECT jsonb_agg(data) FROM dismissals49),
          jsonb_build_array(jsonb_build_object(
              'user_id', '22222222-0000-0000-0000-000000000002', 'ids', NULL, 'all', true)),
          'mark all read dismisses everything in one job');
DELETE FROM tests.jobs49;

INSERT INTO public.notifications (id, type, user_id, data)
VALUES ('49000000-0000-0000-0000-000000000004', 'mention', '22222222-0000-0000-0000-000000000002', '{}');
DELETE FROM tests.jobs49;
DELETE FROM public.notifications WHERE id = '49000000-0000-0000-0000-000000000004';
SELECT is((SELECT jsonb_agg(data->'ids') FROM dismissals49),
          '[["49000000-0000-0000-0000-000000000004"]]'::jsonb,
          'deleting an unread notification dismisses it');
DELETE FROM tests.jobs49;

DELETE FROM public.notifications WHERE id = '49000000-0000-0000-0000-000000000001';
SELECT is_empty($q$SELECT 1 FROM dismissals49$q$, 'deleting a read notification queues nothing');

SELECT is((SELECT count(*)::int FROM tests.jobs49 WHERE name LIKE 'federate-%'),
          0, 'dismissals are not federation jobs, so maintenance windows leave them running');

-- Account deletion ----------------------------------------------------------------------
-- delete_my_account anonymizes the profile instead of deleting it and clears push targets
-- by user, which covers every transport. auth.mfa_factors is absent from this harness, so
-- the body is read rather than run.
SELECT ok((SELECT prosrc FROM pg_proc WHERE oid = 'public.delete_my_account()'::regprocedure)
          ~ 'DELETE FROM public\.push_subscriptions WHERE user_id = v_profile_id',
          'account deletion clears push targets by user, whatever their transport');
SELECT is((SELECT confdeltype::text FROM pg_constraint
            WHERE conrelid = 'public.push_subscriptions'::regclass AND contype = 'f'
              AND confrelid = 'public.profiles'::regclass),
          'c', 'deleting a profile cascades to its push targets');

SELECT * FROM finish();
ROLLBACK;
