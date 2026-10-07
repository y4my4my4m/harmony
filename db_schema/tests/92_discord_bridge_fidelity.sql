-- 20261008900001_discord_bridge_fidelity.sql: AutoMod counts relayed Discord authors; bridge
-- bots carry the bundled bridge avatar.
--
--   alice  owner of server F (created here, so it gets the recommended preset: more than 20
--          mentions in a message or 50 in a minute, more than 10 messages in 10 s, the same text
--          in more than 2 channels in 5 minutes; each block + alert), instance admin
--   bob    member of F
-- Bots: relay (bot_type 'bridge'), plain (bot_type 'bot'). now() is fixed for the transaction,
-- so every row falls inside every window; each section uses its own Discord ids.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(40);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;

-- Fixture -----------------------------------------------------------------------------------
INSERT INTO public.servers (id, name, owner) VALUES
  ('92000000-0000-0000-0000-0000000000f1', 'Fidelity', '11111111-0000-0000-0000-000000000001'),
  ('92000000-0000-0000-0000-0000000000f2', 'Linked', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('92000000-0000-0000-0000-0000000000c1', '92000000-0000-0000-0000-0000000000f1', 'one', 0),
  ('92000000-0000-0000-0000-0000000000c2', '92000000-0000-0000-0000-0000000000f1', 'two', 0),
  ('92000000-0000-0000-0000-0000000000c3', '92000000-0000-0000-0000-0000000000f1', 'three', 0),
  ('92000000-0000-0000-0000-0000000000c9', '92000000-0000-0000-0000-0000000000f1', 'mod-log', 0);
UPDATE public.server_automod_settings
   SET raid_settings = raid_settings || '{"enabled": false}'::jsonb,
       alert_channel_id = '92000000-0000-0000-0000-0000000000c9'
 WHERE server_id = '92000000-0000-0000-0000-0000000000f1';
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', '92000000-0000-0000-0000-0000000000f1', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', '92000000-0000-0000-0000-0000000000f1', 'accepted');
INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('92000000-0000-0000-0000-0000000000b1', 'discord-bridge-92', 'Discord Bridge', '11111111-0000-0000-0000-000000000001', 'bridge'),
  ('92000000-0000-0000-0000-0000000000b2', 'plain-bot-92', 'Plain Bot', '11111111-0000-0000-0000-000000000001', 'bot');
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

-- metadata.discord_user of a relayed Discord author; username 'user' + the id's last 4 digits.
CREATE FUNCTION pg_temp.du(p_id text, p_joined text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_strip_nulls(jsonb_build_object(
           'id', p_id, 'username', 'user' || right(p_id, 4), 'display_name', 'User ' || right(p_id, 4),
           'avatar_url', 'https://cdn.discordapp.com/embed/avatars/0.png', 'joined_at', p_joined));
$fn$;

CREATE FUNCTION pg_temp.txt(p_text text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text));
$fn$;

CREATE FUNCTION pg_temp.mentions(p_n integer) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_agg(jsonb_build_object('type', 'mention', 'userId', gen_random_uuid()::text, 'username', 'u' || g))
    FROM generate_series(1, p_n) g;
$fn$;

-- Rows written; 0 when AutoMod dropped the row.
CREATE FUNCTION pg_temp.relay(p_bot uuid, p_channel uuid, p_user jsonb, p_content jsonb)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.messages (channel_id, bot_id, content, metadata)
  VALUES (p_channel, p_bot, p_content,
          CASE WHEN p_user IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('discord_user', p_user) END);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

-- p_n distinct messages; rows written.
CREATE FUNCTION pg_temp.burst(p_bot uuid, p_channel uuid, p_user jsonb, p_n integer)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE i integer; total integer := 0;
BEGIN
  FOR i IN 1..p_n LOOP
    total := total + pg_temp.relay(p_bot, p_channel, p_user, pg_temp.txt('message ' || i || ' ' || md5(random()::text)));
  END LOOP;
  RETURN total;
END $fn$;

