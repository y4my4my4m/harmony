-- 20261117900002_matrix_authors.sql and 20261117900003_matrix_author_indexes.sql: Matrix authors
-- relayed by a Matrix bridge bot, AutoMod and notifications for them, remote-user privacy for
-- platform 'matrix'.
--
-- Server M (alice owns, instance admin; bob is a member) is created here, so it carries the
-- recommended AutoMod preset (more than 10 messages in 10 s: block + alert to #mod-log).
--   m1 mx304     alice's bot, bridge_platform 'matrix', install [one, two], bound to #one
--   d1 dc304     alice's bridge bot of M's discord_bridges row, paired with #one
--   o1 plain304  alice's ordinary bot, install [one]
-- Matrix authors are @u<n>:example.org. Gateway functions are called as postgres, their owner;
-- rows AutoMod judges are written as service_role (postgres is internal to it).

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(60);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;

INSERT INTO public.servers (id, name, owner) VALUES
  ('f3040000-0000-0000-0000-0000000000e1', 'Matrix 304', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f3040000-0000-0000-0000-0000000000c1', 'f3040000-0000-0000-0000-0000000000e1', 'one', 0),
  ('f3040000-0000-0000-0000-0000000000c2', 'f3040000-0000-0000-0000-0000000000e1', 'two', 0),
  ('f3040000-0000-0000-0000-0000000000c9', 'f3040000-0000-0000-0000-0000000000e1', 'mod-log', 0);
UPDATE public.server_automod_settings
   SET raid_settings = raid_settings || '{"enabled": false}'::jsonb,
       alert_channel_id = 'f3040000-0000-0000-0000-0000000000c9'
 WHERE server_id = 'f3040000-0000-0000-0000-0000000000e1';
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f3040000-0000-0000-0000-0000000000e1', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f3040000-0000-0000-0000-0000000000e1', 'accepted')
ON CONFLICT DO NOTHING;
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type, bridge_platform) VALUES
  ('f3040000-0000-0000-0000-0000000000b1', 'mx304', 'Matrix 304', '11111111-0000-0000-0000-000000000001', 'bot', 'matrix'),
  ('f3040000-0000-0000-0000-0000000000d1', 'dc304', 'Discord 304', '11111111-0000-0000-0000-000000000001', 'bridge', NULL),
  ('f3040000-0000-0000-0000-0000000000a1', 'plain304', 'Plain 304', '11111111-0000-0000-0000-000000000001', 'bot', NULL);
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, allowed_channel_ids) VALUES
  ('f3040000-0000-0000-0000-0000000000b1', 'f3040000-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-000000000001',
   ARRAY['f3040000-0000-0000-0000-0000000000c1', 'f3040000-0000-0000-0000-0000000000c2']::uuid[]),
  ('f3040000-0000-0000-0000-0000000000d1', 'f3040000-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-000000000001', NULL),
  ('f3040000-0000-0000-0000-0000000000a1', 'f3040000-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-000000000001',
   ARRAY['f3040000-0000-0000-0000-0000000000c1']::uuid[]);
INSERT INTO public.bridge_channels (bot_id, channel_id, platform) VALUES
  ('f3040000-0000-0000-0000-0000000000b1', 'f3040000-0000-0000-0000-0000000000c1', 'matrix');
INSERT INTO public.discord_bridges (id, server_id, mode, bot_id, discord_guild_id, created_by) VALUES
  ('f3040000-0000-0000-0000-0000000000f1', 'f3040000-0000-0000-0000-0000000000e1', 'self',
   'f3040000-0000-0000-0000-0000000000d1', '900000000000000304', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id) VALUES
  ('f3040000-0000-0000-0000-0000000000f1', 'f3040000-0000-0000-0000-0000000000c1', '3040000000000000001');

CREATE FUNCTION pg_temp.mu(p_n integer) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object('id', '@u' || p_n || ':example.org', 'username', 'u' || p_n,
                            'display_name', 'U ' || p_n, 'avatar_url', 'https://example.org/u' || p_n || '.png');
