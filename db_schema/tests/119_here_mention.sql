-- @here after 20261011600001_here_mention.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not, banned is banned. Added
-- members carol (idle), dave (do not disturb), erin (invisible), fred (online at his last
-- heartbeat, ten minutes ago) and gwen (no presence). alice, bob, mallory and banned are online.
-- Role r119 (mentionable) is held by bob and gwen; role pingers (MENTION_EVERYONE) by nobody yet;
-- role hushers by carol. Channel hush119 is hidden from @everyone and open to hushers.
-- reached(message) lists the members a mention notification of the message reached, each with
-- :here, :everyone or :role as the notification says. AutoMod is off but for mention_spam,
-- which blocks nothing until the AutoMod section.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(28);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1190000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol119@test.local'),
  ('f1190000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave119@test.local'),
  ('f1190000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin119@test.local'),
  ('f1190000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fred119@test.local'),
  ('f1190000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gwen119@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1190000-0000-0000-0000-0000000000c3', 'f1190000-0000-0000-0000-0000000000a3', 'carol119', 'Carol', true),
  ('f1190000-0000-0000-0000-0000000000c4', 'f1190000-0000-0000-0000-0000000000a4', 'dave119', 'Dave', true),
  ('f1190000-0000-0000-0000-0000000000c5', 'f1190000-0000-0000-0000-0000000000a5', 'erin119', 'Erin', true),
  ('f1190000-0000-0000-0000-0000000000c6', 'f1190000-0000-0000-0000-0000000000a6', 'fred119', 'Fred', true),
  ('f1190000-0000-0000-0000-0000000000c7', 'f1190000-0000-0000-0000-0000000000a7', 'gwen119', 'Gwen', true);
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT p, '55555555-0000-0000-0000-000000000005', 'accepted'
  FROM unnest(ARRAY['f1190000-0000-0000-0000-0000000000c3', 'f1190000-0000-0000-0000-0000000000c4',
                    'f1190000-0000-0000-0000-0000000000c5', 'f1190000-0000-0000-0000-0000000000c6',
                    'f1190000-0000-0000-0000-0000000000c7']::uuid[]) p;

