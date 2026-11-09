-- One live row per Discord message per channel, after
-- 20261109100002_discord_message_unique_index.sql.
--
-- Fixture server_1 with #general (66666666-...06); alice is the author. Added: a second
-- channel in server_1.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(3);

INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f2460000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'dedupe246', 0);

INSERT INTO public.messages (id, channel_id, user_id, content, metadata)
VALUES ('f2460000-0000-0000-0000-0000000000a1', '66666666-0000-0000-0000-000000000006',
        '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"first"}]'::jsonb,
        '{"discord_message_id": "2460000000000000001"}');

SELECT throws_ok(
    $$INSERT INTO public.messages (channel_id, user_id, content, metadata)
      VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
              '[{"type":"text","text":"again"}]'::jsonb, '{"discord_message_id": "2460000000000000001"}')$$,
    '23505', NULL,
    'the same Discord message id twice in one channel is refused');

SELECT lives_ok(
    $$INSERT INTO public.messages (channel_id, user_id, content, metadata)
      VALUES ('f2460000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001',
              '[{"type":"text","text":"elsewhere"}]'::jsonb, '{"discord_message_id": "2460000000000000001"}')$$,
    'the same id in another channel is accepted');

SELECT set_config('harmony.silent_content_update', 'true', true);
UPDATE public.messages SET is_deleted = true WHERE id = 'f2460000-0000-0000-0000-0000000000a1';
SELECT set_config('harmony.silent_content_update', 'false', true);

SELECT lives_ok(
    $$INSERT INTO public.messages (channel_id, user_id, content, metadata)
      VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
              '[{"type":"text","text":"replacement"}]'::jsonb, '{"discord_message_id": "2460000000000000001"}')$$,
    'a soft-deleted duplicate does not block a new row');

SELECT * FROM finish();
ROLLBACK;
