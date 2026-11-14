-- 20261115800001_privacy_erase_indexes.sql and 20261115900001_review_round4.sql.
--
-- Fixture server_1 (alice owns, bob is a member) with #general. Added: bridge293 run by bot293,
-- paired with #general; relayed rows of Discord authors ...9001 (3), ...9002 (250), ...9003 (1),
-- ...9004 (250) and ...9005 (3); an AutoMod event and alert of ...9006; copy293, a server copy. Carol (33333333) is made an instance admin for the instance purge.
-- 203.0.113.0/24 is a documentation range and counts as public.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(35);

-- Captcha. ----------------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.verdict(p_codes text) RETURNS text LANGUAGE sql AS $fn$
    SELECT public.signup_captcha_verdict(200, '{"success": false, "error-codes": ' || p_codes || '}')
$fn$;
SELECT is(pg_temp.verdict('["invalid-remoteip"]'), 'fail', 'an answer about an address refuses the token');
SELECT is(pg_temp.verdict('["missing-remoteip"]'), 'fail', 'as does one about a missing address');
SELECT ok((SELECT prosrc FROM pg_proc WHERE oid = 'public.signup_captcha_check(text, text, text, text)'::regprocedure)
          !~ '&remoteip=', 'the provider is sent the token and the secret, no address');

INSERT INTO public.instance_config (config_key, config_value) VALUES
  ('signup_captcha_provider', '"turnstile"'), ('signup_captcha_site_key', '"0x4AAAAAAA-site"'),
  ('signup_captcha_secret', '"0x4AAAAAAA-secret"'), ('signup_captcha_mode', '"suspect"'),
  ('signup_blocked_email_domains', '["blocked293.test"]')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
CREATE TABLE tests.captcha_calls293 (token text);
CREATE OR REPLACE FUNCTION public.signup_captcha_verify(p_provider text, p_secret text, p_token text, p_remote_ip text)
RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
    INSERT INTO tests.captcha_calls293 VALUES (p_token);
    RETURN 'pass';
END
$fn$;
CREATE FUNCTION pg_temp.signup(p_email text, p_token text) RETURNS jsonb LANGUAGE sql AS $fn$
    SELECT public.before_user_created_hook(jsonb_build_object(
        'metadata', jsonb_build_object('uuid', gen_random_uuid(), 'time', now(), 'name', 'before-user-created',
                                       'ip_address', '203.0.113.93'),
        'user', jsonb_build_object('email', p_email, 'app_metadata', jsonb_build_object('provider', 'email'),
                                   'user_metadata', jsonb_build_object('captcha_token', p_token))))
$fn$;
SELECT is((pg_temp.signup('x293@blocked293.test', 'tok-blocked') #>> '{error,http_code}')::integer, 422,
          'a blocked domain is refused');
SELECT is((SELECT count(*)::int FROM tests.captcha_calls293), 0, 'without a call to the provider');
SELECT pg_temp.signup('y293@example.org', 'tok-allowed');
SELECT is((SELECT array_agg(token) FROM tests.captcha_calls293), ARRAY['tok-allowed'],
          'a sign-up past the refusals has its token checked');

-- Erase. ------------------------------------------------------------------------------------------
INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f2930000-0000-0000-0000-0000000000b1', 'bot293', 'Bot 293', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f2930000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f2930000-0000-0000-0000-0000000000b1', '900000000000000293', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f2930000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '2930000000000000001', 'both');
CREATE FUNCTION pg_temp.relayed(p_author text, p_n int) RETURNS void LANGUAGE sql AS $fn$
    INSERT INTO public.messages (bot_id, channel_id, content, metadata)
    SELECT 'f2930000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
           '[{"type": "text", "text": "relayed"}]',
           jsonb_build_object('discord_user', jsonb_build_object('id', p_author), 'bot', true)
      FROM generate_series(1, p_n)
$fn$;
CREATE FUNCTION pg_temp.left_of(p_author text) RETURNS int LANGUAGE sql AS $fn$
    SELECT count(*)::int FROM public.messages
     WHERE channel_id = '66666666-0000-0000-0000-000000000006' AND metadata -> 'discord_user' ->> 'id' = p_author
$fn$;
CREATE FUNCTION pg_temp.pending(p_author text) RETURNS text LANGUAGE sql AS $fn$
    SELECT COALESCE((SELECT COALESCE(erase_pending, 'none') FROM public.bridge_remote_optouts
                      WHERE server_id = '55555555-0000-0000-0000-000000000005' AND remote_user_id = p_author), 'no row')
$fn$;
CREATE FUNCTION pg_temp.listed() RETURNS text[] LANGUAGE sql AS $fn$
    SELECT COALESCE(array_agg(remote_user_id ORDER BY remote_user_id), '{}') FROM public.bridge_privacy_pending(50)