-- Status 1 online, 2 idle, 3 do not disturb, 4 invisible; a device heartbeat p_seen ago.
CREATE FUNCTION pg_temp.presence(p_profile uuid, p_status smallint, p_seen interval) RETURNS void
LANGUAGE sql AS $fn$
    INSERT INTO public.user_presence (profile_id, status, online, last_seen_at)
    VALUES (p_profile, p_status, true, now() - p_seen)
    ON CONFLICT (profile_id) DO UPDATE SET status = EXCLUDED.status, online = true,
                                           last_seen_at = EXCLUDED.last_seen_at;
    INSERT INTO public.presence_devices (profile_id, device_id, last_seen_at)
    VALUES (p_profile, 'tab119', now() - p_seen)
    ON CONFLICT (profile_id, device_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at;
$fn$;
SELECT pg_temp.presence('11111111-0000-0000-0000-000000000001', 1::smallint, '0 s');
SELECT pg_temp.presence('22222222-0000-0000-0000-000000000002', 1::smallint, '10 s');
SELECT pg_temp.presence('33333333-0000-0000-0000-000000000003', 1::smallint, '0 s');
SELECT pg_temp.presence('44444444-0000-0000-0000-000000000004', 1::smallint, '0 s');
SELECT pg_temp.presence('f1190000-0000-0000-0000-0000000000c3', 2::smallint, '0 s');
SELECT pg_temp.presence('f1190000-0000-0000-0000-0000000000c4', 3::smallint, '2 min');
SELECT pg_temp.presence('f1190000-0000-0000-0000-0000000000c5', 4::smallint, '0 s');
SELECT pg_temp.presence('f1190000-0000-0000-0000-0000000000c6', 1::smallint, '10 min');

INSERT INTO public.server_roles (id, server_id, name, position, permissions, mentionable) VALUES
  ('f1191000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'r119', 1, 0, true),
  ('f1191000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'pingers', 2, 1048576, false),
  ('f1191000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'hushers', 3, 0, false);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1191000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('f1190000-0000-0000-0000-0000000000c7', 'f1191000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('f1190000-0000-0000-0000-0000000000c3', 'f1191000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1192000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'hush119', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT 'f1192000-0000-0000-0000-000000000001', 'role', r.id, 0, 2
  FROM public.server_roles r WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
VALUES ('f1192000-0000-0000-0000-000000000001', 'role', 'f1191000-0000-0000-0000-000000000003', 2, 0);

UPDATE public.server_automod_rules
   SET enabled = rule_type = 'mention_spam',
       config = config || '{"window_mentions": 0}'::jsonb
 WHERE server_id = '55555555-0000-0000-0000-000000000005';

INSERT INTO public.bots (id, username, owner_id, bot_type) VALUES
  ('f1193000-0000-0000-0000-000000000001', 'quiet119', '11111111-0000-0000-0000-000000000001', 'bot'),
  ('f1193000-0000-0000-0000-000000000002', 'loud119', '11111111-0000-0000-0000-000000000001', 'bot');
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, mention_everyone) VALUES
  ('f1193000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', false),
  ('f1193000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', true);

CREATE FUNCTION pg_temp.post(p_user uuid, p_content jsonb,
                             p_channel uuid DEFAULT '66666666-0000-0000-0000-000000000006',
                             p_bot uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $fn$
DECLARE
    v uuid;
BEGIN
    INSERT INTO public.messages (channel_id, user_id, bot_id, content)
    VALUES (p_channel, p_user, p_bot, p_content)
    RETURNING id INTO v;
    RETURN v;
END;
$fn$;

-- Rows written: 0 when AutoMod drops the message.
CREATE FUNCTION pg_temp.sent(p_user uuid, p_content jsonb) RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
    n integer;
BEGIN
    INSERT INTO public.messages (channel_id, user_id, content)
    VALUES ('66666666-0000-0000-0000-000000000006', p_user, p_content);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.sent(uuid, jsonb) TO authenticated;

CREATE FUNCTION pg_temp.reached(p_message uuid) RETURNS text[] LANGUAGE sql AS $fn$
    SELECT COALESCE(array_agg(p.username || CASE WHEN n.data->>'is_here' = 'true' THEN ':here'
                                                 WHEN n.data->>'is_everyone' = 'true' THEN ':everyone'
                                                 WHEN n.data->>'is_role_mention' = 'true' THEN ':role'
                                                 ELSE '' END
                              ORDER BY p.username, n.data::text), '{}')
      FROM public.notifications n
      JOIN public.profiles p ON p.id = n.user_id
     WHERE n.type = 'mention' AND n.data->>'message_id' = p_message::text;
$fn$;

-- bob's notifications of a message, any type.
CREATE FUNCTION pg_temp.bob(p_message uuid) RETURNS text[] LANGUAGE sql AS $fn$
    SELECT COALESCE(array_agg(n.type || CASE WHEN n.data->>'is_here' = 'true' THEN ':here' ELSE '' END
                              ORDER BY n.type), '{}')
      FROM public.notifications n
     WHERE n.user_id = '22222222-0000-0000-0000-000000000002'
       AND n.data->>'message_id' = p_message::text;
$fn$;

CREATE FUNCTION pg_temp.server(p_changes jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
    v jsonb;
BEGIN
    PERFORM tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
    v := public.update_server_notification_settings('55555555-0000-0000-0000-000000000005', p_changes);
    PERFORM tests.clear_authentication();
    RETURN v;
END;
$fn$;

CREATE FUNCTION pg_temp.here() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT '[{"type":"text","text":"standup "},{"type":"role_mention","roleId":"here","roleName":"here","roleColor":null}]'::jsonb $fn$;
CREATE FUNCTION pg_temp.everyone() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT jsonb_build_array(jsonb_build_object('type', 'role_mention', 'roleId', r.id::text))
       FROM public.server_roles r
      WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default $fn$;
CREATE FUNCTION pg_temp.at_bob() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT '[{"type":"mention","userId":"22222222-0000-0000-0000-000000000002","username":"bob"}]'::jsonb $fn$;
CREATE FUNCTION pg_temp.at_r119() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT '[{"type":"role_mention","roleId":"f1191000-0000-0000-0000-000000000001"}]'::jsonb $fn$;

-- Recipients -----------------------------------------------------------------------------------
SELECT set_config('tests.m1', pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.here())::text, true);
SELECT is(pg_temp.reached(current_setting('tests.m1')::uuid),
          ARRAY['bob:here', 'carol119:here', 'dave119:here'],
          'online, idle and do-not-disturb members are notified; invisible, stale, absent, the sender and non-members are not');
SELECT is((SELECT n.data - 'sender' - 'message' - 'location' - 'priority' - 'from_user_id' - 'mentioned_by'
                  - 'sender_username' - 'sender_display_name' - 'preview' - 'message_id'
             FROM public.notifications n
            WHERE n.user_id = '22222222-0000-0000-0000-000000000002'
              AND n.data->>'message_id' = current_setting('tests.m1')),
          jsonb_build_object('is_here', true, 'is_everyone', true, 'is_role_mention', true,
                             'server_id', '55555555-0000-0000-0000-000000000005',
                             'server_name', 'Test Server',
                             'channel_id', '66666666-0000-0000-0000-000000000006',
                             'channel_name', 'general'),
          'the notification marks @here');
SELECT is((SELECT u.unread_mentions FROM public.unread_counts u
            WHERE u.user_id = 'f1190000-0000-0000-0000-0000000000c3'
              AND u.channel_id = '66666666-0000-0000-0000-000000000006'),
          1, 'an @here counts as an unread mention');
SELECT is(pg_temp.reached(pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.here(),
                                       'f1192000-0000-0000-0000-000000000001')),
          ARRAY['carol119:here'], 'in a channel hidden from @everyone only members who view it are notified');

UPDATE public.presence_devices SET last_seen_at = now() - interval '151 seconds'
 WHERE profile_id = 'f1190000-0000-0000-0000-0000000000c4';
SELECT is(pg_temp.reached(pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.here())),
          ARRAY['bob:here', 'carol119:here'], 'a device unseen for more than 150 s is offline');
UPDATE public.presence_devices SET last_seen_at = now()
 WHERE profile_id = 'f1190000-0000-0000-0000-0000000000c4';
DELETE FROM public.presence_devices WHERE profile_id = 'f1190000-0000-0000-0000-0000000000c3';
SELECT is(pg_temp.reached(pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.here())),
          ARRAY['bob:here', 'dave119:here'], 'a member whose devices signed out is offline whatever user_presence says');
SELECT pg_temp.presence('f1190000-0000-0000-0000-0000000000c3', 2::smallint, '0 s');

SELECT is(pg_temp.reached(pg_temp.post('11111111-0000-0000-0000-000000000001',
              '[{"type":"role_mention","roleId":"HERE"},{"type":"role_mention","roleId":"there"}]'::jsonb)),
          '{}'::text[], 'only the roleId here is @here');

-- Who may @here ------------------------------------------------------------------------------
SELECT ok(NOT public.has_permission('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
                                    'MENTION_EVERYONE', '66666666-0000-0000-0000-000000000006'),
          'bob holds no MENTION_EVERYONE');
SELECT is(pg_temp.reached(pg_temp.post('22222222-0000-0000-0000-000000000002', pg_temp.here())),
          '{}'::text[], 'a member without MENTION_EVERYONE notifies no one');
SELECT is(pg_temp.reached(pg_temp.post(NULL, pg_temp.here(), p_bot => 'f1193000-0000-0000-0000-000000000001')),
          '{}'::text[], 'a bot without mention_everyone notifies no one');
SELECT is(pg_temp.reached(pg_temp.post(NULL, pg_temp.here(), p_bot => 'f1193000-0000-0000-0000-000000000002')),
          ARRAY['alice:here', 'bob:here', 'carol119:here', 'dave119:here'],
          'a bot with mention_everyone notifies the online members');

INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1191000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');
SELECT is(pg_temp.reached(pg_temp.post('22222222-0000-0000-0000-000000000002', pg_temp.here())),
          ARRAY['alice:here', 'carol119:here', 'dave119:here'],
          'with MENTION_EVERYONE through a role a member notifies the online members but themselves');
DELETE FROM public.user_roles
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = 'f1191000-0000-0000-0000-000000000002';

-- Webhooks never mention ---------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('tests.hook', public.create_channel_webhook('66666666-0000-0000-0000-000000000006', 'Deploys')::text, true);
SELECT tests.clear_authentication();
UPDATE public.bot_server_permissions SET mention_everyone = true
 WHERE bot_id = (SELECT w.bot_id FROM public.channel_webhooks w
                  WHERE w.id = (current_setting('tests.hook')::jsonb ->> 'id')::uuid);
SELECT set_config('tests.m_hook',
    public.execute_channel_webhook((current_setting('tests.hook')::jsonb ->> 'id')::uuid,
                                   encode(extensions.digest(convert_to(current_setting('tests.hook')::jsonb ->> 'token', 'UTF8'),
                                                            'sha256'), 'hex'),
                                   '@here deploy finished') ->> 'id', true);
SELECT is((SELECT content FROM public.messages WHERE id = current_setting('tests.m_hook')::uuid),
          '[{"type": "text", "text": "@here deploy finished"}]'::jsonb, 'a webhook''s @here stays text');
SELECT is(pg_temp.reached(current_setting('tests.m_hook')::uuid), '{}'::text[],
          'and notifies no one, mention_everyone or not');

-- Settings -------------------------------------------------------------------------------------
SELECT pg_temp.server('{"suppress_everyone":true}');
SELECT is(pg_temp.bob(pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.here())),
          '{}'::text[], 'suppress @everyone suppresses @here');
SELECT pg_temp.server('{"level":"all"}');
SELECT is(pg_temp.bob(pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.here())),
          ARRAY['channel_message'], 'at all, a suppressed @here notifies as a message');
