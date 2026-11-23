-- 20261123300001_bridge_optout_guard_order.sql.
--
-- Fixture server_1 (alice owns, bob is a member, mallory is neither) with #general and the
-- fixture message 8888. Added: bot325, the server's Discord bridge. Discord user dana (...9001)
-- opted out; eve (...9002) did not. dana's kept message a1, eve's message a2.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(16);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f3250000-0000-0000-0000-0000000000b1', 'bot325', 'Bot 325', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', 'f3250000-0000-0000-0000-0000000000b1', 'self',
        '900000000000000325', '11111111-0000-0000-0000-000000000001');

INSERT INTO public.messages (id, channel_id, bot_id, content, metadata) VALUES
  ('f3250000-0000-0000-0000-0000000000a1', '66666666-0000-0000-0000-000000000006', 'f3250000-0000-0000-0000-0000000000b1',
   '[{"type": "text", "text": "dana kept"}]',
   '{"discord_user": {"id": "3250000000000009001", "username": "dana"}, "discord_message_id": "3250000000000010001", "bot": true}'),
  ('f3250000-0000-0000-0000-0000000000a2', '66666666-0000-0000-0000-000000000006', 'f3250000-0000-0000-0000-0000000000b1',
   '[{"type": "text", "text": "eve"}]',
   '{"discord_user": {"id": "3250000000000009002", "username": "eve"}, "discord_message_id": "3250000000000010002", "bot": true}');
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '3250000000000009001', true);

-- Trigger order --------------------------------------------------------------------------------------
SELECT ok((SELECT array_agg(t.tgname::text ORDER BY t.tgname) FROM pg_trigger t
            WHERE t.tgrelid = 'public.messages'::regclass AND t.tgname LIKE 'a\_messages\_c%')
          = ARRAY['a_messages_client_write_guard', 'a_messages_client_write_optout',
                  'a_messages_client_write_optout_edit', 'a_messages_content_emoji_parts',
                  'a_messages_content_permissions'],
          'the message opt-out guards sort after the client write guard and before the content rewrites');
SELECT ok((SELECT array_agg(t.tgname::text ORDER BY t.tgname) FROM pg_trigger t
            WHERE t.tgrelid = 'public.reactions'::regclass AND t.tgname LIKE 'a\_reactions\_%')
          = ARRAY['a_reactions_add_permission', 'a_reactions_client_write_guard', 'a_reactions_client_write_optout',
                  'a_reactions_external_emoji', 'a_reactions_matrix_author_guard'],
          'the reaction opt-out guard sorts after the client write guard');

-- A client learns nothing of the opt-outs --------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                   VALUES ('66666666-0000-0000-0000-000000000006', '33333333-0000-0000-0000-000000000003',
                           '[{"type": "text", "text": "probe"}]', '{"discord_user": {"id": "3250000000000009001"}}')$q$,
                 '42501', 'metadata key reserved for the server: discord_user',
                 'an outsider''s message naming an opted-out Discord user meets the reserved-key refusal');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                   VALUES ('66666666-0000-0000-0000-000000000006', '33333333-0000-0000-0000-000000000003',
                           '[{"type": "text", "text": "probe"}]', '{"discord_user": {"id": "3250000000000009002"}}')$q$,
                 '42501', 'metadata key reserved for the server: discord_user',
                 'as does one naming a Discord user who did not opt out');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.reactions (message_id, user_id, channel_id, custom_emoji_content, metadata)
                  VALUES ('88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002',
                          '66666666-0000-0000-0000-000000000006', '👍', '{"discord_user": {"id": "3250000000000009001"}}')$q$,
                'a member''s reaction naming an opted-out Discord user is stored as any reaction');
SELECT tests.clear_authentication();
SELECT is((SELECT metadata FROM public.reactions
            WHERE message_id = '88888888-0000-0000-0000-000000000008' AND user_id = '22222222-0000-0000-0000-000000000002'),
          '{}'::jsonb, 'without the metadata');

-- The bridge keeps its relayed rows and authors -------------------------------------------------------
SELECT throws_ok($q$INSERT INTO public.reactions (message_id, bot_id, channel_id, custom_emoji_content, metadata)
                   VALUES ('88888888-0000-0000-0000-000000000008', 'f3250000-0000-0000-0000-0000000000b1',
                           '66666666-0000-0000-0000-000000000006', '👍', '{"discord_user": {"id": "3250000000000009001"}}')$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'the bridge''s reaction of an opted-out member is still refused');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, bot_id, content, metadata)
                   VALUES ('66666666-0000-0000-0000-000000000006', 'f3250000-0000-0000-0000-0000000000b1',
                           '[{"type": "text", "text": "dana again"}]', '{"discord_user": {"id": "3250000000000009001"}, "bot": true}')$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'and so is its message');

SELECT throws_ok($q$UPDATE public.messages SET metadata = metadata || '{"discord_user": {"id": "3250000000000009002", "username": "eve"}}'
                    WHERE id = 'f3250000-0000-0000-0000-0000000000a1'$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'an opted-out member''s kept message is not moved to another author');
SELECT throws_ok($q$UPDATE public.messages SET metadata = metadata || '{"discord_user": null}'
                    WHERE id = 'f3250000-0000-0000-0000-0000000000a1'$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'nor left without one');
SELECT throws_ok($q$UPDATE public.messages SET metadata = metadata - 'discord_user'
                    WHERE id = 'f3250000-0000-0000-0000-0000000000a1'$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'nor stripped of the key');
SELECT throws_ok($q$UPDATE public.messages SET metadata = metadata || '{"discord_user": {"id": "3250000000000009001", "username": "dana"}}'
                    WHERE id = 'f3250000-0000-0000-0000-0000000000a2'$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'and no message is moved onto an opted-out member');

SELECT lives_ok($q$UPDATE public.messages SET metadata = metadata || '{"discord_user": {"id": "3250000000000009001", "username": "dana2"}, "federated_at": "2026-11-23T00:00:00Z"}'
                   WHERE id = 'f3250000-0000-0000-0000-0000000000a1'$q$,
                'the kept message''s metadata changes otherwise, its author''s name included');
SELECT lives_ok($q$UPDATE public.messages SET content = content
                   WHERE id = 'f3250000-0000-0000-0000-0000000000a1'$q$,
                'an update that keeps the words passes');
SELECT throws_ok($q$UPDATE public.messages SET content = '[{"type": "text", "text": "new words"}]'
                    WHERE id = 'f3250000-0000-0000-0000-0000000000a1'$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'new words are refused as before');
SELECT lives_ok($q$UPDATE public.messages SET metadata = metadata || '{"discord_user": {"id": "3250000000000009003", "username": "finn"}}'
                   WHERE id = 'f3250000-0000-0000-0000-0000000000a2'$q$,
                'a message moves between authors who did not opt out');

SELECT * FROM finish();
ROLLBACK;
