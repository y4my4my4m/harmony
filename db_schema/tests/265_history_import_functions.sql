-- The import insert functions after 20261110900005_history_import_functions.sql:
-- bridge_import_guard / _messages / _thread / _link_replies.
--
-- Fixture server_1 (alice owns, bob is a member) with #general. Added: bridge249 run by bot249 (bot249x
-- is another bot) with the pairs
--   A  #general  Discord ...01  main job: batches, replies, pins, threads, side effects of live posts
--   B  p249b     Discord ...02  50 pinned messages already there: the pin cap
--   C  p249c     Discord ...03  a batch, then its pair is removed
--   D  p249d     Discord ...04  becomes end-to-end encrypted
--   E  p249e     Discord ...05  becomes to_discord only
--   F  p249f     Discord ...06  job left queued
-- The functions set harmony.history_import for the rest of the transaction, which an RPC would not
-- outlive, so the tests reset it to 'false' before any assertion about a live (flag off) action.
-- queue_federation_job is replaced so jobs can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(74);

UPDATE public.servers SET is_local_server = true, federation_enabled = true
 WHERE id = '55555555-0000-0000-0000-000000000005';

INSERT INTO public.bots (id, username, display_name, owner_id) VALUES
  ('f2490000-0000-0000-0000-0000000000b1', 'bot249', 'Bot 249', '11111111-0000-0000-0000-000000000001'),
  ('f2490000-0000-0000-0000-0000000000b2', 'bot249x', 'Bot 249x', '11111111-0000-0000-0000-000000000001');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2490000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'p249b', 0),
  ('f2490000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'p249c', 0),
  ('f2490000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'p249d', 0),
  ('f2490000-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000005', 'p249e', 0),
  ('f2490000-0000-0000-0000-000000000006', '55555555-0000-0000-0000-000000000005', 'p249f', 0);

INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f2490000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f2490000-0000-0000-0000-0000000000b1', '900000000000000249', '11111111-0000-0000-0000-000000000001');

INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f2490000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '2490000000000000001', 'both'),
  ('f2490000-0000-0000-0000-0000000000d1', 'f2490000-0000-0000-0000-000000000002', '2490000000000000002', 'both'),
  ('f2490000-0000-0000-0000-0000000000d1', 'f2490000-0000-0000-0000-000000000003', '2490000000000000003', 'both'),
  ('f2490000-0000-0000-0000-0000000000d1', 'f2490000-0000-0000-0000-000000000004', '2490000000000000004', 'both'),
  ('f2490000-0000-0000-0000-0000000000d1', 'f2490000-0000-0000-0000-000000000005', '2490000000000000005', 'both'),
  ('f2490000-0000-0000-0000-0000000000d1', 'f2490000-0000-0000-0000-000000000006', '2490000000000000006', 'both');

CREATE TABLE tests.jobs249 (name text, data jsonb);
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs249 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

-- One job per pair, running except F's.
SELECT count(*) FROM public.discord_bridge_import_start_internal('f2490000-0000-0000-0000-0000000000d1', NULL, 'harmony', NULL);
CREATE TEMP TABLE j249 AS
SELECT right(i.discord_channel_id, 1) AS k, i.id FROM public.discord_bridge_imports i
 WHERE i.bridge_id = 'f2490000-0000-0000-0000-0000000000d1';
SELECT public.discord_bridge_import_update('f2490000-0000-0000-0000-0000000000d1', id, '{"state": "running"}')
  FROM j249 WHERE k <> '6';

CREATE FUNCTION pg_temp.job(p_k text) RETURNS uuid LANGUAGE sql AS $fn$ SELECT id FROM j249 WHERE k = p_k $fn$;
CREATE FUNCTION pg_temp.row_of(p_k text) RETURNS public.discord_bridge_imports LANGUAGE sql AS
$fn$ SELECT i FROM public.discord_bridge_imports i WHERE i.id = pg_temp.job(p_k) $fn$;

CREATE FUNCTION pg_temp.msg(p_did text, p_created text, p_extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT jsonb_build_object('discord_message_id', p_did, 'created_at', p_created,
           'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'hello ' || p_did)),
           'discord_user', jsonb_build_object('id', '2490000000000009001', 'username', 'dana')) || p_extra $fn$;

-- Calls bridge_import_messages as the bot of the bridge and stores the answer.
CREATE TEMP TABLE r249 (k text PRIMARY KEY, j jsonb);
CREATE FUNCTION pg_temp.batch(p_key text, p_job text, p_msgs jsonb) RETURNS void LANGUAGE sql AS
$fn$ INSERT INTO r249 SELECT p_key, public.bridge_import_messages('f2490000-0000-0000-0000-0000000000b1',
                                                                  pg_temp.job(p_job), p_msgs) $fn$;
CREATE FUNCTION pg_temp.mid(p_did text) RETURNS uuid LANGUAGE sql AS
$fn$ SELECT id FROM public.messages WHERE metadata->>'discord_message_id' = p_did AND channel_id IS NOT NULL $fn$;

-- Access and guard ----------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_import_messages(uuid, uuid, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.bridge_import_thread(uuid, uuid, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_import_link_replies(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_import_guard(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_import_link_replies_core(uuid, uuid[])', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_import_messages(uuid, uuid, jsonb)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_import_thread(uuid, uuid, jsonb)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_import_link_replies(uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_import_guard(uuid, uuid)', 'EXECUTE'),
          'the import functions are for the service role alone');

SELECT throws_ok(format($q$SELECT public.bridge_import_messages('f2490000-0000-0000-0000-0000000000b2', %L, '[]')$q$, pg_temp.job('1')),
                 'P0002', 'import_not_found', 'a bot that is not the bridge''s bot: import_not_found');
SELECT throws_ok(format($q$SELECT public.bridge_import_thread('f2490000-0000-0000-0000-0000000000b2', %L, '{}')$q$, pg_temp.job('1')),
                 'P0002', 'import_not_found', 'and for a thread');
SELECT throws_ok(format($q$SELECT public.bridge_import_link_replies('f2490000-0000-0000-0000-0000000000b2', %L)$q$, pg_temp.job('1')),
                 'P0002', 'import_not_found', 'and for the reply links');
SELECT throws_ok($q$SELECT public.bridge_import_messages('f2490000-0000-0000-0000-0000000000b1', gen_random_uuid(), '[]')$q$,
                 'P0002', 'import_not_found', 'an unknown job: import_not_found');
SELECT throws_ok(format($q$SELECT public.bridge_import_messages('f2490000-0000-0000-0000-0000000000b1', %L, '[]')$q$, pg_temp.job('6')),
                 '55000', 'import_not_running', 'a queued job: import_not_running');

-- A batch of three ------------------------------------------------------------------------------------
SELECT pg_temp.batch('b1', '1', jsonb_build_array(
    pg_temp.msg('2490000000000010001', '2020-01-01T10:00:00Z'),
    pg_temp.msg('2490000000000010002', '2020-01-01T11:00:00Z', '{"edited_at": "2020-01-02T08:00:00Z"}'),
    pg_temp.msg('2490000000000010003', '2020-01-01T12:00:00Z', '{"reply_to_discord_message_id": "2490000000000010001"}')));

SELECT is(jsonb_array_length((SELECT j->'inserted' FROM r249 WHERE k = 'b1')), 3, 'a batch of 3: 3 inserted');
SELECT is((SELECT j->'skipped' FROM r249 WHERE k = 'b1'), '[]'::jsonb, 'none skipped');
SELECT is((SELECT (j->'inserted'->0->>'id')::uuid FROM r249 WHERE k = 'b1'), pg_temp.mid('2490000000000010001'),
          'each insert answers its Harmony id by Discord id');
SELECT is((SELECT array_agg(created_at ORDER BY created_at) FROM public.messages
            WHERE metadata->>'discord_message_id' IN ('2490000000000010001', '2490000000000010002', '2490000000000010003')),
          ARRAY['2020-01-01 10:00+00', '2020-01-01 11:00+00', '2020-01-01 12:00+00']::timestamptz[],
          'the rows keep their original created_at');
SELECT ok((SELECT bool_and(metadata->>'history_import' = 'true' AND metadata->>'created_via' = 'history_import'
                          AND metadata->>'bot' = 'true' AND metadata->'discord_user'->>'username' = 'dana'
                          AND bot_id = 'f2490000-0000-0000-0000-0000000000b1' AND user_id IS NULL
                          AND channel_id = '66666666-0000-0000-0000-000000000006')
             FROM public.messages WHERE metadata->>'discord_message_id' LIKE '249000000000001000_'),
          'they carry the import marker, the Discord member, the bridge bot and the channel');
SELECT is((SELECT updated_at FROM public.messages WHERE id = pg_temp.mid('2490000000000010002')),
          '2020-01-02 08:00+00'::timestamptz, 'edited_at becomes updated_at');
SELECT is((SELECT updated_at FROM public.messages WHERE id = pg_temp.mid('2490000000000010001')),
          '2020-01-01 10:00+00'::timestamptz, 'an unedited message has updated_at = created_at');
SELECT is((SELECT reply_to FROM public.messages WHERE id = pg_temp.mid('2490000000000010003')),
          pg_temp.mid('2490000000000010001'), 'a reply whose target is earlier in the batch links');
SELECT is((SELECT metadata->>'discord_reply_to' FROM public.messages WHERE id = pg_temp.mid('2490000000000010003')),
          '2490000000000010001', 'and keeps the Discord id it replies to');
SELECT is((SELECT imported_count FROM public.discord_bridge_imports WHERE id = pg_temp.job('1')), 3, 'imported_count is 3');

-- Re-sent -----------------------------------------------------------------------------------------------
SELECT pg_temp.batch('b1again', '1', jsonb_build_array(
    pg_temp.msg('2490000000000010001', '2020-01-01T10:00:00Z'),
    pg_temp.msg('2490000000000010002', '2020-01-01T11:00:00Z'),
    pg_temp.msg('2490000000000010003', '2020-01-01T12:00:00Z')));
SELECT is(jsonb_array_length((SELECT j->'inserted' FROM r249 WHERE k = 'b1again')), 0, 're-sent: 0 inserted');
SELECT is((SELECT j->'skipped' FROM r249 WHERE k = 'b1again'),
          '["2490000000000010001", "2490000000000010002", "2490000000000010003"]'::jsonb, 'all 3 skipped, by Discord id');
SELECT is((SELECT imported_count FROM public.discord_bridge_imports WHERE id = pg_temp.job('1')), 3,
          'imported_count counts only real inserts: still 3');
SELECT is((SELECT skipped_count FROM public.discord_bridge_imports WHERE id = pg_temp.job('1')), 3, 'skipped_count is 3');
SELECT is((SELECT count(*)::int FROM public.messages WHERE metadata->>'discord_message_id' LIKE '249000000000001000_'), 3,
          'and there are still 3 rows');

-- A live message with the same Discord id (the race of the review focus) is skipped, not an error.
INSERT INTO public.messages (channel_id, bot_id, content, metadata)
VALUES ('66666666-0000-0000-0000-000000000006', 'f2490000-0000-0000-0000-0000000000b1',
        '[{"type": "text", "text": "live"}]', '{"discord_message_id": "2490000000000010099"}');
SELECT pg_temp.batch('race', '1', jsonb_build_array(pg_temp.msg('2490000000000010099', '2020-01-01T09:00:00Z')));
SELECT is((SELECT j->'skipped' FROM r249 WHERE k = 'race'), '["2490000000000010099"]'::jsonb,
          'a Discord id already relayed live is skipped, not an error');

-- Replies whose target arrives later ----------------------------------------------------------------------
SELECT pg_temp.batch('b2', '1', jsonb_build_array(
    pg_temp.msg('2490000000000010004', '2020-01-03T10:00:00Z', '{"reply_to_discord_message_id": "2490000000000010005"}')));
SELECT is((SELECT reply_to FROM public.messages WHERE id = pg_temp.mid('2490000000000010004')), NULL::uuid,
          'a reply to a message not yet imported is left unlinked');
CREATE TEMP TABLE u249 AS SELECT updated_at FROM public.messages WHERE id = pg_temp.mid('2490000000000010004');
SELECT pg_temp.batch('b3', '1', jsonb_build_array(pg_temp.msg('2490000000000010005', '2020-01-03T09:00:00Z')));
SELECT is(public.bridge_import_link_replies('f2490000-0000-0000-0000-0000000000b1', pg_temp.job('1')), 1,
          'link_replies links it and returns 1');
SELECT is((SELECT reply_to FROM public.messages WHERE id = pg_temp.mid('2490000000000010004')),
          pg_temp.mid('2490000000000010005'), 'the reply points at its target');
SELECT is((SELECT updated_at FROM public.messages WHERE id = pg_temp.mid('2490000000000010004')),
          (SELECT updated_at FROM u249), 'linking leaves updated_at alone');
SELECT is(public.bridge_import_link_replies('f2490000-0000-0000-0000-0000000000b1', pg_temp.job('1')), 0,
          'a second run links nothing');

-- A reply may come before its target in one batch.
SELECT pg_temp.batch('b4', '1', jsonb_build_array(
    pg_temp.msg('2490000000000010006', '2020-01-04T10:00:00Z', '{"reply_to_discord_message_id": "2490000000000010007"}'),
    pg_temp.msg('2490000000000010007', '2020-01-04T09:00:00Z')));
SELECT is((SELECT reply_to FROM public.messages WHERE id = pg_temp.mid('2490000000000010006')),
          pg_temp.mid('2490000000000010007'), 'a reply listed before its target in the same batch links');

-- Pins -------------------------------------------------------------------------------------------------------
SELECT pg_temp.batch('pin', '1', jsonb_build_array(
    pg_temp.msg('2490000000000010008', '2020-01-05T10:00:00Z', '{"pinned": true}')));
SELECT ok((SELECT is_pinned AND pinned_at = created_at FROM public.messages WHERE id = pg_temp.mid('2490000000000010008')),
          'a pinned message is pinned at its created_at while the channel has room');

INSERT INTO public.messages (channel_id, bot_id, content, is_pinned, pinned_at)
SELECT 'f2490000-0000-0000-0000-000000000002', 'f2490000-0000-0000-0000-0000000000b2',
       '[{"type": "text", "text": "old pin"}]', true, now()
  FROM generate_series(1, 50);
SELECT pg_temp.batch('pinfull', '2', jsonb_build_array(
    pg_temp.msg('2490000000000020001', '2020-01-05T10:00:00Z', '{"pinned": true}'),
    pg_temp.msg('2490000000000020002', '2020-01-05T11:00:00Z')));
SELECT is((SELECT is_pinned FROM public.messages WHERE id = pg_temp.mid('2490000000000020001')), false,
          'with 50 pins already, a pinned message is inserted unpinned');
SELECT is((SELECT (imported_count, pins_skipped)::text FROM public.discord_bridge_imports WHERE id = pg_temp.job('2')),
          '(2,1)', 'pins_skipped is 1 and both messages counted as imported');
SELECT is((SELECT count(*)::int FROM public.messages WHERE channel_id = 'f2490000-0000-0000-0000-000000000002' AND is_pinned), 50,
          'the channel stays at 50 pins');

-- Threads --------------------------------------------------------------------------------------------------------
CREATE TEMP TABLE t249 (k text PRIMARY KEY, id uuid);
INSERT INTO t249 SELECT 'a1', public.bridge_import_thread('f2490000-0000-0000-0000-0000000000b1', pg_temp.job('1'),
    jsonb_build_object('discord_thread_id', '2490000000000030001', 'name', 'Old plans', 'created_at', '2020-02-01T10:00:00Z',
                       'starter_discord_message_id', '2490000000000010001', 'archived', true, 'locked', true,
                       'discord_user', jsonb_build_object('id', '2490000000000009001', 'username', 'dana')));
INSERT INTO t249 SELECT 'a2', public.bridge_import_thread('f2490000-0000-0000-0000-0000000000b1', pg_temp.job('1'),
    jsonb_build_object('discord_thread_id', '2490000000000030001', 'name', 'Old plans', 'created_at', '2020-02-01T10:00:00Z',
                       'starter_discord_message_id', '2490000000000010001', 'archived', true, 'locked', true));
INSERT INTO t249 SELECT 's1', public.bridge_import_thread('f2490000-0000-0000-0000-0000000000b1', pg_temp.job('1'),
    jsonb_build_object('discord_thread_id', '2490000000000030002', 'name', 'Forum post', 'created_at', '2020-03-01T10:00:00Z',
                       'archived', false, 'locked', false));
INSERT INTO t249 SELECT 's2', public.bridge_import_thread('f2490000-0000-0000-0000-0000000000b1', pg_temp.job('1'),
    jsonb_build_object('discord_thread_id', '2490000000000030002', 'name', 'Forum post', 'created_at', '2020-03-01T10:00:00Z',
                       'archived', false, 'locked', false));

SELECT is((SELECT id FROM t249 WHERE k = 'a2'), (SELECT id FROM t249 WHERE k = 'a1'),
          'the same discord_thread_id returns the same thread');
SELECT is((SELECT id FROM t249 WHERE k = 's2'), (SELECT id FROM t249 WHERE k = 's1'), 'also for a standalone thread');
SELECT is((SELECT count(*)::int FROM public.threads WHERE name IN ('Old plans', 'Forum post')), 2, 'two threads exist');
SELECT is((SELECT (created_at, archived, locked, parent_message_id)::text FROM public.threads WHERE id = (SELECT id FROM t249 WHERE k = 'a1')),
          format('("2020-02-01 10:00:00+00",t,t,%s)', pg_temp.mid('2490000000000010001')),
          'the thread is backdated, keeps archived and locked, and hangs on the starter message');
SELECT ok((SELECT updated_at = '2020-02-01 10:00+00' AND created_by IS NULL FROM public.threads WHERE id = (SELECT id FROM t249 WHERE k = 'a1')),
          'its updated_at is the same time');
SELECT ok((SELECT created_at = '2020-02-01 10:00+00' AND metadata->>'history_import' = 'true'
                  AND metadata->>'created_via' = 'history_import' AND metadata->'discord_user'->>'username' = 'dana'
                  AND is_system AND metadata->>'actor_bot_id' = 'f2490000-0000-0000-0000-0000000000b1'
             FROM public.messages WHERE metadata->>'type' = 'thread_created'
              AND metadata->>'thread_id' = (SELECT id::text FROM t249 WHERE k = 'a1')),
          'the "started a thread" notice carries created_at, the marker and the Discord member');
SELECT ok((SELECT created_at = '2020-03-01 10:00+00' AND metadata->>'history_import' = 'true'
                  AND (metadata->>'standalone')::boolean AND id = (SELECT parent_message_id FROM public.threads WHERE id = (SELECT id FROM t249 WHERE k = 's1'))
             FROM public.messages WHERE metadata->>'type' = 'thread_created'
              AND metadata->>'thread_id' = (SELECT id::text FROM t249 WHERE k = 's1')),
          'a standalone thread hangs on its own backdated, marked notice');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_threads WHERE bridge_id = 'f2490000-0000-0000-0000-0000000000d1'), 2,
          'both are paired with their Discord threads');

SELECT pg_temp.batch('thr', '1', jsonb_build_array(
    pg_temp.msg('2490000000000010010', '2020-02-02T10:00:00Z', jsonb_build_object('thread_id', (SELECT id FROM t249 WHERE k = 'a1')))));
SELECT is((SELECT (message_count, archived, last_message_at = '2020-02-02T10:00:00Z'::timestamptz, last_message_id IS NULL)::text
             FROM public.threads WHERE id = (SELECT id FROM t249 WHERE k = 'a1')),
          '(1,t,t,t)', 'a message in the thread is counted; the thread stays archived and takes its time as last activity, not as last message');
SELECT throws_ok(format($q$SELECT public.bridge_import_messages('f2490000-0000-0000-0000-0000000000b1', %L, %L::jsonb)$q$,
                        pg_temp.job('1'), jsonb_build_array(pg_temp.msg('2490000000000010011', '2020-02-02T10:00:00Z',
                            jsonb_build_object('thread_id', gen_random_uuid())))),
                 '22023', 'invalid_thread', 'a thread that is not this channel''s is refused');

-- Quiet: no side effects for a clean channel (C) ----------------------------------------------------------------
SELECT pg_temp.batch('c1', '3', jsonb_build_array(
    pg_temp.msg('2490000000000040001', '2020-04-01T10:00:00Z', '{"pinned": true}'),
    pg_temp.msg('2490000000000040002', '2020-04-01T11:00:00Z', '{"reply_to_discord_message_id": "2490000000000040001"}')));
SELECT is((SELECT count(*)::int FROM tests.jobs249 WHERE data->>'channel_id' = 'f2490000-0000-0000-0000-000000000003'), 0,
          'imported rows queue no federation job');
SELECT is((SELECT array_agg(DISTINCT federation_status) FROM public.messages WHERE channel_id = 'f2490000-0000-0000-0000-000000000003'),
          ARRAY['skipped'], 'they are marked skipped');
SELECT is((SELECT count(*)::int FROM public.notifications n
            WHERE n.data->>'message_id' IN (SELECT id::text FROM public.messages WHERE channel_id = 'f2490000-0000-0000-0000-000000000003')), 0,
          'they notify no one');
SELECT is((SELECT count(*)::int FROM public.message_heads WHERE channel_id = 'f2490000-0000-0000-0000-000000000003'), 0,
          'they leave no unread head or last-activity row');
SELECT is((SELECT count(*)::int FROM realtime.messages WHERE topic = 'channel-messages-f2490000-0000-0000-0000-000000000003'), 0,
          'they broadcast nothing');

-- A pair that goes away, a channel that is encrypted -----------------------------------------------------------------
DELETE FROM public.discord_bridge_channels WHERE harmony_channel_id = 'f2490000-0000-0000-0000-000000000003';
SELECT pg_temp.batch('gone', '3', jsonb_build_array(pg_temp.msg('2490000000000040003', '2020-04-02T10:00:00Z')));
SELECT is((SELECT (j->>'not_running', j->>'error')::text FROM r249 WHERE k = 'gone'), '(true,pair_removed)',
          'after the pair is removed the batch answers not running, with the reason');
SELECT is((SELECT (state, error)::text FROM public.discord_bridge_imports WHERE id = pg_temp.job('3')), '(failed,pair_removed)',
          'and the job is failed with pair_removed');
SELECT is((SELECT count(*)::int FROM public.messages WHERE metadata->>'discord_message_id' = '2490000000000040003'), 0,
          'nothing was inserted');
SELECT throws_ok(format($q$SELECT public.bridge_import_messages('f2490000-0000-0000-0000-0000000000b1', %L, '[]')$q$, pg_temp.job('3')),
                 '55000', 'import_not_running', 'the next call raises import_not_running');

INSERT INTO public.server_encryption_settings (server_id, encryption_mode)
VALUES ('55555555-0000-0000-0000-000000000005', 'optional')
ON CONFLICT (server_id) DO UPDATE SET encryption_mode = 'optional';
INSERT INTO public.channel_encryption_settings (channel_id, messages_encrypted)
VALUES ('f2490000-0000-0000-0000-000000000004', true)
ON CONFLICT (channel_id) DO UPDATE SET messages_encrypted = true;
SELECT pg_temp.batch('enc', '4', jsonb_build_array(pg_temp.msg('2490000000000050001', '2020-05-01T10:00:00Z')));
SELECT is((SELECT (state, error)::text FROM public.discord_bridge_imports WHERE id = pg_temp.job('4')), '(failed,channel_encrypted)',
          'an encrypted channel fails the job with channel_encrypted');

UPDATE public.discord_bridge_channels SET direction = 'to_discord' WHERE harmony_channel_id = 'f2490000-0000-0000-0000-000000000005';
SELECT is(public.bridge_import_thread('f2490000-0000-0000-0000-0000000000b1', pg_temp.job('5'),
              '{"discord_thread_id": "2490000000000060001", "name": "x", "created_at": "2020-01-01T00:00:00Z"}'), NULL::uuid,
          'a thread call on a pair no longer importable answers NULL');
SELECT is((SELECT (state, error)::text FROM public.discord_bridge_imports WHERE id = pg_temp.job('5')), '(failed,pair_not_importable)',
          'and the job fails with pair_not_importable');

-- Live actions after the import (flag off) ------------------------------------------------------------------------------
SELECT set_config('harmony.history_import', 'false', true);
CREATE TEMP TABLE k249 (k text PRIMARY KEY, id uuid);
INSERT INTO k249 VALUES ('imp', pg_temp.mid('2490000000000010002'));
INSERT INTO public.messages (channel_id, bot_id, content, metadata)
VALUES ('66666666-0000-0000-0000-000000000006', 'f2490000-0000-0000-0000-0000000000b2',
        '[{"type": "text", "text": "normal"}]', '{}');
INSERT INTO k249 SELECT 'norm', id FROM public.messages WHERE content = '[{"type": "text", "text": "normal"}]'::jsonb
                                                          AND bot_id = 'f2490000-0000-0000-0000-0000000000b2'
                                                          AND channel_id = '66666666-0000-0000-0000-000000000006';
DELETE FROM tests.jobs249;

CREATE FUNCTION pg_temp.njobs(p_name text, p_k text) RETURNS int LANGUAGE sql AS $fn$
    SELECT count(*)::int FROM tests.jobs249 WHERE name = p_name AND data->>'message_id' = (SELECT id::text FROM k249 WHERE k = p_k)
$fn$;

UPDATE public.messages SET content = '[{"type": "text", "text": "edited"}]' WHERE id IN (SELECT id FROM k249);
SELECT is(pg_temp.njobs('federate-channel-message-edit', 'norm'), 1, 'control: editing a normal message federates');
SELECT is(pg_temp.njobs('federate-channel-message-edit', 'imp'), 0, 'editing an imported message queues no federation job');
UPDATE public.messages SET is_pinned = true, pinned_at = now() WHERE id IN (SELECT id FROM k249);
SELECT is(pg_temp.njobs('federate-channel-pin', 'norm'), 1, 'control: pinning a normal message federates');
SELECT is(pg_temp.njobs('federate-channel-pin', 'imp'), 0, 'pinning an imported message queues no federation job');
UPDATE public.messages SET is_deleted = true WHERE id IN (SELECT id FROM k249);
SELECT is(pg_temp.njobs('federate-channel-message-delete', 'norm'), 1, 'control: deleting a normal message federates');
SELECT is(pg_temp.njobs('federate-channel-message-delete', 'imp'), 0, 'deleting an imported message queues no federation job');

INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
VALUES ('f2490000-0000-0000-0000-0000000000e1', '66666666-0000-0000-0000-000000000006',
        (SELECT id FROM k249 WHERE k = 'norm'), 'normal thread',
        '11111111-0000-0000-0000-000000000001');
DELETE FROM tests.jobs249;
DELETE FROM public.threads WHERE id IN ('f2490000-0000-0000-0000-0000000000e1', (SELECT id FROM t249 WHERE k = 'a1'));
SELECT is((SELECT count(*)::int FROM tests.jobs249 WHERE name = 'federate-thread' AND data->>'type' = 'delete'
             AND data->>'thread_id' = 'f2490000-0000-0000-0000-0000000000e1'), 1, 'control: deleting a normal thread federates');
SELECT is((SELECT count(*)::int FROM tests.jobs249 WHERE name = 'federate-thread' AND data->>'type' = 'delete'
             AND data->>'thread_id' = (SELECT id::text FROM t249 WHERE k = 'a1')), 0,
          'deleting an imported thread queues no federation job');

-- bridge_import_present_ids: the dedupe pre-filter ------------------------------------------------------------
INSERT INTO public.messages (channel_id, bot_id, content, metadata, is_deleted) VALUES
  ('66666666-0000-0000-0000-000000000006', 'f2490000-0000-0000-0000-0000000000b1',
   '[{"type": "text", "text": "gone"}]', '{"discord_message_id": "2490000000000010098"}', true),
  ('f2490000-0000-0000-0000-000000000002', 'f2490000-0000-0000-0000-0000000000b1',
   '[{"type": "text", "text": "elsewhere"}]', '{"discord_message_id": "2490000000000040001"}', false);
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_import_present_ids(uuid, uuid, text[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.bridge_import_present_ids(uuid, uuid, text[])', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_import_present_ids(uuid, uuid, text[])', 'EXECUTE'),
          'present_ids is for the service role alone');
SELECT is((SELECT array_agg(x ORDER BY x) FROM unnest(public.bridge_import_present_ids(
              'f2490000-0000-0000-0000-0000000000b1', pg_temp.job('1'),
              ARRAY['2490000000000010001', '2490000000000010099', '2490000000000099999'])) x),
          ARRAY['2490000000000010001', '2490000000000010099'], 'present_ids returns the ids the channel already holds');
SELECT is(public.bridge_import_present_ids('f2490000-0000-0000-0000-0000000000b1', pg_temp.job('1'),
                                           ARRAY['2490000000000010098']), ARRAY[]::text[],
          'a deleted row does not count as present');
SELECT is(public.bridge_import_present_ids('f2490000-0000-0000-0000-0000000000b1', pg_temp.job('1'),
                                           ARRAY['2490000000000040001']), ARRAY[]::text[],
          'nor does a row of another channel');
SELECT throws_ok(format($q$SELECT public.bridge_import_present_ids('f2490000-0000-0000-0000-0000000000b2', %L, ARRAY['1'])$q$,
                        pg_temp.job('1')),
                 'P0002', 'import_not_found', 'present_ids of another bot''s job: import_not_found');

-- A message that breaks a check is rejected; the batch carries on ------------------------------------------------
CREATE TEMP TABLE c249 AS SELECT imported_count AS i, skipped_count AS s FROM public.discord_bridge_imports WHERE id = pg_temp.job('1');
SELECT pg_temp.batch('rej', '1', jsonb_build_array(
    pg_temp.msg('2490000000000010101', '2020-06-01T10:00:00Z'),
    pg_temp.msg('2490000000000010102', '2020-06-01T11:00:00Z',
                jsonb_build_object('content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', repeat('x', 4000))))),
    pg_temp.msg('2490000000000010103', '2020-06-01T12:00:00Z', '{"content": []}'),
    pg_temp.msg('2490000000000010104', '2020-06-01T13:00:00Z')));