$fn$;

SELECT ok(EXISTS (SELECT 1 FROM pg_index x WHERE x.indexrelid = 'public.messages_discord_relayed_channel'::regclass AND x.indisvalid)
          AND EXISTS (SELECT 1 FROM pg_index x WHERE x.indexrelid = 'public.messages_automod_alert_event'::regclass AND x.indisvalid),
          'relayed messages are found by channel, AutoMod alerts by event');

-- A user's own erase with rows left is marked, listed for the gateway, and cleared when it ends.
SELECT pg_temp.relayed('2930000000000009001', 3);
SELECT is(public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009001', 1) ->> 'more',
          'true', 'a first batch leaves rows');
SELECT is(pg_temp.pending('2930000000000009001'), 'self', 'and marks the erase unfinished, asked by the user');
SELECT is(pg_temp.listed(), ARRAY['2930000000000009001'], 'the gateway is given it');
SELECT is(public.bridge_privacy_erase_tail('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009001', 50) ->> 'more',
          'false', 'the tail ends it');
SELECT is(pg_temp.pending('2930000000000009001'), 'none', 'and clears the mark');
SELECT is(pg_temp.listed(), '{}'::text[], 'nothing is left to resume');
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_privacy_pending(integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_privacy_pending(integer)', 'EXECUTE'),
          'the list is for the service role alone');

-- A manager's removal continues only while it stands.
SELECT pg_temp.relayed('2930000000000009002', 250);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009002')
              - 'removed', '{"erased": 200, "more": true}'::jsonb, 'a removal erases its first batch');
SELECT tests.clear_authentication();
SELECT is(pg_temp.pending('2930000000000009002'), 'manager', 'and is marked unfinished, asked by a manager');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.bridge_privacy_erase_continue('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009002')$q$,
                 '42501', NULL, 'a member without Manage Server cannot continue it');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.bridge_privacy_restore_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009002');
SELECT is(public.bridge_privacy_erase_continue('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009002'),
          '{"erased": 0, "more": false}'::jsonb, 'after a restore the continuation erases nothing');
SELECT tests.clear_authentication();
SELECT is(pg_temp.pending('2930000000000009002'), 'no row', 'and does not remove the user again');
SELECT is(pg_temp.left_of('2930000000000009002'), 50, 'their remaining messages stay');

-- A user who only opted out, then was removed and restored: the removal's erase ends with it.
SELECT pg_temp.relayed('2930000000000009004', 250);
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009004', true);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009004');
SELECT public.bridge_privacy_restore_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009004');
SELECT is(public.bridge_privacy_erase_continue('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009004'),
          '{"erased": 0, "more": false}'::jsonb, 'the manager''s continuation does not erase a user who only opted out');
SELECT tests.clear_authentication();
SELECT is(pg_temp.pending('2930000000000009004'), 'none', 'the restore ends the pending erase; the opt-out stays');
SELECT is(pg_temp.listed(), '{}'::text[], 'the gateway is not given it');
SELECT is(public.bridge_privacy_erase_tail('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009004', 50),
          '{"opted_out": true, "erased": 0, "more": false}'::jsonb, 'nor does a tail erase it');
SELECT is(pg_temp.left_of('2930000000000009004'), 50, 'their remaining messages stay');

-- A user's own erase outlives a manager's removal and its restore.
SELECT pg_temp.relayed('2930000000000009005', 250);
SELECT public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009005', 1);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009005');
SELECT public.bridge_privacy_restore_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009005');
SELECT tests.clear_authentication();
SELECT is(pg_temp.pending('2930000000000009005'), 'self', 'the erase the user asked for stays pending');
SELECT is(public.bridge_privacy_erase_tail('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009005', 100) ->> 'erased',
          '49', 'and goes on');

-- A thread anyone started on the erased author's message loses the title Discord took from it.
SELECT pg_temp.relayed('2930000000000009003', 1);
INSERT INTO public.threads (id, channel_id, parent_message_id, name)
SELECT 'f2930000-0000-0000-0000-0000000000c1', '66666666-0000-0000-0000-000000000006', m.id, 'words of 9003'
  FROM public.messages m WHERE m.metadata -> 'discord_user' ->> 'id' = '2930000000000009003';
INSERT INTO public.messages (bot_id, channel_id, thread_id, content, metadata) VALUES
  ('f2930000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 'f2930000-0000-0000-0000-0000000000c1',
   '[{"type": "text", "text": "reply"}]', '{"discord_user": {"id": "2930000000000009009"}, "bot": true}');
SELECT public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009003', 50);
SELECT is((SELECT name FROM public.threads WHERE id = 'f2930000-0000-0000-0000-0000000000c1'), 'Thread',
          'a thread on the erased author''s message is renamed, whoever started it');