CREATE FUNCTION pg_temp.say(p_user uuid, p_channel uuid, p_text text)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.messages (channel_id, user_id, content) VALUES (p_channel, p_user, pg_temp.txt(p_text));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

-- A server F rule as upsert_server_automod_rule takes it; the tables are closed to clients.
CREATE FUNCTION pg_temp.rule(p_type text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT jsonb_build_object('id', r.id, 'name', r.name, 'rule_type', r.rule_type, 'enabled', r.enabled,
                            'config', r.config, 'actions', r.actions,
                            'exempt_role_ids', to_jsonb(r.exempt_role_ids),
                            'exempt_channel_ids', to_jsonb(r.exempt_channel_ids))
    FROM public.server_automod_rules r
   WHERE r.server_id = '92000000-0000-0000-0000-0000000000f1' AND r.rule_type = p_type
   LIMIT 1;
$fn$;

GRANT EXECUTE ON FUNCTION pg_temp.du(text, text), pg_temp.txt(text), pg_temp.mentions(integer),
                         pg_temp.relay(uuid, uuid, jsonb, jsonb), pg_temp.burst(uuid, uuid, jsonb, integer),
                         pg_temp.say(uuid, uuid, text), pg_temp.rule(text)
    TO authenticated, service_role;

-- Privileges --------------------------------------------------------------------------------
SELECT is(ARRAY(SELECT p.oid::regprocedure::text FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'automod_record_match'),
          ARRAY['automod_record_match(uuid,uuid,uuid,uuid,uuid,text,jsonb,text,boolean,jsonb,uuid,text,text)'],
          'automod_record_match has the relayed-author signature alone');
SELECT ok(NOT has_function_privilege('anon', 'public.automod_record_match(uuid,uuid,uuid,uuid,uuid,text,jsonb,text,boolean,jsonb,uuid,text,text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.automod_record_match(uuid,uuid,uuid,uuid,uuid,text,jsonb,text,boolean,jsonb,uuid,text,text)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.automod_record_match(uuid,uuid,uuid,uuid,uuid,text,jsonb,text,boolean,jsonb,uuid,text,text)', 'EXECUTE'),
  'automod_record_match stays internal');
SELECT ok(has_function_privilege('authenticated', 'public.automod_check_message(public.messages, text, text)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.automod_check_message(public.messages, text, text)', 'EXECUTE'),
  'automod_check_message keeps its grants');
SELECT ok(NOT has_function_privilege('anon', 'public.discord_bridge_provision_bot(uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.discord_bridge_provision_bot(uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('service_role', 'public.discord_bridge_provision_bot(uuid, uuid)', 'EXECUTE'),
  'discord_bridge_provision_bot stays executable by its owner alone');

-- Flood, under exempt_bots ------------------------------------------------------------------
SET LOCAL ROLE service_role;
INSERT INTO out VALUES
  ('flood_relayed', to_jsonb(pg_temp.burst('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                                           pg_temp.du('100000000000000001'), 12))),
  ('flood_other', to_jsonb(pg_temp.burst('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                                         pg_temp.du('100000000000000002'), 3))),
  ('flood_plain', to_jsonb(pg_temp.burst('92000000-0000-0000-0000-0000000000b2', '92000000-0000-0000-0000-0000000000c1',
                                         pg_temp.du('100000000000000003'), 12))),
  ('flood_bridge_self', to_jsonb(pg_temp.burst('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                                               NULL, 12))),
  ('flood_malformed', to_jsonb(pg_temp.burst('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                                             '{"id": "not-a-snowflake", "username": "x"}'::jsonb, 12)));
RESET ROLE;

SELECT is((SELECT v FROM out WHERE k = 'flood_relayed'), '10'::jsonb,
  'a relayed Discord author is held to the flood rule under exempt_bots: 10 of 12 written');
SELECT is((SELECT v FROM out WHERE k = 'flood_other'), '3'::jsonb,
  'another Discord author of the same bridge counts separately');
SELECT is((SELECT v FROM out WHERE k = 'flood_plain'), '12'::jsonb,
  'a bot that is no bridge stays exempt, discord_user or not');
SELECT is((SELECT v FROM out WHERE k = 'flood_bridge_self'), '12'::jsonb,
  'a bridge bot''s own rows stay exempt');
SELECT is((SELECT v FROM out WHERE k = 'flood_malformed'), '12'::jsonb,
  'a discord_user without a snowflake id relays no author');
SELECT is((SELECT count(*)::integer FROM public.automod_recent_activity
            WHERE user_id = md5('discord:100000000000000001')::uuid
              AND server_id = '92000000-0000-0000-0000-0000000000f1'),
          10, 'the relayed author''s written messages are counted under md5(''discord:<id>'')');
SELECT results_eq(
  $q$SELECT rule_type, user_id IS NULL, bot_id, details ->> 'author_key', details ->> 'author_name', actions, hits
       FROM public.automod_events
      WHERE server_id = '92000000-0000-0000-0000-0000000000f1' AND rule_type = 'message_flood'$q$,
  $q$VALUES ('message_flood', true, '92000000-0000-0000-0000-0000000000b1'::uuid, 'discord:100000000000000001',
             'user0001', ARRAY['alert', 'block'], 2)$q$,
  'both blocks fold into one event naming the bridge bot and the Discord author');
SELECT ok(EXISTS (SELECT 1 FROM public.messages m
                   WHERE m.channel_id = '92000000-0000-0000-0000-0000000000c9' AND m.is_system
                     AND m.metadata ->> 'type' = 'automod_alert'
                     AND m.metadata -> 'automod' ->> 'author_key' = 'discord:100000000000000001'
                     AND m.metadata -> 'automod' ->> 'author_name' = 'user0001'
                     AND m.content -> 0 ->> 'text' LIKE 'AutoMod blocked a message from @user0001 (Discord) in #one%'),
  'the alert names the Discord author');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(EXISTS (SELECT 1 FROM jsonb_array_elements(public.get_server_automod_events('92000000-0000-0000-0000-0000000000f1')) e
                   WHERE e -> 'details' ->> 'author_name' = 'user0001' AND e ->> 'bot_name' = 'Discord Bridge'),
  'the AutoMod log carries the Discord author beside the bridge bot');
SELECT tests.clear_authentication();

-- Duplicates and mentions -------------------------------------------------------------------
SET LOCAL ROLE service_role;
INSERT INTO out VALUES
  ('dup', jsonb_build_array(
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                   pg_temp.du('100000000000000004'), pg_temp.txt('join my totally real giveaway')),
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c2',
                   pg_temp.du('100000000000000004'), pg_temp.txt('join my totally real giveaway')),
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c3',
                   pg_temp.du('100000000000000004'), pg_temp.txt('join my totally real giveaway')))),
  ('mention_window', jsonb_build_array(
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                   pg_temp.du('100000000000000005'), pg_temp.mentions(20)),
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c2',
                   pg_temp.du('100000000000000005'), pg_temp.mentions(20)),
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c3',
                   pg_temp.du('100000000000000005'), pg_temp.mentions(20)))),
  ('mention_message', to_jsonb(
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                   pg_temp.du('100000000000000006'), pg_temp.mentions(21))));
RESET ROLE;

SELECT is((SELECT v FROM out WHERE k = 'dup'), '[1, 1, 0]'::jsonb,
  'the same relayed text in a third channel is dropped');
SELECT is((SELECT v FROM out WHERE k = 'mention_window'), '[1, 1, 0]'::jsonb,
  'a relayed author''s mentions count toward the per-minute window');
SELECT is((SELECT v FROM out WHERE k = 'mention_message'), '0'::jsonb,
  'the per-message mention limit applies to a relayed author under exempt_bots');

-- Content rules follow exempt_bots ----------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('92000000-0000-0000-0000-0000000000f1',
                   '{"name": "Words", "rule_type": "keyword", "config": {"keywords": ["badword"]},
                     "actions": {"block": true, "alert": false}}'::jsonb)$q$,
  'the owner adds a keyword rule');
SELECT tests.clear_authentication();

SET LOCAL ROLE service_role;
INSERT INTO out VALUES ('keyword_exempt', to_jsonb(
  pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                pg_temp.du('100000000000000007'), pg_temp.txt('a badword here'))));
RESET ROLE;
UPDATE public.server_automod_settings SET exempt_bots = false WHERE server_id = '92000000-0000-0000-0000-0000000000f1';
SET LOCAL ROLE service_role;
INSERT INTO out VALUES
  ('keyword_not_exempt', to_jsonb(
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                   pg_temp.du('100000000000000007'), pg_temp.txt('another badword')))),
  ('flood_plain_not_exempt', to_jsonb(
     pg_temp.burst('92000000-0000-0000-0000-0000000000b2', '92000000-0000-0000-0000-0000000000c2', NULL, 12)));
RESET ROLE;
UPDATE public.server_automod_settings SET exempt_bots = true WHERE server_id = '92000000-0000-0000-0000-0000000000f1';

SELECT is((SELECT v FROM out WHERE k = 'keyword_exempt'), '1'::jsonb,
  'keyword rules skip a relayed author under exempt_bots, as for any bot');
SELECT is((SELECT v FROM out WHERE k = 'keyword_not_exempt'), '0'::jsonb,
  'keyword rules apply to a relayed author with exempt_bots off');
SELECT is((SELECT v FROM out WHERE k = 'flood_plain_not_exempt'), '12'::jsonb,
  'the flood rule still never applies to a bot that relays no author');

-- New members -------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('92000000-0000-0000-0000-0000000000f1',
                   pg_temp.rule('new_member') || '{"enabled": true}'::jsonb)$q$,
  'the owner turns new-member restrictions on (24 h account, 10 min membership, links)');
SELECT tests.clear_authentication();

-- A snowflake minted now: (Unix ms - 1420070400000) << 22.
SELECT ((floor(extract(epoch FROM now()) * 1000)::bigint - 1420070400000) * 4194304)::text AS fresh_id \gset

SET LOCAL ROLE service_role;
INSERT INTO out VALUES
  ('nm_just_joined', to_jsonb(
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                   pg_temp.du('100000000000000008', (now() - interval '1 minute')::text), pg_temp.txt('see https://example.org')))),
  ('nm_plain_text', to_jsonb(
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                   pg_temp.du('100000000000000008', (now() - interval '1 minute')::text), pg_temp.txt('just words')))),
  ('nm_no_joined_at', to_jsonb(
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                   pg_temp.du('100000000000000009'), pg_temp.txt('see https://example.org')))),
  ('nm_bad_joined_at', to_jsonb(
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                   pg_temp.du('100000000000000010', 'last tuesday'), pg_temp.txt('see https://example.org')))),
  ('nm_established', to_jsonb(
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                   pg_temp.du('100000000000000011', '2020-01-01T00:00:00Z'), pg_temp.txt('see https://example.org')))),
  ('nm_fresh_account', to_jsonb(
     pg_temp.relay('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c1',
                   pg_temp.du(:'fresh_id', '2020-01-01T00:00:00Z'), pg_temp.txt('see https://example.org'))));
