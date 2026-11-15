-- Opting back in is forward-looking, after 20261115910001_bridge_optin_history.sql.
--
-- Fixture server_1 (alice owns and is the instance admin) with #general. Added: bridge294 (mode
-- self) run by bot294 pairing #general with Discord ...01. Discord users: dana opts out and back
-- in, eve never opts out, frank is removed and restored by alice.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f2940000-0000-0000-0000-0000000000b1', 'bot294', 'Bot 294', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f2940000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f2940000-0000-0000-0000-0000000000b1', '900000000000000294', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f2940000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '2940000000000000001', 'both');
UPDATE public.instance_config SET config_value = '"self_run"' WHERE config_key = 'bridge_history_import';

SELECT count(*) FROM public.discord_bridge_import_start_internal('f2940000-0000-0000-0000-0000000000d1', NULL, 'discord', NULL);
CREATE TEMP TABLE job294 AS
SELECT i.id FROM public.discord_bridge_imports i WHERE i.bridge_id = 'f2940000-0000-0000-0000-0000000000d1';
SELECT public.discord_bridge_import_update('f2940000-0000-0000-0000-0000000000d1', (SELECT id FROM job294), '{"state": "running"}');

CREATE FUNCTION pg_temp.msg(p_did text, p_created text, p_author text) RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT jsonb_build_object('discord_message_id', p_did, 'created_at', p_created,
           'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'hello ' || p_did)),
           'discord_user', jsonb_build_object('id', p_author, 'username', 'u' || p_author)) $fn$;
CREATE FUNCTION pg_temp.send(p_msgs jsonb) RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT public.bridge_import_messages('f2940000-0000-0000-0000-0000000000b1', (SELECT id FROM job294), p_msgs) $fn$;
CREATE FUNCTION pg_temp.thread(p_did text, p_name text, p_created text, p_author text) RETURNS uuid LANGUAGE sql AS
$fn$ SELECT public.bridge_import_thread('f2940000-0000-0000-0000-0000000000b1', (SELECT id FROM job294), jsonb_build_object(
           'discord_thread_id', p_did, 'name', p_name, 'created_at', p_created,
           'discord_user', jsonb_build_object('id', p_author))) $fn$;
CREATE FUNCTION pg_temp.optin_of(p_server uuid, p_author text) RETURNS bigint LANGUAGE sql AS
$fn$ SELECT count(*) FROM public.bridge_remote_optins
      WHERE server_id = p_server AND platform = 'discord' AND remote_user_id = p_author $fn$;

-- Recording ----------------------------------------------------------------------------------------------
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2940000000000009001', true);
SELECT is(pg_temp.optin_of('55555555-0000-0000-0000-000000000005', '2940000000000009001'), 0::bigint,
          'an opt-out records no opt-in');
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2940000000000009001', false);
SELECT is(pg_temp.optin_of('55555555-0000-0000-0000-000000000005', '2940000000000009001'), 1::bigint,
          'opting back in records when');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2940000000000009003');
SELECT public.bridge_privacy_restore_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2940000000000009003');
SELECT tests.clear_authentication();
SELECT is(pg_temp.optin_of('55555555-0000-0000-0000-000000000005', '2940000000000009003'), 1::bigint,
          'a manager''s restore records it too');
SELECT is(has_table_privilege('authenticated', 'public.bridge_remote_optins', 'SELECT'), false,
          'a signed-in account does not read the opt-ins');

-- History import ---------------------------------------------------------------------------------------------
CREATE TEMP TABLE b294 AS
SELECT pg_temp.send(jsonb_build_array(
    pg_temp.msg('2940000000000010001', '2020-01-01T10:00:00Z', '2940000000000009001'),
    pg_temp.msg('2940000000000010002', (now() + interval '30 seconds')::text, '2940000000000009001'),
    pg_temp.msg('2940000000000010003', '2020-01-01T10:00:01Z', '2940000000000009002'),
    pg_temp.msg('2940000000000010004', '2020-01-01T10:00:02Z', '2940000000000009003'))) AS j;
SELECT is((SELECT jsonb_agg(e ->> 'discord_message_id' ORDER BY e ->> 'discord_message_id') FROM b294, jsonb_array_elements(j -> 'inserted') e),
          '["2940000000000010002", "2940000000000010003"]'::jsonb,
          'a message written after the opt-in is stored, and so is one of an author who never opted out');
SELECT is((SELECT jsonb_object_agg(e ->> 'discord_message_id', e ->> 'reason') FROM b294, jsonb_array_elements(j -> 'rejected') e),
          '{"2940000000000010001": "before_opt_in", "2940000000000010004": "before_opt_in"}'::jsonb,
          'a message written before the author''s opt-in or restore is rejected as before_opt_in');
SELECT is((SELECT count(*) FROM public.messages WHERE metadata ->> 'discord_message_id' IN ('2940000000000010001', '2940000000000010004')),
          0::bigint, 'and is not stored');

SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2940000000000009001', true);
SELECT is(pg_temp.send(jsonb_build_array(pg_temp.msg('2940000000000010005', '2020-01-01T10:00:03Z', '2940000000000009001'))) -> 'rejected',
          '[{"discord_message_id": "2940000000000010005", "reason": "opted_out"}]'::jsonb,
          'an author opted out again is rejected as opted_out');
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2940000000000009001', false);

-- Threads ------------------------------------------------------------------------------------------------------
CREATE TEMP TABLE t294 AS
SELECT pg_temp.thread('2940000000000030001', 'dana said this in 2020', '2020-01-01T09:00:00Z', '2940000000000009001') AS old,
       pg_temp.thread('2940000000000030002', 'dana says this now', now()::text, '2940000000000009001') AS fresh,
       pg_temp.thread('2940000000000030003', 'eve said this in 2020', '2020-01-01T09:00:00Z', '2940000000000009002') AS eve;
SELECT is((SELECT name FROM public.threads WHERE id = (SELECT old FROM t294)), 'Thread',
          'a thread started before its author''s opt-in is imported under a plain name');
SELECT is((SELECT m.metadata ? 'discord_user' FROM public.messages m
            WHERE m.is_system AND m.metadata ->> 'thread_id' = (SELECT old::text FROM t294)),
          false, 'and its notice does not name the author');
SELECT is((SELECT name FROM public.threads WHERE id = (SELECT fresh FROM t294)), 'dana says this now',
          'a thread started since keeps its title');
SELECT is((SELECT name FROM public.threads WHERE id = (SELECT eve FROM t294)), 'eve said this in 2020',
          'a thread of an author who never opted out keeps its title');

-- Server deletion -------------------------------------------------------------------------------------------------
INSERT INTO public.servers (id, name, owner) VALUES
  ('f2940000-0000-0000-0000-0000000000a1', 'Doomed', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.bridge_remote_optouts (server_id, platform, remote_user_id)
VALUES ('f2940000-0000-0000-0000-0000000000a1', 'discord', '2940000000000009001');
SELECT lives_ok($q$DELETE FROM public.servers WHERE id = 'f2940000-0000-0000-0000-0000000000a1'$q$,
                'a server with an opt-out is deleted');
SELECT is(pg_temp.optin_of('f2940000-0000-0000-0000-0000000000a1', '2940000000000009001'), 0::bigint,
          'and its opt-out ending with it records no opt-in');

SELECT * FROM finish();
ROLLBACK;
