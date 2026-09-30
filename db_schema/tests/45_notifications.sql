-- Notifications (migration 20261003200001): per-device view context and its freshness,
-- the push-gating functions, quiet hours that keep the row, bulk read and the deletion
-- broadcast.
--
-- Fixture roles: alice notifies bob; bob views #general or the alice/bob DM from two devices.
-- now() is fixed for the transaction, so staleness is written into last_active_at directly.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(27);

-- Grants ----------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.sync_view_context_from_presence(text, uuid, uuid, uuid, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.sync_view_context_from_presence(text, uuid, uuid, uuid, text)', 'EXECUTE'),
          'signed-in clients record their view context; anon does not');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'sync_view_context_from_presence'),
          1, 'one sync_view_context_from_presence overload, so named calls are unambiguous');
SELECT ok(NOT has_function_privilege('anon', 'public.is_user_viewing_context(uuid, uuid, uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.is_user_viewing_context(uuid, uuid, uuid, uuid)', 'EXECUTE'),
          'clients cannot probe where another user is looking');
SELECT ok(NOT has_function_privilege('anon', 'public.has_active_session(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.has_active_session(uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.has_active_session(uuid)', 'EXECUTE'),
          'has_active_session is service-side');
SELECT ok(NOT has_function_privilege('anon', 'public.delete_push_subscription_by_endpoint(text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.delete_push_subscription_by_endpoint(text)', 'EXECUTE'),
          'clients cannot delete push subscriptions by endpoint');
SELECT ok(NOT has_table_privilege('authenticated', 'public.device_view_contexts', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.device_view_contexts', 'SELECT'),
          'device view contexts are not readable by clients');

-- View context --------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$SELECT public.sync_view_context_from_presence(
        'server_channel', '55555555-0000-0000-0000-000000000005',
        '66666666-0000-0000-0000-000000000006', NULL, 'tab-1')$q$,
    'a device records the channel it shows');
-- Clients predating p_device_id call with four named arguments.
SELECT lives_ok(
    $q$SELECT public.sync_view_context_from_presence(
        p_view_type => 'dm', p_server_id => NULL, p_channel_id => NULL,
        p_conversation_id => '77777777-0000-0000-0000-000000000007')$q$,
    'the four-argument named call still resolves');
RESET role;

SELECT set_eq(
    $q$SELECT device_id, view_type FROM public.device_view_contexts
        WHERE user_id = '22222222-0000-0000-0000-000000000002'$q$,
    $q$VALUES ('tab-1', 'server_channel'), ('', 'dm')$q$,
    'each device keeps its own row');
SELECT ok(public.is_user_viewing_context('22222222-0000-0000-0000-000000000002',
          '55555555-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006', NULL),
          'a fresh channel view counts as viewing');
SELECT ok(public.is_user_viewing_context('22222222-0000-0000-0000-000000000002',
          NULL, NULL, '77777777-0000-0000-0000-000000000007'),
          'a second device viewing the DM counts too');
SELECT ok(public.has_active_session('22222222-0000-0000-0000-000000000002'),
          'a visible device is an active session');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.sync_view_context_from_presence('away', NULL, NULL, NULL, 'tab-1');
RESET role;
SELECT ok(NOT public.is_user_viewing_context('22222222-0000-0000-0000-000000000002',
          '55555555-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006', NULL),
          'a device that went away stops viewing its channel');
SELECT ok(public.has_active_session('22222222-0000-0000-0000-000000000002'),
          'another visible device keeps the session active');

UPDATE public.device_view_contexts SET last_active_at = now() - interval '5 minutes'
 WHERE user_id = '22222222-0000-0000-0000-000000000002';
SELECT ok(NOT public.is_user_viewing_context('22222222-0000-0000-0000-000000000002',
          NULL, NULL, '77777777-0000-0000-0000-000000000007'),
          'a view older than 150 s no longer counts');
SELECT ok(NOT public.has_active_session('22222222-0000-0000-0000-000000000002'),
          'no fresh device, no active session');
SELECT ok(NOT public.is_user_viewing_push_context('22222222-0000-0000-0000-000000000002',
          NULL, NULL, '77777777-0000-0000-0000-000000000007'),
          'push context follows the same freshness');

