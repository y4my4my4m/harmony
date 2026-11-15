-- Discord history import jobs, after 20261110900003_discord_bridge_imports.sql.
--
-- Fixture server_1 (alice owns, bob is a member) with #general. Added: bridge247 with four pairs
--   #general                both         Discord ...01   importable
--   p247b                   to_harmony   Discord ...02   importable
--   p247c                   to_discord   Discord ...03   not importable
--   p247d                   both         Discord ...04   not importable: end-to-end encrypted

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(29);

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2470000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'p247b', 0),
  ('f2470000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'p247c', 0),
  ('f2470000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'p247d', 0);

INSERT INTO public.discord_bridges (id, server_id, mode, discord_guild_id, created_by)
VALUES ('f2470000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        '900000000000000247', '11111111-0000-0000-0000-000000000001');

-- 20261112700001: the instance switch is on and its caps are off; 282 covers both.
UPDATE public.instance_config SET config_value = '"self_run"'::jsonb WHERE config_key = 'bridge_history_import';
UPDATE public.instance_config SET config_value = '0'::jsonb
 WHERE config_key IN ('bridge_import_max_running', 'bridge_import_messages_per_minute');

INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f2470000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '2470000000000000001', 'both'),
  ('f2470000-0000-0000-0000-0000000000d1', 'f2470000-0000-0000-0000-000000000002', '2470000000000000002', 'to_harmony'),
  ('f2470000-0000-0000-0000-0000000000d1', 'f2470000-0000-0000-0000-000000000003', '2470000000000000003', 'to_discord'),
  ('f2470000-0000-0000-0000-0000000000d1', 'f2470000-0000-0000-0000-000000000004', '2470000000000000004', 'both');

INSERT INTO public.server_encryption_settings (server_id, encryption_mode)
VALUES ('55555555-0000-0000-0000-000000000005', 'optional')
ON CONFLICT (server_id) DO UPDATE SET encryption_mode = 'optional';
INSERT INTO public.channel_encryption_settings (channel_id, messages_encrypted)
VALUES ('f2470000-0000-0000-0000-000000000004', true)
ON CONFLICT (channel_id) DO UPDATE SET messages_encrypted = true;

-- Start ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE TEMP TABLE r247 AS
SELECT * FROM public.discord_bridge_import_start('f2470000-0000-0000-0000-0000000000d1');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM r247), 2, 'a manager''s start with no channels queues the two importable pairs');
SELECT is((SELECT array_agg(discord_channel_id ORDER BY discord_channel_id) FROM public.discord_bridge_imports
            WHERE bridge_id = 'f2470000-0000-0000-0000-0000000000d1'),
          ARRAY['2470000000000000001', '2470000000000000002'],
          'a to_discord pair and an encrypted channel get no job');
SELECT ok((SELECT bool_and(state = 'queued' AND phase = 'messages' AND requested_via = 'harmony'
                           AND requested_by = '11111111-0000-0000-0000-000000000001')
             FROM r247),
          'new jobs are queued, in the messages phase, requested via harmony by the caller');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT * FROM public.discord_bridge_import_start('f2470000-0000-0000-0000-0000000000d1')$q$,
                 '42501', NULL, 'a member without MANAGE_SERVER cannot start an import');
SELECT throws_ok($q$SELECT * FROM public.discord_bridge_import_cancel('f2470000-0000-0000-0000-0000000000d1')$q$,
                 '42501', NULL, 'a member without MANAGE_SERVER cannot cancel an import');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_imports), 0, 'a non-manager reads no import rows');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_imports), 2, 'a manager reads the bridge''s import rows');
SELECT throws_ok($q$SELECT * FROM public.discord_bridge_import_start('f2470000-0000-0000-0000-0000000000d1',
                        ARRAY['f2470000-0000-0000-0000-000000000003']::uuid[])$q$,
                 '22023', 'pair_not_importable', 'a to_discord pair named explicitly raises pair_not_importable');
