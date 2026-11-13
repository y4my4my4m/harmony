-- History import limits after 20261112700001_bridge_import_limits.sql.
--
-- Fixture server_1 (alice owns and is the instance admin, bob is a member) with #general. Added:
-- bridge282 (mode self) run by bot282 with the pairs
--   A  #general  Discord ...01
--   B  p282b     Discord ...02
-- and an AutoMod keyword rule that blocks "badword".

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(51);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f2820000-0000-0000-0000-0000000000b1', 'bot282', 'Bot 282', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2820000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'p282b', 0);
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f2820000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f2820000-0000-0000-0000-0000000000b1', '900000000000000282', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f2820000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '2820000000000000001', 'both'),
  ('f2820000-0000-0000-0000-0000000000d1', 'f2820000-0000-0000-0000-000000000002', '2820000000000000002', 'both');

CREATE FUNCTION pg_temp.setting(p_key text, p_value jsonb) RETURNS void LANGUAGE sql AS
$fn$ UPDATE public.instance_config SET config_value = p_value WHERE config_key = p_key $fn$;
CREATE FUNCTION pg_temp.job(p_k text) RETURNS uuid LANGUAGE sql AS
$fn$ SELECT i.id FROM public.discord_bridge_imports i
      WHERE i.bridge_id = 'f2820000-0000-0000-0000-0000000000d1' AND right(i.discord_channel_id, 1) = p_k $fn$;
CREATE FUNCTION pg_temp.row_of(p_k text) RETURNS public.discord_bridge_imports LANGUAGE sql AS
$fn$ SELECT i FROM public.discord_bridge_imports i WHERE i.id = pg_temp.job(p_k) $fn$;
CREATE FUNCTION pg_temp.patch(p_k text, p_patch jsonb) RETURNS public.discord_bridge_imports LANGUAGE sql AS
$fn$ SELECT public.discord_bridge_import_update('f2820000-0000-0000-0000-0000000000d1', pg_temp.job(p_k), p_patch) $fn$;
CREATE FUNCTION pg_temp.msg(p_did text, p_created text, p_extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT jsonb_build_object('discord_message_id', p_did, 'created_at', p_created,
           'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'hello ' || p_did)),
           'discord_user', jsonb_build_object('id', '2820000000000009001', 'username', 'dana')) || p_extra $fn$;
CREATE FUNCTION pg_temp.send(p_k text, p_msgs jsonb) RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT public.bridge_import_messages('f2820000-0000-0000-0000-0000000000b1', pg_temp.job(p_k), p_msgs) $fn$;

-- Settings and the switch ---------------------------------------------------------------------------
SELECT is((SELECT jsonb_object_agg(config_key, config_value) FROM public.instance_config
            WHERE config_key IN ('bridge_history_import', 'bridge_import_max_running', 'bridge_import_messages_per_minute')),
          '{"bridge_history_import": "off", "bridge_import_max_running": 1, "bridge_import_messages_per_minute": 600}'::jsonb,
          'import is off by default; one import at a time, 600 messages a minute');
SELECT ok('bridge_history_import' = ANY (public.public_instance_config_keys()), 'the switch is a public setting');
SELECT is(public.discord_bridge_import_block('f2820000-0000-0000-0000-0000000000d1'), 'instance_off',
          'off: the bridge may not import');
SELECT throws_ok($q$SELECT public.discord_bridge_import_start_internal('f2820000-0000-0000-0000-0000000000d1', NULL, 'discord', NULL)$q$,
                 '0A000', 'import_disabled', 'off: the gateway start is refused');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.discord_bridge_import_start('f2820000-0000-0000-0000-0000000000d1')$q$,
                 '0A000', 'import_disabled', 'off: the app start is refused');
SELECT tests.clear_authentication();

SELECT pg_temp.setting('bridge_history_import', '"self_run"');
SELECT is(public.discord_bridge_import_block('f2820000-0000-0000-0000-0000000000d1'), NULL,
          'self_run: a bridge of mode self may import');
UPDATE public.discord_bridges SET mode = 'hosted' WHERE id = 'f2820000-0000-0000-0000-0000000000d1';
SELECT is(public.discord_bridge_import_block('f2820000-0000-0000-0000-0000000000d1'), 'bridge_mode',
          'self_run: a hosted bridge may not');
UPDATE public.discord_bridges SET mode = 'instance' WHERE id = 'f2820000-0000-0000-0000-0000000000d1';
SELECT is(public.discord_bridge_import_block('f2820000-0000-0000-0000-0000000000d1'), 'bridge_mode',
          'self_run: the instance bot may not');
