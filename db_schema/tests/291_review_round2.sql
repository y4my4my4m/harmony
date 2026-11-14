-- 20261115400001_notifications_message_index.sql and 20261115500001_review_round2.sql.
--
-- Fixture server_1 (alice owns, bob is a member) with #general. Added: bridge291 run by bot291,
-- paired with #general, relayed rows of Discord author dana (...9001); copy291, a server copy with
-- 3 mirrored emojis under a cap of 2.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(29);

-- Captcha verdicts. -------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.verdict(p_codes text) RETURNS text LANGUAGE sql AS $fn$
    SELECT public.signup_captcha_verdict(200, '{"success": false, "error-codes": ' || p_codes || '}')
$fn$;
SELECT is(pg_temp.verdict('["sitekey-secret-mismatch"]'), 'fail',
          'a token minted on another site key is refused');
SELECT is(pg_temp.verdict('["bad-request"]'), 'fail', 'a malformed request about the token is refused');
SELECT is(pg_temp.verdict('["invalid-input-response"]'), 'fail', 'an invalid token is refused');
SELECT is(pg_temp.verdict('[]'), 'fail', 'a refusal naming no code is refused');
SELECT is(pg_temp.verdict('["invalid-input-secret"]'), 'error', 'the instance''s own secret gives no verdict');
SELECT is(pg_temp.verdict('["internal-error"]'), 'error', 'nor does the provider failing');
SELECT is(public.signup_captcha_verdict(503, ''), 'error', 'nor an answer that is not 200');
SELECT is(public.signup_captcha_verdict(200, '{"success": true}'), 'pass', 'a passing token passes');

-- Fixture. ----------------------------------------------------------------------------------------
INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f2910000-0000-0000-0000-0000000000b1', 'bot291', 'Bot 291', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f2910000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f2910000-0000-0000-0000-0000000000b1', '900000000000000291', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f2910000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '2910000000000000001', 'both');

CREATE FUNCTION pg_temp.optout(p_user text) RETURNS text LANGUAGE sql AS $fn$
    SELECT COALESCE((SELECT source || CASE WHEN self_opted_out THEN '+self' ELSE '' END
                       FROM public.bridge_remote_optouts
                      WHERE server_id = '55555555-0000-0000-0000-000000000005' AND remote_user_id = p_user), 'none')
$fn$;

-- The user's opt-out and a manager's removal are separate decisions. --------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009001');
SELECT tests.clear_authentication();
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009001', true);
SELECT is(pg_temp.optout('2910000000000009001'), 'manager+self', 'a removed user who opts out keeps the manager''s removal');
SELECT is(public.bridge_privacy_status('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009001') ->> 'self',
          'true', 'status says the user opted out too');
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009001', false);
SELECT is(pg_temp.optout('2910000000000009001'), 'manager', 'opting in does not lift the manager''s removal');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_restore_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009001'),
          true, 'the manager restores');
SELECT tests.clear_authentication();
SELECT is(pg_temp.optout('2910000000000009001'), 'none', 'and nothing is left');

SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009002', true);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009002');
SELECT is(pg_temp.optout('2910000000000009002'), 'manager+self', 'a manager removes a user who opted out');
SELECT is(public.bridge_privacy_restore_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009002'),
          true, 'and restores');
SELECT tests.clear_authentication();
SELECT is(pg_temp.optout('2910000000000009002'), 'self+self', 'the user''s own opt-out stays');
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009002', false);
SELECT is(pg_temp.optout('2910000000000009002'), 'none', 'until the user opts in');

-- Reactions of an opted-out author. ---------------------------------------------------------------
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009003', true);
INSERT INTO public.messages (id, bot_id, channel_id, content, metadata) VALUES
  ('f2910000-0000-0000-0000-0000000000a9', 'f2910000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
   '[{"type": "text", "text": "zed"}]', '{"discord_user": {"id": "2910000000000009009"}, "discord_message_id": "2910000000000010009", "bot": true}');
SELECT throws_ok($q$INSERT INTO public.reactions (message_id, bot_id, custom_emoji_content, metadata)
                    VALUES ('f2910000-0000-0000-0000-0000000000a9', 'f2910000-0000-0000-0000-0000000000b1', 'x',
                            '{"discord_user": {"id": "2910000000000009003"}}')$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'a relayed reaction of an opted-out author is refused');
SELECT lives_ok($q$INSERT INTO public.reactions (message_id, bot_id, custom_emoji_content, metadata)
                   VALUES ('f2910000-0000-0000-0000-0000000000a9', 'f2910000-0000-0000-0000-0000000000b1', 'y',
                           '{"discord_user": {"id": "2910000000000009009"}}')$q$,
                'another author''s reaction is stored');

-- Erase: notifications, thread titles, import requests. -------------------------------------------
INSERT INTO public.messages (id, bot_id, channel_id, content, metadata) VALUES
  ('f2910000-0000-0000-0000-0000000000a1', 'f2910000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
   '[{"type": "text", "text": "secret words"}]', '{"discord_user": {"id": "2910000000000009004"}, "discord_message_id": "2910000000000010001", "bot": true}'),
  ('f2910000-0000-0000-0000-0000000000a2', 'f2910000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
   '[{"type": "text", "text": "a thread of mine"}]', '{"discord_user": {"id": "2910000000000009004"}, "discord_message_id": "2910000000000010002", "bot": true}');
INSERT INTO public.threads (id, channel_id, parent_message_id, name)
VALUES ('f2910000-0000-0000-0000-0000000000c1', '66666666-0000-0000-0000-000000000006',
        'f2910000-0000-0000-0000-0000000000a2', 'my private title');
