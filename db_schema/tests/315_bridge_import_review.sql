-- Discord history import fixes after 20261123200001_bridge_import_review.sql: a start during a
-- cancel, the manager's stop, the stale-job sweep, progress keys on a job that is not running, the
-- paged replies phase, threads a person deleted, and the thread pairs a purge drops.
--
-- Fixture server_1 (alice owns and is the instance admin) with #general. Added: bridge315 run by
-- bot315 with the pairs
--   A  #general  Discord ...01  cancel and start, threads
--   B  p315b     Discord ...02  progress keys after a purge-like failure
--   C  p315c     Discord ...03  stale jobs
--   D  p315d     Discord ...04  the replies phase
-- The import functions set harmony.history_import for the rest of the transaction; the tests reset
-- it before a live action.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(35);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f3150000-0000-0000-0000-0000000000b1', 'bot315', 'Bot 315', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f3150000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'p315b', 0),
  ('f3150000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'p315c', 0),
  ('f3150000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'p315d', 0);
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f3150000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f3150000-0000-0000-0000-0000000000b1', '900000000000000315', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f3150000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '3150000000000000001', 'both'),
  ('f3150000-0000-0000-0000-0000000000d1', 'f3150000-0000-0000-0000-000000000002', '3150000000000000002', 'both'),
  ('f3150000-0000-0000-0000-0000000000d1', 'f3150000-0000-0000-0000-000000000003', '3150000000000000003', 'both'),
  ('f3150000-0000-0000-0000-0000000000d1', 'f3150000-0000-0000-0000-000000000004', '3150000000000000004', 'both');

UPDATE public.instance_config SET config_value = '"self_run"'::jsonb WHERE config_key = 'bridge_history_import';
UPDATE public.instance_config SET config_value = '0'::jsonb
 WHERE config_key IN ('bridge_import_max_running', 'bridge_import_messages_per_minute');

CREATE FUNCTION pg_temp.job(p_k text) RETURNS uuid LANGUAGE sql AS
$fn$ SELECT i.id FROM public.discord_bridge_imports i
      WHERE i.bridge_id = 'f3150000-0000-0000-0000-0000000000d1' AND right(i.discord_channel_id, 1) = p_k $fn$;
CREATE FUNCTION pg_temp.row_of(p_k text) RETURNS public.discord_bridge_imports LANGUAGE sql AS
$fn$ SELECT i FROM public.discord_bridge_imports i WHERE i.id = pg_temp.job(p_k) $fn$;
CREATE FUNCTION pg_temp.patch(p_k text, p_patch jsonb) RETURNS public.discord_bridge_imports LANGUAGE sql AS
$fn$ SELECT public.discord_bridge_import_update('f3150000-0000-0000-0000-0000000000d1', pg_temp.job(p_k), p_patch) $fn$;
CREATE FUNCTION pg_temp.start(p_k text) RETURNS SETOF public.discord_bridge_imports LANGUAGE sql AS
$fn$ SELECT * FROM public.discord_bridge_import_start_internal('f3150000-0000-0000-0000-0000000000d1',
         ARRAY['315000000000000000' || p_k], 'discord', NULL) $fn$;
CREATE FUNCTION pg_temp.cancel(p_k text) RETURNS SETOF public.discord_bridge_imports LANGUAGE sql AS
$fn$ SELECT * FROM public.discord_bridge_import_cancel_internal('f3150000-0000-0000-0000-0000000000d1', pg_temp.job(p_k)) $fn$;
CREATE FUNCTION pg_temp.msg(p_did text, p_created text, p_extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT jsonb_build_object('discord_message_id', p_did, 'created_at', p_created,
           'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'hello ' || p_did)),
           'discord_user', jsonb_build_object('id', '3150000000000009001', 'username', 'dana')) || p_extra $fn$;
CREATE FUNCTION pg_temp.batch(p_k text, p_messages jsonb) RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT public.bridge_import_messages('f3150000-0000-0000-0000-0000000000b1', pg_temp.job(p_k), p_messages) $fn$;
CREATE FUNCTION pg_temp.page(p_limit integer) RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT public.bridge_import_link_replies_page('f3150000-0000-0000-0000-0000000000b1', pg_temp.job('4'), p_limit) $fn$;
CREATE FUNCTION pg_temp.thread(p_did text) RETURNS uuid LANGUAGE sql AS
$fn$ SELECT public.bridge_import_thread('f3150000-0000-0000-0000-0000000000b1', pg_temp.job('1'),
         jsonb_build_object('discord_thread_id', p_did, 'name', 'topic ' || p_did, 'created_at', '2024-03-01T00:00:00Z')) $fn$;
CREATE FUNCTION pg_temp.by_did(p_did text) RETURNS public.messages LANGUAGE sql AS
$fn$ SELECT m FROM public.messages m WHERE m.metadata ? 'discord_message_id'
         AND m.metadata ->> 'discord_message_id' = p_did AND m.is_deleted IS NOT TRUE $fn$;

SELECT count(*) FROM public.discord_bridge_import_start_internal('f3150000-0000-0000-0000-0000000000d1', NULL, 'discord', NULL);

-- Start during a cancel ---------------------------------------------------------------------------------
SELECT pg_temp.patch('1', '{"state": "running"}');
SELECT pg_temp.cancel('1');
SELECT ok((pg_temp.row_of('1')).cancel_requested, 'a cancel asks the running job to stop');
SELECT is((SELECT state || ':' || cancel_requested FROM pg_temp.start('1')), 'running:false',
          'a start before the bridge stopped it withdraws the request');
SELECT throws_ok($q$SELECT pg_temp.patch('1', '{"state": "cancelled"}')$q$, '55000', 'invalid_transition',
                 'the bridge''s cancel that read the withdrawn request is refused');
SELECT is((pg_temp.row_of('1')).state, 'running', 'the run carries on');

-- The manager's stop ------------------------------------------------------------------------------------
SELECT pg_temp.cancel('1');
SELECT is((pg_temp.row_of('1')).state, 'running', 'the first cancel leaves the job to its bridge');
SELECT is((SELECT state FROM pg_temp.cancel('1')), 'cancelled', 'a second cancel ends it');
SELECT ok((pg_temp.row_of('1')).finished_at IS NOT NULL, 'and records when');

SELECT pg_temp.start('1');
SELECT pg_temp.patch('1', '{"state": "running"}');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_bridge_import_cancel('f3150000-0000-0000-0000-0000000000d1', pg_temp.job('1'));
SELECT is((SELECT state FROM public.discord_bridge_import_cancel('f3150000-0000-0000-0000-0000000000d1', pg_temp.job('1'))),
          'cancelled', 'a manager''s second cancel ends a job whose bridge never answered');
SELECT tests.clear_authentication();

-- The stale-job sweep, with no cap on running imports ------------------------------------------------------
SELECT pg_temp.patch('3', '{"state": "running"}');
SELECT pg_temp.cancel('3');
UPDATE public.discord_bridge_imports SET updated_at = now() - interval '11 minutes' WHERE id = pg_temp.job('3');
SELECT pg_temp.start('1');
SELECT pg_temp.patch('1', '{"state": "running"}');
SELECT is((pg_temp.row_of('3')).state, 'cancelled', 'a stale job asked to stop is cancelled when another job starts');

-- Progress keys only into a running job ------------------------------------------------------------------
SELECT pg_temp.patch('2', '{"state": "running"}');
SELECT pg_temp.patch('2', '{"reached_discord_message_id": "3150000000000000900", "reached_at": "2024-01-01T00:00:00Z"}');
SELECT public.bridge_privacy_stop_imports('55555555-0000-0000-0000-000000000005', 'server_purged');
SELECT is((pg_temp.row_of('2')).state || ':' || COALESCE((pg_temp.row_of('2')).reached_discord_message_id, 'none'),
          'failed:none', 'a purge fails the job and resets its cursor');
SELECT throws_ok($q$SELECT pg_temp.patch('2', '{"reached_discord_message_id": "3150000000000000900"}')$q$,
                 '55000', 'import_not_running', 'a cursor reported after the purge is refused');
SELECT throws_ok($q$SELECT pg_temp.patch('2', '{"thread_cursor": {"at": null, "done": []}, "threads_done": 3}')$q$,
                 '55000', 'import_not_running', 'so is thread progress');
SELECT throws_ok($q$SELECT pg_temp.patch('2', '{"authors_skipped": 4}')$q$,
                 '55000', 'import_not_running', 'and a count');
SELECT is((pg_temp.row_of('2')).reached_discord_message_id, NULL, 'the purged cursor stays reset');
SELECT is((pg_temp.patch('2', '{"error": "late"}')).error, 'late', 'an error alone still writes');
SELECT pg_temp.start('2');
SELECT is((pg_temp.patch('2', '{"state": "running", "phase": "threads"}')).phase, 'threads',
          'a patch that starts the job carries progress');

-- The replies phase in pages -----------------------------------------------------------------------------
-- p315d holds, newest first: 105 (reply to 198), 104 (reply to 199), 103, 102, 101, 198, 199. The
-- replies arrive before their targets, so no batch links them.
SELECT pg_temp.start('4');
SELECT pg_temp.patch('4', '{"state": "running"}');
SELECT pg_temp.batch('4', jsonb_build_array(
    pg_temp.msg('3150000000000000101', '2024-01-01T00:00:01Z'),
    pg_temp.msg('3150000000000000102', '2024-01-01T00:00:02Z'),
    pg_temp.msg('3150000000000000103', '2024-01-01T00:00:03Z')));
SELECT pg_temp.batch('4', jsonb_build_array(
    pg_temp.msg('3150000000000000104', '2024-01-01T00:00:04Z', '{"reply_to_discord_message_id": "3150000000000000199"}'),
    pg_temp.msg('3150000000000000105', '2024-01-01T00:00:05Z', '{"reply_to_discord_message_id": "3150000000000000198"}')));
SELECT pg_temp.batch('4', jsonb_build_array(
    pg_temp.msg('3150000000000000199', '2023-12-01T00:00:00Z'),
    pg_temp.msg('3150000000000000198', '2023-12-01T00:00:01Z')));
SELECT pg_temp.patch('4', '{"phase": "replies"}');
SELECT is(pg_temp.page(1), '{"done": false, "linked": 1}'::jsonb, 'a page of one row links the reply in it');
SELECT ok((pg_temp.row_of('4')).replies_cursor IS NOT NULL, 'the page records where it stopped');
SELECT is(pg_temp.page(2), '{"done": false, "linked": 1}'::jsonb, 'the next page goes on below it');
SELECT is((pg_temp.by_did('3150000000000000104')).reply_to, (pg_temp.by_did('3150000000000000199')).id,
          'a reply points at its target');
SELECT is((SELECT array_agg((p ->> 'linked')::int) FROM (SELECT pg_temp.page(2) p FROM generate_series(1, 2)) s),
          ARRAY[0, 0], 'pages of rows that are no replies link nothing');
SELECT is(pg_temp.page(2), '{"done": true, "linked": 0}'::jsonb, 'a short page is the last');
SELECT is((pg_temp.row_of('4')).replies_cursor, NULL, 'and leaves no cursor');
SELECT pg_temp.page(1);
SELECT pg_temp.patch('4', '{"phase": "replies"}');
SELECT is((pg_temp.row_of('4')).replies_cursor, NULL, 'a phase write starts the replies over');
SELECT pg_temp.patch('4', '{"state": "paused"}');
SELECT throws_ok($q$SELECT pg_temp.page(2)$q$, '55000', 'import_not_running', 'a page of a job that is not running is refused');

-- Threads a person deleted ---------------------------------------------------------------------------------
SELECT pg_temp.start('1');
SELECT pg_temp.patch('1', '{"state": "running"}');
CREATE TEMP TABLE t315 AS SELECT pg_temp.thread('3150000000000000301') AS mod, pg_temp.thread('3150000000000000302') AS emptied;
GRANT SELECT ON t315 TO authenticated;
SELECT pg_temp.batch('1', jsonb_build_array(
    pg_temp.msg('3150000000000000311', '2024-03-01T00:00:01Z', jsonb_build_object('thread_id', (SELECT emptied FROM t315)))));
SELECT set_config('harmony.history_import', 'false', true);

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
DELETE FROM public.threads WHERE id = (SELECT mod FROM t315);
SELECT tests.clear_authentication();
SELECT ok(EXISTS (SELECT 1 FROM public.discord_bridge_deleted_threads d
                   WHERE d.bridge_id = 'f3150000-0000-0000-0000-0000000000d1' AND d.discord_thread_id = '3150000000000000301'),
          'a moderator''s delete of a bridged thread is recorded');
SELECT throws_ok($q$SELECT pg_temp.thread('3150000000000000301')$q$, '55000', 'thread_deleted',
                 'the next import does not bring it back');

UPDATE public.messages SET is_deleted = true WHERE id = (pg_temp.by_did('3150000000000000311')).id;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = (SELECT emptied FROM t315)),
          'a thread emptied of its messages is deleted');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.discord_bridge_deleted_threads d WHERE d.discord_thread_id = '3150000000000000302'),
          'and not recorded');
