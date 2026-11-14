-- 20261115100001_bridge_privacy_followups.sql, 20261115200001_history_import_deleted_copies.sql and
-- the emoji index of 20261115300001_review_followups.sql.
--
-- Fixture server_1 (alice owns, bob is a member) with #general. Added: bridge290 run by bot290,
-- paired with #general, and relayed rows of Discord authors
--   dana   ...9001   m1 live
--   eve    ...9002   m2 live
--   frank  ...9003   m3 live, two reactions on zed's m9, an AutoMod event
--   zed    ...9009   m9 live, never erased

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(23);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f2900000-0000-0000-0000-0000000000b1', 'bot290', 'Bot 290', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f2900000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f2900000-0000-0000-0000-0000000000b1', '900000000000000290', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f2900000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '2900000000000000001', 'both');

CREATE FUNCTION pg_temp.relayed(p_id uuid, p_did text, p_author text, p_extra jsonb DEFAULT '{}') RETURNS void
LANGUAGE sql AS $fn$
    INSERT INTO public.messages (id, bot_id, channel_id, content, metadata)
    VALUES (p_id, 'f2900000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'from ' || p_author)),
            jsonb_build_object('discord_user', jsonb_build_object('id', p_author, 'username', 'u' || right(p_author, 1)),
                               'discord_message_id', p_did, 'bot', true, 'created_via', 'bot_api') || p_extra)
$fn$;

SELECT pg_temp.relayed('f2900000-0000-0000-0000-0000000000a1', '2900000000000010001', '2900000000000009001');
SELECT pg_temp.relayed('f2900000-0000-0000-0000-0000000000a2', '2900000000000010002', '2900000000000009002');
SELECT pg_temp.relayed('f2900000-0000-0000-0000-0000000000a3', '2900000000000010003', '2900000000000009003');
SELECT pg_temp.relayed('f2900000-0000-0000-0000-0000000000a9', '2900000000000010009', '2900000000000009009');
INSERT INTO public.reactions (message_id, bot_id, custom_emoji_content, channel_id, metadata) VALUES
  ('f2900000-0000-0000-0000-0000000000a9', 'f2900000-0000-0000-0000-0000000000b1', 'a', '66666666-0000-0000-0000-000000000006',
   '{"discord_user": {"id": "2900000000000009003"}}'),
  ('f2900000-0000-0000-0000-0000000000a9', 'f2900000-0000-0000-0000-0000000000b1', 'b', '66666666-0000-0000-0000-000000000006',
   '{"discord_user": {"id": "2900000000000009003"}}');
INSERT INTO public.automod_events (server_id, channel_id, bot_id, event_type, details) VALUES
  ('55555555-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006', 'f2900000-0000-0000-0000-0000000000b1',
   'message', '{"author_key": "discord:2900000000000009003", "author_name": "u3"}');

-- bridge_erased is the server's. -----------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.messages (id, user_id, channel_id, content)
                   VALUES ('f2900000-0000-0000-0000-0000000000e1', '22222222-0000-0000-0000-000000000002',
                           '66666666-0000-0000-0000-000000000006', '[{"type": "text", "text": "mine"}]')$q$,
                'control: bob posts in #general');
SELECT throws_ok($q$INSERT INTO public.messages (user_id, channel_id, content, metadata)
                    VALUES ('22222222-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006',
                            '[{"type": "text", "text": "quiet"}]', '{"bridge_erased": true}')$q$,
                 '42501', 'metadata key reserved for the server: bridge_erased',
                 'a member cannot post a message marked bridge_erased');
SELECT throws_ok($q$UPDATE public.messages SET metadata = '{"bridge_erased": true}'
                    WHERE id = 'f2900000-0000-0000-0000-0000000000e1'$q$,
                 '42501', 'metadata key reserved for the server: bridge_erased',
                 'nor mark their own message so');
SELECT tests.clear_authentication();

-- The user's own opt-out outlives a manager's restore. --------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009001') ->> 'more',
          'false', 'the owner removes dana');
SELECT tests.clear_authentication();
SELECT is(public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009001', true)
              ->> 'self', 'true', 'dana then opts out herself, beside the manager''s removal');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_restore_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009001'),
          true, 'a restore by the manager lifts the removal');
SELECT tests.clear_authentication();
SELECT is((SELECT source FROM public.bridge_remote_optouts WHERE remote_user_id = '2900000000000009001'), 'self',
          'and dana stays opted out');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009002');
