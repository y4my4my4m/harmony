-- 20261123300004_bridge_thread_titles.sql: a bridged thread's title is its starter message's text,
-- so the opt-out of that message's author holds, and a title from before an opt-in stays off.
--
-- Fixture server_1 (alice owns it) with #general. Added: bridge328 run by bot328 pairing #general,
-- a running history import of it. Discord users: dana (...9001) opted out, with two messages kept
-- from before; eve (...9002) opted out and back in, at this transaction's now(); finn (...9003)
-- never opted out. flake(t, n) is a Discord id of time t.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(15);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f3280000-0000-0000-0000-0000000000b1', 'bot328', 'Bot 328', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f3280000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f3280000-0000-0000-0000-0000000000b1', '900000000000000328', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f3280000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '3280000000000000001', 'both');
UPDATE public.instance_config SET config_value = '"self_run"' WHERE config_key = 'bridge_history_import';
SELECT count(*) FROM public.discord_bridge_import_start_internal('f3280000-0000-0000-0000-0000000000d1', NULL, 'discord', NULL);
CREATE TEMP TABLE job328 AS
SELECT i.id FROM public.discord_bridge_imports i WHERE i.bridge_id = 'f3280000-0000-0000-0000-0000000000d1';
SELECT public.discord_bridge_import_update('f3280000-0000-0000-0000-0000000000d1', (SELECT id FROM job328), '{"state": "running"}');

CREATE FUNCTION pg_temp.flake(p_at timestamptz, p_n integer) RETURNS text LANGUAGE sql IMMUTABLE AS
$fn$ SELECT ((floor(extract(epoch FROM p_at) * 1000) - 1420070400000)::numeric * 4194304 + p_n)::text $fn$;
CREATE FUNCTION pg_temp.live(p_name text, p_did text, p_starter text, p_parent uuid DEFAULT NULL,
                             p_owner text DEFAULT '3280000000000009003', p_created timestamptz DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS
$fn$ SELECT public.bot_create_thread(
         p_bot_id => 'f3280000-0000-0000-0000-0000000000b1', p_channel_id => '66666666-0000-0000-0000-000000000006',
         p_name => p_name, p_parent_message_id => p_parent, p_discord_thread_id => p_did,
         p_discord_user => jsonb_build_object('id', p_owner, 'username', 'u' || right(p_owner, 1)),
         p_created_at => p_created, p_starter_discord_user_id => p_starter) $fn$;
CREATE FUNCTION pg_temp.imported(p_name text, p_did text, p_starter text) RETURNS uuid LANGUAGE sql AS
$fn$ SELECT public.bridge_import_thread('f3280000-0000-0000-0000-0000000000b1', (SELECT id FROM job328), jsonb_build_object(
         'discord_thread_id', p_did, 'name', p_name, 'created_at', '2020-06-01T00:00:00Z',
         'starter_discord_message_id', p_did, 'starter_discord_user_id', p_starter,
         'discord_user', jsonb_build_object('id', '3280000000000009003', 'username', 'finn'))) $fn$;
CREATE FUNCTION pg_temp.title(p_thread uuid) RETURNS text LANGUAGE sql AS
$fn$ SELECT t.name || ' / ' || (SELECT m.metadata ->> 'thread_name' FROM public.messages m
                                  WHERE m.metadata ->> 'type' = 'thread_created'
                                    AND m.metadata ->> 'thread_id' = p_thread::text)
       FROM public.threads t WHERE t.id = p_thread $fn$;

-- dana's two kept messages, relayed before she opted out.
INSERT INTO public.messages (id, channel_id, bot_id, content, metadata)
SELECT ('f3280000-0000-0000-0000-0000000000a' || n)::uuid, '66666666-0000-0000-0000-000000000006',
       'f3280000-0000-0000-0000-0000000000b1', '[{"type": "text", "text": "dana kept"}]',
       jsonb_build_object('discord_user', jsonb_build_object('id', '3280000000000009001', 'username', 'dana'),
                          'discord_message_id', pg_temp.flake('2020-01-01', 100 + n), 'bot', true)
  FROM generate_series(1, 2) n;
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '3280000000000009001', true);
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '3280000000000009002', true);
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '3280000000000009002', false);

SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_privacy_hides(uuid, text, text, timestamptz)', 'EXECUTE')
      AND NOT has_function_privilege('service_role', 'public.bridge_privacy_hides(uuid, text, text, timestamptz)', 'EXECUTE'),
          'no API role executes bridge_privacy_hides');