SELECT throws_ok($q$SELECT public.discord_bridge_import_start_internal('f2820000-0000-0000-0000-0000000000d1', NULL, 'discord', NULL)$q$,
                 '0A000', 'import_disabled', 'and its start is refused');
UPDATE public.discord_bridges SET mode = 'self' WHERE id = 'f2820000-0000-0000-0000-0000000000d1';

-- Start: the requester -------------------------------------------------------------------------------
SELECT is((SELECT count(*) FROM public.discord_bridge_import_start_internal(
               'f2820000-0000-0000-0000-0000000000d1', NULL, 'discord', NULL,
               jsonb_build_object('id', '2820000000000009009', 'username', E'mod\nerator', 'extra', 'x'))),
          2::bigint, 'a start from Discord queues both pairs');
SELECT is((pg_temp.row_of('1')).requested_by_remote, '{"id": "2820000000000009009", "username": "mod erator"}'::jsonb,
          'the Discord requester is stored: id and name, control characters out');
SELECT pg_temp.patch('1', '{"state": "running"}');
SELECT pg_temp.patch('1', '{"state": "failed", "error": "x"}');
SELECT count(*) FROM public.discord_bridge_import_start_internal(
    'f2820000-0000-0000-0000-0000000000d1', ARRAY['2820000000000000001'], 'discord', NULL, '{"id": "not-an-id"}');
SELECT is((pg_temp.row_of('1')).requested_by_remote, NULL, 'a requester without a Discord id is not stored');

-- Running cap -----------------------------------------------------------------------------------------
SELECT is((pg_temp.patch('1', '{"state": "running"}')).state, 'running', 'the first job runs');
SELECT throws_ok($q$SELECT pg_temp.patch('2', '{"state": "running"}')$q$,
                 '53400', 'import_busy', 'cap 1: a second job is refused');
SELECT is((pg_temp.row_of('2')).state, 'queued', 'and stays queued');
SELECT is((pg_temp.patch('1', '{"state": "running"}')).state, 'running', 'the running job patches running again');
UPDATE public.discord_bridge_imports SET updated_at = now() - interval '11 minutes' WHERE id = pg_temp.job('1');
SELECT is((pg_temp.patch('2', '{"state": "running"}')).state, 'running',
          'a running job silent for over 10 minutes gives its slot away');
SELECT is((pg_temp.row_of('1')).state, 'paused', 'and is paused');
SELECT throws_ok($q$SELECT pg_temp.patch('1', '{"state": "running"}')$q$,
                 '53400', 'import_busy', 'it waits for the slot in turn');
SELECT pg_temp.setting('bridge_import_max_running', '0');
SELECT is((pg_temp.patch('1', '{"state": "running"}')).state, 'running', 'cap 0: no limit');

-- Patch keys --------------------------------------------------------------------------------------------
SELECT is((pg_temp.patch('1', '{"authors_skipped": 7}')).authors_skipped, 7, 'authors_skipped is a patch key');
SELECT is(char_length((pg_temp.patch('1', jsonb_build_object('error', repeat('e', 500)))).error), 200,
          'an error is cut to 200 characters');
SELECT throws_ok($q$SELECT pg_temp.patch('1', '{"imported_count": 5}')$q$,
                 '22023', 'invalid_patch', 'a counter of the server is not a patch key');

-- Rate ----------------------------------------------------------------------------------------------------
SELECT pg_temp.setting('bridge_import_messages_per_minute', '5');
SELECT is(public.bridge_import_admit('f2820000-0000-0000-0000-0000000000b1', pg_temp.job('1'), 3),
          '{"admitted": true}'::jsonb, 'rate 5: three are admitted');
CREATE TEMP TABLE a282 AS
SELECT public.bridge_import_admit('f2820000-0000-0000-0000-0000000000b1', pg_temp.job('1'), 3) AS j;
SELECT is((SELECT j -> 'admitted' FROM a282), 'false'::jsonb, 'three more are not');
SELECT ok((SELECT (j ->> 'retry_after')::integer BETWEEN 1 AND 60 FROM a282), 'with the seconds left of the minute');
SELECT is(public.bridge_import_admit('f2820000-0000-0000-0000-0000000000b1', pg_temp.job('1'), 2),
          '{"admitted": true}'::jsonb, 'two fit');
UPDATE public.discord_bridge_imports SET rate_window_start = now() - interval '61 seconds' WHERE id = pg_temp.job('1');
SELECT is(public.bridge_import_admit('f2820000-0000-0000-0000-0000000000b1', pg_temp.job('1'), 100),
          '{"admitted": true}'::jsonb, 'a new minute admits its first batch whatever its size');