RESET ROLE;

SELECT is((SELECT v FROM out WHERE k = 'nm_just_joined'), '0'::jsonb,
  'a Discord member who joined a minute ago cannot post links');
SELECT is((SELECT v FROM out WHERE k = 'nm_plain_text'), '1'::jsonb,
  'that member''s plain text passes');
SELECT is((SELECT v FROM out WHERE k = 'nm_no_joined_at'), '1'::jsonb,
  'without joined_at the new-member rule does not apply');
SELECT is((SELECT v FROM out WHERE k = 'nm_bad_joined_at'), '1'::jsonb,
  'an unparseable joined_at counts as absent');
SELECT is((SELECT v FROM out WHERE k = 'nm_established'), '1'::jsonb,
  'an established Discord member posts links');
SELECT is((SELECT v FROM out WHERE k = 'nm_fresh_account'), '0'::jsonb,
  'a Discord account created now is a new account, whenever it joined');

-- Timeouts ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('92000000-0000-0000-0000-0000000000f1',
                   pg_temp.rule('message_flood')
                   || '{"actions": {"block": true, "alert": true, "timeout_seconds": 60}}'::jsonb)$q$,
  'the owner adds a timeout to the flood rule');
SELECT tests.clear_authentication();

SET LOCAL ROLE service_role;
INSERT INTO out VALUES ('flood_timeout', to_jsonb(
  pg_temp.burst('92000000-0000-0000-0000-0000000000b1', '92000000-0000-0000-0000-0000000000c2',
                pg_temp.du('100000000000000012'), 11)));
