-- Every server permission outside the message-content (153) and voice (154) files: a member
-- without it is refused at its enforcement point, a holder passes, and channel overrides act
-- where Discord honours them. 20261017100003_permission_audit.sql: strangers and banned
-- members hold nothing; a channel without VIEW_CHANNEL grants nothing; threads need
-- CREATE_PUBLIC_THREADS; a timed-out member reacts to nothing and starts no thread.
--
-- Server "audit", owned by alice. @everyone holds VIEW_CHANNEL, SEND_MESSAGES and
-- READ_MESSAGE_HISTORY (2 | 4096 | 4194304 = 4198402).
--   bob      member, no role
--   mallory  not a member
--   banned   user_servers status banned
--   mod      role mods (position 10): MANAGE_CHANNELS, MANAGE_ROLES, MANAGE_EMOJIS,
--            VIEW_AUDIT_LOG, MANAGE_WEBHOOKS, MANAGE_SERVER, CREATE_INVITE, KICK_MEMBERS,
--            BAN_MEMBERS, TIMEOUT_MEMBERS, SEND_MESSAGES_IN_THREADS, CREATE_PUBLIC_THREADS,
--            ATTACH_FILES, ADD_REACTIONS, MENTION_EVERYONE, MANAGE_MESSAGES (3567612)
--   pinner   role pinners (position 2): PIN_MESSAGES (8388608)
--   privy    role privy (position 2): CREATE_PRIVATE_THREADS (32768)
--   admin    role admins (position 20): ADMINISTRATOR (1)
--   target, victim  members, no role
--
--   open      no overrides
--   hidden    @everyone: Deny VIEW_CHANNEL
--   readonly  @everyone: Deny SEND_MESSAGES; mods: Allow SEND_MESSAGES
--   grantee   bob: Allow MANAGE_CHANNELS, MANAGE_WEBHOOKS (4 | 64)
--   permchan  bob: Allow MANAGE_ROLES (8)
--   nopin     pinners: Deny PIN_MESSAGES
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(78);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('a1550000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pa-mod@test.local'),
  ('a1550000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pa-pinner@test.local'),
  ('a1550000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pa-privy@test.local'),
  ('a1550000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pa-admin@test.local'),
  ('a1550000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pa-target@test.local'),
  ('a1550000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pa-victim@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('e1550000-0000-0000-0000-000000000001', 'a1550000-0000-0000-0000-000000000001', 'pamod', 'Mod', true),
  ('e1550000-0000-0000-0000-000000000002', 'a1550000-0000-0000-0000-000000000002', 'papinner', 'Pinner', true),
  ('e1550000-0000-0000-0000-000000000003', 'a1550000-0000-0000-0000-000000000003', 'paprivy', 'Privy', true),
  ('e1550000-0000-0000-0000-000000000004', 'a1550000-0000-0000-0000-000000000004', 'paadmin', 'Admin', true),
  ('e1550000-0000-0000-0000-000000000005', 'a1550000-0000-0000-0000-000000000005', 'patarget', 'Target', true),
  ('e1550000-0000-0000-0000-000000000006', 'a1550000-0000-0000-0000-000000000006', 'pavictim', 'Victim', true);

INSERT INTO public.servers (id, name, owner)
VALUES ('e1551000-0000-0000-0000-000000000001', 'audit', '11111111-0000-0000-0000-000000000001');
UPDATE public.server_roles SET permissions = 4198402
 WHERE server_id = 'e1551000-0000-0000-0000-000000000001' AND is_default;
SELECT set_config('tests.everyone',
                  (SELECT id::text FROM public.server_roles
                    WHERE server_id = 'e1551000-0000-0000-0000-000000000001' AND is_default), true);

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('22222222-0000-0000-0000-000000000002', 'e1551000-0000-0000-0000-000000000001', 'accepted'),
  ('44444444-0000-0000-0000-000000000004', 'e1551000-0000-0000-0000-000000000001', 'banned'),
  ('e1550000-0000-0000-0000-000000000001', 'e1551000-0000-0000-0000-000000000001', 'accepted'),
  ('e1550000-0000-0000-0000-000000000002', 'e1551000-0000-0000-0000-000000000001', 'accepted'),
  ('e1550000-0000-0000-0000-000000000003', 'e1551000-0000-0000-0000-000000000001', 'accepted'),
  ('e1550000-0000-0000-0000-000000000004', 'e1551000-0000-0000-0000-000000000001', 'accepted'),
  ('e1550000-0000-0000-0000-000000000005', 'e1551000-0000-0000-0000-000000000001', 'accepted'),
  ('e1550000-0000-0000-0000-000000000006', 'e1551000-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT DO NOTHING;

INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('e1552000-0000-0000-0000-000000000001', 'e1551000-0000-0000-0000-000000000001', 'mods', 10, 3567612),
  ('e1552000-0000-0000-0000-000000000002', 'e1551000-0000-0000-0000-000000000001', 'pinners', 2, 8388608),
  ('e1552000-0000-0000-0000-000000000003', 'e1551000-0000-0000-0000-000000000001', 'privy', 2, 32768),
  ('e1552000-0000-0000-0000-000000000004', 'e1551000-0000-0000-0000-000000000001', 'admins', 20, 1);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('e1550000-0000-0000-0000-000000000001', 'e1552000-0000-0000-0000-000000000001', 'e1551000-0000-0000-0000-000000000001'),
  ('e1550000-0000-0000-0000-000000000002', 'e1552000-0000-0000-0000-000000000002', 'e1551000-0000-0000-0000-000000000001'),
  ('e1550000-0000-0000-0000-000000000003', 'e1552000-0000-0000-0000-000000000003', 'e1551000-0000-0000-0000-000000000001'),
  ('e1550000-0000-0000-0000-000000000004', 'e1552000-0000-0000-0000-000000000004', 'e1551000-0000-0000-0000-000000000001');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('e1553000-0000-0000-0000-000000000001', 'e1551000-0000-0000-0000-000000000001', 'open', 0),
  ('e1553000-0000-0000-0000-000000000002', 'e1551000-0000-0000-0000-000000000001', 'hidden', 0),
  ('e1553000-0000-0000-0000-000000000003', 'e1551000-0000-0000-0000-000000000001', 'readonly', 0),
  ('e1553000-0000-0000-0000-000000000004', 'e1551000-0000-0000-0000-000000000001', 'grantee', 0),
  ('e1553000-0000-0000-0000-000000000005', 'e1551000-0000-0000-0000-000000000001', 'permchan', 0),
  ('e1553000-0000-0000-0000-000000000006', 'e1551000-0000-0000-0000-000000000001', 'nopin', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions) VALUES
  ('e1553000-0000-0000-0000-000000000002', 'role', current_setting('tests.everyone')::uuid, NULL, 0, 2),
  ('e1553000-0000-0000-0000-000000000003', 'role', current_setting('tests.everyone')::uuid, NULL, 0, 4096),
  ('e1553000-0000-0000-0000-000000000003', 'role', 'e1552000-0000-0000-0000-000000000001', NULL, 4096, 0),
  ('e1553000-0000-0000-0000-000000000004', 'user', NULL, '22222222-0000-0000-0000-000000000002', 4 | 64, 0),
  ('e1553000-0000-0000-0000-000000000005', 'user', NULL, '22222222-0000-0000-0000-000000000002', 8, 0),
  ('e1553000-0000-0000-0000-000000000006', 'role', 'e1552000-0000-0000-0000-000000000002', NULL, 0, 8388608);

INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('e1554000-0000-0000-0000-000000000001', 'e1553000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000005', '[{"type":"text","text":"target speaks"}]'),
  ('e1554000-0000-0000-0000-000000000002', 'e1553000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"hidden"}]'),
  ('e1554000-0000-0000-0000-000000000003', 'e1553000-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"no pins here"}]'),
  ('e1554000-0000-0000-0000-000000000004', 'e1553000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"pin me"}]'),
  ('e1554000-0000-0000-0000-000000000005', 'e1553000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"thread parent"}]'),
  ('e1554000-0000-0000-0000-000000000006', 'e1553000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000005', '[{"type":"text","text":"delete me"}]'),
  ('e1554000-0000-0000-0000-000000000007', 'e1553000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000005', '[{"type":"text","text":"https://example.com"}]'),
  ('e1554000-0000-0000-0000-000000000008', 'e1553000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"another parent"}]');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
VALUES ('e1555000-0000-0000-0000-000000000001', 'e1553000-0000-0000-0000-000000000001',
        'e1554000-0000-0000-0000-000000000005', 'side', '11111111-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.rows(p_sql text) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
CREATE FUNCTION pg_temp.post(p_user uuid, p_channel uuid, p_content jsonb, p_thread uuid DEFAULT NULL)
RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO public.messages (channel_id, thread_id, user_id, content) VALUES (p_channel, p_thread, p_user, p_content);
$fn$;
CREATE FUNCTION pg_temp.text(p_text text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text));
$fn$;
CREATE FUNCTION pg_temp.attachment(p_channel uuid, p_auth uuid) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'see attached'),
         jsonb_build_object('type', 'file', 'url', '', 'fileType', 'image',
                            'path', 'c/' || p_channel || '/' || p_auth || '/' || gen_random_uuid() || '.png'));
