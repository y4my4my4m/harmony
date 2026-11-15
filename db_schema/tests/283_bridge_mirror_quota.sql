-- 20261112800001_bridge_mirror_quota.sql: the per-server cap on mirrored Discord files, the
-- over_quota queue state, the status keys that report them, and a queue without done rows or
-- copies of the message's bot and channel. 20261112800002_messages_bot_index.sql: one bot index
-- on messages.
--
--   bot b1    bridge bot of server_1 (in discord_bridges)
--   server_2  a second server with one channel, c2
--   alice is made instance admin, bob is not
--
-- Mirrored files (1 MB = 1048576 bytes): server_1 holds 1 MB + 2 MB in general, server_2 holds
-- 8 MB in c2. Every other object below sits outside the mirror paths of server_1.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(54);

SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'bridge_mirror_server_limit_mb'),
          '5120'::jsonb, 'the cap defaults to 5120 MB');

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('28300000-0000-0000-0000-0000000000b1', 'bridge-283', 'Bridge 283', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', '28300000-0000-0000-0000-0000000000b1', 'instance',
        '900000000000000283', '11111111-0000-0000-0000-000000000001');
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO public.servers (id, name, owner)
VALUES ('28300000-0000-0000-0000-000000000052', 'Server 283', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('28300000-0000-0000-0000-0000000000c2', '28300000-0000-0000-0000-000000000052', 'c2', 0);

INSERT INTO public.messages (id, channel_id, bot_id, user_id, content) VALUES
  ('28300000-0000-0000-0000-00000000a001', '66666666-0000-0000-0000-000000000006', '28300000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "file", "url": "https://cdn.discordapp.com/attachments/1/2/a.png"}]'),
  ('28300000-0000-0000-0000-00000000a002', '66666666-0000-0000-0000-000000000006', '28300000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "file", "url": "https://cdn.discordapp.com/attachments/1/2/b.png"}]');

INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
  -- server_1, mirror paths: 1 MB + 2 MB, and one object whose size is unreadable
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge/28300000-0000-0000-0000-0000000000b1/a.png', '{"size": 1048576}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge/28300000-0000-0000-0000-0000000000b1/b.mp4', '{"size": 2097152}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge/28300000-0000-0000-0000-0000000000b1/c.bin', '{"size": "unknown"}'),
  -- server_1, same channel, outside the mirror path: a member's upload and names either side of bridge/
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/photo.png', '{"size": 4194304}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge-old/x.png', '{"size": 4194304}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridged/x.png', '{"size": 4194304}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bridge0', '{"size": 4194304}'),
  -- the mirror path of server_1 in another bucket
  ('stickers', 'c/66666666-0000-0000-0000-000000000006/bridge/28300000-0000-0000-0000-0000000000b1/a.png', '{"size": 4194304}'),
  -- server_2
  ('message_media', 'c/28300000-0000-0000-0000-0000000000c2/bridge/28300000-0000-0000-0000-0000000000b1/d.png', '{"size": 8388608}'),
  -- a channel that does not exist
  ('message_media', 'c/28300000-0000-0000-0000-0000000000ff/bridge/28300000-0000-0000-0000-0000000000b1/e.png', '{"size": 16777216}');

-- Access ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1)$$, '42501', NULL,
                 'authenticated cannot ask the cap');
SELECT throws_ok($$SELECT public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005')$$, '42501', NULL,
                 'authenticated cannot read a server''s usage');
SELECT throws_ok($$SELECT public.bridge_mirror_observe('mirror', 100)$$, '42501', NULL, 'authenticated cannot observe');
SELECT throws_ok($$SELECT public.bridge_mirror_status()$$, '42501', 'Only instance admins can read the mirror queue',
                 'a non-admin cannot read the status');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1)$$, '42501', NULL,
                 'anon cannot ask the cap');
SELECT throws_ok($$SELECT public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005')$$, '42501', NULL,
                 'anon cannot read a server''s usage');
