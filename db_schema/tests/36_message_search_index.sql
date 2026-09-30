-- index_message keeps message_search_index in step with messages. Encrypted messages are
-- indexed with empty text: their content is one ciphertext part.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(6);

INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('a0000000-0000-0000-0000-00000000000a', '66666666-0000-0000-0000-000000000006',
        '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"searchable walrus"}]');

SELECT is((SELECT server_id FROM public.message_search_index
           WHERE message_id = 'a0000000-0000-0000-0000-00000000000a'),
          '55555555-0000-0000-0000-000000000005'::uuid,
          'a channel message is indexed under its server');
SELECT ok(EXISTS (SELECT 1 FROM public.message_search_index
                  WHERE message_id = 'a0000000-0000-0000-0000-00000000000a'
                    AND content_tsvector @@ plainto_tsquery('english', 'walrus')),
          'the indexed text matches a word from the message');

UPDATE public.messages SET content = '[{"type":"text","text":"edited narwhal"}]'
WHERE id = 'a0000000-0000-0000-0000-00000000000a';
SELECT ok(EXISTS (SELECT 1 FROM public.message_search_index
                  WHERE message_id = 'a0000000-0000-0000-0000-00000000000a'
                    AND content_tsvector @@ plainto_tsquery('english', 'narwhal')),
          'an edit replaces the indexed text');

UPDATE public.messages SET is_deleted = true WHERE id = 'a0000000-0000-0000-0000-00000000000a';
SELECT ok(NOT EXISTS (SELECT 1 FROM public.message_search_index
                      WHERE message_id = 'a0000000-0000-0000-0000-00000000000a'),
          'a soft-deleted message leaves the index');

INSERT INTO public.messages (id, conversation_id, user_id, content, encrypted)
VALUES ('b0000000-0000-0000-0000-00000000000b', '77777777-0000-0000-0000-000000000007',
        '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"Q2lwaGVydGV4dA=="}]', true);

SELECT ok(EXISTS (SELECT 1 FROM public.message_search_index
                  WHERE message_id = 'b0000000-0000-0000-0000-00000000000b'),
          'an encrypted message is indexed');
SELECT is((SELECT content_text FROM public.message_search_index
           WHERE message_id = 'b0000000-0000-0000-0000-00000000000b'),
          '',
          'an encrypted message is indexed without its ciphertext');

SELECT * FROM finish();
ROLLBACK;