$fn$;
CREATE FUNCTION pg_temp.everyone_mention(p_id uuid, p_user uuid) RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO public.messages (id, channel_id, user_id, content)
  VALUES (p_id, 'e1553000-0000-0000-0000-000000000001', p_user,
          jsonb_build_array(jsonb_build_object('type', 'role_mention', 'roleId', current_setting('tests.everyone')),
                            jsonb_build_object('type', 'text', 'text', ' ping')));
$fn$;
CREATE FUNCTION pg_temp.notified(p_user uuid, p_message uuid) RETURNS boolean LANGUAGE sql AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.notifications
                  WHERE user_id = p_user AND type = 'mention' AND data->>'message_id' = p_message::text);
$fn$;
CREATE FUNCTION pg_temp.voice_channel() RETURNS uuid LANGUAGE sql AS $fn$
  SELECT id FROM public.channels WHERE server_id = 'e1551000-0000-0000-0000-000000000001' AND type = 1 LIMIT 1;
$fn$;
CREATE FUNCTION pg_temp.grant_everyone(p_bits bigint) RETURNS void LANGUAGE sql AS $fn$
  UPDATE public.server_roles SET permissions = 4198402 | p_bits
   WHERE server_id = 'e1551000-0000-0000-0000-000000000001' AND is_default;
