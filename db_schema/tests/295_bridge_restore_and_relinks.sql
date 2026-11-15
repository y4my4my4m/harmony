-- 20261115920001_bridge_restore_and_relinks.sql.
--
-- Fixture server_1 (alice owns it) with #general, bridged by bot295. Discord user dana opted out
-- and left a message with a Discord file on Harmony. Two emojis the bridge imported.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(20);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f2950000-0000-0000-0000-0000000000b1', 'bot295', 'Bot 295', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', 'f2950000-0000-0000-0000-0000000000b1', 'self',
        '900000000000000295', '11111111-0000-0000-0000-000000000001');

-- Relinked parts -----------------------------------------------------------------------------------------
SELECT ok(public.message_parts_relinked(
              '[{"type": "text", "text": "hi"}, {"type": "url", "url": "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1"}]',
              '[{"type": "text", "text": "hi"}, {"type": "url", "url": "https://cdn.discordapp.com/attachments/1/2/a.png?ex=2"}]'),
          'a re-signed link is a relink');
SELECT ok(public.message_parts_relinked(
              '[{"type": "url", "url": "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1"}]',
              '[{"type": "file", "fileType": "image", "url": "https://db.test/s/a.png", "path": "c/x/a.png"}]'),
          'so is a link copied into storage');
SELECT ok(NOT public.message_parts_relinked(
              '[{"type": "url", "url": "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1"}]',
              '[{"type": "url", "url": "https://elsewhere.example/a.png"}]'),
          'a link pointed elsewhere is not');
SELECT ok(NOT public.message_parts_relinked(
              '[{"type": "link", "url": "https://a.example/x", "text": "a"}]',
              '[{"type": "link", "url": "https://a.example/x?y", "text": "a"}]'),
          'nor a change to a link part');

-- An opted-out member's kept message --------------------------------------------------------------------
INSERT INTO public.messages (id, channel_id, bot_id, content, metadata) VALUES
  ('f2950000-0000-0000-0000-0000000000a1', '66666666-0000-0000-0000-000000000006', 'f2950000-0000-0000-0000-0000000000b1',
   '[{"type": "text", "text": "kept"}, {"type": "file", "fileType": "image", "url": "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1"}]',
   '{"discord_user": {"id": "2950000000000009001", "username": "dana"}, "discord_message_id": "2950000000000010001", "bot": true}');
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2950000000000009001', true);

SELECT is(public.update_message_content_silent('f2950000-0000-0000-0000-0000000000a1',
              '[{"type": "text", "text": "kept"}, {"type": "file", "fileType": "image", "url": "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1"}]',
              '[{"type": "text", "text": "kept"}, {"type": "file", "fileType": "image", "url": "https://cdn.discordapp.com/attachments/1/2/a.png?ex=2"}]'),
          true, 'a link refresh of an opted-out member''s kept message passes');
SELECT is(public.update_message_content_silent('f2950000-0000-0000-0000-0000000000a1',
              '[{"type": "text", "text": "kept"}, {"type": "file", "fileType": "image", "url": "https://cdn.discordapp.com/attachments/1/2/a.png?ex=2"}]',
              '[{"type": "text", "text": "kept"}, {"type": "file", "fileType": "image", "url": "https://db.test/storage/v1/object/public/m/a.png", "path": "c/66666666-0000-0000-0000-000000000006/m/a.png"}]'),
          true, 'and so does a mirror swap');
SELECT throws_ok($q$SELECT public.update_message_content_silent('f2950000-0000-0000-0000-0000000000a1',
                       (SELECT content FROM public.messages WHERE id = 'f2950000-0000-0000-0000-0000000000a1'),
                       '[{"type": "text", "text": "new words"}, {"type": "file", "fileType": "image", "url": "https://db.test/storage/v1/object/public/m/a.png", "path": "c/66666666-0000-0000-0000-000000000006/m/a.png"}]')$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'a silent update that changes the text is refused');
SELECT throws_ok($q$SELECT public.update_message_content_silent('f2950000-0000-0000-0000-0000000000a1',
                       (SELECT content FROM public.messages WHERE id = 'f2950000-0000-0000-0000-0000000000a1'),
                       '[{"type": "text", "text": "kept"}]')$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'and one that drops a part');
SELECT throws_ok($q$UPDATE public.messages SET content = '[{"type": "text", "text": "kept"}, {"type": "file", "url": "https://elsewhere"}]'
                     WHERE id = 'f2950000-0000-0000-0000-0000000000a1'$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'an edit that is not silent is refused as before');
SELECT throws_ok($q$SELECT public.update_message_content_silent('f2950000-0000-0000-0000-0000000000a1',
                       (SELECT content FROM public.messages WHERE id = 'f2950000-0000-0000-0000-0000000000a1'),
                       '[{"type": "text", "text": "kept"}, {"type": "file", "fileType": "image", "url": "https://elsewhere.example/a.png"}]')$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'a silent update that points the file elsewhere is refused');