SELECT isnt(pg_temp.thread('3150000000000000302'), NULL, 'so the next import builds it again');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f3150000-0000-0000-0000-000000000009', '55555555-0000-0000-0000-000000000005', 'p315gone', 0);
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f3150000-0000-0000-0000-0000000000d1', 'f3150000-0000-0000-0000-000000000009', '3150000000000000009', 'both');
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f3150000-0000-0000-0000-0000000000e9', 'f3150000-0000-0000-0000-000000000009', '11111111-0000-0000-0000-000000000001',
   '[{"type": "text", "text": "starter"}]');
INSERT INTO public.threads (id, channel_id, parent_message_id, name) VALUES
  ('f3150000-0000-0000-0000-0000000000a9', 'f3150000-0000-0000-0000-000000000009', 'f3150000-0000-0000-0000-0000000000e9', 'doomed');
INSERT INTO public.discord_bridge_threads (thread_id, bridge_id, discord_thread_id) VALUES
  ('f3150000-0000-0000-0000-0000000000a9', 'f3150000-0000-0000-0000-0000000000d1', '3150000000000000309');
DELETE FROM public.channels WHERE id = 'f3150000-0000-0000-0000-000000000009';
SELECT ok(NOT EXISTS (SELECT 1 FROM public.discord_bridge_deleted_threads d WHERE d.discord_thread_id = '3150000000000000309'),
          'a channel''s deletion records none of its threads');

-- A purge drops the thread pairs ---------------------------------------------------------------------------
SELECT ok(EXISTS (SELECT 1 FROM public.discord_bridge_threads bt WHERE bt.bridge_id = 'f3150000-0000-0000-0000-0000000000d1'),
          'the bridge has thread pairs');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.bridge_privacy_purge_server('55555555-0000-0000-0000-000000000005', 'discord');
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM public.discord_bridge_threads bt WHERE bt.bridge_id = 'f3150000-0000-0000-0000-0000000000d1'),
          'a purge drops them, for a re-import to build each thread on its re-imported starter');

-- Grants -----------------------------------------------------------------------------------------------------
SELECT ok(has_function_privilege('service_role', 'public.bridge_import_link_replies_page(uuid, uuid, integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_import_link_replies_page(uuid, uuid, integer)', 'EXECUTE'),
          'the page is the service role''s');
SELECT ok(NOT has_table_privilege('authenticated', 'public.discord_bridge_deleted_threads', 'SELECT')
          AND has_table_privilege('service_role', 'public.discord_bridge_deleted_threads', 'SELECT'),
          'deleted threads are the service role''s');

SELECT * FROM finish();
ROLLBACK;