SELECT is(public.bridge_import_admit('f2820000-0000-0000-0000-0000000000b1', pg_temp.job('1'), 1) -> 'admitted',
          'false'::jsonb, 'and nothing after it');
SELECT pg_temp.setting('bridge_import_messages_per_minute', '0');
SELECT is(public.bridge_import_admit('f2820000-0000-0000-0000-0000000000b1', pg_temp.job('1'), 100),
          '{"admitted": true}'::jsonb, 'rate 0: no limit');
SELECT throws_ok($q$SELECT public.bridge_import_admit('f2820000-0000-0000-0000-0000000000b1', gen_random_uuid(), 1)$q$,
                 'P0002', 'import_not_found', 'an unknown job: import_not_found');

-- Refusals per message ----------------------------------------------------------------------------------
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2820000000000009002', true);
CREATE TEMP TABLE b282 AS
SELECT pg_temp.send('1', jsonb_build_array(
    pg_temp.msg('2820000000000010001', '2020-01-01T10:00:00Z'),
    pg_temp.msg('2820000000000010002', (now() + interval '2 hours')::text),
    pg_temp.msg('2820000000000010003', '2020-01-01T10:00:02Z', jsonb_build_object('edited_at', (now() + interval '1 day')::text)),
    pg_temp.msg('2820000000000010004', '2020-01-01T10:00:03Z', '{"content": "text"}'),
    pg_temp.msg('2820000000000010005', 'yesterday at noon-ish'),
    pg_temp.msg('2820000000000010006', '2020-01-01T10:00:05Z', '{"discord_user": {"id": "2820000000000009002", "username": "eve"}}'),
    '{"content": []}'::jsonb,
    pg_temp.msg('2820000000000010007', '2020-01-01T10:00:06Z'))) AS j;
SELECT is((SELECT jsonb_agg(e ->> 'discord_message_id' ORDER BY e ->> 'discord_message_id') FROM b282, jsonb_array_elements(j -> 'inserted') e),
          '["2820000000000010001", "2820000000000010007"]'::jsonb, 'the two good messages of the batch are stored');
SELECT is((SELECT jsonb_object_agg(e ->> 'discord_message_id', e ->> 'reason') FROM b282, jsonb_array_elements(j -> 'rejected') e),
          '{"2820000000000010002": "future_date", "2820000000000010003": "future_date", "2820000000000010004": "invalid",
            "2820000000000010005": "invalid", "2820000000000010006": "opted_out"}'::jsonb,
          'each bad one is rejected alone: a future date, a future edit, content that is no array, a date that is no date, an opted-out author');
SELECT is((SELECT jsonb_array_length(j -> 'skipped') FROM b282), 5, 'every rejected id is also skipped; the entry without an id is answered nowhere');
SELECT is((pg_temp.row_of('1')).imported_count, 2, 'two counted as imported');
SELECT is((SELECT count(*) FROM public.messages WHERE metadata ->> 'discord_message_id' LIKE '28200000000000100%'
              AND created_at > now()), 0::bigint, 'no row is dated in the future');

-- AutoMod ---------------------------------------------------------------------------------------------------
INSERT INTO public.server_automod_settings (server_id, enabled, exempt_bots)
VALUES ('55555555-0000-0000-0000-000000000005', true, false)
ON CONFLICT (server_id) DO UPDATE SET enabled = true, exempt_bots = false;
INSERT INTO public.server_automod_rules (server_id, name, rule_type, enabled, config, actions, position)
VALUES ('55555555-0000-0000-0000-000000000005', 'No badword', 'keyword', true,
        public.automod_canonical_config('keyword', '{"keywords": ["badword"]}'::jsonb),
        public.automod_canonical_actions('{"block": true}'::jsonb), 1),
       ('55555555-0000-0000-0000-000000000005', 'Watch word', 'keyword', true,
        public.automod_canonical_config('keyword', '{"keywords": ["watchword"]}'::jsonb),
        public.automod_canonical_actions('{"block": false, "alert": true}'::jsonb), 2);