$fn$;
CREATE FUNCTION pg_temp.txt(p_text text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text));
$fn$;
-- Rows written; 0 when AutoMod dropped the row.
CREATE FUNCTION pg_temp.mx(p_bot text, p_channel text, p_meta jsonb, p_content jsonb, p_id uuid DEFAULT gen_random_uuid())
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.messages (id, channel_id, bot_id, content, metadata)
  VALUES (p_id, ('f3040000-0000-0000-0000-0000000000' || p_channel)::uuid,
          ('f3040000-0000-0000-0000-0000000000' || p_bot)::uuid, p_content, p_meta);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
CREATE FUNCTION pg_temp.author(p_user jsonb) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object('matrix_user', p_user, 'bridge_source', 'matrix', 'bot', true, 'created_via', 'bot_api');
$fn$;
-- SQLSTATE of relaying p_user through m1 into #one, 'ok' when written.
CREATE FUNCTION pg_temp.state(p_user jsonb) RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_temp.mx('b1', 'c1', pg_temp.author(p_user), pg_temp.txt('shape ' || md5(random()::text)));
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $fn$;
CREATE FUNCTION pg_temp.burst(p_n integer, p_count integer) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE i integer; total integer := 0;
BEGIN
  FOR i IN 1..p_count LOOP
    total := total + pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(p_n)), pg_temp.txt('message ' || i || ' ' || md5(random()::text)));
  END LOOP;
  RETURN total;
END $fn$;
GRANT EXECUTE ON FUNCTION pg_temp.mu(integer), pg_temp.txt(text), pg_temp.author(jsonb),
                         pg_temp.mx(text, text, jsonb, jsonb, uuid), pg_temp.burst(integer, integer) TO PUBLIC;

-- Guard -----------------------------------------------------------------------------------------------
SELECT is(pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(1)), pg_temp.txt('hello from Matrix'),
                     'f3040000-0000-0000-0000-000000000101'),
          1, 'the Matrix bridge relays a Matrix author in its channel');
SELECT throws_ok($q$SELECT pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(1)) || '{"bridge_author": {"platform": "matrix"}}', pg_temp.txt('x'))$q$,
                 '42501', 'metadata key reserved for the server: bridge_author', 'bridge_author is never stored');
SELECT throws_ok($q$SELECT pg_temp.mx('b1', 'c1', jsonb_build_object('bridge_author', pg_temp.mu(1) || '{"platform": "discord"}'), pg_temp.txt('x'))$q$,
                 '42501', 'metadata key reserved for the server: bridge_author', 'a Discord bridge_author is refused too');
SELECT throws_ok($q$SELECT pg_temp.mx('d1', 'c1', pg_temp.author(pg_temp.mu(1)), pg_temp.txt('x'))$q$,
                 '42501', 'matrix_user is written by the Matrix bridge of the channel',
                 'the Discord bridge of the channel relays no Matrix author');
SELECT throws_ok($q$SELECT pg_temp.mx('a1', 'c1', pg_temp.author(pg_temp.mu(1)), pg_temp.txt('x'))$q$,
                 '42501', 'matrix_user is written by the Matrix bridge of the channel', 'an ordinary bot relays none');
SELECT throws_ok($q$SELECT pg_temp.mx('b1', 'c2', pg_temp.author(pg_temp.mu(1)), pg_temp.txt('x'))$q$,
                 '42501', 'matrix_user is written by the Matrix bridge of the channel',
                 'the Matrix bot relays none in a channel it is not bound to');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                    VALUES ('f3040000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001',
                            pg_temp.txt('x'), pg_temp.author(pg_temp.mu(1)))$q$,
                 '42501', 'metadata key reserved for the server: matrix_user', 'a member''s row carries no Matrix author');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, content, metadata)
                    VALUES ('f3040000-0000-0000-0000-0000000000c1', pg_temp.txt('x'), pg_temp.author(pg_temp.mu(1)))$q$,
                 '42501', 'metadata key reserved for the server: matrix_user', 'a row without a bot carries none');
