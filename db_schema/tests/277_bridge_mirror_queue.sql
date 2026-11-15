-- 20261112200001_bridge_mirror_queue.sql: the queue the gateway worker uses to store Discord
-- attachments in Harmony storage, and the service-role functions that drive it.
--
--   bot b1  bridge bot of server_1 (in discord_bridges)
--   bot b2  a bot that bridges nothing
--   alice is made instance admin, bob is not
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(34);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('27300000-0000-0000-0000-0000000000b1', 'bridge-273', 'Bridge 273', '11111111-0000-0000-0000-000000000001', 'bridge'),
  ('27300000-0000-0000-0000-0000000000b2', 'other-273', 'Other 273', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', '27300000-0000-0000-0000-0000000000b1', 'instance',
        '900000000000000273', '11111111-0000-0000-0000-000000000001');
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

-- a001 no link, a002 Discord CDN file, a003 Discord CDN url (2023), a004 non-bridge bot, a005 a user's message
INSERT INTO public.messages (id, channel_id, bot_id, user_id, content, created_at) VALUES
  ('27300000-0000-0000-0000-00000000a001', '66666666-0000-0000-0000-000000000006', '27300000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "text", "text": "plain"}]', now() - interval '3 hours'),
  ('27300000-0000-0000-0000-00000000a002', '66666666-0000-0000-0000-000000000006', '27300000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "file", "url": "https://cdn.discordapp.com/attachments/1/2/a.png"}]', now() - interval '2 hours'),
  ('27300000-0000-0000-0000-00000000a003', '66666666-0000-0000-0000-000000000006', '27300000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "url", "url": "https://media.discordapp.net/attachments/1/2/b.png"}]', '2023-05-01T00:00:00Z'),
  ('27300000-0000-0000-0000-00000000a004', '66666666-0000-0000-0000-000000000006', '27300000-0000-0000-0000-0000000000b2', NULL,
   '[{"type": "file", "url": "https://cdn.discordapp.com/attachments/1/2/c.png"}]', now() - interval '1 hour');
INSERT INTO public.messages (id, channel_id, user_id, content, created_at) VALUES
  ('27300000-0000-0000-0000-00000000a005', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type": "file", "url": "https://cdn.discordapp.com/attachments/1/2/d.png"}]', now() - interval '30 minutes');

-- Access ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT * FROM public.bridge_mirror_queue$$, '42501', NULL, 'authenticated cannot read the queue');
SELECT throws_ok($$SELECT * FROM public.bridge_mirror_state$$, '42501', NULL, 'authenticated cannot read the state');
SELECT throws_ok($$SELECT public.bridge_mirror_status()$$, '42501', NULL, 'a non-admin cannot read the status');
SELECT throws_ok($$SELECT public.bridge_mirror_enqueue(ARRAY[]::uuid[])$$, '42501', NULL, 'authenticated cannot enqueue');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT * FROM public.bridge_mirror_queue$$, '42501', NULL, 'anon cannot read the queue');
SELECT throws_ok($$SELECT * FROM public.bridge_mirror_state$$, '42501', NULL, 'anon cannot read the state');
SELECT tests.clear_authentication();
SELECT ok(NOT has_function_privilege('anon', 'public.bridge_mirror_status()', 'EXECUTE'), 'anon cannot run the status');
SELECT ok(has_function_privilege('service_role', 'public.bridge_mirror_claim(integer)', 'EXECUTE'), 'service_role can claim');
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_mirror_backfill(integer)', 'EXECUTE'), 'authenticated cannot backfill');

-- Enqueue -----------------------------------------------------------------------------------------
SELECT is(public.bridge_mirror_enqueue(ARRAY['27300000-0000-0000-0000-00000000a004']::uuid[]), 0,
          'a non-bridge bot message is not enqueued');
SELECT is(public.bridge_mirror_enqueue(ARRAY['27300000-0000-0000-0000-00000000a005']::uuid[]), 0,
          'a user message is not enqueued');
SELECT is(public.bridge_mirror_enqueue(ARRAY['27300000-0000-0000-0000-00000000a002']::uuid[]), 1,
          'a bridge bot message is enqueued');
SELECT is((SELECT state FROM public.bridge_mirror_queue WHERE message_id = '27300000-0000-0000-0000-00000000a002'), 'queued',
          'as queued');
UPDATE public.bridge_mirror_queue SET state = 'failed', attempts = 5
 WHERE message_id = '27300000-0000-0000-0000-00000000a002';
SELECT is(public.bridge_mirror_enqueue(ARRAY['27300000-0000-0000-0000-00000000a002']::uuid[]), 1,
          're-enqueue touches the failed row');
SELECT results_eq($$SELECT state, attempts FROM public.bridge_mirror_queue WHERE message_id = '27300000-0000-0000-0000-00000000a002'$$,
                  $$VALUES ('queued'::text, 0)$$, 'and resets it to queued with 0 attempts');

-- Claim and finish --------------------------------------------------------------------------------
SELECT is((SELECT message_id FROM public.bridge_mirror_claim(60)), '27300000-0000-0000-0000-00000000a002'::uuid,
          'claim returns the due row');