$fn$;

-- Membership and visibility ----------------------------------------------------------------
SELECT ok(public.has_permission('22222222-0000-0000-0000-000000000002', 'e1551000-0000-0000-0000-000000000001', 'VIEW_CHANNEL')
          AND NOT public.has_permission('33333333-0000-0000-0000-000000000003', 'e1551000-0000-0000-0000-000000000001', 'VIEW_CHANNEL'),
          'a stranger holds none of @everyone''s permissions');
SELECT ok(NOT public.has_permission('44444444-0000-0000-0000-000000000004', 'e1551000-0000-0000-0000-000000000001', 'SEND_MESSAGES'),
          'a banned member holds none');
SELECT ok(public.has_permission('22222222-0000-0000-0000-000000000002', 'e1551000-0000-0000-0000-000000000001', 'SEND_MESSAGES', 'e1553000-0000-0000-0000-000000000001')
          AND NOT public.has_permission('22222222-0000-0000-0000-000000000002', 'e1551000-0000-0000-0000-000000000001', 'SEND_MESSAGES', 'e1553000-0000-0000-0000-000000000002')
          AND NOT public.has_permission('22222222-0000-0000-0000-000000000002', 'e1551000-0000-0000-0000-000000000001', 'READ_MESSAGE_HISTORY', 'e1553000-0000-0000-0000-000000000002'),
          'a channel without VIEW_CHANNEL grants nothing in it');