SELECT throws_ok($q$SELECT pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(1))
                        || '{"interaction": {"user_id": "22222222-0000-0000-0000-000000000002"}}', pg_temp.txt('x'))$q$,
                 '42501', 'metadata key reserved for the server: matrix_user', 'a slash command reply carries none');
SELECT throws_ok($q$SELECT pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(1))
                        || '{"discord_user": {"id": "1", "username": "d"}}', pg_temp.txt('x'))$q$,
                 '42501', 'metadata key reserved for the server: matrix_user', 'one row relays one platform');
SELECT is(ARRAY[pg_temp.state(pg_temp.mu(1) || '{"id": "@nocolon"}'),
                pg_temp.state(pg_temp.mu(1) || '{"id": "@a b:example.org"}'),
                pg_temp.state(pg_temp.mu(1) || jsonb_build_object('id', '@' || repeat('a', 250) || ':example.org')),
                pg_temp.state(pg_temp.mu(1) || '{"username": "   "}'),
                pg_temp.state(pg_temp.mu(1) || jsonb_build_object('username', repeat('u', 101))),
                pg_temp.state(pg_temp.mu(1) || jsonb_build_object('display_name', repeat('d', 101))),
                pg_temp.state(pg_temp.mu(1) || '{"display_name": 5}'),
                pg_temp.state(pg_temp.mu(1) || '{"avatar_url": "http://example.org/a.png"}'),
                pg_temp.state(pg_temp.mu(1) || jsonb_build_object('avatar_url', 'https://example.org/' || repeat('a', 2040))),
                pg_temp.state(pg_temp.mu(1) || '{"joined_at": "2020-01-01T00:00:00Z"}'),
                pg_temp.state('"@u1:example.org"'::jsonb),
                pg_temp.state(pg_temp.mu(1) - 'username')],
          array_fill('22023'::text, ARRAY[12]), 'every malformed Matrix author is refused: invalid_matrix_user');
SELECT is(pg_temp.state(jsonb_build_object('id', '@u2:example.org', 'username', 'u2', 'display_name', NULL, 'avatar_url', NULL)),
          'ok', 'display_name and avatar_url are optional and may be null');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                    VALUES ('f3040000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001',
                            pg_temp.txt('x'), '{"matrix_user": {"id": "@u1:example.org", "username": "u1"}}')$q$,
                 '42501', 'metadata key reserved for the server: matrix_user', 'a client cannot claim a Matrix author');
SELECT throws_ok($q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
                    VALUES ('f3040000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001',
                            pg_temp.txt('x'), '{"bridge_author": {"platform": "matrix"}}')$q$,
                 '42501', 'metadata key reserved for the server: bridge_author', 'nor a bridge_author');
SELECT tests.clear_authentication();

-- Reactions -------------------------------------------------------------------------------------------
SELECT lives_ok($q$INSERT INTO public.reactions (message_id, bot_id, custom_emoji_content, metadata)
                   VALUES ('f3040000-0000-0000-0000-000000000101', 'f3040000-0000-0000-0000-0000000000b1', 'a',
                           jsonb_build_object('matrix_user', pg_temp.mu(3)))$q$,
                'the Matrix bridge adds a Matrix user''s reaction');
SELECT throws_ok($q$INSERT INTO public.reactions (message_id, bot_id, custom_emoji_content, metadata)
                    VALUES ('f3040000-0000-0000-0000-000000000101', 'f3040000-0000-0000-0000-0000000000d1', 'b',
                            jsonb_build_object('matrix_user', pg_temp.mu(3)))$q$,
                 '42501', 'matrix_user is written by the Matrix bridge of the channel', 'the Discord bridge cannot');