-- Live -------------------------------------------------------------------------------------------------
CREATE TEMP TABLE t328 (k text, id uuid);
INSERT INTO t328 VALUES
  ('on-dana', pg_temp.live('dana''s words', pg_temp.flake('2020-01-01', 1), '3280000000000009001')),
  ('on-finn', pg_temp.live('finn''s words', pg_temp.flake('2020-01-01', 2), '3280000000000009003')),
  ('on-dana-kept', pg_temp.live('dana kept', pg_temp.flake('2020-01-01', 101), NULL, 'f3280000-0000-0000-0000-0000000000a1')),
  ('on-eve-old', pg_temp.live('eve''s old words', pg_temp.flake('2020-01-01', 3), '3280000000000009002')),
  ('on-eve-new', pg_temp.live('eve''s new words', pg_temp.flake(now() + interval '1 minute', 4), '3280000000000009002')),
  ('by-eve-old', pg_temp.live('eve''s old thread', pg_temp.flake('2020-01-01', 5), NULL, NULL,
                              '3280000000000009002', '2020-01-01')),
  ('by-eve-new', pg_temp.live('eve''s new thread', pg_temp.flake(now(), 6), NULL, NULL,
                              '3280000000000009002', now() + interval '1 minute'));

SELECT is(pg_temp.title((SELECT id FROM t328 WHERE k = 'on-dana')), 'Thread / Thread',
          'a thread finn starts on a message of dana''s the bridge left out does not carry her words');
SELECT is((SELECT m.metadata #>> '{discord_user,id}' FROM public.messages m
            WHERE m.metadata ->> 'thread_id' = (SELECT id FROM t328 WHERE k = 'on-dana')::text),
          '3280000000000009003', 'its notice still names finn');
SELECT is(pg_temp.title((SELECT id FROM t328 WHERE k = 'on-finn')), 'finn''s words / finn''s words',
          'control: a thread on finn''s message keeps its title');
SELECT is(pg_temp.title((SELECT id FROM t328 WHERE k = 'on-dana-kept')), 'Thread / Thread',
          'a thread on dana''s kept message does not carry her words');
SELECT is(pg_temp.title((SELECT id FROM t328 WHERE k = 'on-eve-old')), 'Thread / Thread',
          'nor one on a message eve wrote before she opted back in');
SELECT is(pg_temp.title((SELECT id FROM t328 WHERE k = 'on-eve-new')), 'eve''s new words / eve''s new words',
          'one on a message she wrote after keeps its title');
SELECT is(pg_temp.title((SELECT id FROM t328 WHERE k = 'by-eve-old')), 'Thread / Thread',
          'a thread eve started before she opted back in arrives live as Thread');
SELECT is((SELECT m.metadata ? 'discord_user' FROM public.messages m
            WHERE m.metadata ->> 'thread_id' = (SELECT id FROM t328 WHERE k = 'by-eve-old')::text),
          false, 'without her name on the notice');
SELECT is(pg_temp.title((SELECT id FROM t328 WHERE k = 'by-eve-new')), 'eve''s new thread / eve''s new thread',
          'one she started after keeps its title');
SELECT is((SELECT m.metadata #>> '{discord_user,id}' FROM public.messages m
            WHERE m.metadata ->> 'thread_id' = (SELECT id FROM t328 WHERE k = 'by-eve-new')::text),
          '3280000000000009002', 'and her name');

-- History import -------------------------------------------------------------------------------------
SELECT is(pg_temp.title(pg_temp.imported('dana''s words again', pg_temp.flake('2020-01-01', 11), '3280000000000009001')),
          'Thread / Thread', 'an imported thread on a message of dana''s the import left out does not carry her words');
SELECT is(pg_temp.title(pg_temp.imported('dana kept', pg_temp.flake('2020-01-01', 102), NULL)),
          'Thread / Thread', 'nor one on her kept message');
SELECT is(pg_temp.title(pg_temp.imported('eve''s old words again', pg_temp.flake('2020-01-01', 12), '3280000000000009002')),
          'Thread / Thread', 'nor one on a message eve wrote before she opted back in');
SELECT is(pg_temp.title(pg_temp.imported('finn''s words again', pg_temp.flake('2020-01-01', 13), '3280000000000009003')),
          'finn''s words again / finn''s words again', 'control: one on finn''s message keeps its title');

SELECT * FROM finish();
ROLLBACK;
