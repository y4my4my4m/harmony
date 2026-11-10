-- Instance write limits after 20261109200001_instance_write_limits.sql: settings, counts, rates, exempt
-- accounts, bot REST ceiling, Drive total.
--
--   alice    instance admin (fixture)
--   bob      plain account
--   mallory  plain account in no server
--   carol    plain account old enough not to count as new
-- Each limit is set low for the transaction. now() is fixed inside it, so windows do not pass.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(71);

CREATE FUNCTION pg_temp.set_antispam(p jsonb) RETURNS void LANGUAGE sql AS $$
  UPDATE public.instance_config SET config_value = config_value || p WHERE config_key = 'antispam';
$$;

-- Settings -------------------------------------------------------------------------------------------
SELECT is((SELECT config_value ->> 'new_account_messages_per_minute' FROM tests.new_install_antispam), '20',
          'a new install stores 20 new-account messages per minute');
SELECT is((SELECT config_value ->> 'new_account_posts_per_hour' FROM tests.new_install_antispam), '20',
          'and 20 posts per hour');
SELECT is((SELECT config_value ->> 'new_account_max_stranger_mentions' FROM tests.new_install_antispam), '5',
          'and 5 stranger mentions');
SELECT is((SELECT config_value ->> 'new_account_block_links' FROM tests.new_install_antispam), 'false',
          'and leaves links allowed');
SELECT ok(NOT (SELECT config_value ? 'account_messages_per_minute' FROM public.instance_config WHERE config_key = 'antispam'),
          'the stored row holds no account limit: defaults come from antispam_settings()');

SELECT is(public.antispam_settings() ->> 'account_messages_per_minute', '120', 'messages default to 120 per minute');
SELECT is(public.antispam_settings() ->> 'account_posts_per_hour', '100', 'posts default to 100 per hour');
SELECT is(public.antispam_settings() ->> 'account_reactions_per_minute', '240', 'reactions default to 240 per minute');
SELECT is(public.antispam_settings() ->> 'account_follows_per_hour', '200', 'follows default to 200 per hour');
SELECT is(public.antispam_settings() ->> 'account_joins_per_hour', '60', 'joins default to 60 per hour');
SELECT is(public.antispam_settings() ->> 'account_servers_per_hour', '10', 'servers default to 10 per hour');
SELECT is(public.antispam_settings() ->> 'account_stranger_dms_per_hour', '30', 'stranger conversations default to 30 per hour');
SELECT is(public.antispam_settings() ->> 'new_account_stranger_dms_per_hour', '5', 'and 5 for new accounts');
SELECT is(public.antispam_settings() ->> 'bot_requests_per_minute', '600', 'bots default to 600 requests per minute');
SELECT is(public.antispam_settings() ->> 'bridge_requests_per_minute', '3000', 'linked bridges to 3000');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'max_servers_per_user'), '100'::jsonb, '100 servers per account');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'max_bots_per_user'), '25'::jsonb, '25 bots per account');
SELECT is((SELECT config_value FROM public.instance_config WHERE config_key = 'drive_instance_limit_mb'), '0'::jsonb, 'no Drive total');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.update_instance_antispam_settings('{"account_messages_per_minute": 1}'::jsonb)$q$,
                 '42501', NULL, 'only instance admins change them');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.update_instance_antispam_settings('{"account_messages_per_minute": 77, "bot_requests_per_minute": 0}'::jsonb)
              ->> 'account_messages_per_minute', '77', 'an admin sets one');
SELECT throws_ok($q$SELECT public.update_instance_antispam_settings('{"account_posts_per_hour": -1}'::jsonb)$q$,
                 '22023', NULL, 'a negative limit is refused');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT is(public.antispam_settings() ->> 'bot_requests_per_minute', '0', 'and turns another off');

-- Messages -------------------------------------------------------------------------------------------
SELECT pg_temp.set_antispam('{"account_messages_per_minute": 2}');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                   VALUES ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"one"}]'),
                          ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"two"}]')$q$,
                'an account writes up to its limit');