SELECT throws_ok($q$INSERT INTO public.reactions (message_id, bot_id, custom_emoji_content, metadata)
                    VALUES ('f3040000-0000-0000-0000-000000000101', 'f3040000-0000-0000-0000-0000000000b1', 'c',
                            '{"bridge_author": {"platform": "matrix"}}')$q$,
                 '42501', 'metadata key reserved for the server: bridge_author', 'a reaction stores no bridge_author');
SELECT is((SELECT (channel_id, metadata -> 'matrix_user' ->> 'id')::text FROM public.reactions
            WHERE message_id = 'f3040000-0000-0000-0000-000000000101' AND custom_emoji_content = 'a'),
          '(f3040000-0000-0000-0000-0000000000c1,@u3:example.org)', 'the reaction is stored with its channel and author');
SELECT is((SELECT payload ->> 'username' || '|' || (payload ->> 'display_name') || '|' || (payload ->> 'avatar_url')
             FROM realtime.messages
            WHERE topic = 'channel-messages-f3040000-0000-0000-0000-0000000000c1'
              AND payload ->> 'type' = 'reaction:insert' AND payload ->> 'custom_emoji_content' = 'a'),
          'u3|U 3|https://example.org/u3.png', 'the reaction broadcast names the Matrix user');

-- Notifications ---------------------------------------------------------------------------------------
SELECT is(public.message_notification_sender_json(NULL, 'f3040000-0000-0000-0000-0000000000b1',
              jsonb_build_object('matrix_user', pg_temp.mu(4)), NULL),
          '{"username": "u4", "display_name": "U 4", "avatar_url": "https://example.org/u4.png",
            "is_local": false, "handle": "@u4:example.org"}'::jsonb,
          'a Matrix sender is shown as a remote author, its MXID the handle');
SELECT is(public.message_notification_sender_json(NULL, 'f3040000-0000-0000-0000-0000000000d1',
              '{"discord_user": {"id": "1", "username": "dana"}}'::jsonb, NULL),
          '{"username": "dana", "display_name": "dana", "avatar_url": null, "is_local": false, "handle": "@dana"}'::jsonb,
          'a Discord sender is shown as before');
SELECT is(pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(4)),
                     '[{"type": "mention", "userId": "22222222-0000-0000-0000-000000000002", "username": "bob"}]'::jsonb), 1,
          'a Matrix author mentions bob');
SELECT is((SELECT n.data -> 'sender' ->> 'handle' FROM public.notifications n
            WHERE n.user_id = '22222222-0000-0000-0000-000000000002'
              AND n.data ->> 'channel_id' = 'f3040000-0000-0000-0000-0000000000c1'
            ORDER BY n.created_at DESC LIMIT 1),
          '@u4:example.org', 'the mention notification carries the Matrix sender');

-- AutoMod ---------------------------------------------------------------------------------------------
SET LOCAL ROLE service_role;
INSERT INTO out VALUES
  ('flood', to_jsonb(pg_temp.burst(5, 12))),
  ('flood_other', to_jsonb(pg_temp.burst(6, 3)));
RESET ROLE;
SELECT is((SELECT v FROM out WHERE k = 'flood'), '10'::jsonb,
          'a Matrix author is held to the flood rule under exempt_bots: 10 of 12 written');
SELECT is((SELECT v FROM out WHERE k = 'flood_other'), '3'::jsonb, 'another Matrix author counts separately');
SELECT is((SELECT count(*)::integer FROM public.automod_recent_activity
            WHERE user_id = md5('matrix:@u5:example.org')::uuid AND server_id = 'f3040000-0000-0000-0000-0000000000e1'),
          10, 'the written messages are counted under md5(''matrix:<mxid>'')');