RESET ROLE;

SELECT is((SELECT v FROM out WHERE k = 'flood_timeout'), '10'::jsonb, 'the eleventh relayed message is dropped');
SELECT is((SELECT actions FROM public.automod_events
            WHERE details ->> 'author_key' = 'discord:100000000000000012'),
          ARRAY['alert', 'block'], 'a relayed author''s event records no timeout');
SELECT is((SELECT count(*)::integer FROM public.server_member_timeouts
            WHERE server_id = '92000000-0000-0000-0000-0000000000f1'),
          0, 'no member is timed out for a relayed author');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO out
SELECT 'member_flood', to_jsonb(sum(pg_temp.say('22222222-0000-0000-0000-000000000002',
                                                '92000000-0000-0000-0000-0000000000c3', 'member line ' || g)))
  FROM generate_series(1, 11) g;
SELECT tests.clear_authentication();
SELECT is((SELECT v FROM out WHERE k = 'member_flood'), '10'::jsonb, 'a member''s flood is counted as before');
SELECT ok(EXISTS (SELECT 1 FROM public.server_member_timeouts
                   WHERE server_id = '92000000-0000-0000-0000-0000000000f1'
                     AND user_id = '22222222-0000-0000-0000-000000000002' AND until > now())
      AND (SELECT count(*) FROM public.automod_recent_activity
            WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND server_id = '92000000-0000-0000-0000-0000000000f1') = 10,
  'a member is still keyed by profile and timed out');