-- An erased author's AutoMod alerts go with their events, and the batch counts them.
INSERT INTO public.automod_events (id, server_id, channel_id, bot_id, event_type, details) VALUES
  ('f2930000-0000-0000-0000-0000000000a6', '55555555-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006',
   'f2930000-0000-0000-0000-0000000000b1', 'message', '{"author_key": "discord:2930000000000009006", "author_name": "u6"}');
SELECT public.automod_post_alert('66666666-0000-0000-0000-000000000006', 'f2930000-0000-0000-0000-0000000000a6',
                                 'Blocked a message from @u6 (Discord): secret words',
                                 '{"author_key": "discord:2930000000000009006", "excerpt": "secret words"}');
SELECT is(public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009006', 50),
          '{"opted_out": true, "erased": 0, "more": false, "removed": 2}'::jsonb,
          'no message, the event and its alert');
SELECT is((SELECT count(*)::int FROM public.messages WHERE metadata ->> 'type' = 'automod_alert'
            AND metadata #>> '{automod,event_id}' = 'f2930000-0000-0000-0000-0000000000a6'), 0, 'the alert is gone');

-- Purges stop imports. ---------------------------------------------------------------------------------
INSERT INTO public.discord_bridge_imports (id, bridge_id, harmony_channel_id, discord_channel_id, state) VALUES
  ('f2930000-0000-0000-0000-0000000000f1', 'f2930000-0000-0000-0000-0000000000d1',
   '66666666-0000-0000-0000-000000000006', '2930000000000000001', 'running');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.bridge_privacy_purge_server('55555555-0000-0000-0000-000000000005', 'discord');
SELECT tests.clear_authentication();
SELECT is((SELECT state || ':' || error FROM public.discord_bridge_imports WHERE id = 'f2930000-0000-0000-0000-0000000000f1'),
          'failed:server_purged', 'a server purge fails the server''s unfinished import');

UPDATE public.instance_config SET config_value = '"self_run"'::jsonb WHERE config_key = 'bridge_history_import';
UPDATE public.discord_bridge_imports SET state = 'queued', error = NULL, finished_at = NULL
 WHERE id = 'f2930000-0000-0000-0000-0000000000f1';
UPDATE public.profiles SET is_admin = true WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.bridge_privacy_purge_instance('discord');
SELECT tests.clear_authentication();
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'bridge_history_import'), '"off"'::jsonb,
          'an instance purge turns history import off');
SELECT is((SELECT state || ':' || error FROM public.discord_bridge_imports WHERE id = 'f2930000-0000-0000-0000-0000000000f1'),
          'failed:instance_purged', 'and fails an unfinished import');

-- Eviction ranks every dropped row before it filters. ----------------------------------------------
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, is_local)
VALUES ('f2930000-0000-0000-0000-0000000000e1', 'remote293', 'Remote 293', 'remote.test', 'https://remote.test/users/remote293', false);
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id)
VALUES ('f2930000-0000-0000-0000-0000000000f0', 'Copy 293', 'f2930000-0000-0000-0000-0000000000e1', false, true,
        'remote.test', 'https://remote.test/servers/f2930000-0000-0000-0000-0000000000f0');
-- 1600 dropped within the hour (they stay), then one dropped hours ago: past any window of 1500.
INSERT INTO public.emojis (name, url, server_id, scope, domain, ap_id, created_at, deleted_at)
SELECT 'n293_' || n, 'https://remote.test/e/n' || n || '.webp', 'f2930000-0000-0000-0000-0000000000f0', 'server',
       'remote.test', 'https://remote.test/servers/f2930000-0000-0000-0000-0000000000f0/emojis/n' || n,
       now() - interval '10 minutes', now() - interval '1 minute' * (n % 9 + 1)
  FROM generate_series(1, 1600) AS n;
INSERT INTO public.emojis (id, name, url, server_id, scope, domain, ap_id, created_at, deleted_at)
VALUES ('f2930000-0000-0000-0000-000000000101', 'old293', 'https://remote.test/e/old.webp',
        'f2930000-0000-0000-0000-0000000000f0', 'server', 'remote.test',
        'https://remote.test/servers/f2930000-0000-0000-0000-0000000000f0/emojis/old',
        now() - interval '6 hours', now() - interval '5 hours');
SELECT is(public.evict_copy_emojis('f2930000-0000-0000-0000-0000000000f0', 1), 1,
          'a row past many that must stay is evicted');
SELECT is((SELECT count(*)::int FROM public.emojis WHERE id = 'f2930000-0000-0000-0000-000000000101'), 0, 'the old one');

SELECT * FROM finish();
ROLLBACK;