SELECT throws_like($q$INSERT INTO public.messages (channel_id, user_id, content)
                      VALUES ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"three"}]')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'the next message is refused');
SELECT throws_like($q$INSERT INTO public.messages (conversation_id, user_id, content)
                      VALUES ('77777777-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"dm"}]')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'a direct message counts against the same limit');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                   SELECT '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"staff"}]'
                     FROM generate_series(1, 3)$q$,
                'an instance admin is exempt');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                   SELECT '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"no jwt"}]'
                     FROM generate_series(1, 3)$q$,
                'a write without the account''s JWT is not counted');

SELECT is(public.antispam_check_local_author('22222222-0000-0000-0000-000000000002', 'message', '[]'::jsonb, 'UPDATE'),
          false, 'an edit is not counted');
SELECT pg_temp.set_antispam('{"account_messages_per_minute": 0, "new_account_messages_per_minute": 1}');
DELETE FROM public.automod_recent_activity WHERE user_id = '22222222-0000-0000-0000-000000000002';
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                   SELECT '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"backend"}]'
                     FROM generate_series(1, 3)$q$,
                'the new-account rate does not count a backend write on the account''s behalf');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                   VALUES ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"own"}]')$q$,
                'the new account''s own first write passes');
SELECT throws_like($q$INSERT INTO public.messages (channel_id, user_id, content)
                      VALUES ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"own two"}]')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'and its second within the minute is refused');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT pg_temp.set_antispam('{"account_messages_per_minute": 2, "new_account_messages_per_minute": 0}');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::integer FROM public.messages WHERE user_id = '22222222-0000-0000-0000-000000000002'
            AND content::text LIKE '%three%'), 0, 'the refused message was not stored');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT pg_temp.set_antispam('{"account_messages_per_minute": 0}');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.messages (channel_id, user_id, content)
                   VALUES ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"off"}]')$q$,
                '0 turns the limit off');
RESET ROLE;
SELECT tests.clear_authentication();

-- Posts ----------------------------------------------------------------------------------------------
SELECT pg_temp.set_antispam('{"account_posts_per_hour": 1}');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.posts (id, author_id, content, visibility)
                   VALUES ('c2470000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"p1"}]', 'public')$q$,
                'a post within the limit');
SELECT throws_like($q$INSERT INTO public.posts (author_id, content, visibility)
                      VALUES ('22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"p2"}]', 'public')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'the next post is refused');
RESET ROLE;
SELECT tests.clear_authentication();

-- Reactions, follows, joins --------------------------------------------------------------------------
SELECT pg_temp.set_antispam('{"account_reactions_per_minute": 1, "account_follows_per_hour": 1, "account_joins_per_hour": 1}');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
                   VALUES ('88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002', '👍')$q$,
                'a reaction within the limit');
SELECT throws_like($q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
                      VALUES ('88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002', '👀')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'the next reaction is refused');
SELECT throws_like($q$INSERT INTO public.post_interactions (user_id, post_id, interaction_type)
                      VALUES ('22222222-0000-0000-0000-000000000002', 'c2470000-0000-0000-0000-000000000001', 'favorite')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'a favourite counts as a reaction');
SELECT lives_ok($q$INSERT INTO public.post_interactions (user_id, post_id, interaction_type)
                   VALUES ('22222222-0000-0000-0000-000000000002', 'c2470000-0000-0000-0000-000000000001', 'bookmark')$q$,
                'a bookmark does not');
SELECT lives_ok($q$INSERT INTO public.follows (follower_id, following_id)
                   VALUES ('22222222-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003')$q$,
                'a follow within the limit');
SELECT throws_like($q$INSERT INTO public.follows (follower_id, following_id)
                      VALUES ('22222222-0000-0000-0000-000000000002', '44444444-0000-0000-0000-000000000004')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'the next follow is refused');
RESET ROLE;
SELECT tests.clear_authentication();