CREATE FUNCTION pg_temp.said(p_did text, p_text text) RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT pg_temp.msg(p_did, '2020-01-02T10:00:00Z',
         jsonb_build_object('content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text)))) $fn$;
CREATE TEMP TABLE c282 AS
SELECT pg_temp.send('1', jsonb_build_array(
    pg_temp.said('2820000000000020001', 'a badword here'),
    pg_temp.said('2820000000000020002', 'a watchword here'),
    pg_temp.said('2820000000000020003', 'nothing here'))) AS j;
SELECT is((SELECT j -> 'rejected' FROM c282),
          '[{"reason": "automod", "discord_message_id": "2820000000000020001"}]'::jsonb,
          'bots not exempt: a blocking keyword rule refuses the message; an alert-only rule does not');
SELECT is((pg_temp.row_of('1')).automod_skipped, 1, 'counted in automod_skipped');
SELECT is((SELECT count(*) FROM public.automod_events WHERE server_id = '55555555-0000-0000-0000-000000000005'),
          0::bigint, 'no AutoMod event is recorded for imported history');
UPDATE public.server_automod_settings SET exempt_bots = true WHERE server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.send('1', jsonb_build_array(pg_temp.said('2820000000000020004', 'a badword here'))) -> 'rejected',
          '[]'::jsonb, 'bots exempt: content rules do not apply, as for a live relayed message');

-- Threads -----------------------------------------------------------------------------------------------------
CREATE TEMP TABLE t282 AS
SELECT public.bridge_import_thread('f2820000-0000-0000-0000-0000000000b1', pg_temp.job('1'), jsonb_build_object(
           'discord_thread_id', '2820000000000030001', 'name', 'later', 'created_at', (now() + interval '3 days')::text,
           'discord_user', jsonb_build_object('id', '2820000000000009002', 'username', 'eve'))) AS id;
SELECT ok((SELECT t.created_at <= now() FROM public.threads t WHERE t.id = (SELECT id FROM t282)),
          'a thread dated in the future is created now');
SELECT is((SELECT m.metadata ? 'discord_user' FROM public.messages m
            WHERE m.is_system AND m.metadata ->> 'thread_id' = (SELECT id::text FROM t282)),
          false, 'the notice does not name an opted-out starter');

-- The switch goes off under a running job ------------------------------------------------------------------------
SELECT pg_temp.setting('bridge_history_import', '"off"');
SELECT is(pg_temp.send('1', jsonb_build_array(pg_temp.msg('2820000000000040001', '2020-01-03T10:00:00Z'))) - 'inserted' - 'skipped' - 'rejected',
          '{"not_running": true, "state": "failed", "error": "import_disabled"}'::jsonb,
          'off under a running job: the next batch stores nothing and the job fails with import_disabled');
SELECT is(public.bridge_import_admit('f2820000-0000-0000-0000-0000000000b1', pg_temp.job('2'), 1) - 'admitted',
          '{"not_running": true, "state": "failed", "error": "import_disabled"}'::jsonb, 'admit says the same for the other job');
SELECT throws_ok($q$SELECT pg_temp.patch('1', '{"state": "running"}')$q$,
                 '55000', 'invalid_transition', 'a failed job does not run again by patch');
SELECT pg_temp.setting('bridge_history_import', '"self_run"');

-- A new run clears the run's counters ------------------------------------------------------------------------------
UPDATE public.discord_bridge_imports SET state = 'done', authors_skipped = 3, automod_skipped = 2 WHERE id = pg_temp.job('2');
SELECT count(*) FROM public.discord_bridge_import_start_internal(
    'f2820000-0000-0000-0000-0000000000d1', ARRAY['2820000000000000002'], 'harmony', NULL);
SELECT is((SELECT (state, authors_skipped, automod_skipped)::text FROM public.discord_bridge_imports WHERE id = pg_temp.job('2')),
          '(queued,0,0)', 'a finished job started again has its counters at zero');

-- Status and grants ---------------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.bridge_import_status()$q$, '42501', NULL, 'a member cannot read the totals');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_import_status(), '{"running": 0, "queued": 1, "imported": 5}'::jsonb, 'an admin reads them');
SELECT tests.clear_authentication();
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_import_admit(uuid, uuid, integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.discord_bridge_import_block(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.discord_bridge_import_start_internal(uuid, text[], text, uuid, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.bridge_import_status()', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_import_admit(uuid, uuid, integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.discord_bridge_import_block(uuid)', 'EXECUTE'),
          'the gateway functions are for the service role alone');
SELECT ok(NOT has_function_privilege('service_role', 'public.bridge_import_automod_hit(jsonb, uuid, uuid, uuid, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.bridge_import_automod_hit(jsonb, uuid, uuid, uuid, jsonb)', 'EXECUTE'),
          'no role calls the AutoMod matcher');
SELECT is((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'discord_bridge_import_start_internal'),
          1::bigint, 'one start function: the four-argument one is gone');

SELECT * FROM finish();
ROLLBACK;