SELECT results_eq(
  $q$SELECT rule_type, user_id IS NULL, bot_id, details ->> 'author_key', details ->> 'author_name'
       FROM public.automod_events
      WHERE server_id = 'f3040000-0000-0000-0000-0000000000e1' AND rule_type = 'message_flood'$q$,
  $q$VALUES ('message_flood', true, 'f3040000-0000-0000-0000-0000000000b1'::uuid, 'matrix:@u5:example.org', 'u5')$q$,
  'the event names the Matrix bridge bot and the Matrix author');
SELECT ok(EXISTS (SELECT 1 FROM public.messages m
                   WHERE m.channel_id = 'f3040000-0000-0000-0000-0000000000c9' AND m.is_system
                     AND m.metadata ->> 'type' = 'automod_alert'
                     AND m.metadata -> 'automod' ->> 'author_key' = 'matrix:@u5:example.org'
                     AND m.content -> 0 ->> 'text' LIKE 'AutoMod blocked a message from @u5 (Matrix) in #one%'),
          'the alert names the Matrix author');

INSERT INTO out
SELECT 'new_member_rule', jsonb_build_object('id', r.id, 'name', r.name, 'rule_type', r.rule_type, 'enabled', true,
                          'config', r.config || '{"restrict_links": true, "min_account_age_minutes": 100000}',
                          'actions', r.actions, 'exempt_role_ids', to_jsonb(r.exempt_role_ids),
                          'exempt_channel_ids', to_jsonb(r.exempt_channel_ids))
  FROM public.server_automod_rules r
 WHERE r.server_id = 'f3040000-0000-0000-0000-0000000000e1' AND r.rule_type = 'new_member';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('f3040000-0000-0000-0000-0000000000e1',
                   '{"name": "Words", "rule_type": "keyword", "config": {"keywords": ["badword"]},
                     "actions": {"block": true, "alert": false}}'::jsonb)$q$,
                'the owner adds a keyword rule');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('f3040000-0000-0000-0000-0000000000e1',
                   (SELECT v FROM out WHERE k = 'new_member_rule'))$q$,
                'the owner turns new-member link restrictions on');
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;
INSERT INTO out VALUES
  ('keyword_exempt', to_jsonb(pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(7)), pg_temp.txt('a badword here')))),
  ('new_member', to_jsonb(pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(7)), pg_temp.txt('see https://example.net'))));
RESET ROLE;
UPDATE public.server_automod_settings SET exempt_bots = false WHERE server_id = 'f3040000-0000-0000-0000-0000000000e1';
SET LOCAL ROLE service_role;
INSERT INTO out VALUES
  ('keyword', to_jsonb(pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(7)), pg_temp.txt('another badword'))));
RESET ROLE;
UPDATE public.server_automod_settings SET exempt_bots = true WHERE server_id = 'f3040000-0000-0000-0000-0000000000e1';
SELECT is((SELECT v FROM out WHERE k = 'keyword_exempt'), '1'::jsonb,
          'keyword rules skip a Matrix author under exempt_bots, as a Discord author');
SELECT is((SELECT v FROM out WHERE k = 'keyword'), '0'::jsonb, 'and apply with exempt_bots off');
SELECT is((SELECT v FROM out WHERE k = 'new_member'), '1'::jsonb,
          'the new-member rule does not apply: Matrix carries no account age');

-- Remote-user privacy ---------------------------------------------------------------------------------
SELECT is(public.bridge_platform_author_key('matrix'), 'matrix_user', 'matrix_user is the Matrix author key');
SELECT lives_ok($q$SELECT public.bridge_privacy_check_subject('matrix', '@u9:example.org')$q$, 'an MXID is a Matrix subject');
SELECT throws_ok($q$SELECT public.bridge_privacy_check_subject('matrix', '2810000000000009001')$q$,
                 '22023', 'invalid_remote_user', 'a Discord id is no Matrix subject');
SELECT throws_ok($q$SELECT public.bridge_privacy_check_subject('discord', '@u9:example.org')$q$,
                 '22023', 'invalid_remote_user', 'nor is an MXID a Discord subject');