SELECT is((SELECT content #>> '{0,text}' FROM public.messages WHERE id = 'f2950000-0000-0000-0000-0000000000a1'),
          'kept', 'the words stay as they were');

-- Author locks ---------------------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.holds(p_key bigint, p_mode text) RETURNS boolean LANGUAGE sql AS
$fn$ SELECT EXISTS (SELECT 1 FROM pg_locks l
                     WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.mode = p_mode AND l.objsubid = 1
                       AND ((l.classid::bigint << 32) | l.objid::bigint) = p_key) $fn$;
INSERT INTO public.messages (channel_id, bot_id, content, metadata) VALUES
  ('66666666-0000-0000-0000-000000000006', 'f2950000-0000-0000-0000-0000000000b1', '[{"type": "text", "text": "eve"}]',
   '{"discord_user": {"id": "2950000000000009002", "username": "eve"}, "bot": true}');
SELECT ok(pg_temp.holds(public.bridge_author_lock_key('55555555-0000-0000-0000-000000000005', 'discord', '2950000000000009002'), 'ShareLock'),
          'a relayed message holds its author''s lock shared until it commits');
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2950000000000009003', true);
SELECT ok(pg_temp.holds(public.bridge_author_lock_key('55555555-0000-0000-0000-000000000005', 'discord', '2950000000000009003'), 'ExclusiveLock'),
          'an opt-out holds the author''s lock exclusive');

-- Import batches -----------------------------------------------------------------------------------------
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction)
SELECT b.id, '66666666-0000-0000-0000-000000000006', '2950000000000000001', 'both'
  FROM public.discord_bridges b WHERE b.bot_id = 'f2950000-0000-0000-0000-0000000000b1';
UPDATE public.instance_config SET config_value = '"self_run"' WHERE config_key = 'bridge_history_import';
SELECT count(*) FROM public.discord_bridge_import_start_internal(
    (SELECT id FROM public.discord_bridges WHERE bot_id = 'f2950000-0000-0000-0000-0000000000b1'), NULL, 'discord', NULL);
CREATE TEMP TABLE job295 AS
SELECT i.id, i.bridge_id FROM public.discord_bridge_imports i
  JOIN public.discord_bridges b ON b.id = i.bridge_id WHERE b.bot_id = 'f2950000-0000-0000-0000-0000000000b1';
SELECT public.discord_bridge_import_update((SELECT bridge_id FROM job295), (SELECT id FROM job295), '{"state": "running"}');
SELECT public.bridge_import_messages('f2950000-0000-0000-0000-0000000000b1', (SELECT id FROM job295), jsonb_build_array(
    jsonb_build_object('discord_message_id', '2950000000000020001', 'created_at', (now() + interval '2 hours')::text,
                       'content', '[{"type": "text", "text": "later"}]'::jsonb,
                       'discord_user', '{"id": "2950000000000009004", "username": "fay"}'::jsonb)));
SELECT ok(pg_temp.holds(public.bridge_author_lock_key('55555555-0000-0000-0000-000000000005', 'discord', '2950000000000009004'), 'ShareLock'),
          'a history batch takes its authors'' locks before any row, even for a message it then rejects');

-- Emojis -------------------------------------------------------------------------------------------------
INSERT INTO public.emojis (id, name, url, server_id, scope, discord_emoji_id) VALUES
  ('295e0000-0000-0000-0000-00000000000a', 'honk295',
   'https://db.test/storage/v1/object/public/emojis/55555555-0000-0000-0000-000000000005/discord/2951.png',
   '55555555-0000-0000-0000-000000000005', 'server', '2951'),
  ('295e0000-0000-0000-0000-00000000000b', 'quack295',
   'https://db.test/storage/v1/object/public/emojis/55555555-0000-0000-0000-000000000005/discord/2952.png',
   '55555555-0000-0000-0000-000000000005', 'server', '2952');

SELECT is(public.bridge_remove_server_emoji('f2950000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
                                            '295e0000-0000-0000-0000-00000000000a'),
          'removed', 'the bridge removes an emoji it imported');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.restore_emoji('295e0000-0000-0000-0000-00000000000a');
SELECT tests.clear_authentication();
SELECT throws_ok($q$SELECT public.bridge_remove_server_emoji('f2950000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
                                                             '295e0000-0000-0000-0000-00000000000a')$q$,
                 '42501', 'EMOJI_NOT_LINKED: the bridge removes only emoji it imported',
                 'after a manager restores it, the bridge does not remove it again');
SELECT is((SELECT deleted_at FROM public.emojis WHERE id = '295e0000-0000-0000-0000-00000000000a'), NULL,
          'it stays');
SELECT is((SELECT status FROM public.bridge_import_server_emoji('f2950000-0000-0000-0000-0000000000b1',
              '55555555-0000-0000-0000-000000000005', '2951', 'honk295_renamed', 'https://x', true)), 'updated',
          'the bridge may still rename it');
SELECT throws_ok($q$SELECT public.bridge_remove_server_emoji('f2950000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
                                                             '295e0000-0000-0000-0000-00000000000a')$q$,
                 '42501', 'EMOJI_NOT_LINKED: the bridge removes only emoji it imported',
                 'and it stays the manager''s after the rename');
SELECT is(public.bridge_remove_server_emoji('f2950000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005',
                                            '295e0000-0000-0000-0000-00000000000b'),
          'removed', 'another imported emoji is still the bridge''s to remove');

SELECT * FROM finish();
ROLLBACK;