SELECT pg_temp.server('{"level":"none","suppress_everyone":false}');
SELECT is(pg_temp.bob(pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.here())),
          '{}'::text[], 'level nothing: no @here');
SELECT pg_temp.server('{"level":"mentions"}');
UPDATE public.user_servers SET muted = true
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(pg_temp.bob(pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.here())),
          ARRAY['mention:here'], 'a muted server admits @here, as other mentions');
UPDATE public.user_servers SET muted = false
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND server_id = '55555555-0000-0000-0000-000000000005';

-- One notification per member ------------------------------------------------------------------
SELECT is(pg_temp.reached(pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.everyone() || pg_temp.here())),
          ARRAY['bob:everyone', 'carol119:everyone', 'dave119:everyone', 'erin119:everyone',
                'fred119:everyone', 'gwen119:everyone'],
          '@everyone and @here notify each member once, as @everyone');
SELECT is(pg_temp.reached(pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.at_bob() || pg_temp.here())),
          ARRAY['bob', 'carol119:here', 'dave119:here'],
          'a member mentioned and @here is notified once, by the mention');
SELECT is(pg_temp.reached(pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.at_r119() || pg_temp.here())),
          ARRAY['bob:here', 'carol119:here', 'dave119:here', 'gwen119:role'],
          'a role holder @here reached is not notified again; an offline holder is, by the role');