SELECT ok(public.has_permission('11111111-0000-0000-0000-000000000001', 'e1551000-0000-0000-0000-000000000001', 'PIN_MESSAGES', 'e1553000-0000-0000-0000-000000000002')
          AND public.has_permission('e1550000-0000-0000-0000-000000000004', 'e1551000-0000-0000-0000-000000000001', 'PIN_MESSAGES', 'e1553000-0000-0000-0000-000000000002'),
          'the owner and administrators keep every permission in a hidden channel');

-- ADMINISTRATOR ----------------------------------------------------------------------------
SELECT ok(public.has_permission('e1550000-0000-0000-0000-000000000004', 'e1551000-0000-0000-0000-000000000001', 'MANAGE_SERVER')
          AND NOT public.has_permission('22222222-0000-0000-0000-000000000002', 'e1551000-0000-0000-0000-000000000001', 'MANAGE_SERVER'),
          'ADMINISTRATOR grants every permission');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT throws_ok($q$INSERT INTO public.server_roles (server_id, name, position, permissions)
                    VALUES ('e1551000-0000-0000-0000-000000000001', 'boss', 1, 1)$q$,
                 '42501', 'Cannot grant ADMINISTRATOR without holding it',
                 'a role manager without ADMINISTRATOR cannot grant it');

-- VIEW_CHANNEL -----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.channels WHERE id = 'e1553000-0000-0000-0000-000000000002'), 0,
          'without VIEW_CHANNEL a member does not see the channel');
SELECT is((SELECT count(*)::int FROM public.messages WHERE channel_id = 'e1553000-0000-0000-0000-000000000002'), 0,
          'nor read its messages');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.messages WHERE channel_id = 'e1553000-0000-0000-0000-000000000002'), 1,
          'the owner reads it');

-- MANAGE_CHANNELS --------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.rows($q$UPDATE public.channels SET name = 'renamed' WHERE id = 'e1553000-0000-0000-0000-000000000001'$q$), 0,
          'without MANAGE_CHANNELS a member edits no channel');
SELECT is(pg_temp.rows($q$UPDATE public.channels SET name = 'granted' WHERE id = 'e1553000-0000-0000-0000-000000000004'$q$), 1,
          'a channel Allow of MANAGE_CHANNELS lets them edit that channel');
SELECT throws_ok($q$INSERT INTO public.channels (server_id, name, type) VALUES ('e1551000-0000-0000-0000-000000000001', 'new', 0)$q$,
                 '42501', NULL, 'nor create a channel');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT is(pg_temp.rows($q$UPDATE public.channels SET name = 'modded' WHERE id = 'e1553000-0000-0000-0000-000000000001'$q$), 1,
          'MANAGE_CHANNELS edits channels');

-- MANAGE_ROLES -----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$INSERT INTO public.server_roles (server_id, name, position, permissions)
                    VALUES ('e1551000-0000-0000-0000-000000000001', 'mine', 0, 0)$q$,
                 '42501', NULL, 'without MANAGE_ROLES a member creates no role');
SELECT lives_ok($q$INSERT INTO public.channel_permission_overrides (channel_id, target_type, user_id, allow_permissions, deny_permissions)
                   VALUES ('e1553000-0000-0000-0000-000000000005', 'user', 'e1550000-0000-0000-0000-000000000005', 0, 4096)$q$,
                'a channel Allow of MANAGE_ROLES lets a member edit that channel''s overrides');
