-- 20261115800001_messages_relayed_channel_index.sql and 20261115900001_review_round4.sql.
--
-- Fixture server_1 (alice owns, bob is a member) with #general. Added: bridge293 run by bot293,
-- paired with #general; relayed rows of Discord authors ...9001 (3), ...9002 (250) and ...9003 (1);
-- copy293, a server copy. Carol (33333333) is made an instance admin for the instance purge.
-- 203.0.113.0/24 is a documentation range and counts as public.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(29);

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
CREATE FUNCTION pg_temp.pending(p_author text) RETURNS boolean LANGUAGE sql AS $fn$
    SELECT erase_pending FROM public.bridge_remote_optouts
     WHERE server_id = '55555555-0000-0000-0000-000000000005' AND remote_user_id = p_author
$fn$;

SELECT ok(EXISTS (SELECT 1 FROM pg_index x WHERE x.indexrelid = 'public.messages_discord_relayed_channel'::regclass AND x.indisvalid),
          'relayed messages are found by channel');

-- An erase with rows left is marked, listed for the gateway, and cleared when it ends.
SELECT pg_temp.relayed('2930000000000009001', 3);
SELECT is(public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009001', 1) ->> 'more',
          'true', 'a first batch leaves rows');
SELECT is(pg_temp.pending('2930000000000009001'), true, 'and marks the erase unfinished');
SELECT is((SELECT array_agg(remote_user_id) FROM public.bridge_privacy_pending(50)), ARRAY['2930000000000009001'],
          'the gateway is given it');
SELECT is(public.bridge_privacy_erase_tail('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009001', 50) ->> 'more',
          'false', 'the tail ends it');
SELECT is(pg_temp.pending('2930000000000009001'), false, 'and clears the mark');
SELECT is((SELECT count(*)::int FROM public.bridge_privacy_pending(50)), 0, 'nothing is left to resume');
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_privacy_pending(integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_privacy_pending(integer)', 'EXECUTE'),
          'the list is for the service role alone');

-- A manager's removal continues only while it stands.
SELECT pg_temp.relayed('2930000000000009002', 250);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_remove_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009002'),
          '{"erased": 200, "more": true}'::jsonb, 'a removal erases its first batch');
SELECT tests.clear_authentication();
SELECT is(pg_temp.pending('2930000000000009002'), true, 'and is marked unfinished');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.bridge_privacy_erase_continue('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009002')$q$,
                 '42501', NULL, 'a member without Manage Server cannot continue it');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.bridge_privacy_restore_remote_user('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009002');
SELECT is(public.bridge_privacy_erase_continue('55555555-0000-0000-0000-000000000005', 'discord', '2930000000000009002'),
          '{"erased": 0, "more": false}'::jsonb, 'after a restore the continuation erases nothing');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.bridge_remote_optouts WHERE remote_user_id = '2930000000000009002'), 0,
          'and does not remove the user again');
SELECT is(pg_temp.left_of('2930000000000009002'), 50, 'their remaining messages stay');

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

-- A deleted bridged thread is not imported again. ----------------------------------------------------
UPDATE public.instance_config SET config_value = '"self_run"'::jsonb WHERE config_key = 'bridge_history_import';
UPDATE public.instance_config SET config_value = '0'::jsonb
 WHERE config_key IN ('bridge_import_max_running', 'bridge_import_messages_per_minute');
SELECT count(*) FROM public.discord_bridge_import_start_internal('f2930000-0000-0000-0000-0000000000d1', NULL, 'harmony', NULL);
CREATE TEMP TABLE j293 AS
SELECT i.id FROM public.discord_bridge_imports i WHERE i.bridge_id = 'f2930000-0000-0000-0000-0000000000d1';
SELECT public.discord_bridge_import_update('f2930000-0000-0000-0000-0000000000d1', id, '{"state": "running"}') FROM j293;
CREATE FUNCTION pg_temp.import_thread() RETURNS uuid LANGUAGE sql AS $fn$
    SELECT public.bridge_import_thread('f2930000-0000-0000-0000-0000000000b1', (SELECT id FROM j293),
        jsonb_build_object('discord_thread_id', '2930000000000030001', 'name', 'Plans', 'created_at', '2020-02-01T10:00:00Z',
                           'archived', false, 'locked', false))
$fn$;
CREATE TEMP TABLE t293 AS SELECT pg_temp.import_thread() AS id;
SELECT set_config('harmony.history_import', 'false', true);
SELECT isnt((SELECT id FROM t293), NULL, 'a Discord thread is imported');
DELETE FROM public.threads WHERE id = (SELECT id FROM t293);
SELECT is((SELECT count(*)::int FROM public.discord_bridge_deleted_threads
            WHERE bridge_id = 'f2930000-0000-0000-0000-0000000000d1' AND discord_thread_id = '2930000000000030001'), 1,
          'deleting it records the Discord thread');
SELECT is(pg_temp.import_thread(), NULL, 'and the import does not create it again');
SELECT set_config('harmony.history_import', 'false', true);
SELECT ok(NOT has_table_privilege('authenticated', 'public.discord_bridge_deleted_threads', 'SELECT'),
          'members do not read the record');

-- The instance purge stops imports. ------------------------------------------------------------------
UPDATE public.profiles SET is_admin = true WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.bridge_privacy_purge_instance('discord');
SELECT tests.clear_authentication();
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'bridge_history_import'), '"off"'::jsonb,
          'history import is turned off');
SELECT is((SELECT state || ':' || error FROM public.discord_bridge_imports WHERE id = (SELECT id FROM j293)),
          'failed:instance_purged', 'and an unfinished import fails');

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
