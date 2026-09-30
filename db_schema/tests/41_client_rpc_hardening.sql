-- Client-callable SECURITY DEFINER functions act as the caller and authorize it
-- (migration 20261001200003).

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(17);

-- Grants ----------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.update_message_embeds(uuid, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.update_message_embeds(uuid, jsonb)', 'EXECUTE'),
          'clients cannot write message embeds');
SELECT ok(NOT has_function_privilege('anon', 'public.update_message_content_silent(uuid, jsonb, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.update_message_content_silent(uuid, jsonb, jsonb)', 'EXECUTE'),
          'clients cannot rewrite message content silently');
SELECT ok(NOT has_function_privilege('anon', 'public.send_notification(character varying, uuid[], jsonb, uuid, uuid, uuid, uuid, character varying)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.send_notification(character varying, uuid[], jsonb, uuid, uuid, uuid, uuid, character varying)', 'EXECUTE'),
          'clients cannot call send_notification');
SELECT ok(NOT has_function_privilege('anon', 'public.pin_message(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.unpin_message(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.send_notification_to_user(character varying, uuid, jsonb, uuid, uuid, uuid, uuid, character varying)', 'EXECUTE'),
          'anon cannot pin, unpin or send notifications');
SELECT ok(has_function_privilege('service_role', 'public.update_message_embeds(uuid, jsonb)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.update_message_content_silent(uuid, jsonb, jsonb)', 'EXECUTE'),
          'the service role keeps the embed and silent-content writers');

-- Report fixture: bob reported something, alice resolved it.
INSERT INTO public.reports (id, reporter_id, reason, status, resolved_by)
VALUES ('abababab-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-000000000002',
        'spam', 'resolved', '11111111-0000-0000-0000-000000000001');

-- Pinning -------------------------------------------------------------------------
-- bob holds neither PIN_MESSAGES nor MANAGE_MESSAGES; naming the owner does not lend him hers.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.pin_message('88888888-0000-0000-0000-000000000008', '11111111-0000-0000-0000-000000000001')$q$,
    'P0001', 'Permission denied: cannot pin messages',
    'a member cannot pin by passing the owner as p_user_id');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.pin_message('99999999-0000-0000-0000-000000000009', '11111111-0000-0000-0000-000000000001')$q$,
    'P0001', 'Permission denied: not a participant in this conversation',
    'a non-participant cannot pin a DM by passing a participant as p_user_id');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.pin_message('88888888-0000-0000-0000-000000000008'), true, 'the owner pins as herself');
SELECT is((SELECT is_pinned FROM public.messages WHERE id = '88888888-0000-0000-0000-000000000008'), true,
          'the message is pinned');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.unpin_message('88888888-0000-0000-0000-000000000008', '11111111-0000-0000-0000-000000000001')$q$,
    'P0001', 'Permission denied: cannot unpin messages',
    'a member cannot unpin by passing the owner as p_user_id');

-- Notifications ---------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.send_notification_to_user(character varying, uuid, jsonb, uuid, uuid, uuid, uuid, character varying)', 'EXECUTE'),
          'clients cannot call send_notification_to_user');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.notify_report_update('abababab-0000-0000-0000-00000000000a')$q$,
    'P0001', 'Unauthorized: not a report this caller may update',
    'a reporter cannot send updates about its own report');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.notify_report_update('abababab-0000-0000-0000-00000000000a')$q$,
    'P0001', 'Unauthorized: not a report this caller may update',
    'a stranger cannot send report updates');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$SELECT public.notify_report_update('abababab-0000-0000-0000-00000000000a',
        '{"status":"pending","report_id":"00000000-0000-0000-0000-000000000000"}'::jsonb, true)$q$,
    'the resolver notifies the reporter');

RESET role;
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'report_update'),
          1, 'exactly one report_update reached the reporter');
SELECT is((SELECT data->>'status' FROM public.notifications
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'report_update'),
          'resolved', 'status comes from the report, not the caller');
SELECT is((SELECT data->>'report_id' FROM public.notifications
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'report_update'),
          'abababab-0000-0000-0000-00000000000a', 'report_id comes from the argument, not the payload');

SELECT * FROM finish();
ROLLBACK;