SELECT throws_ok($$SELECT public.bridge_mirror_status()$$, '42501', NULL, 'anon cannot read the status');
SELECT tests.clear_authentication();
SELECT ok(has_function_privilege('service_role', 'public.bridge_mirror_allows(uuid, bigint)', 'EXECUTE'),
          'service_role can ask the cap');
SELECT ok(has_function_privilege('service_role', 'public.bridge_mirror_server_bytes(uuid)', 'EXECUTE'),
          'service_role can read a server''s usage');
SELECT ok(has_function_privilege('service_role', 'public.bridge_mirror_observe(text, bigint)', 'EXECUTE'),
          'service_role can observe');
SELECT ok(NOT has_function_privilege('anon', 'public.bridge_mirror_observe(text, bigint)', 'EXECUTE'),
          'anon cannot observe');

-- Usage -------------------------------------------------------------------------------------------
SELECT is(public.bridge_mirror_server_bytes('55555555-0000-0000-0000-000000000005'), 3145728::bigint,
          'a server''s usage is its channels'' mirror paths in message_media: 1 MB + 2 MB');
SELECT is(public.bridge_mirror_server_bytes('28300000-0000-0000-0000-000000000052'), 8388608::bigint,
          'the second server''s usage is its own 8 MB');
SELECT is(public.bridge_mirror_server_bytes('28300000-0000-0000-0000-0000000000ee'), 0::bigint,
          'an unknown server uses nothing');

-- The cap -----------------------------------------------------------------------------------------
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1048576), true,
          'under the default cap a file is allowed');
UPDATE public.instance_config SET config_value = '4'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1048576), true,
          'cap 4 MB, 3 MB used: 1 MB more is allowed');
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1048577), false,
          'one byte past the cap is refused');
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', NULL), true,
          'a null size counts as 0 bytes');
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', -5), true,
          'a negative size counts as 0 bytes');
SELECT is(public.bridge_mirror_allows('28300000-0000-0000-0000-0000000000c2', 0), false,
          'a server already over the cap is refused any file');
SELECT is(public.bridge_mirror_allows('28300000-0000-0000-0000-0000000000ff', 1), false,
          'an unknown channel is refused');
UPDATE public.instance_config SET config_value = '"4"'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1048577), false,
          'a cap stored as a string reads the same');
UPDATE public.instance_config SET config_value = '0'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT is(public.bridge_mirror_allows('66666666-0000-0000-0000-000000000006', 1099511627776), true,
          'cap 0 is no limit');
SELECT is(public.bridge_mirror_allows('28300000-0000-0000-0000-0000000000c2', 1), true,
          'cap 0 lifts the limit of the server that was over it');
SELECT is(public.bridge_mirror_allows('28300000-0000-0000-0000-0000000000ff', 1), false,
          'an unknown channel is refused without a cap too');
UPDATE public.instance_config SET config_value = '"lots"'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT is(public.bridge_mirror_allows('28300000-0000-0000-0000-0000000000c2', 1), true,
          'an unreadable cap reads as the default 5120 MB');
DELETE FROM public.instance_config WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT is(public.bridge_mirror_allows('28300000-0000-0000-0000-0000000000c2', 5360320512), true,
          'an absent cap reads as the default: 8 MB + 5112 MB is allowed');
SELECT is(public.bridge_mirror_allows('28300000-0000-0000-0000-0000000000c2', 5360320513), false,
          'and one byte more is refused');

-- over_quota --------------------------------------------------------------------------------------
INSERT INTO public.instance_config (config_key, config_value) VALUES ('bridge_mirror_server_limit_mb', '4'::jsonb);
SELECT is(public.bridge_mirror_enqueue(ARRAY['28300000-0000-0000-0000-00000000a001', '28300000-0000-0000-0000-00000000a002']::uuid[]),
          2, 'two bridge bot messages are queued');
