-- Newcomer alerts after 20261006100001_newcomer_message_alerts.sql.
--
-- Server s61, owner o61. Staff: m61 holds mods61 (KICK_MEMBERS, position 5), b61 holds bans61
-- (BAN_MEMBERS, position 4), g61 holds managers61 (MANAGE_SERVER, position 3). p61 is a plain
-- member, old61 joined 60 days ago, n01..n12 join in the test, c01..c08 hold crew61
-- (TIMEOUT_MEMBERS, position 2) from the cap section on. #general61 is open; #side61 denies b61
-- VIEW_CHANNEL. AutoMod and raid detection are off until the AutoMod section.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(47);

-- Setup, as postgres. -------------------------------------------------------------------
CREATE TEMP TABLE u61 (name text PRIMARY KEY, auth_id uuid, id uuid);
INSERT INTO u61
SELECT name,
       ('f6100000-0000-0000-0000-' || lpad(to_hex(n), 12, '0'))::uuid,
       ('f6110000-0000-0000-0000-' || lpad(to_hex(n), 12, '0'))::uuid
  FROM unnest(ARRAY['o61', 'm61', 'b61', 'g61', 'p61', 'old61',
                    'n01', 'n02', 'n03', 'n04', 'n05', 'n06', 'n07', 'n08', 'n09', 'n10', 'n11', 'n12',
                    'c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08'])
       WITH ORDINALITY AS t(name, n);

INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT auth_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', name || '@test.local'
  FROM u61;
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, avatar_url)
SELECT id, auth_id, name, upper(name), true, 'avatars/' || name || '.webp' FROM u61;

INSERT INTO public.servers (id, name, owner)
SELECT 'f6120000-0000-0000-0000-000000000001', 'Server 61', id FROM u61 WHERE name = 'o61';
UPDATE public.server_roles SET permissions = 12290
 WHERE server_id = 'f6120000-0000-0000-0000-000000000001' AND is_default;

INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f6130000-0000-0000-0000-000000000001', 'f6120000-0000-0000-0000-000000000001', 'mods61', 5, 512),
  ('f6130000-0000-0000-0000-000000000002', 'f6120000-0000-0000-0000-000000000001', 'bans61', 4, 1024),
  ('f6130000-0000-0000-0000-000000000003', 'f6120000-0000-0000-0000-000000000001', 'managers61', 3, 128),
  ('f6130000-0000-0000-0000-000000000004', 'f6120000-0000-0000-0000-000000000001', 'crew61', 2, 2048);

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f6140000-0000-0000-0000-000000000001', 'f6120000-0000-0000-0000-000000000001', 'general61', 0),
  ('f6140000-0000-0000-0000-000000000002', 'f6120000-0000-0000-0000-000000000001', 'side61', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f6140000-0000-0000-0000-000000000002', 'user', NULL, id, 0, 2 FROM u61 WHERE name = 'b61';

SELECT tests.authenticate_as((SELECT auth_id FROM u61 WHERE name = 'o61'));
SELECT public.update_server_automod_settings('f6120000-0000-0000-0000-000000000001',
       '{"enabled": false, "raid_settings": {"enabled": false}}'::jsonb) IS NOT NULL AS automod_off;
SELECT tests.clear_authentication();

INSERT INTO public.user_servers (user_id, server_id, status, created_at)
SELECT id, 'f6120000-0000-0000-0000-000000000001', 'accepted',
       CASE name WHEN 'old61' THEN now() - interval '60 days' ELSE now() END
  FROM u61 WHERE name !~ '^c0'
ON CONFLICT (user_id, server_id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, server_id)
SELECT u.id, r.role_id, 'f6120000-0000-0000-0000-000000000001'
  FROM u61 u
  JOIN (VALUES ('m61', 'f6130000-0000-0000-0000-000000000001'::uuid),
               ('b61', 'f6130000-0000-0000-0000-000000000002'::uuid),
               ('g61', 'f6130000-0000-0000-0000-000000000003'::uuid)) r(name, role_id) ON r.name = u.name;

CREATE FUNCTION pg_temp.uid(p_name text) RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT id FROM u61 WHERE name = p_name;
$fn$;

CREATE FUNCTION pg_temp.as_user(p_name text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM tests.authenticate_as((SELECT auth_id FROM u61 WHERE name = p_name));
END $fn$;

-- Posts as the member through the client path; the id, or NULL when a trigger dropped the row.
CREATE FUNCTION pg_temp.say(p_name text, p_text text,
                            p_channel uuid DEFAULT 'f6140000-0000-0000-0000-000000000001',
                            p_thread uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE
  v_author uuid := pg_temp.uid(p_name);
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.as_user(p_name);
  INSERT INTO public.messages (id, channel_id, thread_id, user_id, content)
  VALUES (v_id, p_channel, p_thread, v_author,
          jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text)));
  PERFORM tests.clear_authentication();
  RETURN (SELECT m.id FROM public.messages m WHERE m.id = v_id);
END $fn$;

-- Recipients of the newcomer alerts naming a message.
CREATE FUNCTION pg_temp.alerted(p_message uuid) RETURNS text[] LANGUAGE sql AS $fn$
  SELECT COALESCE(array_agg(u.name ORDER BY u.name), '{}')
    FROM public.notifications n JOIN u61 u ON u.id = n.user_id
   WHERE n.type = 'newcomer_message' AND n.data ->> 'message_id' = p_message::text;
$fn$;

CREATE FUNCTION pg_temp.alert_data(p_message uuid, p_recipient text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT n.data FROM public.notifications n
   WHERE n.type = 'newcomer_message' AND n.data ->> 'message_id' = p_message::text
     AND n.user_id = pg_temp.uid(p_recipient);
$fn$;

CREATE FUNCTION pg_temp.posted(p_name text) RETURNS boolean LANGUAGE sql AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.server_first_messages f
                  WHERE f.user_id = pg_temp.uid(p_name)
                    AND f.server_id = 'f6120000-0000-0000-0000-000000000001');
$fn$;

CREATE TEMP TABLE m61 (label text PRIMARY KEY, id uuid);
-- Helpers run inside impersonated statements.
GRANT SELECT ON u61, m61 TO authenticated;

-- Surface -------------------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.server_first_messages', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.server_first_messages', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.server_first_messages', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.server_first_messages', 'DELETE')
          AND NOT has_table_privilege('anon', 'public.server_first_messages', 'SELECT'),
          'clients hold no privileges on server_first_messages');
SELECT ok(NOT has_function_privilege('authenticated', 'public.handle_newcomer_first_message()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.handle_newcomer_first_message()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.server_newcomer_alerts_state(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.server_newcomer_alerts_state(uuid)', 'EXECUTE'),
          'the trigger function and the state helper are internal');
SELECT ok(NOT has_function_privilege('anon', 'public.get_server_newcomer_alerts(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_server_newcomer_alerts(uuid, boolean)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.get_server_newcomer_alerts(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.set_server_newcomer_alerts(uuid, boolean)', 'EXECUTE'),
          'the settings RPCs are for signed-in callers only');
SELECT is((SELECT array_agg(p.proconfig::text ORDER BY p.proname) FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('handle_newcomer_first_message', 'get_server_newcomer_alerts', 'set_server_newcomer_alerts')),
          ARRAY['{"search_path=public, pg_temp"}', '{"search_path=public, pg_temp"}', '{"search_path=public, pg_temp"}'],
          'the definers pin search_path');

-- Settings ------------------------------------------------------------------------------
SELECT pg_temp.as_user('o61');
SELECT is(public.get_server_newcomer_alerts('f6120000-0000-0000-0000-000000000001'),
          '{"enabled": true, "server_value": null, "instance_default": true}'::jsonb,
          'a server without a setting follows the instance default, which is on');