INSERT INTO public.servers (id, name, owner, public)
VALUES ('c2470000-0000-0000-0000-00000000000a', 'Open A', '11111111-0000-0000-0000-000000000001', true),
       ('c2470000-0000-0000-0000-00000000000b', 'Open B', '11111111-0000-0000-0000-000000000001', true);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok($q$SELECT public.join_public_server('c2470000-0000-0000-0000-00000000000a')$q$, 'a join within the limit');
SELECT throws_like($q$SELECT public.join_public_server('c2470000-0000-0000-0000-00000000000b')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'the next join is refused');
RESET ROLE;
SELECT tests.clear_authentication();

-- Servers --------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('t247.tpl', public.export_server_template('c2470000-0000-0000-0000-00000000000a')::text, true);
RESET ROLE;
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = '2'::jsonb WHERE config_key = 'max_servers_per_user';
SELECT pg_temp.set_antispam('{"account_joins_per_hour": 0, "account_servers_per_hour": 0}');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok($q$INSERT INTO public.servers (name, owner) VALUES ('M1', '33333333-0000-0000-0000-000000000003'),
                                                                  ('M2', '33333333-0000-0000-0000-000000000003')$q$,
                'an account owns servers up to the cap');
SELECT throws_like($q$INSERT INTO public.servers (name, owner) VALUES ('M3', '33333333-0000-0000-0000-000000000003')$q$,
                   'SERVER_LIMIT_REACHED:2', 'the next one is refused');
SELECT throws_like($q$SELECT public.create_server_from_template('M4', current_setting('t247.tpl')::jsonb)$q$,
                   'SERVER_LIMIT_REACHED:2', 'through a template as well');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT lives_ok($q$INSERT INTO public.servers (name, owner, is_local_server, ap_id, host_domain)
                   VALUES ('Copy', '33333333-0000-0000-0000-000000000003', false, 'https://remote247.example/g/1', 'remote247.example')$q$,
                'a federated copy is outside the cap');
UPDATE public.instance_config SET config_value = '0'::jsonb WHERE config_key = 'max_servers_per_user';
SELECT pg_temp.set_antispam('{"account_servers_per_hour": 1}');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT lives_ok($q$INSERT INTO public.servers (name, owner) VALUES ('Q1', '44444444-0000-0000-0000-000000000004')$q$,
                'cap 0 is no limit, and a server within the hourly rate');
SELECT throws_like($q$INSERT INTO public.servers (name, owner) VALUES ('Q2', '44444444-0000-0000-0000-000000000004')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'the next server within the hour is refused');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT pg_temp.set_antispam('{"account_servers_per_hour": 0}');

-- Bots -----------------------------------------------------------------------------------------------
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'max_bots_per_user';
INSERT INTO public.bots (id, username, display_name, bot_type, owner_id, is_public) VALUES
    ('c2470000-0000-0000-0000-0000000000b1', 'hook247', 'Hook', 'integration', '33333333-0000-0000-0000-000000000003', false);
INSERT INTO public.bots (id, username, display_name, bot_type, owner_id, is_public) VALUES
    ('c2470000-0000-0000-0000-0000000000b2', 'linked247', 'Linked', 'bridge', '33333333-0000-0000-0000-000000000003', false);
INSERT INTO public.discord_bridges (server_id, bot_id, mode)
VALUES ('c2470000-0000-0000-0000-00000000000a', 'c2470000-0000-0000-0000-0000000000b2', 'self');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$INSERT INTO public.bots (username, display_name, bot_type, owner_id)
                    VALUES ('direct247', 'Direct', 'bot', '33333333-0000-0000-0000-000000000003')$q$,
                 '42501', NULL, 'a client cannot insert a bot directly');
SELECT lives_ok($q$SELECT public.create_bot('capped247a')$q$, 'webhook and linked bridge bots do not count: the first bot is admitted');
SELECT throws_like($q$SELECT public.create_bot('capped247b')$q$, 'BOT_LIMIT_REACHED:1', 'the next bot is refused');
SELECT throws_like($q$SELECT public.create_bot('capped247c', NULL, NULL, 'bridge')$q$, 'BOT_LIMIT_REACHED:1',
                   'an unlinked bridge bot counts');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT ok(has_table_privilege('service_role', 'public.bots', 'INSERT'), 'service role keeps INSERT on bots');