SELECT throws_ok($q$INSERT INTO public.channel_permission_overrides (channel_id, target_type, user_id, allow_permissions, deny_permissions)
                    VALUES ('e1553000-0000-0000-0000-000000000001', 'user', 'e1550000-0000-0000-0000-000000000005', 0, 4096)$q$,
                 '42501', NULL, 'and no other channel''s');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.server_roles (server_id, name, position, permissions)
                   VALUES ('e1551000-0000-0000-0000-000000000001', 'helpers', 1, 4096)$q$,
                'MANAGE_ROLES creates a role below the holder');

-- MANAGE_EMOJIS ----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$INSERT INTO public.emojis (name, url, server_id, scope, uploader)
                    VALUES ('nope', 'https://example.com/nope.png', 'e1551000-0000-0000-0000-000000000001', 'server', '22222222-0000-0000-0000-000000000002')$q$,
                 '42501', NULL, 'without MANAGE_EMOJIS a member adds no server emoji');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.emojis (name, url, server_id, scope, uploader)
                   VALUES ('yes', 'https://example.com/yes.png', 'e1551000-0000-0000-0000-000000000001', 'server', 'e1550000-0000-0000-0000-000000000001')$q$,
                'MANAGE_EMOJIS adds one');

-- VIEW_AUDIT_LOG ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT * FROM public.get_server_audit_log('e1551000-0000-0000-0000-000000000001')$q$,
                 '42501', 'VIEW_AUDIT_LOG required', 'without VIEW_AUDIT_LOG a member reads no audit log');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT * FROM public.get_server_audit_log('e1551000-0000-0000-0000-000000000001')$q$,
                'VIEW_AUDIT_LOG reads it');
SELECT tests.clear_authentication();
SELECT pg_temp.grant_everyone(32);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT * FROM public.get_server_audit_log('e1551000-0000-0000-0000-000000000001')$q$,
                 '42501', 'VIEW_AUDIT_LOG required', 'a stranger reads no audit log when @everyone holds VIEW_AUDIT_LOG');
SELECT tests.clear_authentication();
SELECT pg_temp.grant_everyone(0);

-- MANAGE_WEBHOOKS --------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_channel_webhook('e1553000-0000-0000-0000-000000000001', 'hook', NULL)$q$,
                 '42501', 'Permission denied: MANAGE_WEBHOOKS required', 'without MANAGE_WEBHOOKS a member creates no webhook');
SELECT lives_ok($q$SELECT public.create_channel_webhook('e1553000-0000-0000-0000-000000000004', 'hook', NULL)$q$,
                'a channel Allow of MANAGE_WEBHOOKS lets them create one there');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.create_channel_webhook('e1553000-0000-0000-0000-000000000001', 'hook', NULL)$q$,
                'MANAGE_WEBHOOKS creates webhooks');

-- MANAGE_SERVER ----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.update_server('e1551000-0000-0000-0000-000000000001', '{"description": "bob was here"}')$q$,
                 '42501', 'Missing permission: MANAGE_SERVER', 'without MANAGE_SERVER a member edits no server setting');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.update_server('e1551000-0000-0000-0000-000000000001', '{"description": "moderated"}')$q$,
                'MANAGE_SERVER edits them');
SELECT tests.clear_authentication();
SELECT pg_temp.grant_everyone(128);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.get_server_member_timeouts('e1551000-0000-0000-0000-000000000001')$q$,
                 '42501', 'Missing permission: TIMEOUT_MEMBERS or MANAGE_SERVER',
                 'a stranger reads no AutoMod timeouts when @everyone holds MANAGE_SERVER');
SELECT tests.clear_authentication();
SELECT pg_temp.grant_everyone(0);

-- CREATE_INVITE ----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$INSERT INTO public.invites (code, server_id, created_by)
                    VALUES ('pa-bob', 'e1551000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002')$q$,
                 '42501', NULL, 'without CREATE_INVITE a member creates no invite');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.invites (code, server_id, created_by)
                   VALUES ('pa-mod', 'e1551000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000001')$q$,
                'CREATE_INVITE creates one');