SELECT pg_temp.as_user('p61');
SELECT throws_ok($q$SELECT public.get_server_newcomer_alerts('f6120000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'a member without MANAGE_SERVER cannot read the setting');
SELECT throws_ok($q$SELECT public.set_server_newcomer_alerts('f6120000-0000-0000-0000-000000000001', false)$q$,
                 '42501', NULL, 'a member without MANAGE_SERVER cannot change the setting');
SELECT pg_temp.as_user('m61');
SELECT throws_ok($q$SELECT public.set_server_newcomer_alerts('f6120000-0000-0000-0000-000000000001', false)$q$,
                 '42501', NULL, 'KICK_MEMBERS alone does not change the setting');
SELECT pg_temp.as_user('g61');
SELECT is(public.set_server_newcomer_alerts('f6120000-0000-0000-0000-000000000001', false) ->> 'enabled', 'false',
          'a MANAGE_SERVER holder turns alerts off');
SELECT is(public.set_server_newcomer_alerts('f6120000-0000-0000-0000-000000000001', NULL),
          '{"enabled": true, "server_value": null, "instance_default": true}'::jsonb,
          'NULL returns the server to the instance default');
SELECT tests.clear_authentication();

-- First message -------------------------------------------------------------------------
INSERT INTO m61 VALUES ('n01 first', pg_temp.say('n01', 'hello from n01'));
SELECT is(pg_temp.alerted((SELECT id FROM m61 WHERE label = 'n01 first')),
          ARRAY['b61', 'g61', 'm61', 'o61'],
          'a newcomer''s first message alerts the owner and the KICK, BAN and MANAGE_SERVER holders');
SELECT is(
    (SELECT jsonb_build_object(
        'sender', d -> 'sender' ->> 'user_id', 'sender_name', d -> 'sender' ->> 'display_name',
        'avatar', d -> 'sender' ->> 'avatar_url', 'message', d -> 'message' ->> 'id',
        'location', d -> 'location', 'server_id', d ->> 'server_id', 'channel_id', d ->> 'channel_id',
        'channel_name', d ->> 'channel_name', 'server_name', d ->> 'server_name',
        'preview', d ->> 'preview', 'content_preview', d -> 'message' ->> 'content_preview',
        'from', d ->> 'from_user_id', 'thread', d ? 'thread_id')
       FROM pg_temp.alert_data((SELECT id FROM m61 WHERE label = 'n01 first'), 'o61') d),
    jsonb_build_object(
        'sender', pg_temp.uid('n01')::text, 'sender_name', 'N01', 'avatar', 'avatars/n01.webp',
        'message', (SELECT id FROM m61 WHERE label = 'n01 first')::text,
        'location', jsonb_build_object('server_id', 'f6120000-0000-0000-0000-000000000001',
                                       'server_name', 'Server 61',
                                       'channel_id', 'f6140000-0000-0000-0000-000000000001',
                                       'channel_name', 'general61'),
        'server_id', 'f6120000-0000-0000-0000-000000000001',
        'channel_id', 'f6140000-0000-0000-0000-000000000001',
        'channel_name', 'general61', 'server_name', 'Server 61',
        'preview', 'hello from n01', 'content_preview', 'hello from n01',
        'from', pg_temp.uid('n01')::text, 'thread', false),
    'the alert names the server, channel, message and author and carries a preview');
SELECT ok(pg_temp.posted('n01'), 'the first message is recorded');
SELECT is(pg_temp.alerted(pg_temp.say('n01', 'second from n01')), '{}'::text[],
          'a second message alerts no one');

-- Exclusions ----------------------------------------------------------------------------
SELECT is(pg_temp.alerted(pg_temp.say('o61', 'owner speaking')), '{}'::text[],
          'the owner''s own first message alerts no one');
SELECT is(pg_temp.alerted(pg_temp.say('m61', 'new moderator here')), ARRAY['b61', 'g61', 'o61'],
          'a new moderator''s first message alerts the rest of the staff, not the author');
SELECT is(pg_temp.alerted(pg_temp.say('old61', 'finally posting')), '{}'::text[],
          'a member who joined 60 days ago is not a newcomer');
SELECT ok(pg_temp.posted('old61'), 'that member''s first message is still recorded');

INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
VALUES ('f6140000-0000-0000-0000-000000000001', pg_temp.uid('n02'),
        '[{"type":"text","text":"has joined the server"}]', true, '{"type":"member_join"}');
SELECT ok(NOT pg_temp.posted('n02')
          AND NOT EXISTS (SELECT 1 FROM public.notifications n
                           WHERE n.type = 'newcomer_message'
                             AND n.data ->> 'from_user_id' = pg_temp.uid('n02')::text),
          'a system row neither counts nor alerts');
SELECT is(pg_temp.alerted(pg_temp.say('n02', 'hi after the join notice')), ARRAY['b61', 'g61', 'm61', 'o61'],
          'the member''s next real message is their first');

INSERT INTO public.bots (id, username, display_name, owner_id)
SELECT 'f6150000-0000-0000-0000-000000000001', 'bot61', 'Bot 61', id FROM u61 WHERE name = 'o61';
SELECT is((SELECT count(*)::int FROM public.server_first_messages
            WHERE server_id = 'f6120000-0000-0000-0000-000000000001'), 5,
          'five members have posted before the bot');
INSERT INTO public.messages (channel_id, bot_id, content)
VALUES ('f6140000-0000-0000-0000-000000000001', 'f6150000-0000-0000-0000-000000000001',
        '[{"type":"text","text":"beep"}]');
SELECT is((SELECT count(*)::int FROM public.server_first_messages
            WHERE server_id = 'f6120000-0000-0000-0000-000000000001'), 5,
          'a bot message neither counts nor alerts');

INSERT INTO public.messages (channel_id, user_id, content, is_deleted)
VALUES ('f6140000-0000-0000-0000-000000000001', pg_temp.uid('n03'), '[{"type":"text","text":"gone"}]', true);
SELECT ok(NOT pg_temp.posted('n03'), 'a row inserted deleted does not count');

DELETE FROM public.server_first_messages
 WHERE user_id = pg_temp.uid('n02') AND server_id = 'f6120000-0000-0000-0000-000000000001';
SELECT is(pg_temp.alerted(pg_temp.say('n02', 'posting again')), '{}'::text[],
          'a poster with no first-message row is checked against their earlier messages');
SELECT ok(pg_temp.posted('n02'), 'and the row is recreated');

DELETE FROM public.user_servers
 WHERE user_id = pg_temp.uid('n01') AND server_id = 'f6120000-0000-0000-0000-000000000001';
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES (pg_temp.uid('n01'), 'f6120000-0000-0000-0000-000000000001', 'accepted');
SELECT is(pg_temp.alerted(pg_temp.say('n01', 'back again')), '{}'::text[],
          'a member who posted, left and rejoined is not new again');

-- Switches ------------------------------------------------------------------------------
SELECT pg_temp.as_user('o61');
SELECT public.set_server_newcomer_alerts('f6120000-0000-0000-0000-000000000001', false);
SELECT tests.clear_authentication();
SELECT is(pg_temp.alerted(pg_temp.say('n04', 'quiet server')), '{}'::text[],
          'the per-server switch turns alerts off');
SELECT pg_temp.as_user('o61');
SELECT public.set_server_newcomer_alerts('f6120000-0000-0000-0000-000000000001', NULL);
SELECT tests.clear_authentication();
SELECT is(pg_temp.alerted(pg_temp.say('n04', 'quiet server again')), '{}'::text[],
          'a first message posted while alerts were off is not alerted later');

INSERT INTO public.instance_config (config_key, config_value) VALUES ('newcomer_alerts_default', 'false')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
SELECT is(pg_temp.alerted(pg_temp.say('n05', 'instance says no')), '{}'::text[],
          'the instance default off silences a server that has not chosen');
SELECT pg_temp.as_user('o61');
SELECT is(public.set_server_newcomer_alerts('f6120000-0000-0000-0000-000000000001', true),
          '{"enabled": true, "server_value": true, "instance_default": false}'::jsonb,
          'a server can turn alerts on against the instance default');
SELECT tests.clear_authentication();
SELECT is(pg_temp.alerted(pg_temp.say('n06', 'server says yes')), ARRAY['b61', 'g61', 'm61', 'o61'],
          'the server''s own choice wins over the instance default');
DELETE FROM public.instance_config WHERE config_key = 'newcomer_alerts_default';
SELECT pg_temp.as_user('o61');
SELECT public.set_server_newcomer_alerts('f6120000-0000-0000-0000-000000000001', NULL);
SELECT tests.clear_authentication();

SELECT pg_temp.as_user('m61');
INSERT INTO public.notification_preferences (user_id, newcomer_alerts) VALUES (pg_temp.uid('m61'), false)
ON CONFLICT (user_id) DO UPDATE SET newcomer_alerts = EXCLUDED.newcomer_alerts;
SELECT tests.clear_authentication();
SELECT is(pg_temp.alerted(pg_temp.say('n07', 'is anyone around')), ARRAY['b61', 'g61', 'o61'],
          'a moderator who muted newcomer alerts gets none');
UPDATE public.notification_preferences SET newcomer_alerts = true WHERE user_id = pg_temp.uid('m61');

-- Channel visibility ----------------------------------------------------------------------
SELECT is(pg_temp.alerted(pg_temp.say('n08', 'side channel hello', 'f6140000-0000-0000-0000-000000000002')),
          ARRAY['g61', 'm61', 'o61'],
          'a moderator who cannot view the channel is not alerted');

-- Encrypted ----------------------------------------------------------------------------
INSERT INTO m61 VALUES ('n09 encrypted', 'f6160000-0000-0000-0000-000000000009');
INSERT INTO public.messages (id, channel_id, user_id, content, encrypted)
VALUES ('f6160000-0000-0000-0000-000000000009', 'f6140000-0000-0000-0000-000000000001', pg_temp.uid('n09'),
        '[{"type":"text","text":"ciphertext61"}]', true);
SELECT is(pg_temp.alerted('f6160000-0000-0000-0000-000000000009'), ARRAY['b61', 'g61', 'm61', 'o61'],
          'an encrypted first message alerts');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.notifications n
                       WHERE n.type = 'newcomer_message'
                         AND n.data ->> 'message_id' = 'f6160000-0000-0000-0000-000000000009'
                         AND n.data::text LIKE '%ciphertext61%'),
          'an encrypted message carries no content in its alert');