SELECT tests.clear_authentication();
SELECT is(public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009002', 50) ->> 'opted_out',
          'true', 'eve erases through the bridge after a manager removed her');
SELECT is((SELECT source || ':' || self_opted_out FROM public.bridge_remote_optouts WHERE remote_user_id = '2900000000000009002'),
          'manager:true', 'her own opt-out is kept beside the manager''s removal');
SELECT is(public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009002', true)
              ->> 'self', 'true', 'opting out again changes nothing');

-- Erase in batches, reactions and AutoMod events after the messages. ------------------------------------
SELECT is(public.bridge_privacy_erase_core('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009003', 1),
          '{"erased": 1, "more": true}'::jsonb, 'a full batch says more');
SELECT is(public.bridge_privacy_erase_core('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009003', 1),
          '{"erased": 0, "more": true}'::jsonb, 'then one reaction and the AutoMod event go, and more stays true');
SELECT is((SELECT count(*)::int FROM public.reactions WHERE metadata #>> '{discord_user,id}' = '2900000000000009003'), 1,
          'one reaction per call at a limit of 1');
SELECT is((SELECT count(*)::int FROM public.automod_events WHERE details ->> 'author_key' = 'discord:2900000000000009003'), 0,
          'the AutoMod event is gone');
SELECT is(public.bridge_privacy_erase_core('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009003', 1),
          '{"erased": 0, "more": true}'::jsonb, 'the last reaction goes');
SELECT is(public.bridge_privacy_erase_core('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009003', 1),
          '{"erased": 0, "more": false}'::jsonb, 'nothing is left');
SELECT pg_temp.relayed('f2900000-0000-0000-0000-0000000000a4', '2900000000000010004', '2900000000000009004');
SELECT pg_temp.relayed('f2900000-0000-0000-0000-0000000000a5', '2900000000000010005', '2900000000000009004');
SELECT is(public.bridge_privacy_erase_core('55555555-0000-0000-0000-000000000005', 'discord', '2900000000000009004', 5),
          '{"erased": 2, "more": false}'::jsonb, 'a short batch with nothing left says no more');

-- A thread an opted-out author starts on Discord. ------------------------------------------------------
SELECT lives_ok($q$SELECT public.bot_create_thread('f2900000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
                    'thread 290', NULL, '2900000000000020001',
                    '{"id": "2900000000000009001", "username": "u1"}'::jsonb)$q$,
                'a thread started by an opted-out author is created');
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = '66666666-0000-0000-0000-000000000006' AND is_system
              AND metadata ->> 'thread_name' = 'Thread' AND NOT (metadata ? 'discord_user')), 1,
          'its notice names no author');

-- The import leaves a message whose copy was deleted. --------------------------------------------------
INSERT INTO public.messages (bot_id, channel_id, content, metadata, is_deleted) VALUES
  ('f2900000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
   '[{"type": "text", "text": "[deleted]"}]', '{"discord_message_id": "2900000000000030001", "bot": true}', true);
SELECT set_config('harmony.history_import', 'true', true);
INSERT INTO public.messages (bot_id, channel_id, content, metadata) VALUES
  ('f2900000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
   '[{"type": "text", "text": "back"}]', '{"discord_message_id": "2900000000000030001", "history_import": true, "bot": true}'),
  ('f2900000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
   '[{"type": "text", "text": "new"}]', '{"discord_message_id": "2900000000000030002", "history_import": true, "bot": true}');
SELECT set_config('harmony.history_import', 'false', true);
SELECT is((SELECT array_agg(is_deleted ORDER BY created_at) FROM public.messages
            WHERE metadata ->> 'discord_message_id' = '2900000000000030001'), ARRAY[true],
          'an imported row whose Discord message was deleted here is not inserted');
SELECT is((SELECT count(*)::int FROM public.messages WHERE metadata ->> 'discord_message_id' = '2900000000000030002'), 1,
          'a message with no deleted copy is');
SELECT ok(EXISTS (SELECT 1 FROM pg_index x WHERE x.indexrelid = 'public.messages_channel_discord_message_id_deleted'::regclass
                    AND x.indisvalid), 'the deleted-copy index is valid');

-- Emoji lookups by url. --------------------------------------------------------------------------------
SELECT is((SELECT am.amname::text FROM pg_class c JOIN pg_am am ON am.oid = c.relam
            WHERE c.oid = 'public.idx_emojis_url'::regclass), 'hash', 'emojis.url has a hash index');

SELECT * FROM finish();
ROLLBACK;