-- KICK_MEMBERS -----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.kick_server_member('e1551000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000005')$q$,
                 'P0001', 'Missing KICK_MEMBERS permission', 'without KICK_MEMBERS a member kicks no one');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.kick_server_member('e1551000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000005')$q$,
                'KICK_MEMBERS kicks a lower-ranked member');

-- BAN_MEMBERS ------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.ban_server_member('e1551000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000006')$q$,
                 'P0001', 'Missing BAN_MEMBERS permission', 'without BAN_MEMBERS a member bans no one');
SELECT throws_ok($q$SELECT public.get_server_bans('e1551000-0000-0000-0000-000000000001')$q$,
                 'P0001', 'Missing BAN_MEMBERS permission', 'nor lists bans');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.ban_server_member('e1551000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000006')$q$,
                'BAN_MEMBERS bans a lower-ranked member');
SELECT ok(public.get_server_bans('e1551000-0000-0000-0000-000000000001')::text LIKE '%e1550000-0000-0000-0000-000000000006%',
          'and lists the ban');

-- TIMEOUT_MEMBERS --------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_server_member_timeout('e1551000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000003', 60)$q$,
                 '42501', 'Missing permission: TIMEOUT_MEMBERS', 'without TIMEOUT_MEMBERS a member times out no one');
SELECT throws_ok($q$SELECT * FROM public.get_server_member_timeouts('e1551000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'nor lists timeouts');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.set_server_member_timeout('e1551000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000003', 60)$q$,
                'TIMEOUT_MEMBERS times out a lower-ranked member');

-- A timed-out member (privy) reacts to nothing, starts no thread and is admitted to no voice
-- channel, while @everyone grants all three. ------------------------------------------------
SELECT tests.clear_authentication();
SELECT pg_temp.grant_everyone(16384 | 262144 | 16777216);
INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
VALUES ('e1554000-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001', '🐝');
SELECT ok(NOT public.voice_channel_admits('e1550000-0000-0000-0000-000000000003', pg_temp.voice_channel())
          AND public.voice_channel_admits('22222222-0000-0000-0000-000000000002', pg_temp.voice_channel()),
          'a timed-out member is admitted to no voice channel');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000003');
SELECT throws_like($q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
                      VALUES ('e1554000-0000-0000-0000-000000000004', 'e1550000-0000-0000-0000-000000000003', '🐝')$q$,
                   'MEMBER_TIMED_OUT:%', 'a timed-out member joins no reaction');
SELECT throws_like($q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
                      VALUES ('e1554000-0000-0000-0000-000000000004', 'e1550000-0000-0000-0000-000000000003', '🐢')$q$,
                   'MEMBER_TIMED_OUT:%', 'nor adds one');
SELECT throws_like($q$SELECT public.create_channel_thread('e1553000-0000-0000-0000-000000000001', 'while out')$q$,
                   'MEMBER_TIMED_OUT:%', 'nor starts a thread');
SELECT throws_like($q$SELECT public.create_thread('e1554000-0000-0000-0000-000000000008', 'while out')$q$,
                   'MEMBER_TIMED_OUT:%', 'nor one from a message');
SELECT throws_like($q$INSERT INTO public.threads (channel_id, parent_message_id, name, created_by)
                      VALUES ('e1553000-0000-0000-0000-000000000001', 'e1554000-0000-0000-0000-000000000008', 'while out', 'e1550000-0000-0000-0000-000000000003')$q$,
                   'MEMBER_TIMED_OUT:%', 'nor writes a threads row');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
                   VALUES ('e1554000-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000002', '🐢')$q$,
                'a member not timed out reacts');
SELECT lives_ok($q$SELECT public.create_channel_thread('e1553000-0000-0000-0000-000000000001', 'bob thread')$q$,
                'and starts a thread');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT public.set_server_member_timeout('e1551000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000003', 0);
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000003');
SELECT lives_ok($q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
                   VALUES ('e1554000-0000-0000-0000-000000000004', 'e1550000-0000-0000-0000-000000000003', '🐝')$q$,
                'once the timeout is lifted, they react again');