-- send_notification ---------------------------------------------------------------------
SELECT is(cardinality(public.send_notification('dm', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
              '{"probe":"stale_view"}'::jsonb, NULL, NULL, '77777777-0000-0000-0000-000000000007',
              '11111111-0000-0000-0000-000000000001')),
          1, 'a stale view no longer suppresses the notification');

UPDATE public.device_view_contexts SET last_active_at = now()
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND device_id = '';
SELECT is(cardinality(public.send_notification('dm', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
              '{"probe":"fresh_view"}'::jsonb, NULL, NULL, '77777777-0000-0000-0000-000000000007',
              '11111111-0000-0000-0000-000000000001')),
          0, 'a fresh view of the conversation suppresses it');
UPDATE public.device_view_contexts SET last_active_at = now() - interval '5 minutes'
 WHERE user_id = '22222222-0000-0000-0000-000000000002';

INSERT INTO public.notification_preferences (user_id, dnd_enabled, dnd_start_time, dnd_end_time)
VALUES ('22222222-0000-0000-0000-000000000002', true, '00:00', '23:59:59')
ON CONFLICT (user_id) DO UPDATE
   SET dnd_enabled = true, dnd_start_time = '00:00', dnd_end_time = '23:59:59';
SELECT is(cardinality(public.send_notification('mention', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
              '{"probe":"quiet_hours"}'::jsonb, '55555555-0000-0000-0000-000000000005',
              '66666666-0000-0000-0000-000000000006', NULL, '11111111-0000-0000-0000-000000000001')),
          1, 'quiet hours keep the notification');

-- Bulk read -----------------------------------------------------------------------------
CREATE TEMP TABLE rt45 AS SELECT id FROM realtime.messages;

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.mark_all_notifications_read('22222222-0000-0000-0000-000000000002')$q$,
                'mark all read runs as the owner');
RESET role;
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND NOT is_read),
          0, 'every notification is read');
SELECT is((SELECT tgenabled::text FROM pg_trigger
            WHERE tgrelid = 'public.notifications'::regclass AND tgname = 'trg_broadcast_notification'),
          'O', 'the per-row broadcast trigger stays enabled');
SELECT is((SELECT array_agg(payload->>'type' ORDER BY payload->>'type') FROM realtime.messages m
            WHERE m.topic = 'user:22222222-0000-0000-0000-000000000002'
              AND payload->>'type' LIKE 'notification:%'
              AND m.id NOT IN (SELECT id FROM rt45)),
          ARRAY['notification:bulk_read'], 'one bulk_read and no per-row updates');

-- Deletion ------------------------------------------------------------------------------
DELETE FROM rt45;
INSERT INTO rt45 SELECT id FROM realtime.messages;
CREATE TEMP TABLE gone45 AS
SELECT id FROM public.notifications WHERE user_id = '22222222-0000-0000-0000-000000000002';
DELETE FROM public.notifications WHERE user_id = '22222222-0000-0000-0000-000000000002';
SELECT set_eq(
    $q$SELECT jsonb_array_elements_text(payload->'ids')::uuid FROM realtime.messages m
        WHERE m.topic = 'user:22222222-0000-0000-0000-000000000002'
          AND payload->>'type' = 'notification:deleted'
          AND m.id NOT IN (SELECT id FROM rt45)$q$,
    $q$SELECT id FROM gone45$q$,
    'one deletion broadcast carries every deleted id');

-- Push pipeline -------------------------------------------------------------------------
INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
VALUES ('22222222-0000-0000-0000-000000000002', 'https://push.test/ep45', 'k', 'a');
SELECT throws_ok(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ('22222222-0000-0000-0000-000000000002', 'https://push.test/ep45', 'k2', 'a2')$q$,
    '23505', NULL, 'one row per user and endpoint');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger
                   WHERE tgrelid = 'public.notifications'::regclass
                     AND tgname = 'trigger_send_push_notification' AND tgenabled = 'O'),
          'new notifications queue a push job');

SELECT * FROM finish();
ROLLBACK;