SELECT throws_ok($q$SELECT * FROM public.discord_bridge_import_start('f2470000-0000-0000-0000-0000000000d1',
                        ARRAY['f2470000-0000-0000-0000-000000000004']::uuid[])$q$,
                 '22023', 'pair_not_importable', 'an encrypted channel named explicitly raises pair_not_importable');
SELECT throws_ok($q$SELECT * FROM public.discord_bridge_import_start('f2470000-0000-0000-0000-0000000000d1',
                        ARRAY['f2470000-0000-0000-0000-0000000000ff']::uuid[])$q$,
                 '22023', 'pair_not_importable', 'an unpaired channel named explicitly raises pair_not_importable');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_import_start('f2470000-0000-0000-0000-0000000000d1', '{}'::uuid[])),
          0, 'starting an empty channel list queues nothing');
SELECT tests.clear_authentication();

-- Restart rules ----------------------------------------------------------------------------------
UPDATE public.discord_bridge_imports
   SET state = 'failed', reached_discord_message_id = '2470000000000009001', imported_count = 7,
       error = 'boom', cancel_requested = true, finished_at = now()
 WHERE harmony_channel_id = '66666666-0000-0000-0000-000000000006';
UPDATE public.discord_bridge_imports
   SET state = 'done', reached_discord_message_id = '2470000000000009002', imported_count = 9,
       threads_done = 3, thread_cursor = '{"a":1}', phase = 'replies', finished_at = now()
 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002';

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE TEMP TABLE r247b AS
SELECT * FROM public.discord_bridge_import_start('f2470000-0000-0000-0000-0000000000d1');
SELECT tests.clear_authentication();

SELECT is((SELECT reached_discord_message_id FROM r247b WHERE harmony_channel_id = '66666666-0000-0000-0000-000000000006'),
          '2470000000000009001', 'starting a failed job keeps its cursor');
SELECT ok((SELECT state = 'queued' AND error IS NULL AND NOT cancel_requested AND finished_at IS NULL
                  AND imported_count = 7
             FROM r247b WHERE harmony_channel_id = '66666666-0000-0000-0000-000000000006'),
          'it is queued again, with error, cancel_requested and finished_at cleared');
SELECT ok((SELECT state = 'queued' AND reached_discord_message_id IS NULL AND imported_count = 0
                  AND threads_done = 0 AND thread_cursor IS NULL AND phase = 'messages' AND finished_at IS NULL
             FROM r247b WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002'),
          'starting a done job resets its cursors and counters');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_imports), 2, 'jobs are reused: one row per pair');

UPDATE public.discord_bridge_imports SET state = 'running', imported_count = 4
 WHERE harmony_channel_id = '66666666-0000-0000-0000-000000000006';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT state || ':' || imported_count FROM public.discord_bridge_import_start(
              'f2470000-0000-0000-0000-0000000000d1', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])),
          'running:4', 'starting a running job leaves it unchanged');
SELECT tests.clear_authentication();

-- A pair redirected to another Discord channel restarts from scratch.
UPDATE public.discord_bridge_imports
   SET state = 'paused', reached_discord_message_id = '2470000000000009003'
 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002';
UPDATE public.discord_bridge_channels SET discord_channel_id = '2470000000000000012'
 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok((SELECT state = 'queued' AND reached_discord_message_id IS NULL AND discord_channel_id = '2470000000000000012'
             FROM public.discord_bridge_import_start('f2470000-0000-0000-0000-0000000000d1',
                  ARRAY['f2470000-0000-0000-0000-000000000002']::uuid[])),
          'a changed Discord channel resets the job as for done');
SELECT tests.clear_authentication();