SELECT tests.clear_authentication();
SELECT pg_temp.grant_everyone(0);

-- SEND_MESSAGES ----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT pg_temp.post('22222222-0000-0000-0000-000000000002', 'e1553000-0000-0000-0000-000000000003', pg_temp.text('hi'))$q$,
                 '42501', NULL, 'a channel Deny of SEND_MESSAGES refuses the member''s message');
SELECT lives_ok($q$SELECT pg_temp.post('22222222-0000-0000-0000-000000000002', 'e1553000-0000-0000-0000-000000000001', pg_temp.text('hi'))$q$,
                '@everyone''s SEND_MESSAGES posts elsewhere');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT pg_temp.post('e1550000-0000-0000-0000-000000000001', 'e1553000-0000-0000-0000-000000000003', pg_temp.text('mods only'))$q$,
                'a role Allow restores SEND_MESSAGES over @everyone''s Deny');

-- SEND_MESSAGES_IN_THREADS -----------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT pg_temp.post('22222222-0000-0000-0000-000000000002', 'e1553000-0000-0000-0000-000000000001', pg_temp.text('in thread'), 'e1555000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'SEND_MESSAGES does not reach threads without SEND_MESSAGES_IN_THREADS');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT pg_temp.post('e1550000-0000-0000-0000-000000000001', 'e1553000-0000-0000-0000-000000000001', pg_temp.text('in thread'), 'e1555000-0000-0000-0000-000000000001')$q$,
                'SEND_MESSAGES_IN_THREADS posts in a thread');

-- CREATE_PUBLIC_THREADS, CREATE_PRIVATE_THREADS --------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_channel_thread('e1553000-0000-0000-0000-000000000001', 'bob thread')$q$,
                 '42501', 'Unauthorized: CREATE_PUBLIC_THREADS required', 'without CREATE_PUBLIC_THREADS a member starts no thread');
SELECT throws_ok($q$SELECT public.create_thread('e1554000-0000-0000-0000-000000000008', 'bob thread')$q$,
                 '42501', 'Unauthorized: CREATE_PUBLIC_THREADS required', 'nor one from a message');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.create_channel_thread('e1553000-0000-0000-0000-000000000001', 'private?')$q$,
                 '42501', 'Unauthorized: CREATE_PUBLIC_THREADS required', 'CREATE_PRIVATE_THREADS alone starts no thread');
SELECT throws_ok($q$SELECT public.create_thread('e1554000-0000-0000-0000-000000000008', 'private?')$q$,
                 '42501', 'Unauthorized: CREATE_PUBLIC_THREADS required', 'nor one from a message');
SELECT throws_ok($q$INSERT INTO public.threads (channel_id, parent_message_id, name, created_by)
                    VALUES ('e1553000-0000-0000-0000-000000000001', 'e1554000-0000-0000-0000-000000000008', 'private?', 'e1550000-0000-0000-0000-000000000003')$q$,
                 '42501', NULL, 'nor writes a threads row');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.create_channel_thread('e1553000-0000-0000-0000-000000000001', 'mods thread')$q$,
                'CREATE_PUBLIC_THREADS starts a thread');

-- ATTACH_FILES -----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT pg_temp.post('22222222-0000-0000-0000-000000000002', 'e1553000-0000-0000-0000-000000000001',
                                         pg_temp.attachment('e1553000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'))$q$,
                 '42501', 'Missing permission: ATTACH_FILES', 'without ATTACH_FILES a member uploads nothing');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT pg_temp.post('e1550000-0000-0000-0000-000000000001', 'e1553000-0000-0000-0000-000000000001',
                                        pg_temp.attachment('e1553000-0000-0000-0000-000000000001', 'a1550000-0000-0000-0000-000000000001'))$q$,
                'ATTACH_FILES uploads');

