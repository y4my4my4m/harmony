-- Under "Only when I'm away" (notification_preferences.push_offline_only), a device in use holds
-- push from every device (federation-backend pushPolicy.ts, heldWhileDeviceInUse). The switch is
-- on for every new account. The client reports 'background' for a computer that runs Harmony
-- hidden and shows its own system notifications (src/composables/useViewContext.ts): that row
-- makes the user's devices in use without viewing any channel or DM.
--
-- Fixture roles: bob (profile 2222…0002) on two devices; #general and the alice/bob DM.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(9);

-- Default ------------------------------------------------------------------------------
SELECT is((SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'notification_preferences'
              AND column_name = 'push_offline_only'),
          'true', '"Only when I''m away" defaults to on');

INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('eeeeeeee-0000-0000-0000-000000000196', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'newcomer196@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES ('19619619-0000-0000-0000-000000000196', 'eeeeeeee-0000-0000-0000-000000000196',
        'newcomer196', 'Newcomer', true);
SELECT is((SELECT push_offline_only FROM public.notification_preferences
            WHERE user_id = '19619619-0000-0000-0000-000000000196'),
          true, 'a new local account gets a preferences row with the switch on');

-- Background ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$SELECT public.sync_view_context_from_presence('background', NULL, NULL, NULL, 'desktop')$q$,
    'a device records that it runs in the background');
RESET role;

SELECT ok(public.has_active_session('22222222-0000-0000-0000-000000000002'),
          'a device in the background is in use');
SELECT ok(NOT public.is_user_viewing_context('22222222-0000-0000-0000-000000000002',
          '55555555-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006', NULL),
          'a device in the background views no channel');
SELECT is(cardinality(public.send_notification('dm', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
              '{"probe":"background"}'::jsonb, NULL, NULL, '77777777-0000-0000-0000-000000000007',
              '11111111-0000-0000-0000-000000000001')),
          1, 'a device in the background does not suppress the notification row');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.sync_view_context_from_presence('away', NULL, NULL, NULL, 'desktop');
SELECT public.sync_view_context_from_presence('away', NULL, NULL, NULL, 'phone');
RESET role;
SELECT ok(NOT public.has_active_session('22222222-0000-0000-0000-000000000002'),
          'no device in use once every device is away');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.sync_view_context_from_presence('background', NULL, NULL, NULL, 'desktop');
RESET role;
SELECT ok(public.has_active_session('22222222-0000-0000-0000-000000000002'),
          'one device in the background puts the user in use; the phone away does not undo it');

UPDATE public.device_view_contexts SET last_active_at = now() - interval '151 seconds'
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND device_id = 'desktop';
SELECT ok(NOT public.has_active_session('22222222-0000-0000-0000-000000000002'),
          'a background report older than 150 s no longer counts');

SELECT * FROM finish();
ROLLBACK;
