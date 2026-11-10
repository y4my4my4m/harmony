-- guard_message_client_write after 20261109100007_reserve_history_import_keys.sql: a client cannot
-- write the server-owned history_import, discord_reply_to and created_via metadata keys, on insert
-- or on update of their own message; ordinary posts and edits still work.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(9);

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT lives_ok($q$INSERT INTO public.messages (id, channel_id, user_id, content)
                    VALUES ('f2510000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006',
                            '11111111-0000-0000-0000-000000000001', '[{"type": "text", "text": "plain"}]')$q$,
                'a normal client insert still works');

SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                    VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                            '[{"type": "text", "text": "x"}]', '{"history_import": true}')$q$,
                 '42501', NULL, 'a client insert with metadata.history_import is refused');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                    VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                            '[{"type": "text", "text": "x"}]', '{"discord_reply_to": "1"}')$q$,
                 '42501', NULL, 'a client insert with metadata.discord_reply_to is refused');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                    VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                            '[{"type": "text", "text": "x"}]', '{"created_via": "history_import"}')$q$,
                 '42501', NULL, 'a client insert with metadata.created_via is refused');

SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                    VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                            '[{"type": "text", "text": "x"}]', '{"created_via": "harmony_client"}')$q$,
                'the client''s own created_via = harmony_client is still accepted');

SELECT throws_ok($q$UPDATE public.messages SET metadata = metadata || '{"history_import": true}'
                     WHERE id = 'f2510000-0000-0000-0000-000000000001'$q$,
                 '42501', NULL, 'a client update adding history_import is refused');
SELECT throws_ok($q$UPDATE public.messages SET metadata = metadata || '{"discord_reply_to": "1"}'
                     WHERE id = 'f2510000-0000-0000-0000-000000000001'$q$,
                 '42501', NULL, 'a client update adding discord_reply_to is refused');
SELECT throws_ok($q$UPDATE public.messages SET metadata = metadata || '{"created_via": "x"}'
                     WHERE id = 'f2510000-0000-0000-0000-000000000001'$q$,
                 '42501', NULL, 'a client update adding created_via is refused');
SELECT lives_ok($q$UPDATE public.messages SET content = '[{"type": "text", "text": "edited"}]'
                     WHERE id = 'f2510000-0000-0000-0000-000000000001'$q$,
                'a normal client edit still works');

SELECT tests.clear_authentication();
SELECT * FROM finish();
ROLLBACK;