-- Exempt accounts ------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.admin_set_limit_exempt('33333333-0000-0000-0000-000000000003', true)$q$,
                 '42501', NULL, 'only an instance admin exempts an account');
SELECT is((SELECT count(*)::integer FROM public.limit_exempt_accounts), 0, 'and a plain account reads none');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.admin_set_limit_exempt('33333333-0000-0000-0000-000000000003', true), true, 'an admin exempts an account');
SELECT is((SELECT count(*)::integer FROM public.limit_exempt_accounts), 1, 'and reads the list');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok($q$SELECT public.create_bot('capped247d')$q$, 'an exempt account passes the bot cap');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT ok(public.antispam_account_exempt('33333333-0000-0000-0000-000000000003'), 'the exemption is read');

-- Bot REST -------------------------------------------------------------------------------------------
INSERT INTO public.bots (id, username, display_name, bot_type, owner_id) VALUES
    ('c2470000-0000-0000-0000-0000000000b3', 'plain247', 'Plain', 'bot', '22222222-0000-0000-0000-000000000002'),
    ('c2470000-0000-0000-0000-0000000000b4', 'free247', 'Free', 'bot', '33333333-0000-0000-0000-000000000003'),
    ('c2470000-0000-0000-0000-0000000000b5', 'flip247', 'Flip', 'bridge', '22222222-0000-0000-0000-000000000002');
SELECT pg_temp.set_antispam('{"bot_requests_per_minute": 3, "bridge_requests_per_minute": 5}');
SELECT is(public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b3', '/a', 1, 60)
          + public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b3', '/b', 1, 60)
          + public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b3', '/c', 1, 60), 0,
          'three requests on three routes are admitted');
SELECT cmp_ok(public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b3', '/d', 1, 60), '>', 0,
              'the fourth passes the overall ceiling on a route it never used, and answers seconds to wait');
SELECT is(public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b3', '/e', 100, 60), 0,
          'overall never reads below the route limit per minute');
SELECT cmp_ok(public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b3', '/e', 1, 60), '>', 0,
              'a route past its own limit is refused');
SELECT is(public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b4', '/a', 1, 60)
          + public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b4', '/b', 1, 60)
          + public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b4', '/c', 1, 60)
          + public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b4', '/d', 1, 60), 0,
          'a bot whose owner is exempt has no overall ceiling');
SELECT is(public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b2', '/a', 1, 60)
          + public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b2', '/b', 1, 60)
          + public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b2', '/c', 1, 60)
          + public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b2', '/d', 1, 60), 0,
          'a linked bridge has the bridge ceiling');
SELECT is(public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b5', '/a', 1, 60)
          + public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b5', '/b', 1, 60)
          + public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b5', '/c', 1, 60), 0,
          'an unlinked bridge bot starts as any bot');
SELECT cmp_ok(public.check_and_increment_bot_rate_limit('c2470000-0000-0000-0000-0000000000b5', '/d', 1, 60), '>', 0,
              'and has the bot ceiling: bot_type alone earns nothing');
SELECT ok(NOT has_function_privilege('authenticated', 'public.check_and_increment_bot_rate_limit(uuid, text, integer, integer)', 'EXECUTE'),
          'the limiter is closed to clients');

-- Drive ----------------------------------------------------------------------------------------------
INSERT INTO public.drive_files (owner_id, bucket, path, name, size_bytes, state)
VALUES ('11111111-0000-0000-0000-000000000001', 'message_media', 'c247/a.bin', 'a.bin', 2097152, 'drive');
UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'drive_instance_limit_mb';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.drive_can_upload(), false, 'past the instance total a plain account cannot upload');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.drive_can_upload(), true, 'an instance admin can');

SELECT * FROM finish();
ROLLBACK;
