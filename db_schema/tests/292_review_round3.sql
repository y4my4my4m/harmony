-- 20261115600001_bridge_author_indexes.sql and 20261115700001_review_round3.sql.
--
-- Fixture server_1 (alice owns, bob is a member) with #general. Added: bridge292 run by bot292,
-- paired with #general, relayed rows of Discord author dana (...9001); copy292, a server copy.
-- 203.0.113.0/24 is a documentation range and counts as public.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(20);

-- Captcha verdicts. -------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.verdict(p_codes text) RETURNS text LANGUAGE sql AS $fn$
    SELECT public.signup_captcha_verdict(200, '{"success": false, "error-codes": ' || p_codes || '}')
$fn$;
SELECT is(pg_temp.verdict('["invalid-widget-id"]'), 'error', 'a Turnstile widget gone gives no verdict');
SELECT is(pg_temp.verdict('["invalid-parsed-secret"]'), 'error', 'nor a secret Turnstile cannot parse');
SELECT is(pg_temp.verdict('["missing-remoteip"]'), 'error', 'nor an address hCaptcha wants and lacks');
SELECT is(pg_temp.verdict('["invalid-remoteip"]'), 'error', 'nor one it refuses');
SELECT is(pg_temp.verdict('["sitekey-secret-mismatch"]'), 'fail', 'a token of another site key still fails');

-- The sign-up hook runs its checks when the captcha call fails. -----------------------------------
SELECT ok(has_function_privilege(
              (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
                WHERE p.proname = 'before_user_created_hook' AND p.pronamespace = 'public'::regnamespace),
              'public.signup_captcha_verify(text, text, text, text)', 'EXECUTE'),
          'the hook''s owner may call the captcha check');

INSERT INTO public.instance_config (config_key, config_value) VALUES
  ('signup_captcha_provider', '"turnstile"'), ('signup_captcha_site_key', '"0x4AAAAAAA-site"'),
  ('signup_captcha_secret', '"0x4AAAAAAA-secret"'), ('signup_blocked_email_domains', '["blocked292.test"]')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
CREATE OR REPLACE FUNCTION public.signup_captcha_verify(p_provider text, p_secret text, p_token text, p_remote_ip text)
RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'permission denied for function signup_captcha_verify' USING ERRCODE = '42501';
END
$fn$;
CREATE FUNCTION pg_temp.signup(p_email text, p_token text) RETURNS jsonb LANGUAGE sql AS $fn$
    SELECT public.before_user_created_hook(jsonb_build_object(
        'metadata', jsonb_build_object('uuid', gen_random_uuid(), 'time', now(), 'name', 'before-user-created',
                                       'ip_address', '203.0.113.92'),
        'user', jsonb_build_object('email', p_email, 'app_metadata', jsonb_build_object('provider', 'email'),
                                   'user_metadata', jsonb_build_object('captcha_token', p_token))))
$fn$;
SELECT is((pg_temp.signup('x292@blocked292.test', 'any-token') #>> '{error,http_code}')::integer, 422,
          'a token whose check fails does not get a blocked domain past the hook');

-- Erase. ------------------------------------------------------------------------------------------
INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('f2920000-0000-0000-0000-0000000000b1', 'bot292', 'Bot 292', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by)
VALUES ('f2920000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'self',
        'f2920000-0000-0000-0000-0000000000b1', '900000000000000292', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id, direction) VALUES
  ('f2920000-0000-0000-0000-0000000000d1', '66666666-0000-0000-0000-000000000006', '2920000000000000001', 'both');
INSERT INTO public.messages (id, bot_id, channel_id, content, metadata) VALUES
  ('f2920000-0000-0000-0000-0000000000a1', 'f2920000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
   '[{"type": "text", "text": "dana"}]', '{"discord_user": {"id": "2920000000000009001"}, "discord_message_id": "2920000000000010001", "bot": true}');
-- Bob starts a thread on dana's message, under his own title.
INSERT INTO public.threads (id, channel_id, parent_message_id, name)
VALUES ('f2920000-0000-0000-0000-0000000000c1', '66666666-0000-0000-0000-000000000006',
        'f2920000-0000-0000-0000-0000000000a1', 'bob''s question');
INSERT INTO public.messages (bot_id, channel_id, thread_id, content, metadata) VALUES
  ('f2920000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 'f2920000-0000-0000-0000-0000000000c1',
   '[{"type": "text", "text": "reply"}]', '{"discord_user": {"id": "2920000000000009009"}, "bot": true}');
SELECT public.bridge_privacy_erase('55555555-0000-0000-0000-000000000005', 'discord', '2920000000000009001', 50);
SELECT is((SELECT name FROM public.threads WHERE id = 'f2920000-0000-0000-0000-0000000000c1'), 'bob''s question',
          'a thread someone else started on the erased author''s message keeps its title');

SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2920000000000009001', false);
SELECT is(public.bridge_privacy_erase_tail('55555555-0000-0000-0000-000000000005', 'discord', '2920000000000009001', 50),
          '{"opted_out": false, "erased": 0, "more": false}'::jsonb, 'after an opt-in the erase''s tail stops');
SELECT is((SELECT count(*)::int FROM public.bridge_remote_optouts WHERE remote_user_id = '2920000000000009001'), 0,
          'and does not opt the user out again');
SELECT public.bridge_privacy_set_optout('55555555-0000-0000-0000-000000000005', 'discord', '2920000000000009002', true);
SELECT is(public.bridge_privacy_erase_tail('55555555-0000-0000-0000-000000000005', 'discord', '2920000000000009002', 50) ->> 'opted_out',
          'true', 'while opted out it erases');
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_privacy_erase_tail(uuid, text, text, integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.bridge_privacy_erase_tail(uuid, text, text, integer)', 'EXECUTE'),
          'the tail is for the service role alone');

SELECT ok(EXISTS (SELECT 1 FROM pg_index x WHERE x.indexrelid = 'public.idx_reactions_discord_author'::regclass AND x.indisvalid)
          AND EXISTS (SELECT 1 FROM pg_index x WHERE x.indexrelid = 'public.idx_automod_events_author_key'::regclass AND x.indisvalid),
          'relayed reactions and AutoMod events are found by author');

-- Eviction of a copy's dropped emojis. --------------------------------------------------------------
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, is_local)
VALUES ('f2920000-0000-0000-0000-0000000000e1', 'remote292', 'Remote 292', 'remote.test', 'https://remote.test/users/remote292', false);
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id)
VALUES ('f2920000-0000-0000-0000-0000000000f0', 'Copy 292', 'f2920000-0000-0000-0000-0000000000e1', false, true,
        'remote.test', 'https://remote.test/servers/f2920000-0000-0000-0000-0000000000f0');
