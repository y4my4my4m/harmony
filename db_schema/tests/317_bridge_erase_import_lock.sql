-- bridge_privacy_erase_core after 20261123200003_bridge_erase_import_lock.sql: the threads a purge
-- empties take their notices and erased starters with them, and the import job's requester is
-- still cleared. The job row taken with SKIP LOCKED needs a second session; the report of the
-- change carries that reproduction.
--
-- Fixture server_1 (alice owns, bob is a member) with #general. Added: bridge317 run by bot317
-- pairing #general with Discord ...01, its import started on Discord by dana (...9001). Imported:
--   T1  standalone, one reply by dana
--   T2  on dana's 702, one reply by dana
--   T3  on dana's 703, one reply by dana and one by bob

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(10);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f3170000-0000-0000-0000-0000000000b1', 'bot317', 'Bot 317', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f3170000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f3170000-0000-0000-0000-0000000000b1', '900000000000000317', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f3170000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '3170000000000000001', 'both');

UPDATE public.instance_config SET config_value = '"self_run"'::jsonb WHERE config_key = 'bridge_history_import';
UPDATE public.instance_config SET config_value = '0'::jsonb
 WHERE config_key IN ('bridge_import_max_running', 'bridge_import_messages_per_minute');

SELECT count(*) FROM public.discord_bridge_import_start_internal('f3170000-0000-0000-0000-0000000000d1', NULL, 'discord', NULL,
    '{"id": "3170000000000009001", "username": "dana"}'::jsonb);
CREATE FUNCTION pg_temp.job() RETURNS uuid LANGUAGE sql AS
$fn$ SELECT i.id FROM public.discord_bridge_imports i WHERE i.bridge_id = 'f3170000-0000-0000-0000-0000000000d1' $fn$;
SELECT public.discord_bridge_import_update('f3170000-0000-0000-0000-0000000000d1', pg_temp.job(), '{"state": "running"}');

CREATE FUNCTION pg_temp.msg(p_did text, p_thread uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT jsonb_strip_nulls(jsonb_build_object('discord_message_id', p_did, 'created_at', '2024-01-01T00:00:00Z',
           'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'hello ' || p_did)),
           'discord_user', jsonb_build_object('id', '3170000000000009001', 'username', 'dana'),
           'thread_id', p_thread)) $fn$;
CREATE FUNCTION pg_temp.batch(p_messages jsonb) RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT public.bridge_import_messages('f3170000-0000-0000-0000-0000000000b1', pg_temp.job(), p_messages) $fn$;
CREATE FUNCTION pg_temp.thread(p_did text, p_starter text) RETURNS uuid LANGUAGE sql AS
$fn$ SELECT public.bridge_import_thread('f3170000-0000-0000-0000-0000000000b1', pg_temp.job(), jsonb_strip_nulls(jsonb_build_object(
         'discord_thread_id', p_did, 'name', 'topic ' || p_did, 'created_at', '2024-01-02T00:00:00Z',
         'starter_discord_message_id', p_starter,
         'discord_user', jsonb_build_object('id', '3170000000000009001', 'username', 'dana')))) $fn$;
CREATE FUNCTION pg_temp.notices(p_thread uuid) RETURNS bigint LANGUAGE sql AS
$fn$ SELECT count(*) FROM public.messages m
      WHERE m.metadata ->> 'type' = 'thread_created' AND m.metadata ->> 'thread_id' = p_thread::text $fn$;

SELECT pg_temp.batch(jsonb_build_array(pg_temp.msg('3170000000000000702'), pg_temp.msg('3170000000000000703')));
CREATE TEMP TABLE t317 AS
SELECT pg_temp.thread('3170000000000000801', NULL) AS t1,
       pg_temp.thread('3170000000000000702', '3170000000000000702') AS t2,
       pg_temp.thread('3170000000000000703', '3170000000000000703') AS t3;
SELECT pg_temp.batch(jsonb_build_array(
    pg_temp.msg('3170000000000000711', (SELECT t1 FROM t317)),
    pg_temp.msg('3170000000000000712', (SELECT t2 FROM t317)),
    pg_temp.msg('3170000000000000713', (SELECT t3 FROM t317))));
SELECT set_config('harmony.history_import', 'false', true);
INSERT INTO public.messages (channel_id, thread_id, user_id, content)
SELECT '66666666-0000-0000-0000-000000000006', t3, '22222222-0000-0000-0000-000000000002', '[{"type": "text", "text": "bob in T3"}]'
  FROM t317;
CREATE TEMP TABLE p317 AS
SELECT (SELECT t.parent_message_id FROM public.threads t WHERE t.id = t1) AS p1,
       (SELECT t.parent_message_id FROM public.threads t WHERE t.id = t2) AS p2,
       (SELECT t.parent_message_id FROM public.threads t WHERE t.id = t3) AS p3
  FROM t317;
GRANT SELECT ON t317, p317 TO authenticated;

-- Erasing the member who started the import clears the job's requester.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE FUNCTION pg_temp.purge() RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
    r jsonb;
BEGIN
    FOR i IN 1..10 LOOP
        r := public.bridge_privacy_purge_server('55555555-0000-0000-0000-000000000005', 'discord');
        EXIT WHEN NOT (r ->> 'more')::boolean;
    END LOOP;
    RETURN r;
END;
$fn$;
SELECT is(pg_temp.purge() ->> 'more', 'false', 'the purge runs to its end');
SELECT tests.clear_authentication();

SELECT is((SELECT requested_by_remote FROM public.discord_bridge_imports WHERE id = pg_temp.job()), NULL,
          'the job keeps no Discord requester');

-- Emptied threads -------------------------------------------------------------------------------------
SELECT ok(NOT EXISTS (SELECT 1 FROM public.threads WHERE id = (SELECT t1 FROM t317)), 'a standalone thread emptied by the purge is gone');
SELECT is(pg_temp.notices((SELECT t1 FROM t317)), 0::bigint, 'with its notice');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.threads WHERE id = (SELECT t2 FROM t317)), 'a thread on an erased message emptied by the purge is gone');
SELECT is(pg_temp.notices((SELECT t2 FROM t317)), 0::bigint, 'with its notice');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.messages WHERE id = (SELECT p2 FROM p317)), 'and the erased starter kept for it');

SELECT ok(EXISTS (SELECT 1 FROM public.threads WHERE id = (SELECT t3 FROM t317) AND name = 'Thread'),
          'a thread a Harmony member wrote in stays, renamed');
SELECT is(pg_temp.notices((SELECT t3 FROM t317)), 1::bigint, 'with its notice');
SELECT ok(EXISTS (SELECT 1 FROM public.messages m WHERE m.id = (SELECT p3 FROM p317)
                   AND m.is_deleted AND m.metadata ->> 'bridge_erased' = 'true'),
          'on its erased starter');

SELECT * FROM finish();
ROLLBACK;