INSERT INTO public.server_settings (server_id, default_message_notifications)
VALUES ('55555555-0000-0000-0000-000000000005', 'all');
SELECT pg_temp.server('{"level":null}');
SELECT set_config('tests.m_all', pg_temp.post('11111111-0000-0000-0000-000000000001', pg_temp.here())::text, true);
SELECT is(pg_temp.bob(current_setting('tests.m_all')::uuid), ARRAY['mention:here'],
          'at all, @here replaces the message notification');
SELECT is((SELECT array_agg(p.username ORDER BY p.username)
             FROM public.notifications n JOIN public.profiles p ON p.id = n.user_id
            WHERE n.type = 'channel_message' AND n.data->>'message_id' = current_setting('tests.m_all')),
          ARRAY['erin119', 'fred119', 'gwen119'], 'members @here did not reach get the message notification');
DELETE FROM public.server_settings WHERE server_id = '55555555-0000-0000-0000-000000000005';

-- Encrypted channels ---------------------------------------------------------------------------
SELECT ok(public.is_plaintext_mention_part('{"type":"role_mention","roleId":"here"}'),
          'an encrypted message carries @here beside its ciphertext');
SELECT ok(NOT public.is_plaintext_mention_part('{"type":"role_mention","roleId":"there"}')
          AND NOT public.is_plaintext_mention_part('{"type":"role_mention","roleId":"here","roleName":"here"}'),
          'no other non-UUID role, nor a role name');

-- AutoMod --------------------------------------------------------------------------------------
UPDATE public.server_automod_rules
   SET config = config || '{"block_everyone_without_permission": true}'::jsonb
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND rule_type = 'mention_spam';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.sent('22222222-0000-0000-0000-000000000002', pg_temp.here()), 0,
          'block @everyone without the permission blocks @here');
SELECT tests.clear_authentication();
SELECT is((SELECT e.matched FROM public.automod_events e
            WHERE e.server_id = '55555555-0000-0000-0000-000000000005' AND e.user_id = '22222222-0000-0000-0000-000000000002'
            ORDER BY e.created_at DESC LIMIT 1),
          '@here', 'the event names @here');
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1191000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.sent('22222222-0000-0000-0000-000000000002', pg_temp.here()), 1,
          'a member holding MENTION_EVERYONE passes');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
