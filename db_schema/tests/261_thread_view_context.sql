-- 20261110800001_thread_view_context.sql: a thread shown full page is a viewed context.
--
-- Fixture roles: alice posts in #general and its threads T and U; bob, a member, shows T on
-- device 'desk'.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(17);

INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f2615000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"starter T"}]'::jsonb),
  ('f2615000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"starter U"}]'::jsonb);
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by) VALUES
  ('f2614000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', 'f2615000-0000-0000-0000-000000000001', 'T', '11111111-0000-0000-0000-000000000001'),
  ('f2614000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006', 'f2615000-0000-0000-0000-000000000002', 'U', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('f2615000-0000-0000-0000-000000000011', '66666666-0000-0000-0000-000000000006', 'f2614000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"in T"}]'::jsonb),
  ('f2615000-0000-0000-0000-000000000012', '66666666-0000-0000-0000-000000000006', 'f2614000-0000-0000-0000-000000000002',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"in U"}]'::jsonb);
DELETE FROM public.notifications WHERE user_id = '22222222-0000-0000-0000-000000000002';

-- A mention of bob from alice for message p_message, in #general.
CREATE FUNCTION pg_temp.mention(p_message uuid) RETURNS uuid[] LANGUAGE sql AS $fn$
  SELECT public.send_notification('mention', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
      jsonb_build_object('message_id', p_message), '55555555-0000-0000-0000-000000000005',
      '66666666-0000-0000-0000-000000000006', NULL, '11111111-0000-0000-0000-000000000001');
$fn$;
-- Rows a statement writes are invisible to that statement: results are kept, then read.
CREATE TEMP TABLE sent261 (label text PRIMARY KEY, ids uuid[]);
CREATE FUNCTION pg_temp.sent(p_label text) RETURNS uuid LANGUAGE sql AS $fn$
  SELECT ids[1] FROM sent261 WHERE label = p_label;
$fn$;

SELECT has_column('public', 'device_view_contexts', 'thread_id', 'a device row names the thread it shows');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$SELECT public.sync_view_context_from_presence('thread', '55555555-0000-0000-0000-000000000005', NULL, NULL, 'desk',
        'f2614000-0000-0000-0000-000000000001')$q$,
    'a device records the thread it shows');
SELECT lives_ok(
    $q$SELECT public.sync_view_context_from_presence(p_view_type => 'home', p_server_id => NULL, p_channel_id => NULL,
        p_conversation_id => NULL, p_device_id => 'older-client')$q$,
    'a client without the thread argument still records its view');
SELECT throws_ok(
    $q$SELECT public.is_user_viewing_thread('22222222-0000-0000-0000-000000000002', 'f2614000-0000-0000-0000-000000000001')$q$,
    '42501', NULL, 'a client cannot ask what a user views');
RESET role;

SELECT is((SELECT thread_id FROM public.device_view_contexts
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND device_id = 'desk'),
          'f2614000-0000-0000-0000-000000000001'::uuid, 'the thread is stored');
SELECT is((SELECT thread_id FROM public.device_view_contexts
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND device_id = 'older-client'),
          NULL, 'the older client stores none');
SELECT ok(public.is_user_viewing_thread('22222222-0000-0000-0000-000000000002', 'f2614000-0000-0000-0000-000000000001'),
          'bob views T');
SELECT ok(NOT public.is_user_viewing_thread('22222222-0000-0000-0000-000000000002', 'f2614000-0000-0000-0000-000000000002'),
          'bob does not view U');

SELECT is(cardinality(pg_temp.mention('f2615000-0000-0000-0000-000000000011')), 0,
          'a mention in the thread a device shows writes no notification');
SELECT is(cardinality(public.send_notification('thread_reply', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[],
              jsonb_build_object('thread_id', 'f2614000-0000-0000-0000-000000000001', 'message_id', 'f2615000-0000-0000-0000-000000000011'),
              NULL, '66666666-0000-0000-0000-000000000006', NULL, '11111111-0000-0000-0000-000000000001')), 0,
          'nor does a reply there');
INSERT INTO sent261 VALUES ('other thread', pg_temp.mention('f2615000-0000-0000-0000-000000000012'));
INSERT INTO sent261 VALUES ('channel', pg_temp.mention('f2615000-0000-0000-0000-000000000001'));
SELECT is((SELECT data->>'thread_id' FROM public.notifications WHERE id = pg_temp.sent('other thread')),
          'f2614000-0000-0000-0000-000000000002', 'a mention in another thread notifies and names its thread');
SELECT ok((SELECT NOT (data ? 'thread_id') FROM public.notifications WHERE id = pg_temp.sent('channel')),
          'a mention in the channel names no thread');

UPDATE public.device_view_contexts SET last_active_at = now() - interval '151 seconds'
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND device_id = 'desk';
INSERT INTO sent261 VALUES ('stale view', pg_temp.mention('f2615000-0000-0000-0000-000000000011'));
SELECT is((SELECT data->>'thread_id' FROM public.notifications WHERE id = pg_temp.sent('stale view')),
          'f2614000-0000-0000-0000-000000000001', 'a thread view older than 150 s no longer suppresses');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.mark_notifications_read_by_context('thread', 'f2614000-0000-0000-0000-000000000002'), 1,
          'opening a thread reads its notification');
RESET role;
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND NOT is_read), 2,
          'and leaves the channel''s and the other thread''s unread');

SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'send_notification' AND p.pronamespace = 'public'::regnamespace
       AND NOT has_function_privilege(p.proowner, 'public.is_user_viewing_thread(uuid, uuid)', 'EXECUTE')),
    'the owner of send_notification can run is_user_viewing_thread');
SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'sync_view_context_from_presence' AND p.pronamespace = 'public'::regnamespace
       AND p.pronargs <> 6),
    'one sync_view_context_from_presence, so a call naming five arguments is not ambiguous');

SELECT * FROM finish();
ROLLBACK;
