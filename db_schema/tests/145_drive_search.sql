-- Attachment names in message search from 20261015100003_drive_search.sql.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(3);

INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f1450000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"numbers attached"},{"type":"file","fileType":"file","url":"https://example.com/q.pdf","fileName":"quarterly-revenue.pdf"}]');
INSERT INTO public.messages (id, channel_id, user_id, content, encrypted, encryption_metadata) VALUES
  ('f1450000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"Y2lwaGVydGV4dA=="}]', true, '{"algorithm":"megolm_v3","session_id":"s145","message_index":0}');

SELECT ok((SELECT content_tsvector @@ websearch_to_tsquery('english', 'quarterly revenue')
             FROM public.message_search_index WHERE message_id = 'f1450000-0000-0000-0000-000000000001'),
  'a message is found by the name of its attachment');
SELECT ok((SELECT content_tsvector @@ websearch_to_tsquery('english', 'numbers')
             FROM public.message_search_index WHERE message_id = 'f1450000-0000-0000-0000-000000000001'),
  'and still by its text');
SELECT is((SELECT content_text FROM public.message_search_index WHERE message_id = 'f1450000-0000-0000-0000-000000000002'),
  '', 'an encrypted message indexes nothing');

SELECT * FROM finish();
ROLLBACK;