-- Role mentions from a bridge bot ------------------------------------------------------------
-- The bridge bot holds no install on F, so check_bot_permission(..., 'mention_everyone') is false.
INSERT INTO public.server_roles (id, server_id, name, position, permissions, mentionable) VALUES
  ('92000000-0000-0000-0000-0000000000e1', '92000000-0000-0000-0000-0000000000f1', 'crew', 2, 0, true),
  ('92000000-0000-0000-0000-0000000000e2', '92000000-0000-0000-0000-0000000000f1', 'staff', 3, 0, false);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', '92000000-0000-0000-0000-0000000000e1', '92000000-0000-0000-0000-0000000000f1'),
  ('22222222-0000-0000-0000-000000000002', '92000000-0000-0000-0000-0000000000e2', '92000000-0000-0000-0000-0000000000f1');

SET LOCAL ROLE service_role;
INSERT INTO public.messages (id, channel_id, bot_id, content)
SELECT ('92000000-0000-0000-0000-0000000003' || n)::uuid, '92000000-0000-0000-0000-0000000000c1',
       '92000000-0000-0000-0000-0000000000b1',
       jsonb_build_array(jsonb_build_object('type', 'role_mention', 'roleId', r), jsonb_build_object('type', 'text', 'text', ' ping'))
  FROM (VALUES ('01', '92000000-0000-0000-0000-0000000000e1'),
               ('02', '92000000-0000-0000-0000-0000000000e2'),
               ('03', (SELECT id::text FROM public.server_roles
                        WHERE server_id = '92000000-0000-0000-0000-0000000000f1' AND is_default))) v(n, r);
RESET ROLE;

CREATE FUNCTION pg_temp.notified(p_user uuid, p_message uuid) RETURNS boolean LANGUAGE sql AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.notifications
                  WHERE user_id = p_user AND type = 'mention' AND data ->> 'message_id' = p_message::text);
$fn$;

SELECT ok(pg_temp.notified('22222222-0000-0000-0000-000000000002', '92000000-0000-0000-0000-000000000301'),
  'a bridge bot''s mention of a mentionable role notifies its holders');