SELECT pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(9)), pg_temp.txt('before the opt-out'), 'f3040000-0000-0000-0000-000000000109');
INSERT INTO public.reactions (message_id, bot_id, custom_emoji_content, metadata)
VALUES ('f3040000-0000-0000-0000-000000000101', 'f3040000-0000-0000-0000-0000000000b1', 'n',
        jsonb_build_object('matrix_user', pg_temp.mu(9)));
-- A Discord author's row of the same channel, which no Matrix erase touches.
INSERT INTO public.messages (id, channel_id, bot_id, content, metadata)
VALUES ('f3040000-0000-0000-0000-000000000201', 'f3040000-0000-0000-0000-0000000000c1', 'f3040000-0000-0000-0000-0000000000d1',
        pg_temp.txt('from Discord'), '{"discord_user": {"id": "3040000000000009001", "username": "dana"}}');

SELECT is(public.bridge_privacy_set_optout('f3040000-0000-0000-0000-0000000000e1', 'matrix', '@u9:example.org', true)
              ->> 'opted_out', 'true', 'a Matrix user opts out of the server''s bridge');
SELECT throws_ok($q$SELECT pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(9)), pg_temp.txt('after'))$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'their new messages are refused');
SELECT throws_ok($q$UPDATE public.messages SET content = pg_temp.txt('edited')
                     WHERE id = 'f3040000-0000-0000-0000-000000000109'$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'and their edits');
SELECT throws_ok($q$INSERT INTO public.reactions (message_id, bot_id, custom_emoji_content, metadata)
                    VALUES ('f3040000-0000-0000-0000-000000000101', 'f3040000-0000-0000-0000-0000000000b1', 'o',
                            jsonb_build_object('matrix_user', pg_temp.mu(9)))$q$,
                 '23514', 'BRIDGE_AUTHOR_OPTED_OUT', 'and their reactions');
SELECT lives_ok($q$UPDATE public.messages SET is_deleted = true WHERE id = 'f3040000-0000-0000-0000-000000000109'$q$,
                'a delete passes');
SELECT is(public.bridge_privacy_optout_ids('f3040000-0000-0000-0000-0000000000e1', 'matrix') -> 'remote_user_ids',
          '["@u9:example.org"]'::jsonb, 'the Matrix list holds the MXID');
SELECT is(public.bridge_privacy_optout_ids('f3040000-0000-0000-0000-0000000000e1', 'discord') -> 'remote_user_ids',
          '[]'::jsonb, 'the Discord list does not');

SELECT is(public.bridge_privacy_erase('f3040000-0000-0000-0000-0000000000e1', 'matrix', '@u9:example.org', 200) - 'removed',
          '{"opted_out": true, "erased": 1, "more": false}'::jsonb, 'an erase takes the Matrix user''s rows');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.messages WHERE metadata #>> '{matrix_user,id}' = '@u9:example.org')
          AND NOT EXISTS (SELECT 1 FROM public.reactions WHERE metadata #>> '{matrix_user,id}' = '@u9:example.org')
          AND EXISTS (SELECT 1 FROM public.reactions WHERE metadata #>> '{matrix_user,id}' = '@u3:example.org'),
          'their messages and reactions are gone; another Matrix user''s stay');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_remove_remote_user('f3040000-0000-0000-0000-0000000000e1', 'matrix', '@u5:example.org') ->> 'more',
          'false', 'a manager removes a Matrix user in one batch');
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM public.messages WHERE metadata #>> '{matrix_user,id}' = '@u5:example.org')
          AND NOT EXISTS (SELECT 1 FROM public.automod_events WHERE details ->> 'author_key' = 'matrix:@u5:example.org')
          AND NOT EXISTS (SELECT 1 FROM public.messages
                           WHERE metadata ->> 'type' = 'automod_alert'
                             AND metadata -> 'automod' ->> 'author_key' = 'matrix:@u5:example.org'),
          'their messages, AutoMod events and alerts are gone');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_restore_remote_user('f3040000-0000-0000-0000-0000000000e1', 'matrix', '@u5:example.org'),
          true, 'a manager restores the Matrix user');