-- Cancel -----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok((SELECT state = 'cancelled' AND finished_at IS NOT NULL
             FROM public.discord_bridge_import_cancel('f2470000-0000-0000-0000-0000000000d1',
                  (SELECT id FROM public.discord_bridge_imports
                    WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002'))),
          'cancelling a queued job cancels it and sets finished_at');
SELECT ok((SELECT state = 'running' AND cancel_requested AND finished_at IS NULL
             FROM public.discord_bridge_import_cancel('f2470000-0000-0000-0000-0000000000d1',
                  (SELECT id FROM public.discord_bridge_imports
                    WHERE harmony_channel_id = '66666666-0000-0000-0000-000000000006'))),
          'cancelling a running job sets cancel_requested and leaves the state');
SELECT is((SELECT count(*)::int FROM public.discord_bridge_import_cancel('f2470000-0000-0000-0000-0000000000d1')),
          1, 'cancel with no id touches the live jobs only (the running one, again)');
SELECT tests.clear_authentication();

-- Update (the gateway functions run as the owner here; their grants are checked last) ----------
UPDATE public.discord_bridge_imports SET state = 'queued', cancel_requested = false, finished_at = NULL
 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002';
CREATE TEMP TABLE i247 AS
SELECT harmony_channel_id, id FROM public.discord_bridge_imports;

SELECT throws_ok($q$SELECT public.discord_bridge_import_update('f2470000-0000-0000-0000-0000000000d1',
                        (SELECT id FROM i247 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002'),
                        '{"state":"done"}')$q$,
                 '55000', 'invalid_transition', 'queued to done is an invalid transition');
SELECT throws_ok($q$SELECT public.discord_bridge_import_update('f2470000-0000-0000-0000-0000000000d1',
                        (SELECT id FROM i247 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002'),
                        '{"imported_count": 5}')$q$,
                 '22023', 'invalid_patch', 'an unknown patch key is refused');
SELECT throws_ok($q$SELECT public.discord_bridge_import_update('f2470000-0000-0000-0000-0000000000d1',
                        '00000000-0000-0000-0000-000000000000', '{"phase":"threads"}')$q$,
                 'P0002', 'import_not_found', 'an unknown job is not found');
SELECT ok((SELECT state = 'running' AND start_discord_message_id = '2470000000000005000'
                  AND thread_cursor = '{"after":"7"}' AND finished_at IS NULL
             FROM public.discord_bridge_import_update('f2470000-0000-0000-0000-0000000000d1',
                  (SELECT id FROM i247 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002'),
                  '{"state":"running","start_discord_message_id":"2470000000000005000","thread_cursor":{"after":"7"}}')),
          'queued to running applies the cursors in the patch');
SELECT ok((SELECT state = 'running' AND thread_cursor = '{"after":"9"}'
             FROM public.discord_bridge_import_update('f2470000-0000-0000-0000-0000000000d1',
                  (SELECT id FROM i247 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002'),
                  '{"state":"running","thread_cursor":{"after":"9"}}')),
          'running to running is a no-op for the state and the other keys still apply');
SELECT throws_ok($q$SELECT public.discord_bridge_import_update('f2470000-0000-0000-0000-0000000000d1',
                        (SELECT id FROM i247 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002'),
                        '{"state":"cancelled"}')$q$,
                 '55000', 'invalid_transition', 'running to cancelled needs cancel_requested');
SELECT ok((SELECT state = 'running' AND cancel_requested
             FROM public.discord_bridge_import_cancel_internal('f2470000-0000-0000-0000-0000000000d1',
                  (SELECT id FROM i247 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002'))),
          'the service-role cancel marks a running job');
SELECT ok((SELECT state = 'cancelled' AND finished_at IS NOT NULL AND thread_cursor IS NULL
             FROM public.discord_bridge_import_update('f2470000-0000-0000-0000-0000000000d1',
                  (SELECT id FROM i247 WHERE harmony_channel_id = 'f2470000-0000-0000-0000-000000000002'),
                  '{"state":"cancelled","thread_cursor":null}')),
          'running to cancelled once cancel_requested; finished_at set and a null clears a cursor');

SELECT ok(NOT has_function_privilege('authenticated', 'public.discord_bridge_import_start_internal(uuid, text[], text, uuid, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.discord_bridge_import_update(uuid, uuid, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.discord_bridge_import_cancel_internal(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.discord_bridge_import_start(uuid, uuid[])', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.discord_bridge_import_start(uuid, uuid[])', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.discord_bridge_import_update(uuid, uuid, jsonb)', 'EXECUTE'),
          'clients call the two app RPCs only; the gateway functions are service_role');

SELECT * FROM finish();
ROLLBACK;
