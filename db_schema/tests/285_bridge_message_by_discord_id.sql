-- 20261112900001_bridge_message_by_discord_id.sql: the live message of a channel that holds a
-- Discord message id, read through messages_channel_discord_message_id_unique.
--
--   bot b1, channels #general (fixture) and c2 of server_1
--   a001  relayed by b1 in #general, Discord id ...01
--   a002  alice's message in #general, mapped to Discord id ...02
--   a003  relayed by b1 in c2, Discord id ...03
--   a004  relayed by b1 in #general, no Discord id
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(15);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('28500000-0000-0000-0000-0000000000b1', 'bridge-285', 'Bridge 285', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('28500000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'c285', 0);

INSERT INTO public.messages (id, channel_id, bot_id, user_id, content, metadata) VALUES
  ('28500000-0000-0000-0000-00000000a001', '66666666-0000-0000-0000-000000000006', '28500000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "text", "text": "relayed"}]', '{"discord_message_id": "2850000000000000001"}'),
  ('28500000-0000-0000-0000-00000000a002', '66666666-0000-0000-0000-000000000006', NULL, '11111111-0000-0000-0000-000000000001',
   '[{"type": "text", "text": "from harmony"}]', '{"discord_message_id": "2850000000000000002"}'),
  ('28500000-0000-0000-0000-00000000a003', '28500000-0000-0000-0000-0000000000c2', '28500000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "text", "text": "elsewhere"}]', '{"discord_message_id": "2850000000000000003"}'),
  ('28500000-0000-0000-0000-00000000a004', '66666666-0000-0000-0000-000000000006', '28500000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "text", "text": "no mapping"}]', '{}');

CREATE FUNCTION pg_temp.plan_of(p_query text) RETURNS SETOF text LANGUAGE plpgsql AS
  $$ DECLARE l text; BEGIN FOR l IN EXECUTE 'EXPLAIN ' || p_query LOOP RETURN NEXT l; END LOOP; END $$;

-- Shape and access --------------------------------------------------------------------------------
SELECT has_function('public', 'bridge_message_by_discord_id', ARRAY['uuid', 'text'], 'bridge_message_by_discord_id exists');
SELECT function_returns('public', 'bridge_message_by_discord_id', ARRAY['uuid', 'text'], 'uuid', 'it returns a message id');
SELECT ok(has_function_privilege('service_role', 'public.bridge_message_by_discord_id(uuid, text)', 'EXECUTE'),
          'service_role executes it');
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_message_by_discord_id(uuid, text)', 'EXECUTE'),
          'authenticated does not');
SELECT ok(NOT has_function_privilege('anon', 'public.bridge_message_by_discord_id(uuid, text)', 'EXECUTE'), 'anon does not');

-- Lookup ------------------------------------------------------------------------------------------
SELECT is(public.bridge_message_by_discord_id('66666666-0000-0000-0000-000000000006', '2850000000000000001'),
          '28500000-0000-0000-0000-00000000a001'::uuid, 'a relayed message is found by its Discord id');
SELECT is(public.bridge_message_by_discord_id('66666666-0000-0000-0000-000000000006', '2850000000000000002'),
          '28500000-0000-0000-0000-00000000a002'::uuid, 'a member''s message mapped to a Discord id is found');
SELECT is(public.bridge_message_by_discord_id('66666666-0000-0000-0000-000000000006', '2850000000000000003'),
          NULL::uuid, 'an id held in another channel is not found');
SELECT is(public.bridge_message_by_discord_id('28500000-0000-0000-0000-0000000000c2', '2850000000000000003'),
          '28500000-0000-0000-0000-00000000a003'::uuid, 'it is found in its own channel');
SELECT is(public.bridge_message_by_discord_id('66666666-0000-0000-0000-000000000006', '2850000000000000009'),
          NULL::uuid, 'an unknown id answers NULL');
SELECT is(public.bridge_message_by_discord_id(NULL, '2850000000000000001'), NULL::uuid, 'a NULL channel answers NULL');
SELECT is(public.bridge_message_by_discord_id('66666666-0000-0000-0000-000000000006', NULL), NULL::uuid, 'a NULL id answers NULL');

UPDATE public.messages SET is_deleted = true WHERE id = '28500000-0000-0000-0000-00000000a001';
SELECT is(public.bridge_message_by_discord_id('66666666-0000-0000-0000-000000000006', '2850000000000000001'),
          NULL::uuid, 'a deleted message is not found');

INSERT INTO public.messages (id, channel_id, bot_id, user_id, content, metadata) VALUES
  ('28500000-0000-0000-0000-00000000a005', '66666666-0000-0000-0000-000000000006', '28500000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "text", "text": "relayed again"}]', '{"discord_message_id": "2850000000000000001"}');
SELECT is(public.bridge_message_by_discord_id('66666666-0000-0000-0000-000000000006', '2850000000000000001'),
          '28500000-0000-0000-0000-00000000a005'::uuid, 'the live row that took the id after the delete is found');

-- Plan --------------------------------------------------------------------------------------------
-- The body with its parameters bound: the planner proves the predicate of the unique index.
SET LOCAL enable_seqscan = off;
SELECT ok(EXISTS (
    SELECT 1 FROM (SELECT pg_temp.plan_of(replace(replace(
        (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.bridge_message_by_discord_id(uuid, text)'::regprocedure),
        'p_channel_id', $$'66666666-0000-0000-0000-000000000006'::uuid$$),
        'p_discord_message_id', $$'2850000000000000002'$$)) AS line) p
     WHERE p.line LIKE '%messages_channel_discord_message_id_unique%'),
    'the lookup reads messages_channel_discord_message_id_unique');

SELECT * FROM finish();
ROLLBACK;