SELECT tests.clear_authentication();
SELECT is(pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(5)), pg_temp.txt('back again')), 1,
          'the restored Matrix user is relayed again');

INSERT INTO out SELECT 'history_import', COALESCE((SELECT config_value FROM public.instance_config
                                                     WHERE config_key = 'bridge_history_import'), 'null'::jsonb);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.bridge_privacy_purge_server('f3040000-0000-0000-0000-0000000000e1', 'matrix') ->> 'more',
          'false', 'a manager removes every Matrix row of the server');
SELECT is(public.bridge_privacy_purge_instance('matrix') ->> 'more', 'false', 'an admin removes every Matrix row');
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM public.messages m
                       JOIN public.channels c ON c.id = m.channel_id
                      WHERE c.server_id = 'f3040000-0000-0000-0000-0000000000e1' AND m.metadata ? 'matrix_user')
          AND NOT EXISTS (SELECT 1 FROM public.reactions r WHERE r.metadata ? 'matrix_user')
          AND EXISTS (SELECT 1 FROM public.messages WHERE id = 'f3040000-0000-0000-0000-000000000201'),
          'every Matrix row is gone; the Discord author''s row stays');
SELECT is(COALESCE((SELECT config_value FROM public.instance_config WHERE config_key = 'bridge_history_import'), 'null'::jsonb),
          (SELECT v FROM out WHERE k = 'history_import'),
          'a Matrix purge leaves Discord history import alone');

-- Removed binding -------------------------------------------------------------------------------------
SELECT pg_temp.mx('b1', 'c1', pg_temp.author(pg_temp.mu(8)), pg_temp.txt('kept'), 'f3040000-0000-0000-0000-000000000108');
DELETE FROM public.bridge_channels WHERE bot_id = 'f3040000-0000-0000-0000-0000000000b1';
SELECT lives_ok($q$UPDATE public.messages SET metadata = metadata || '{"edited": true}', content = pg_temp.txt('kept, edited')
                    WHERE id = 'f3040000-0000-0000-0000-000000000108'$q$,
                'a row of a removed binding stays editable while its author is unchanged');
SELECT throws_ok($q$UPDATE public.messages SET metadata = jsonb_set(metadata, '{matrix_user,username}', '"other"')
                     WHERE id = 'f3040000-0000-0000-0000-000000000108'$q$,
                 '42501', 'matrix_user is written by the Matrix bridge of the channel', 'its author cannot change');
SELECT lives_ok($q$UPDATE public.messages SET is_deleted = true WHERE id = 'f3040000-0000-0000-0000-000000000108'$q$,
                'and it can be deleted');

-- Schema ----------------------------------------------------------------------------------------------
SELECT is((SELECT count(*)::integer FROM pg_index x
            WHERE x.indexrelid IN (to_regclass('public.messages_matrix_author_idx'),
                                   to_regclass('public.messages_matrix_relayed_channel'),
                                   to_regclass('public.idx_reactions_matrix_author'))
              AND x.indisvalid),
          3, 'the Matrix author indexes are built and valid');
SELECT ok(pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgname = 'a_messages_client_write_optout'))
              LIKE '%matrix_user%'
          AND pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgname = 'a_messages_client_write_optout_edit'))
              LIKE '%matrix_user%'
          AND pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgname = 'a_reactions_client_write_optout'))
              LIKE '%matrix_user%',
          'the opt-out guards fire on a Matrix author');
SELECT ok(NOT has_function_privilege('authenticated', 'public.matrix_user_valid(jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('service_role', 'public.matrix_user_valid(jsonb)', 'EXECUTE'),
          'the Matrix author check is internal');

SELECT * FROM finish();
ROLLBACK;