SELECT ok(NOT pg_temp.notified('22222222-0000-0000-0000-000000000002', '92000000-0000-0000-0000-000000000302'),
  'a bridge bot without mention_everyone pings no role that is not mentionable');
SELECT ok(NOT pg_temp.notified('22222222-0000-0000-0000-000000000002', '92000000-0000-0000-0000-000000000303'),
  'a bridge bot without mention_everyone pings no one with @everyone');

-- Bridge bot avatar -------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('self_bridge', to_jsonb(public.discord_bridge_create('92000000-0000-0000-0000-0000000000f1', 'self')));
SELECT lives_ok($q$SELECT public.discord_bridge_instance_bot_set('300000000000000092',
                   'abcdefghijklmnopqrstuvwxyz012345',
                   ('MTAxMDEwMTAxMDEwMTAxMDEw' || '.GabcDE.' || 'abcdefghijklmnopqrstuvwxyz0123456789AB'))$q$,
  'the admin configures the instance bot');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'discord_bridge_instance_bot_enabled';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('instance_bridge', public.discord_bridge_instance_link('92000000-0000-0000-0000-0000000000f2'));
SELECT tests.clear_authentication();

SELECT results_eq(
  $q$SELECT b.mode, bo.avatar_url, bo.bot_type
       FROM public.discord_bridges b JOIN public.bots bo ON bo.id = b.bot_id
      WHERE b.server_id IN ('92000000-0000-0000-0000-0000000000f1', '92000000-0000-0000-0000-0000000000f2')
      ORDER BY b.mode DESC$q$,
  $q$VALUES ('self', '/discord-bridge-bot.webp', 'bridge'), ('instance', '/discord-bridge-bot.webp', 'bridge')$q$,
  'new self and instance bridge bots carry the bundled bridge avatar');

-- The migration's backfill statement, against bridge bots on each avatar value.
INSERT INTO public.servers (id, name, owner)
SELECT ('92000000-0000-0000-0000-0000000001' || g)::uuid, 'Backfill ' || g, '11111111-0000-0000-0000-000000000001'
  FROM generate_series(10, 14) g;
INSERT INTO public.bots (id, username, owner_id, bot_type, avatar_url)
SELECT ('92000000-0000-0000-0000-0000000002' || g)::uuid, 'backfill-bot-' || g, '11111111-0000-0000-0000-000000000001',
       'bridge', a
  FROM (VALUES (10, NULL), (11, '/default_avatar.webp'), (12, '/default_avatar.png'), (13, 'abc/custom.png'),
               (14, '/default_avatar.webp')) v(g, a);
INSERT INTO public.discord_bridges (server_id, mode, created_by, bot_id)
SELECT ('92000000-0000-0000-0000-0000000001' || g)::uuid, 'self', '11111111-0000-0000-0000-000000000001',
       ('92000000-0000-0000-0000-0000000002' || g)::uuid
  FROM generate_series(10, 13) g;

UPDATE public.bots b
   SET avatar_url = '/discord-bridge-bot.webp'
 WHERE b.id IN (SELECT db.bot_id FROM public.discord_bridges db WHERE db.bot_id IS NOT NULL)
   AND (b.avatar_url IS NULL OR b.avatar_url IN ('/default_avatar.webp', '/default_avatar.png'));

SELECT results_eq(
  $q$SELECT right(id::text, 2), avatar_url FROM public.bots
      WHERE id::text LIKE '92000000-0000-0000-0000-0000000002%' ORDER BY 1$q$,
  $q$VALUES ('10', '/discord-bridge-bot.webp'), ('11', '/discord-bridge-bot.webp'),
            ('12', '/discord-bridge-bot.webp'), ('13', 'abc/custom.png'), ('14', '/default_avatar.webp')$q$,
  'the backfill reaches bridge bots without an avatar or on the default, and leaves custom avatars and unbridged bots');
SELECT is((SELECT avatar_url FROM public.bots WHERE id = '92000000-0000-0000-0000-0000000000b2'), '/default_avatar.webp',
  'an unbridged bot keeps the default avatar');

SELECT * FROM finish();
ROLLBACK;
