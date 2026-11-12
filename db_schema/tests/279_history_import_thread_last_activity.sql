-- 20261112400001_history_import_thread_last_activity.sql: a reply under the history-import flag
-- gives a thread with no last message time one, so auto_archive_threads() can archive it; a set
-- last message time, the last message and the archived state are still left alone.
--
--   thread d1  created with no last_message_at, gets imported replies (the import case)
--   thread d2  has a last_message_at already, gets a newer imported reply
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(7);

INSERT INTO public.messages (id, channel_id, user_id, content, created_at) VALUES
  ('27900000-0000-0000-0000-00000000a001', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type": "text", "text": "parent 1"}]', '2024-01-01T00:00:00Z'),
  ('27900000-0000-0000-0000-00000000a002', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type": "text", "text": "parent 2"}]', '2024-01-01T00:00:00Z');

SELECT set_config('harmony.history_import', 'true', true);
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, archived, created_at, updated_at,
                            last_message_at, auto_archive_duration) VALUES
  ('27900000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '27900000-0000-0000-0000-00000000a001',
   'imported', '11111111-0000-0000-0000-000000000001', false, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', NULL, 1440),
  ('27900000-0000-0000-0000-0000000000d2', '66666666-0000-0000-0000-000000000006', '27900000-0000-0000-0000-00000000a002',
   'had activity', '11111111-0000-0000-0000-000000000001', false, '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z',
   '2020-01-02T00:00:00Z', 1440);

-- Newest first, as the importer reads a thread.
INSERT INTO public.messages (channel_id, user_id, thread_id, content, created_at) VALUES
  ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001', '27900000-0000-0000-0000-0000000000d1',
   '[{"type": "text", "text": "newest"}]', '2024-05-01T00:00:00Z');
INSERT INTO public.messages (channel_id, user_id, thread_id, content, created_at) VALUES
  ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001', '27900000-0000-0000-0000-0000000000d1',
   '[{"type": "text", "text": "older"}]', '2024-04-01T00:00:00Z');
INSERT INTO public.messages (channel_id, user_id, thread_id, content, created_at) VALUES
  ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001', '27900000-0000-0000-0000-0000000000d2',
   '[{"type": "text", "text": "imported later"}]', '2024-05-01T00:00:00Z');
SELECT set_config('harmony.history_import', 'false', true);

SELECT is((SELECT last_message_at FROM public.threads WHERE id = '27900000-0000-0000-0000-0000000000d1'),
          '2024-05-01T00:00:00Z'::timestamptz, 'an imported thread takes its first imported reply''s time');
SELECT is((SELECT message_count FROM public.threads WHERE id = '27900000-0000-0000-0000-0000000000d1'), 2,
          'both imported replies are counted');
SELECT is((SELECT last_message_id FROM public.threads WHERE id = '27900000-0000-0000-0000-0000000000d1'), NULL::uuid,
          'the last message stays unset');
SELECT is((SELECT updated_at FROM public.threads WHERE id = '27900000-0000-0000-0000-0000000000d1'),
          '2024-01-01T00:00:00Z'::timestamptz, 'updated_at stays');
SELECT is((SELECT last_message_at FROM public.threads WHERE id = '27900000-0000-0000-0000-0000000000d2'),
          '2020-01-02T00:00:00Z'::timestamptz, 'a thread with a last message time keeps it');

SELECT public.auto_archive_threads();
SELECT is((SELECT archived FROM public.threads WHERE id = '27900000-0000-0000-0000-0000000000d1'), true,
          'auto_archive_threads archives the imported thread once its last message is past the window');
SELECT ok((SELECT archived_at IS NOT NULL FROM public.threads WHERE id = '27900000-0000-0000-0000-0000000000d1'),
          'and records when');

SELECT * FROM finish();
ROLLBACK;
