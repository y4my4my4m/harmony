-- A live relay of a Discord message a history import already stored, after
-- 20261123200002_bridge_relay_supersedes_import.sql.
--
-- Fixture server_1 (alice owns, bob is a member) with #general, local and federating. Added:
-- bridge316 run by bot316 (bot316x is another bot) pairing #general with Discord ...01. The import
-- stores Discord message 901 (pinned) with a reply 902 to it, a thread on it and bob's reaction; the
-- relay of 901 then arrives mentioning bob.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(16);

UPDATE public.servers SET is_local_server = true, federation_enabled = true
 WHERE id = '55555555-0000-0000-0000-000000000005';

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f3160000-0000-0000-0000-0000000000b1', 'bot316', 'Bot 316', '11111111-0000-0000-0000-000000000001', 'bridge'),
  ('f3160000-0000-0000-0000-0000000000b2', 'bot316x', 'Bot 316x', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f3160000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f3160000-0000-0000-0000-0000000000b1', '900000000000000316', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f3160000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '3160000000000000001', 'both');

UPDATE public.instance_config SET config_value = '"self_run"'::jsonb WHERE config_key = 'bridge_history_import';
UPDATE public.instance_config SET config_value = '0'::jsonb
 WHERE config_key IN ('bridge_import_max_running', 'bridge_import_messages_per_minute');

SELECT count(*) FROM public.discord_bridge_import_start_internal('f3160000-0000-0000-0000-0000000000d1', NULL, 'discord', NULL);
CREATE FUNCTION pg_temp.job() RETURNS uuid LANGUAGE sql AS
$fn$ SELECT i.id FROM public.discord_bridge_imports i WHERE i.bridge_id = 'f3160000-0000-0000-0000-0000000000d1' $fn$;
SELECT public.discord_bridge_import_update('f3160000-0000-0000-0000-0000000000d1', pg_temp.job(), '{"state": "running"}');

CREATE FUNCTION pg_temp.msg(p_did text, p_extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT jsonb_build_object('discord_message_id', p_did, 'created_at', now() - interval '20 minutes',
           'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'hello ' || p_did)),
           'discord_user', jsonb_build_object('id', '3160000000000009001', 'username', 'dana')) || p_extra $fn$;
CREATE FUNCTION pg_temp.by_did(p_did text) RETURNS public.messages LANGUAGE sql AS
$fn$ SELECT m FROM public.messages m WHERE m.channel_id = '66666666-0000-0000-0000-000000000006'
         AND m.metadata ->> 'discord_message_id' = p_did AND m.is_deleted IS NOT TRUE $fn$;

SELECT public.bridge_import_messages('f3160000-0000-0000-0000-0000000000b1', pg_temp.job(), jsonb_build_array(
    pg_temp.msg('3160000000000000902', '{"reply_to_discord_message_id": "3160000000000000901"}'),
    pg_temp.msg('3160000000000000901', '{"pinned": true}')));
SELECT public.bridge_import_thread('f3160000-0000-0000-0000-0000000000b1', pg_temp.job(), jsonb_build_object(
    'discord_thread_id', '3160000000000000901', 'name', 'about 901', 'created_at', now() - interval '19 minutes',
    'starter_discord_message_id', '3160000000000000901'));
SELECT set_config('harmony.history_import', 'false', true);

CREATE TEMP TABLE r316 AS
SELECT (pg_temp.by_did('3160000000000000901')).id AS imported,
       (SELECT h.message_seq FROM public.message_heads h WHERE h.channel_id = '66666666-0000-0000-0000-000000000006') AS seq;
INSERT INTO public.reactions (message_id, user_id, custom_emoji_content, channel_id)
SELECT imported, '22222222-0000-0000-0000-000000000002', '👍', '66666666-0000-0000-0000-000000000006' FROM r316;
GRANT SELECT ON r316 TO service_role;

SELECT is((SELECT federation_status FROM public.messages WHERE id = (SELECT imported FROM r316)), 'skipped',
          'the imported row is quiet');

CREATE FUNCTION pg_temp.relay(p_bot uuid, p_message uuid, p_did text) RETURNS uuid LANGUAGE sql AS
$fn$ SELECT public.bridge_relay_supersede_import(p_bot, p_message, NULL, NULL,
         '[{"type": "text", "text": "hello "}, {"type": "mention", "userId": "22222222-0000-0000-0000-000000000002", "username": "bob"}]'::jsonb,
         jsonb_build_object('discord_message_id', p_did, 'bot', true, 'created_via', 'bot_api',
                            'discord_user', jsonb_build_object('id', '3160000000000009001', 'username', 'dana'))) $fn$;

-- Refusals, then the takeover, as the service role (bot-gateway's role) ----------------------------------
CREATE TEMP TABLE l316 (step text, live uuid);
GRANT INSERT ON l316 TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO l316
SELECT 'other_bot', pg_temp.relay('f3160000-0000-0000-0000-0000000000b2', (SELECT imported FROM r316), '3160000000000000901')
UNION ALL
SELECT 'other_id', pg_temp.relay('f3160000-0000-0000-0000-0000000000b1', (SELECT imported FROM r316), '3160000000000000999')
UNION ALL
SELECT 'missing', pg_temp.relay('f3160000-0000-0000-0000-0000000000b1', '33333333-0000-0000-0000-000000000099', '3160000000000000901');
INSERT INTO l316
SELECT 'takeover', pg_temp.relay('f3160000-0000-0000-0000-0000000000b1', (SELECT imported FROM r316), '3160000000000000901');
RESET ROLE;
CREATE FUNCTION pg_temp.step(p_step text) RETURNS uuid LANGUAGE sql AS $fn$ SELECT live FROM l316 WHERE step = p_step $fn$;

SELECT is(pg_temp.step('other_bot'), NULL::uuid, 'another bot''s import is not taken over');
SELECT is(pg_temp.step('other_id'), NULL::uuid, 'nor one under another Discord id');
SELECT is(pg_temp.step('missing'), NULL::uuid, 'nor a row that does not exist');
DELETE FROM l316 WHERE step <> 'takeover';

SELECT isnt((SELECT live FROM l316), NULL, 'the relay of an imported message takes it over');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.messages WHERE id = (SELECT imported FROM r316)), 'the imported row is gone');
SELECT is((pg_temp.by_did('3160000000000000901')).id, (SELECT live FROM l316), 'the live row holds the Discord id');
SELECT ok((pg_temp.by_did('3160000000000000901')).metadata ->> 'history_import' IS NULL
          AND (pg_temp.by_did('3160000000000000901')).metadata ->> 'created_via' = 'bot_api',
          'and is a relayed message, not an imported one');
SELECT is((SELECT h.last_message_id FROM public.message_heads h WHERE h.channel_id = '66666666-0000-0000-0000-000000000006'),
          (SELECT live FROM l316), 'it moves the channel''s last message, which the unread counts read');
SELECT is((SELECT h.message_seq FROM public.message_heads h WHERE h.channel_id = '66666666-0000-0000-0000-000000000006'),
          (SELECT COALESCE(seq, 0) + 1 FROM r316), 'and counts as one new message');
SELECT ok(EXISTS (SELECT 1 FROM public.notifications n
                   WHERE n.user_id = '22222222-0000-0000-0000-000000000002'
                     AND n.data ->> 'message_id' = (SELECT live FROM l316)::text),
          'the member it mentions is notified');
SELECT isnt((SELECT federation_status FROM public.messages WHERE id = (SELECT live FROM l316)), 'skipped',
            'it federates');
SELECT is((pg_temp.by_did('3160000000000000902')).reply_to, (SELECT live FROM l316), 'a reply to it points at the live row');
SELECT ok(EXISTS (SELECT 1 FROM public.threads t WHERE t.parent_message_id = (SELECT live FROM l316) AND t.name = 'about 901'),
          'the thread started on it hangs on the live row');
SELECT ok(EXISTS (SELECT 1 FROM public.reactions r WHERE r.message_id = (SELECT live FROM l316)
                   AND r.user_id = '22222222-0000-0000-0000-000000000002'),
          'its reactions move with it');
SELECT ok((SELECT is_pinned FROM public.messages WHERE id = (SELECT live FROM l316)), 'and its pin');

SELECT * FROM finish();
ROLLBACK;