SELECT is((SELECT jsonb_build_object('encrypted', d -> 'encrypted', 'preview', d -> 'preview',
                                     'content_preview', d -> 'message' -> 'content_preview')
             FROM pg_temp.alert_data('f6160000-0000-0000-0000-000000000009', 'o61') d),
          '{"encrypted": true, "preview": null, "content_preview": "Encrypted message"}'::jsonb,
          'the alert is marked encrypted');

-- Thread ---------------------------------------------------------------------------------
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
SELECT 'f6170000-0000-0000-0000-000000000001', 'f6140000-0000-0000-0000-000000000001', m.id, 'thread61', m.user_id
  FROM public.messages m
 WHERE m.channel_id = 'f6140000-0000-0000-0000-000000000001' AND m.user_id = pg_temp.uid('o61')
 LIMIT 1;
INSERT INTO m61 VALUES ('n10 thread', pg_temp.say('n10', 'reply in a thread', 'f6140000-0000-0000-0000-000000000001',
                                                  'f6170000-0000-0000-0000-000000000001'));
SELECT is(pg_temp.alerted((SELECT id FROM m61 WHERE label = 'n10 thread')), ARRAY['b61', 'g61', 'm61', 'o61'],
          'a first message in a thread alerts');
SELECT is((SELECT jsonb_build_object('thread_id', d ->> 'thread_id', 'thread', d -> 'thread' ->> 'id')
             FROM pg_temp.alert_data((SELECT id FROM m61 WHERE label = 'n10 thread'), 'o61') d),
          '{"thread_id": "f6170000-0000-0000-0000-000000000001", "thread": "f6170000-0000-0000-0000-000000000001"}'::jsonb,
          'a thread alert names the thread');

