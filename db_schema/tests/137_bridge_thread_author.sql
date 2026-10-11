-- The Discord member who started a bridged thread names its notice, after
-- 20261013400001_bridge_thread_author.sql.
--
-- Fixture server_1 (alice owns) with #general and alice's channel message.
-- Added: bridge137 run by bot137 on server_1.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(6);

INSERT INTO public.bots (id, username, display_name, owner_id, is_public) VALUES
  ('f1370000-0000-0000-0000-0000000000b1', 'bridge137', 'Bridge', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f1370000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f1370000-0000-0000-0000-0000000000b1', '900000000000000137', '11111111-0000-0000-0000-000000000001');

CREATE TEMP TABLE t137 (k text PRIMARY KEY, id uuid);
GRANT ALL ON t137 TO service_role;

SET LOCAL ROLE service_role;

INSERT INTO t137 SELECT 'on-message', public.bot_create_thread(
    'f1370000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 'Plans',
    '88888888-0000-0000-0000-000000000008', '1370000000000000001',
    '{"id": "1370000000000000009", "username": "dana", "display_name": "Dana", "avatar_url": "https://cdn.discordapp.com/a.png", "bot": true}');
INSERT INTO t137 SELECT 'standalone', public.bot_create_thread(
    'f1370000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 'Standalone',
    NULL, '1370000000000000002',
    '{"id": "1370000000000000009", "username": "dana", "avatar_url": "javascript:alert(1)"}');
INSERT INTO t137 SELECT 'bad-id', public.bot_create_thread(
    'f1370000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 'Bad id',
    NULL, '1370000000000000003', '{"id": "dana"}');
INSERT INTO t137 SELECT 'none', public.bot_create_thread(
    'f1370000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 'No author',
    NULL, '1370000000000000004');

RESET ROLE;

CREATE TEMP VIEW n137 AS
SELECT k, m.metadata FROM t137 JOIN public.messages m
    ON m.is_system AND m.metadata->>'type' = 'thread_created' AND m.metadata->>'thread_id' = t137.id::text;

SELECT is((SELECT metadata->'discord_user' FROM n137 WHERE k = 'on-message'),
    '{"id": "1370000000000000009", "username": "dana", "display_name": "Dana", "avatar_url": "https://cdn.discordapp.com/a.png"}'::jsonb,
    'the notice names the Discord member, with only the known fields');
SELECT is((SELECT metadata->'discord_user' FROM n137 WHERE k = 'standalone'),
    '{"id": "1370000000000000009", "username": "dana"}'::jsonb,
    'a non-https avatar is dropped');
SELECT ok((SELECT (metadata->>'standalone')::boolean AND metadata->>'thread_name' = 'Standalone' FROM n137 WHERE k = 'standalone'),
    'a standalone notice keeps its fields');
SELECT ok((SELECT NOT metadata ? 'discord_user' FROM n137 WHERE k = 'bad-id'),
    'a member without a snowflake id is ignored');
SELECT ok((SELECT NOT metadata ? 'discord_user' FROM n137 WHERE k = 'none'),
    'no member: the notice stays under the bot');
SELECT ok(NOT has_function_privilege('authenticated', 'public.bot_create_thread(uuid, uuid, text, uuid, text, jsonb)', 'EXECUTE'),
    'clients cannot call bot_create_thread');

SELECT * FROM finish();
ROLLBACK;