SELECT is((SELECT array_agg(e->>'discord_message_id' ORDER BY e->>'discord_message_id')
             FROM jsonb_array_elements((SELECT j->'inserted' FROM r249 WHERE k = 'rej')) e),
          ARRAY['2490000000000010101', '2490000000000010104'], 'the other messages of the batch are inserted');
SELECT is((SELECT j->'rejected' FROM r249 WHERE k = 'rej'),
          '[{"discord_message_id": "2490000000000010102", "reason": "too_long"},
            {"discord_message_id": "2490000000000010103", "reason": "check_violation"}]'::jsonb,
          'the over-long and the empty message are reported with a reason');
SELECT is((SELECT j->'skipped' FROM r249 WHERE k = 'rej'),
          '["2490000000000010102", "2490000000000010103"]'::jsonb, 'rejected ids are also in skipped');
SELECT is((SELECT count(*)::int FROM public.messages WHERE metadata->>'discord_message_id' IN ('2490000000000010102', '2490000000000010103')),
          0, 'and no row exists for them');
SELECT is((SELECT (d.imported_count - c.i, d.skipped_count - c.s)::text
             FROM public.discord_bridge_imports d, c249 c WHERE d.id = pg_temp.job('1')),
          '(2,2)', 'the job counts 2 more imported and 2 more skipped');

-- Only the definer wrappers call the shared reply linker.
SELECT ok(NOT has_function_privilege('service_role', 'public.bridge_import_link_replies_core(uuid, uuid[])', 'EXECUTE'),
          'the reply-link core is not callable by the service role');

SELECT set_config('harmony.history_import', 'false', true);

-- Clients are unaffected by the flag triggers ------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                   VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                           '[{"type": "text", "text": "a client posts"}]')$q$,
                'a client (authenticated, flag off) can still post a channel message');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