-- Cap ------------------------------------------------------------------------------------
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT id, 'f6120000-0000-0000-0000-000000000001', 'accepted' FROM u61 WHERE name ~ '^c0';
INSERT INTO public.user_roles (user_id, role_id, server_id)
SELECT id, 'f6130000-0000-0000-0000-000000000004', 'f6120000-0000-0000-0000-000000000001'
  FROM u61 WHERE name ~ '^c0';
INSERT INTO m61 VALUES ('n11 cap', pg_temp.say('n11', 'twelve staff'));
SELECT is(cardinality(pg_temp.alerted((SELECT id FROM m61 WHERE label = 'n11 cap'))), 10,
          'twelve staff members receive at most ten alerts');
SELECT ok(pg_temp.alerted((SELECT id FROM m61 WHERE label = 'n11 cap')) @> ARRAY['b61', 'g61', 'm61', 'o61'],
          'the owner and the higher roles come first');

UPDATE public.server_roles SET permissions = 12290 | 2048
 WHERE server_id = 'f6120000-0000-0000-0000-000000000001' AND is_default;
SELECT is(cardinality(pg_temp.alerted(pg_temp.say('p61', 'everyone is staff'))), 10,
          'when @everyone carries a moderation bit every member qualifies, still capped');
UPDATE public.server_roles SET permissions = 12290
 WHERE server_id = 'f6120000-0000-0000-0000-000000000001' AND is_default;

