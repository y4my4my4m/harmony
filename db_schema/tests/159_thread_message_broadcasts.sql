-- 20261019100001_thread_message_broadcasts.sql: thread replies broadcast on
-- 'thread-messages-<thread id>', readable by whoever can view the thread's channel.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(9);

UPDATE public.server_automod_settings SET enabled = false WHERE server_id = '55555555-0000-0000-0000-000000000005';
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f1590000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"thread starter"}]');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
VALUES ('f1591000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006',
        'f1590000-0000-0000-0000-000000000001', 'a thread', '11111111-0000-0000-0000-000000000001');

SELECT ok(public.topic_readable_by('22222222-0000-0000-0000-000000000002', 'thread-messages-f1591000-0000-0000-0000-000000000001'),
          'a member who views the channel reads its thread topic');
SELECT ok(NOT public.topic_readable_by('33333333-0000-0000-0000-000000000003', 'thread-messages-f1591000-0000-0000-0000-000000000001'),
          'a non-member does not');
SELECT ok(NOT public.topic_readable_by('44444444-0000-0000-0000-000000000004', 'thread-messages-f1591000-0000-0000-0000-000000000001'),
          'nor does a banned member');
SELECT ok(NOT public.topic_readable_by('22222222-0000-0000-0000-000000000002', 'thread-messages-f1591000-0000-0000-0000-000000000099'),
          'an unknown thread is not readable');
SELECT ok(NOT public.topic_readable_by('22222222-0000-0000-0000-000000000002', 'thread-messages-not-a-uuid'),
          'a malformed topic is not readable');

DELETE FROM realtime.messages;
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('f1590000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006', 'f1591000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"a reply"}]');
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f1590000-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"not in a thread"}]');

SELECT is((SELECT payload -> 'new' -> 'content' -> 0 ->> 'text' FROM realtime.messages
            WHERE topic = 'thread-messages-f1591000-0000-0000-0000-000000000001'
              AND payload -> 'new' ->> 'id' = 'f1590000-0000-0000-0000-000000000002'),
          'a reply', 'a thread reply broadcasts on its thread topic');
SELECT is((SELECT count(*)::int FROM realtime.messages
            WHERE topic = 'channel-messages-66666666-0000-0000-0000-000000000006'
              AND payload -> 'new' ->> 'id' = 'f1590000-0000-0000-0000-000000000002'),
          1, 'and still on its channel topic');
SELECT is((SELECT count(*)::int FROM realtime.messages
            WHERE topic LIKE 'thread-messages-%'
              AND payload -> 'new' ->> 'id' = 'f1590000-0000-0000-0000-000000000003'),
          0, 'a channel message is not sent to any thread topic');

DELETE FROM realtime.messages;
DELETE FROM public.messages WHERE id = 'f1590000-0000-0000-0000-000000000002';
SELECT is((SELECT payload -> 'old' ->> 'id' FROM realtime.messages
            WHERE topic = 'thread-messages-f1591000-0000-0000-0000-000000000001' AND payload ->> 'op' = 'DELETE'),
          'f1590000-0000-0000-0000-000000000002', 'a deleted reply broadcasts its DELETE on the thread topic');

SELECT * FROM finish();
ROLLBACK;