CREATE FUNCTION pg_temp.dropped(p_n int, p_created interval, p_deleted interval, p_by uuid DEFAULT NULL) RETURNS void
LANGUAGE sql AS $fn$
    INSERT INTO public.emojis (id, name, url, server_id, scope, domain, ap_id, created_at, deleted_at, deleted_by)
    VALUES (('f2920000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid, 'd292_' || p_n,
            'https://remote.test/e/' || p_n || '.webp', 'f2920000-0000-0000-0000-0000000000f0', 'server', 'remote.test',
            'https://remote.test/servers/f2920000-0000-0000-0000-0000000000f0/emojis/' || p_n,
            now() - p_created, now() - p_deleted, p_by)
$fn$;
SELECT pg_temp.dropped(1, '3 hours', '1 minute');    -- the most recent drop: kept
SELECT pg_temp.dropped(2, '3 hours', '2 hours');     -- past the one kept, old: evicted
SELECT pg_temp.dropped(3, '3 hours', '3 hours');     -- past it, named by a reaction: kept
SELECT pg_temp.dropped(4, '10 minutes', '5 minutes'); -- inserted within the hour: kept
SELECT pg_temp.dropped(5, '3 hours', '4 hours', '11111111-0000-0000-0000-000000000001'); -- an admin's removal: kept
INSERT INTO public.reactions (message_id, bot_id, emoji_id, channel_id)
VALUES ('88888888-0000-0000-0000-000000000008', 'f2920000-0000-0000-0000-0000000000b1',
        'f2920000-0000-0000-0000-000000000103', '66666666-0000-0000-0000-000000000006');
SELECT is(public.evict_copy_emojis('f2920000-0000-0000-0000-0000000000f0', 1), 1, 'one dropped emoji is evicted');
SELECT is((SELECT array_agg(right(id::text, 2) ORDER BY id) FROM public.emojis WHERE server_id = 'f2920000-0000-0000-0000-0000000000f0'),
          ARRAY['01', '03', '04', '05'], 'the recent one, the named one, the new one and the admin''s removal stay');
SELECT is(public.evict_copy_emojis('55555555-0000-0000-0000-000000000005', 0), 0, 'a local server''s emojis are not a copy''s');
SELECT ok(NOT has_function_privilege('authenticated', 'public.evict_copy_emojis(uuid, integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.evict_copy_emojis(uuid, integer)', 'EXECUTE'),
          'eviction is for the service role alone');

-- Thread titles named by the notice still change (291), and a deleted copy's emoji follows detach. -------
SELECT is((SELECT count(*)::int FROM public.emojis WHERE id = 'f2920000-0000-0000-0000-000000000102'), 0, 'the evicted row is gone');
SELECT is((SELECT emoji_id FROM public.reactions WHERE emoji_id = 'f2920000-0000-0000-0000-000000000103'),
          'f2920000-0000-0000-0000-000000000103'::uuid, 'the reaction keeps its emoji');
SELECT is(public.evict_copy_emojis('f2920000-0000-0000-0000-0000000000f0', 1), 0, 'a second call finds nothing more');

SELECT * FROM finish();
ROLLBACK;