-- Remote server ----------------------------------------------------------------------------
INSERT INTO public.servers (id, name, owner, is_local_server, host_domain)
SELECT 'f6120000-0000-0000-0000-000000000002', 'Remote 61', id, false, 'remote.example' FROM u61 WHERE name = 'o61';
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f6140000-0000-0000-0000-000000000003', 'f6120000-0000-0000-0000-000000000002', 'remote61', 0);
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT id, 'f6120000-0000-0000-0000-000000000002', 'accepted' FROM u61 WHERE name IN ('o61', 'n12');
INSERT INTO m61 VALUES ('n12 remote', gen_random_uuid());
INSERT INTO public.messages (id, channel_id, user_id, content)
SELECT id, 'f6140000-0000-0000-0000-000000000003', pg_temp.uid('n12'), '[{"type":"text","text":"remote hello"}]'
  FROM m61 WHERE label = 'n12 remote';
SELECT is(pg_temp.alerted((SELECT id FROM m61 WHERE label = 'n12 remote')), '{}'::text[],
          'a server homed on another instance raises no alerts');

-- AutoMod --------------------------------------------------------------------------------
SELECT pg_temp.as_user('o61');
SELECT lives_ok($q$SELECT public.update_server_automod_settings('f6120000-0000-0000-0000-000000000001',
                   '{"enabled": true}'::jsonb)$q$, 'the owner enables AutoMod');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('f6120000-0000-0000-0000-000000000001',
                   '{"name": "Words", "rule_type": "keyword", "config": {"keywords": ["zorblax"]},
                     "actions": {"block": true}}'::jsonb)$q$,
                'the owner adds a blocking keyword rule');
SELECT tests.clear_authentication();
SELECT is(pg_temp.say('n12', 'what a zorblax'), NULL::uuid, 'AutoMod drops the first message');
SELECT ok(NOT pg_temp.posted('n12')
          AND NOT EXISTS (SELECT 1 FROM public.notifications n
                           WHERE n.type = 'newcomer_message'
                             AND n.data ->> 'from_user_id' = pg_temp.uid('n12')::text),
          'a dropped message neither counts nor alerts');
INSERT INTO m61 VALUES ('n12 clean', pg_temp.say('n12', 'a clean hello'));
SELECT ok(pg_temp.alerted((SELECT id FROM m61 WHERE label = 'n12 clean')) @> ARRAY['b61', 'g61', 'm61', 'o61'],
          'the next message that gets through is the first');

SELECT * FROM finish();
ROLLBACK;