-- ADD_REACTIONS ----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
                    VALUES ('e1554000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', '🦊')$q$,
                 '42501', 'Missing permission: ADD_REACTIONS', 'without ADD_REACTIONS a member adds no new reaction');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
                   VALUES ('e1554000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000001', '🦊')$q$,
                'ADD_REACTIONS adds one');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
                   VALUES ('e1554000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', '🦊')$q$,
                'and anyone joins an existing reaction');

-- MENTION_EVERYONE -------------------------------------------------------------------------
SELECT tests.clear_authentication();
SELECT pg_temp.everyone_mention('e1554000-0000-0000-0000-0000000000e1', '22222222-0000-0000-0000-000000000002');
SELECT pg_temp.everyone_mention('e1554000-0000-0000-0000-0000000000e2', 'e1550000-0000-0000-0000-000000000001');
SELECT ok(NOT pg_temp.notified('e1550000-0000-0000-0000-000000000005', 'e1554000-0000-0000-0000-0000000000e1')
          AND NOT pg_temp.notified('e1550000-0000-0000-0000-000000000002', 'e1554000-0000-0000-0000-0000000000e1'),
          'without MENTION_EVERYONE @everyone notifies no one');
SELECT ok(pg_temp.notified('e1550000-0000-0000-0000-000000000002', 'e1554000-0000-0000-0000-0000000000e2'),
          'MENTION_EVERYONE notifies the server');

-- MANAGE_MESSAGES --------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.rows($q$UPDATE public.messages SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true
                          WHERE id = 'e1554000-0000-0000-0000-000000000006'$q$), 0,
          'without MANAGE_MESSAGES a member deletes no one else''s message');
SELECT throws_ok($q$SELECT public.set_message_embeds_suppressed('e1554000-0000-0000-0000-000000000007', true)$q$,
                 '42501', 'Permission denied: MANAGE_MESSAGES required', 'nor removes their embeds');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000001');
SELECT is(pg_temp.rows($q$UPDATE public.messages SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true
                          WHERE id = 'e1554000-0000-0000-0000-000000000006'$q$), 1,
          'MANAGE_MESSAGES deletes it');
SELECT lives_ok($q$SELECT public.set_message_embeds_suppressed('e1554000-0000-0000-0000-000000000007', true)$q$,
                'and removes embeds');
SELECT throws_ok($q$SELECT public.set_message_embeds_suppressed('e1554000-0000-0000-0000-000000000002', true)$q$,
                 '42501', 'Permission denied: MANAGE_MESSAGES required', 'but not in a channel hidden from the holder');

-- PIN_MESSAGES -----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.pin_message('e1554000-0000-0000-0000-000000000004')$q$,
                 'P0001', 'Permission denied: cannot pin messages', 'without PIN_MESSAGES a member pins nothing');
SELECT tests.authenticate_as('a1550000-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.pin_message('e1554000-0000-0000-0000-000000000004')$q$, 'PIN_MESSAGES pins');
SELECT lives_ok($q$SELECT public.unpin_message('e1554000-0000-0000-0000-000000000004')$q$, 'and unpins');
SELECT throws_ok($q$SELECT public.pin_message('e1554000-0000-0000-0000-000000000003')$q$,
                 'P0001', 'Permission denied: cannot pin messages', 'a channel Deny of PIN_MESSAGES refuses it there');
SELECT throws_ok($q$SELECT public.pin_message('e1554000-0000-0000-0000-000000000002')$q$,
                 'P0001', 'Permission denied: cannot pin messages', 'as does a channel hidden from the holder');
SELECT tests.clear_authentication();
SELECT pg_temp.grant_everyone(8388608);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.pin_message('e1554000-0000-0000-0000-000000000004')$q$,
                 'P0001', 'Permission denied: cannot pin messages', 'a stranger pins nothing when @everyone holds PIN_MESSAGES');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.pin_message('e1554000-0000-0000-0000-000000000004')$q$, 'while a member pins through @everyone');

SELECT * FROM finish();
ROLLBACK;