SELECT public.bridge_mirror_finish('28300000-0000-0000-0000-00000000a001', 'over_quota', 3, 0, NULL, 'over the server limit');
SELECT results_eq($$SELECT state, attempts, last_error FROM public.bridge_mirror_queue WHERE message_id = '28300000-0000-0000-0000-00000000a001'$$,
                  $$VALUES ('over_quota'::text, 3, 'over the server limit'::text)$$, 'finish records over_quota');
SELECT throws_ok($$UPDATE public.bridge_mirror_queue SET state = 'bogus' WHERE message_id = '28300000-0000-0000-0000-00000000a002'$$,
                 '23514', NULL, 'the state check still refuses an unknown state');
SELECT is((SELECT count(*)::int FROM public.bridge_mirror_claim(60) WHERE message_id = '28300000-0000-0000-0000-00000000a001'), 0,
          'an over_quota row is not claimed');

-- Observe -----------------------------------------------------------------------------------------
SELECT public.bridge_mirror_observe('mirror', 100);
SELECT is((SELECT last_limit_mb FROM public.bridge_mirror_state), 4, 'observe remembers the cap it saw');
UPDATE public.bridge_mirror_queue SET state = 'over_quota' WHERE message_id = '28300000-0000-0000-0000-00000000a001';
CREATE TEMP TABLE seen AS SELECT ctid AS at FROM public.bridge_mirror_state;
SELECT public.bridge_mirror_observe('mirror', 100);
SELECT is((SELECT ctid FROM public.bridge_mirror_state), (SELECT at FROM seen),
          'observe writes nothing while mode, ceiling and cap are as last seen');
SELECT is((SELECT state FROM public.bridge_mirror_queue WHERE message_id = '28300000-0000-0000-0000-00000000a001'), 'over_quota',
          'and leaves the over_quota row');
UPDATE public.instance_config SET config_value = '8'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT public.bridge_mirror_observe('mirror', 100);
SELECT results_eq($$SELECT state, attempts FROM public.bridge_mirror_queue WHERE message_id = '28300000-0000-0000-0000-00000000a001'$$,
                  $$VALUES ('queued'::text, 0)$$, 'a raised cap requeues the over_quota row with 0 attempts');
SELECT isnt((SELECT ctid FROM public.bridge_mirror_state), (SELECT at FROM seen), 'and the state row is written');
UPDATE public.bridge_mirror_queue SET state = 'over_quota' WHERE message_id = '28300000-0000-0000-0000-00000000a001';
UPDATE public.instance_config SET config_value = '2'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT public.bridge_mirror_observe('mirror', 100);
SELECT is((SELECT state FROM public.bridge_mirror_queue WHERE message_id = '28300000-0000-0000-0000-00000000a001'), 'over_quota',
          'a lowered cap requeues nothing');
UPDATE public.instance_config SET config_value = '0'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT public.bridge_mirror_observe('mirror', 100);
SELECT is((SELECT state FROM public.bridge_mirror_queue WHERE message_id = '28300000-0000-0000-0000-00000000a001'), 'queued',
          'a removed cap requeues the over_quota row');
UPDATE public.bridge_mirror_queue SET state = 'over_quota' WHERE message_id = '28300000-0000-0000-0000-00000000a001';
UPDATE public.instance_config SET config_value = '6'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
SELECT public.bridge_mirror_observe('mirror', 100);
SELECT is((SELECT state FROM public.bridge_mirror_queue WHERE message_id = '28300000-0000-0000-0000-00000000a001'), 'over_quota',
          'a cap set where there was none requeues nothing');
UPDATE public.bridge_mirror_queue SET state = 'too_large', largest_bytes = 150
 WHERE message_id = '28300000-0000-0000-0000-00000000a002';