SELECT is((SELECT count(*)::int FROM public.bridge_mirror_claim(60)), 0, 'a second claim inside the lease returns nothing');
SELECT hasnt_column('public', 'bridge_mirror_queue', 'bot_id', 'the row carries no copy of the bot');
SELECT public.bridge_mirror_finish('27300000-0000-0000-0000-00000000a002', 'queued', 1, 0, NULL, 'x');
SELECT is((SELECT attempts FROM public.bridge_mirror_claim(60)), 1, 'after finish(queued) it is claimable again, with its attempts');
SELECT public.bridge_mirror_finish('27300000-0000-0000-0000-00000000a002', 'too_large', 2, 0, 150, 'big');
SELECT results_eq($$SELECT state, largest_bytes, last_error FROM public.bridge_mirror_queue WHERE message_id = '27300000-0000-0000-0000-00000000a002'$$,
                  $$VALUES ('too_large'::text, 150::bigint, 'big'::text)$$, 'finish records state, size and error');
SELECT lives_ok($$SELECT public.bridge_mirror_finish('27300000-0000-0000-0000-00000000ffff', 'done', 1, 0, NULL, NULL)$$,
                'finish of a missing row is a no-op');

-- Backfill: three bridge bot messages, walked one row per call ------------------------------------
DELETE FROM public.bridge_mirror_queue;
-- a001 and a002 share a created_at: the (created_at, id) cursor must visit each once
UPDATE public.messages SET created_at = (SELECT created_at FROM public.messages WHERE id = '27300000-0000-0000-0000-00000000a002')
 WHERE id = '27300000-0000-0000-0000-00000000a001';
SELECT public.bridge_mirror_observe('mirror', 0);
CREATE TEMP TABLE bf (call int, n int);
INSERT INTO bf SELECT 1, public.bridge_mirror_backfill(1);
INSERT INTO bf SELECT 2, public.bridge_mirror_backfill(1);
INSERT INTO bf SELECT 3, public.bridge_mirror_backfill(1);
SELECT is((SELECT walk_done FROM public.bridge_mirror_state), false, 'the walk is not done while each call fills its limit');
INSERT INTO bf SELECT 4, public.bridge_mirror_backfill(1);
SELECT is((SELECT sum(n)::int FROM bf), 2, 'the walk enqueues the two messages with Discord links');
SELECT is((SELECT array_agg(message_id ORDER BY message_id) FROM public.bridge_mirror_queue),
          ARRAY['27300000-0000-0000-0000-00000000a002', '27300000-0000-0000-0000-00000000a003']::uuid[],
          'they are the file and the (2023) url message');
SELECT is((SELECT walk_done FROM public.bridge_mirror_state), true, 'the walk is done once a call reads fewer rows than its limit');
SELECT public.bridge_mirror_restart_walk();
SELECT is(public.bridge_mirror_backfill(10), 0, 'a walk that is done again enqueues nothing new (queued rows are skipped)');

-- Observe -----------------------------------------------------------------------------------------
SELECT public.bridge_mirror_observe('link', 100);
SELECT is((public.bridge_mirror_observe('mirror', 100))->>'walk_done', 'false', 'link -> mirror resets the walk');
SELECT is((SELECT cursor_id FROM public.bridge_mirror_state), NULL, 'and the cursor');
SELECT public.bridge_mirror_backfill(10);
SELECT public.bridge_mirror_observe('mirror', 100);
SELECT isnt((SELECT cursor_id FROM public.bridge_mirror_state), NULL, 'mirror -> mirror keeps the cursor');

UPDATE public.bridge_mirror_queue SET state = 'too_large', largest_bytes = 150
 WHERE message_id = '27300000-0000-0000-0000-00000000a002';
UPDATE public.bridge_mirror_queue SET state = 'too_large', largest_bytes = 300
 WHERE message_id = '27300000-0000-0000-0000-00000000a003';
SELECT public.bridge_mirror_observe('mirror', 200);
SELECT results_eq($$SELECT message_id, state FROM public.bridge_mirror_queue ORDER BY message_id$$,
                  $$VALUES ('27300000-0000-0000-0000-00000000a002'::uuid, 'queued'::text),
                           ('27300000-0000-0000-0000-00000000a003'::uuid, 'too_large'::text)$$,
                  'a higher ceiling requeues the 150 byte row and leaves the 300 byte one');
-- A lowered ceiling is remembered: 200 -> 100 -> 200 requeues a 150 byte row.
SELECT public.bridge_mirror_observe('mirror', 100);
UPDATE public.bridge_mirror_queue SET state = 'too_large', largest_bytes = 150
 WHERE message_id = '27300000-0000-0000-0000-00000000a002';
SELECT public.bridge_mirror_observe('mirror', 200);
SELECT is((SELECT state FROM public.bridge_mirror_queue WHERE message_id = '27300000-0000-0000-0000-00000000a002'), 'queued',
          'a ceiling lowered and raised again requeues the row that became too large meanwhile');
SELECT public.bridge_mirror_restart_walk();
SELECT is((SELECT cursor_id FROM public.bridge_mirror_state), NULL, 'restart_walk clears the cursor');

-- Status ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_mirror_status(), '{"queued": 1, "too_large": 1, "too_large_bytes": 300, "failed": 0, "over_quota": 0, "stored_bytes": 0}'::jsonb,
          'an admin reads the counts');
SELECT tests.clear_authentication();

-- Cascade -----------------------------------------------------------------------------------------
DELETE FROM public.messages WHERE id = '27300000-0000-0000-0000-00000000a002';
SELECT is((SELECT count(*)::int FROM public.bridge_mirror_queue WHERE message_id = '27300000-0000-0000-0000-00000000a002'), 0,
          'deleting the message deletes its queue row');

SELECT * FROM finish();
ROLLBACK;
