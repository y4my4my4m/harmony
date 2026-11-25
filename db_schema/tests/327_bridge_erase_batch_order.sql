-- 20261123300003_bridge_erase_batch_order.sql: a later erase batch holds its opt-out row, so an
-- opt-in or a Restore waits for a batch already running.
--
-- Fixture server_1 (alice owns it) with #general, bridged by bot327. Discord users dana (...9001,
-- erasing her own messages, a batch pending) and eve (...9002, removed by alice) left three
-- messages each. A row lock leaves the locking transaction's id in the row's xmax; held() reads it.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(6);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f3270000-0000-0000-0000-0000000000b1', 'bot327', 'Bot 327', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', 'f3270000-0000-0000-0000-0000000000b1', 'self',
        '900000000000000327', '11111111-0000-0000-0000-000000000001');

INSERT INTO public.messages (channel_id, bot_id, content, metadata)
SELECT '66666666-0000-0000-0000-000000000006', 'f3270000-0000-0000-0000-0000000000b1',
       jsonb_build_array(jsonb_build_object('type', 'text', 'text', a.name || ' ' || n)),
       jsonb_build_object('discord_user', jsonb_build_object('id', a.id, 'username', a.name),
                          'discord_message_id', '327' || a.n0 || n, 'bot', true)
  FROM (VALUES ('3270000000000009001', 'dana', '1'), ('3270000000000009002', 'eve', '2')) a(id, name, n0),
       generate_series(1, 3) n;

INSERT INTO public.bridge_remote_optouts (server_id, platform, remote_user_id, source, self_opted_out, erase_pending, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', 'discord', '3270000000000009001', 'self', true, 'self', NULL),
       ('55555555-0000-0000-0000-000000000005', 'discord', '3270000000000009002', 'manager', false, NULL,
        '11111111-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.held(p_remote text) RETURNS boolean LANGUAGE sql AS $$
    SELECT o.xmax::text = (txid_current() % 4294967296)::text
      FROM public.bridge_remote_optouts o
     WHERE o.server_id = '55555555-0000-0000-0000-000000000005' AND o.platform = 'discord'
       AND o.remote_user_id = p_remote $$;

SELECT ok(NOT pg_temp.held('3270000000000009001') AND NOT pg_temp.held('3270000000000009002'),
          'control: no lock on the rows yet');

SELECT is(public.bridge_privacy_erase_tail('55555555-0000-0000-0000-000000000005', 'discord', '3270000000000009001', 1),
          '{"opted_out": true, "erased": 1, "more": true, "removed": 1}'::jsonb, 'the tail erases one of dana''s');
SELECT ok(pg_temp.held('3270000000000009001'), 'and holds her opt-out row to the end of its transaction');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_erase_continue('55555555-0000-0000-0000-000000000005', 'discord', '3270000000000009002'),
          '{"erased": 3, "more": false, "removed": 3}'::jsonb, 'a manager''s later batch erases eve''s');
SELECT tests.clear_authentication();
SELECT ok(pg_temp.held('3270000000000009002'), 'and holds her opt-out row to the end of its transaction');

-- An opt-in in the same transaction, after the batch: the tail erases nothing more.
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '3270000000000009001', false);
SELECT is(public.bridge_privacy_erase_tail('55555555-0000-0000-0000-000000000005', 'discord', '3270000000000009001', 1),
          '{"opted_out": false, "erased": 0, "more": false}'::jsonb, 'after an opt-in the tail erases nothing');

SELECT * FROM finish();
ROLLBACK;