SELECT public.bridge_mirror_observe('mirror', 200);
SELECT results_eq($$SELECT message_id, state FROM public.bridge_mirror_queue ORDER BY message_id$$,
                  $$VALUES ('28300000-0000-0000-0000-00000000a001'::uuid, 'over_quota'::text),
                           ('28300000-0000-0000-0000-00000000a002'::uuid, 'queued'::text)$$,
                  'a raised upload ceiling requeues the too_large row and leaves the over_quota one');

-- Status ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_mirror_status(),
          '{"queued": 1, "too_large": 0, "too_large_bytes": 0, "failed": 0, "over_quota": 1, "stored_bytes": 11534336}'::jsonb,
          'an admin reads the counts without done, the over_quota rows and the bytes stored for every server: 3 MB + 8 MB');
SELECT tests.clear_authentication();

-- A row sent back to the queue -------------------------------------------------------------------
SELECT public.bridge_mirror_finish('28300000-0000-0000-0000-00000000a002', 'queued', 0, 900, NULL, NULL);
SELECT is((SELECT (state, next_attempt_at > now() + interval '14 minutes')::text FROM public.bridge_mirror_queue
            WHERE message_id = '28300000-0000-0000-0000-00000000a002'),
          '(queued,t)', 'the row of a bridge that exists waits its 15 minutes');
DELETE FROM public.discord_bridges WHERE bot_id = '28300000-0000-0000-0000-0000000000b1';
SELECT public.bridge_mirror_finish('28300000-0000-0000-0000-00000000a002', 'queued', 0, 900, NULL, NULL);
SELECT is((SELECT (state, last_error)::text FROM public.bridge_mirror_queue
            WHERE message_id = '28300000-0000-0000-0000-00000000a002'),
          '(failed,"bridge removed")', 'once its bridge is removed the row ends failed instead of waiting again');
SELECT public.bridge_mirror_finish('28300000-0000-0000-0000-00000000a001', 'too_large', 1, NULL, 9, NULL);
SELECT is((SELECT (state, largest_bytes)::text FROM public.bridge_mirror_queue
            WHERE message_id = '28300000-0000-0000-0000-00000000a001'),
          '(too_large,9)', 'any other outcome is stored as given');

-- Queue shape -------------------------------------------------------------------------------------
SELECT hasnt_column('public', 'bridge_mirror_queue', 'bot_id', 'the queue holds no copy of the bot');
SELECT hasnt_column('public', 'bridge_mirror_queue', 'channel_id', 'nor of the channel');
SELECT throws_ok($$UPDATE public.bridge_mirror_queue SET state = 'done' WHERE message_id = '28300000-0000-0000-0000-00000000a001'$$,
                 '23514', NULL, 'done is not a stored state');
SELECT public.bridge_mirror_finish('28300000-0000-0000-0000-00000000a001', 'done', 1, NULL, NULL, NULL);
SELECT is((SELECT count(*)::int FROM public.bridge_mirror_queue WHERE message_id = '28300000-0000-0000-0000-00000000a001'),
          0, 'finish(done) deletes the row');
SELECT is(public.bridge_mirror_enqueue(ARRAY['28300000-0000-0000-0000-00000000a001']::uuid[]), 0,
          'a message whose bot runs no bridge any more is not queued again');

-- Bot indexes on messages -------------------------------------------------------------------------
SELECT is((SELECT array_agg(c.relname::text ORDER BY c.relname)
             FROM pg_index x
             JOIN pg_class c ON c.oid = x.indexrelid
             JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[0]
            WHERE x.indrelid = 'public.messages'::regclass AND a.attname = 'bot_id' AND x.indisvalid),
          ARRAY['idx_messages_bot_channel'],
          'idx_messages_bot_channel is the one valid index of messages led by bot_id');
SELECT ok(to_regclass('public.idx_messages_bot_id') IS NULL, 'the prefix index on bot_id is dropped');
SELECT ok(to_regclass('public.idx_messages_bot_created_id') IS NULL, 'no (bot_id, created_at, id) index');

SELECT * FROM finish();
ROLLBACK;
