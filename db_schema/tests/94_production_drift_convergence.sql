-- 20261009100001_production_drift_convergence.sql: the messages.metadata default and six
-- function bodies of a fresh install. A fresh install already has them; a converged live copy
-- matches.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(19);

-- messages.metadata ---------------------------------------------------------------------
SELECT is((SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'metadata'),
          '''{}''::jsonb', 'messages.metadata defaults to an empty object');

INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('e8950000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006',
        '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"no metadata"}]');
SELECT is((SELECT metadata FROM public.messages WHERE id = 'e8950000-0000-0000-0000-000000000001'),
          '{}'::jsonb, 'a message inserted without metadata stores an empty object');

-- delete_server_with_cleanup ------------------------------------------------------------
INSERT INTO public.servers (id, name, owner)
VALUES ('e8920000-0000-0000-0000-000000000001', 'Doomed', '11111111-0000-0000-0000-000000000001');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$SELECT public.delete_server_with_cleanup('e8920000-0000-0000-0000-000000000001',
                                                '11111111-0000-0000-0000-000000000001')$q$,
    'P0001', NULL, 'anon naming the owner cannot delete a server');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.delete_server_with_cleanup('e8920000-0000-0000-0000-000000000001',
                                                '11111111-0000-0000-0000-000000000001')$q$,
    'P0001', NULL, 'a member naming the owner cannot delete a server');
SELECT tests.clear_authentication();
SELECT ok(EXISTS (SELECT 1 FROM public.servers WHERE id = 'e8920000-0000-0000-0000-000000000001'),
          'the server survives both attempts');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$SELECT public.delete_server_with_cleanup('e8920000-0000-0000-0000-000000000001',
                                                '11111111-0000-0000-0000-000000000001')$q$,
    'the owner deletes the server');
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM public.servers WHERE id = 'e8920000-0000-0000-0000-000000000001'),
          'the server is gone');

-- clear_custom_status -------------------------------------------------------------------
UPDATE public.profiles SET custom_status = '{"text":"busy"}'
 WHERE id = '22222222-0000-0000-0000-000000000002';

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$SELECT public.clear_custom_status('22222222-0000-0000-0000-000000000002')$q$,
    'P0001', NULL, 'anon cannot clear a status');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.clear_custom_status('22222222-0000-0000-0000-000000000002')$q$,
    'P0001', NULL, 'a user cannot clear another user''s status');
SELECT tests.clear_authentication();
SELECT isnt((SELECT custom_status FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'),
            NULL, 'the status survives both attempts');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.clear_custom_status('22222222-0000-0000-0000-000000000002'), true,
          'a user clears their own status');
SELECT tests.clear_authentication();
SELECT is((SELECT custom_status FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'),
          NULL, 'the status is cleared');

-- count_pinned_messages -----------------------------------------------------------------
SELECT ok(NOT (SELECT prosecdef FROM pg_proc
                WHERE oid = 'public.count_pinned_messages(uuid,uuid)'::regprocedure),
          'count_pinned_messages runs as the caller');

UPDATE public.messages SET is_pinned = true WHERE id = '88888888-0000-0000-0000-000000000008';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.count_pinned_messages('66666666-0000-0000-0000-000000000006', NULL), 0,
          'a non-member counts no pinned messages in a channel it cannot read');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.count_pinned_messages('66666666-0000-0000-0000-000000000006', NULL), 1,
          'a member counts the pinned message');
SELECT tests.clear_authentication();

-- get_user_notifications ----------------------------------------------------------------
INSERT INTO public.notifications (id, type, user_id, data)
VALUES ('e8970000-0000-0000-0000-000000000001', 'friend_request', '11111111-0000-0000-0000-000000000001',
        '{"from_user_id":"22222222-0000-0000-0000-000000000002"}');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.get_user_notifications('11111111-0000-0000-0000-000000000001', 100)
            WHERE id = 'e8970000-0000-0000-0000-000000000001'), 1,
          'a notification from an unmuted sender is listed');
SELECT tests.clear_authentication();

INSERT INTO public.user_mutes (muter_id, muted_user_id, hide_notifications)
VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', true);

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.get_user_notifications('11111111-0000-0000-0000-000000000001', 100)
            WHERE id = 'e8970000-0000-0000-0000-000000000001'), 0,
          'a sender muted with hide_notifications is filtered out');
SELECT tests.clear_authentication();

-- get_public_federation_settings and handle_post_federation ------------------------------
SELECT ok(public.get_public_federation_settings() ?& ARRAY['federation_enabled', 'enable_inbound_federation',
                                                          'enable_outbound_federation', 'federation_auto_accept_follows'],
          'get_public_federation_settings returns the inbound and outbound flags');

SELECT ok(to_regprocedure('public.build_post_create_activity(uuid,uuid)') IS NOT NULL
          OR position('build_post_create_activity' IN
                      (SELECT prosrc FROM pg_proc WHERE oid = 'public.handle_post_federation()'::regprocedure)) = 0,
          'handle_post_federation calls no function the instance lacks');

SELECT * FROM finish();
ROLLBACK;
