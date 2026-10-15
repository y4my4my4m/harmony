-- Threads across the Discord bridge after 20261013300001_bridge_threads.sql.
--
-- Fixture server_1 (alice owns, bob is a member) with #general and alice's channel message.
-- Added: bridge136 run by bot136 on server_1, and bob's reply-notification state.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(16);

INSERT INTO public.bots (id, username, display_name, owner_id, is_public) VALUES
  ('f1360000-0000-0000-0000-0000000000b1', 'bridge136', 'Bridge', '11111111-0000-0000-0000-000000000001', false),
  ('f1360000-0000-0000-0000-0000000000b2', 'other136', 'Other', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f1360000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f1360000-0000-0000-0000-0000000000b1', '900000000000000136', '11111111-0000-0000-0000-000000000001');

CREATE TEMP TABLE t136 (k text PRIMARY KEY, id uuid);
GRANT ALL ON t136 TO service_role;

SET LOCAL ROLE service_role;

-- Discord thread 1 started from alice's bridged message.
INSERT INTO t136 SELECT 'on-message', public.bot_create_thread(
    'f1360000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', '  Starter thread  ',
    '88888888-0000-0000-0000-000000000008', '1360000000000000001');
-- The same Discord thread again: the pair comes back.
INSERT INTO t136 SELECT 'again', public.bot_create_thread(
    'f1360000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 'Starter thread',
    '88888888-0000-0000-0000-000000000008', '1360000000000000001');
-- Discord thread 2 with no bridged starter: standalone.
INSERT INTO t136 SELECT 'standalone', public.bot_create_thread(
    'f1360000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 'Forum-ish',
    NULL, '1360000000000000002');

RESET ROLE;

SELECT is((SELECT id FROM t136 WHERE k = 'again'), (SELECT id FROM t136 WHERE k = 'on-message'),
    'a Discord thread already paired returns its Harmony thread');
SELECT is((SELECT count(*)::int FROM public.threads WHERE parent_message_id = '88888888-0000-0000-0000-000000000008'), 1,
    'one thread for the starter message');
SELECT is((SELECT name FROM public.threads WHERE id = (SELECT id FROM t136 WHERE k = 'on-message')), 'Starter thread',
    'the name is trimmed');
SELECT ok((SELECT created_by IS NULL FROM public.threads WHERE id = (SELECT id FROM t136 WHERE k = 'on-message')),
    'a bot-created thread has no profile creator');
SELECT ok(EXISTS (SELECT 1 FROM public.thread_members
                   WHERE thread_id = (SELECT id FROM t136 WHERE k = 'on-message')
                     AND user_id = '11111111-0000-0000-0000-000000000001'),
    'the starter message author joins the thread');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_threads
            WHERE bridge_id = 'f1360000-0000-0000-0000-0000000000d1'), 2,
    'both Discord threads are paired');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = '66666666-0000-0000-0000-000000000006' AND is_system
              AND metadata->>'type' = 'thread_created'
              AND metadata->>'thread_id' IN (SELECT id::text FROM t136)), 2,
    'each new thread posts one "started a thread" notice');
SELECT ok((SELECT parent_message_id IN (SELECT id FROM public.messages WHERE is_system AND bot_id = 'f1360000-0000-0000-0000-0000000000b1')
             FROM public.threads WHERE id = (SELECT id FROM t136 WHERE k = 'standalone')),
    'a standalone thread hangs off its bot notice');

-- Bot-authored thread message; bob joins the thread and is notified of it.
INSERT INTO public.thread_members (thread_id, user_id)
VALUES ((SELECT id FROM t136 WHERE k = 'on-message'), '22222222-0000-0000-0000-000000000002');
SET LOCAL ROLE service_role;
INSERT INTO public.messages (channel_id, thread_id, bot_id, content, metadata)
VALUES ('66666666-0000-0000-0000-000000000006', (SELECT id FROM t136 WHERE k = 'on-message'),
        'f1360000-0000-0000-0000-0000000000b1', '[{"type":"text","text":"from discord"}]',
        '{"discord_user":{"id":"1360000000000000099","username":"dana","display_name":"Dana"},"discord_message_id":"1360000000000000100"}');
RESET ROLE;
SELECT is((SELECT message_count FROM public.threads WHERE id = (SELECT id FROM t136 WHERE k = 'on-message')), 1,
    'a bot message lands in the thread');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.thread_members
                       WHERE thread_id = (SELECT id FROM t136 WHERE k = 'on-message') AND user_id IS NULL),
    'a bot author is not enrolled');
SELECT is((SELECT data->'sender'->>'display_name' FROM public.notifications
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'thread_reply'
            ORDER BY created_at DESC LIMIT 1), 'Dana',
    'thread members are notified of a bridged reply, named by its Discord author');

-- Refusals.
SELECT throws_ok($q$SELECT public.bot_create_thread('f1360000-0000-0000-0000-0000000000b2',
    '66666666-0000-0000-0000-000000000006', 'x', NULL, '1360000000000000003')$q$,
    '42501', NULL, 'a bot that runs no bridge on the server cannot pair a Discord thread');
SELECT throws_ok($q$SELECT public.bot_create_thread('f1360000-0000-0000-0000-0000000000b1',
    '66666666-0000-0000-0000-000000000006', '   ')$q$,
    '22023', NULL, 'a blank name is refused');
SELECT throws_ok($q$SELECT public.bot_create_thread('f1360000-0000-0000-0000-0000000000b1',
    '66666666-0000-0000-0000-000000000006', 'x', '99999999-0000-0000-0000-000000000009')$q$,
    'P0002', NULL, 'a starter message outside the channel is refused');

SELECT ok(NOT has_function_privilege('authenticated', 'public.bot_create_thread(uuid, uuid, text, uuid, text, jsonb)', 'EXECUTE'),
    'clients cannot call bot_create_thread');
SELECT ok(NOT has_table_privilege('authenticated', 'public.discord_bridge_threads', 'SELECT'),
    'clients cannot read the thread pairs');

SELECT * FROM finish();
ROLLBACK;