INSERT INTO public.messages (id, bot_id, channel_id, thread_id, content, metadata) VALUES
  ('f2910000-0000-0000-0000-0000000000a3', 'f2910000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
   'f2910000-0000-0000-0000-0000000000c1', '[{"type": "text", "text": "reply"}]',
   '{"discord_user": {"id": "2910000000000009009"}, "discord_message_id": "2910000000000010003", "bot": true}');
INSERT INTO public.notifications (user_id, type, data) VALUES
  ('22222222-0000-0000-0000-000000000002', 'mention',
   '{"message_id": "f2910000-0000-0000-0000-0000000000a1", "preview": "secret words", "sender_username": "u4"}'),
  ('22222222-0000-0000-0000-000000000002', 'mention',
   '{"message_id": "f2910000-0000-0000-0000-0000000000a3", "preview": "reply"}');
SELECT is(public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2910000000000009004', 50) ->> 'erased',
          '2', 'dana''s two messages are erased');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE data ->> 'message_id' = 'f2910000-0000-0000-0000-0000000000a1'), 0,
          'the notification quoting her message is gone');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE data ->> 'message_id' = 'f2910000-0000-0000-0000-0000000000a3'), 1,
          'one quoting another author stays');
SELECT is((SELECT name FROM public.threads WHERE id = 'f2910000-0000-0000-0000-0000000000c1'), 'Thread',
          'the thread she started loses her title');

-- A thread an opted-out author starts. ------------------------------------------------------------
SELECT public.bot_create_thread('f2910000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
                                'her own words', NULL, '2910000000000020001', '{"id": "2910000000000009003"}'::jsonb);
SELECT is((SELECT t.name FROM public.threads t JOIN public.discord_bridge_threads bt ON bt.thread_id = t.id
            WHERE bt.discord_thread_id = '2910000000000020001'), 'Thread', 'is created under the name Thread');

-- A copy's mirrored emoji is outside the cap. -----------------------------------------------------
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
INSERT INTO public.instance_config (config_key, config_value) VALUES ('max_custom_emojis_per_server', '2'::jsonb)
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, is_local)
VALUES ('f2910000-0000-0000-0000-0000000000e1', 'remote291', 'Remote 291', 'remote.test', 'https://remote.test/users/remote291', false);
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id)
VALUES ('f2910000-0000-0000-0000-0000000000f0', 'Copy 291', 'f2910000-0000-0000-0000-0000000000e1', false, true,
        'remote.test', 'https://remote.test/servers/f2910000-0000-0000-0000-0000000000f0');
INSERT INTO public.emojis (id, name, url, server_id, scope, domain, ap_id, deleted_at, deleted_by)
SELECT ('f2910000-0000-0000-0000-00000000010' || g)::uuid, 'm291_' || g, 'https://remote.test/e/' || g || '.webp',
       'f2910000-0000-0000-0000-0000000000f0', 'server', 'remote.test',
       'https://remote.test/servers/f2910000-0000-0000-0000-0000000000f0/emojis/' || g,
       CASE WHEN g = 1 THEN now() END, CASE WHEN g = 1 THEN '11111111-0000-0000-0000-000000000001'::uuid END
  FROM generate_series(1, 3) g;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.restore_emoji('f2910000-0000-0000-0000-000000000101')$q$,
                'an admin restores a copy''s emoji with the cap reached');
SELECT tests.clear_authentication();

-- Mirrored files no message names. ----------------------------------------------------------------
INSERT INTO public.messages (bot_id, channel_id, content, media_paths) VALUES
  ('f2910000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', '[{"type": "text", "text": "f"}]',
   ARRAY['c/66666666-0000-0000-0000-000000000006/bridge/b/kept.png']);
INSERT INTO public.messages (bot_id, channel_id, content, media_paths, is_deleted) VALUES
  ('f2910000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', '[{"type": "text", "text": "g"}]',
   ARRAY['c/66666666-0000-0000-0000-000000000006/bridge/b/deleted.png'], true);
SELECT is((SELECT array_agg(x ORDER BY x) FROM unnest(public.bridge_mirror_unreferenced(ARRAY[
              'c/66666666-0000-0000-0000-000000000006/bridge/b/kept.png',
              'c/66666666-0000-0000-0000-000000000006/bridge/b/deleted.png',
              'c/66666666-0000-0000-0000-000000000006/bridge/b/never.png',
              'c/66666666-0000-0000-0000-000000000006/other.png'])) x),
          ARRAY['c/66666666-0000-0000-0000-000000000006/bridge/b/deleted.png',
                'c/66666666-0000-0000-0000-000000000006/bridge/b/never.png'],
          'the mirrored files no live message names, mirror paths only');
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_mirror_unreferenced(text[])', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_mirror_unreferenced(text[])', 'EXECUTE'),
          'for the service role alone');

-- Member lists keep a member who blocks the caller. -----------------------------------------------
INSERT INTO public.user_presence (profile_id, status, published_status) VALUES
  ('22222222-0000-0000-0000-000000000002', 1, 1)
ON CONFLICT (profile_id) DO UPDATE SET status = 1, published_status = 1;
INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001');
SELECT is((SELECT present FROM public.server_member_presence('55555555-0000-0000-0000-000000000005',
                                                             '11111111-0000-0000-0000-000000000001', NULL, '22222222-0000-0000-0000-000000000002')),
          true, 'a member who blocks the viewer shows their status');
SELECT ok(EXISTS (SELECT 1 FROM pg_index x WHERE x.indexrelid = 'public.idx_notifications_message_id'::regclass AND x.indisvalid),
          'notifications are found by message');

SELECT * FROM finish();
ROLLBACK;
