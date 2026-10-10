-- Server audit log after 20261010600001_server_audit_log.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Added:
--   carol   member holding role auditors (VIEW_AUDIT_LOG)
--   dave    member, kicked
--   erin    member holding role low, banned
--   bob's two messages in #general: alice deletes one, bob the other
--   dave's two messages in #general, purged by the kick

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(46);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1090000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol109@test.local'),
  ('f1090000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave109@test.local'),
  ('f1090000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin109@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1090000-0000-0000-0000-0000000000c1', 'f1090000-0000-0000-0000-0000000000a1', 'carol109', 'Carol', true),
  ('f1090000-0000-0000-0000-0000000000c2', 'f1090000-0000-0000-0000-0000000000a2', 'dave109', 'Dave', true),
  ('f1090000-0000-0000-0000-0000000000c3', 'f1090000-0000-0000-0000-0000000000a3', 'erin109', 'Erin', true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1090000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1090000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1090000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1091000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'auditors', 4, 32),
  ('f1091000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'low', 1, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f1090000-0000-0000-0000-0000000000c1', 'f1091000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('f1090000-0000-0000-0000-0000000000c3', 'f1091000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f1092000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"secret words 109"}]'::jsonb),
  ('f1092000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"mine 109"}]'::jsonb),
  ('f1092000-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006',
   'f1090000-0000-0000-0000-0000000000c2', '[{"type":"text","text":"dave one"}]'::jsonb),
  ('f1092000-0000-0000-0000-000000000004', '66666666-0000-0000-0000-000000000006',
   'f1090000-0000-0000-0000-0000000000c2', '[{"type":"text","text":"dave two"}]'::jsonb);
INSERT INTO public.server_settings (server_id) VALUES ('55555555-0000-0000-0000-000000000005')
ON CONFLICT (server_id) DO NOTHING;

CREATE TEMP TABLE audit_seen ON COMMIT DROP AS
SELECT id FROM public.server_audit_log;

-- Entries written since the fixtures, by alice.
CREATE FUNCTION pg_temp.alice_rows(p_action text)
RETURNS SETOF public.server_audit_log LANGUAGE sql AS $$
    SELECT l.* FROM public.server_audit_log l
     WHERE l.server_id = '55555555-0000-0000-0000-000000000005'
       AND l.actor_id = '11111111-0000-0000-0000-000000000001'
       AND l.action = p_action
       AND l.id NOT IN (SELECT id FROM audit_seen)
$$;

-- Channels ------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f1093000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'audit-room', 0);
UPDATE public.channels SET name = 'audit-hall', slowmode_seconds = 10
 WHERE id = 'f1093000-0000-0000-0000-000000000001';
UPDATE public.channels SET "order" = 7 WHERE id = 'f1093000-0000-0000-0000-000000000001';
UPDATE public.channels SET "order" = 8 WHERE id = '66666666-0000-0000-0000-000000000006';
DELETE FROM public.channels WHERE id = 'f1093000-0000-0000-0000-000000000001';

SELECT tests.clear_authentication();

SELECT is(
    (SELECT changes #>> '{name,new}' FROM pg_temp.alice_rows('channel.create')
      WHERE target_id = 'f1093000-0000-0000-0000-000000000001'),
    'audit-room', 'a channel creation is recorded with its name');
SELECT is(
    (SELECT changes FROM pg_temp.alice_rows('channel.update')
      WHERE target_id = 'f1093000-0000-0000-0000-000000000001'),
    '{"name": {"old": "audit-room", "new": "audit-hall"}, "slowmode_seconds": {"old": 0, "new": 10}}'::jsonb,
    'a channel edit records the changed columns only');
SELECT is(
    (SELECT string_agg(k || '=' || (details #>> ARRAY['items', k, 'new']), ',' ORDER BY k)
       FROM pg_temp.alice_rows('channel.reorder'), jsonb_object_keys(details -> 'items') k),
    '66666666-0000-0000-0000-000000000006=8,f1093000-0000-0000-0000-000000000001=7',
    'position-only edits fold into one reorder entry');
SELECT is(
    (SELECT count(*)::int FROM pg_temp.alice_rows('channel.update')),
    1, 'and are not recorded as channel edits');
SELECT is(
    (SELECT target_name || ' ' || source FROM pg_temp.alice_rows('channel.delete')
      WHERE target_id = 'f1093000-0000-0000-0000-000000000001'),
    'audit-hall user', 'a channel deletion keeps the channel''s last name');

-- Roles -----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.server_roles (id, server_id, name, position, permissions)
VALUES ('f1091000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'helpers', 2, 16);
UPDATE public.server_roles SET permissions = 20, color = '#ff0000'
 WHERE id = 'f1091000-0000-0000-0000-000000000003';
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1091000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005');

SELECT tests.clear_authentication();

SELECT is(
    (SELECT assigned_by FROM public.user_roles
      WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = 'f1091000-0000-0000-0000-000000000003'),
    '11111111-0000-0000-0000-000000000001'::uuid, 'a client role assignment records assigned_by');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
DELETE FROM public.user_roles
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = 'f1091000-0000-0000-0000-000000000003';
DELETE FROM public.server_roles WHERE id = 'f1091000-0000-0000-0000-000000000003';
SELECT tests.clear_authentication();

SELECT is(
    (SELECT changes #>> '{permissions,new}' FROM pg_temp.alice_rows('role.create')
      WHERE target_id = 'f1091000-0000-0000-0000-000000000003'),
    '16', 'a role creation is recorded with its permissions');
SELECT is(
    (SELECT changes FROM pg_temp.alice_rows('role.update')
      WHERE target_id = 'f1091000-0000-0000-0000-000000000003'),
    '{"color": {"new": "#ff0000"}, "permissions": {"old": 16, "new": 20}}'::jsonb,
    'a role edit records old and new permissions');
SELECT is(
    (SELECT target_id || ' ' || (details ->> 'role_name') FROM pg_temp.alice_rows('member.role_add')),
    '22222222-0000-0000-0000-000000000002 helpers', 'a role assignment names the member and the role');
SELECT is(
    (SELECT count(*)::int FROM pg_temp.alice_rows('member.role_remove')
      WHERE target_id = '22222222-0000-0000-0000-000000000002'),
    1, 'a role removal is recorded');
SELECT is(
    (SELECT target_name FROM pg_temp.alice_rows('role.delete')
      WHERE target_id = 'f1091000-0000-0000-0000-000000000003'),
    'helpers', 'a role deletion is recorded');

-- Overrides, emojis, settings, server ---------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
VALUES ('66666666-0000-0000-0000-000000000006', 'role', 'f1091000-0000-0000-0000-000000000002', 0, 4096);
UPDATE public.channel_permission_overrides SET deny_permissions = 6144
 WHERE channel_id = '66666666-0000-0000-0000-000000000006' AND role_id = 'f1091000-0000-0000-0000-000000000002';
INSERT INTO public.emojis (id, name, url, server_id, uploader)
VALUES ('f1094000-0000-0000-0000-000000000001', 'wave109', 'https://e.test/wave.png',
        '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001');
UPDATE public.emojis SET usage_count = 5 WHERE id = 'f1094000-0000-0000-0000-000000000001';
UPDATE public.server_settings SET newcomer_alerts = NOT COALESCE(newcomer_alerts, false),
       default_role_id = 'f1091000-0000-0000-0000-000000000002'
 WHERE server_id = '55555555-0000-0000-0000-000000000005';
UPDATE public.servers SET description = 'audited', member_count = 99
 WHERE id = '55555555-0000-0000-0000-000000000005';

SELECT tests.clear_authentication();

SELECT is(
    (SELECT target_name || ' ' || (details ->> 'role_name') || ' ' || (changes #>> '{deny_permissions,new}')
       FROM pg_temp.alice_rows('override.create')),
    'general low 4096', 'an override creation names the channel and the role');
SELECT is(
    (SELECT changes FROM pg_temp.alice_rows('override.update')),
    '{"deny_permissions": {"old": 4096, "new": 6144}}'::jsonb, 'an override edit records the bits');
SELECT is(
    (SELECT target_name FROM pg_temp.alice_rows('emoji.create')),
    'wave109', 'an emoji upload is recorded');
SELECT is(
    (SELECT count(*)::int FROM pg_temp.alice_rows('emoji.update')),
    0, 'an emoji usage count is not');
SELECT is(
    (SELECT changes #>> '{default_role,new}' FROM pg_temp.alice_rows('settings.update')),
    'low', 'a settings change records the default role by name');
SELECT ok(
    (SELECT changes ? 'newcomer_alerts' FROM pg_temp.alice_rows('settings.update')),
    'and the toggled setting');
SELECT is(
    (SELECT changes FROM pg_temp.alice_rows('server.update')),
    '{"description": {"new": "audited"}}'::jsonb, 'a server edit leaves member_count out');

-- Kick, ban, timeouts ------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.kick_server_member('55555555-0000-0000-0000-000000000005', 'f1090000-0000-0000-0000-0000000000c2', 'spam', 3600);
SELECT public.ban_server_member('55555555-0000-0000-0000-000000000005', 'f1090000-0000-0000-0000-0000000000c3', 'rude');
SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', 600, 'cool off');
SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', 0);
SELECT tests.clear_authentication();

SELECT is(
    (SELECT target_name || ' ' || reason || ' ' || (details ->> 'messages_deleted') FROM pg_temp.alice_rows('member.kick')),
    'dave109 spam 3', 'a kick is recorded with its reason and deleted message count');
SELECT is(
    (SELECT details ->> 'count' FROM pg_temp.alice_rows('message.delete')
      WHERE target_id = 'f1090000-0000-0000-0000-0000000000c2'
        AND details ->> 'channel_id' = '66666666-0000-0000-0000-000000000006'),
    '2', 'the kick''s message purge folds into one deletion entry per channel');
SELECT is(
    (SELECT target_id || ' ' || reason FROM pg_temp.alice_rows('member.ban')),
    'f1090000-0000-0000-0000-0000000000c3 rude', 'a ban is recorded with its reason');
SELECT is(
    (SELECT count(*)::int FROM public.server_audit_log
      WHERE action = 'member.role_remove' AND target_id = 'f1090000-0000-0000-0000-0000000000c3'),
    0, 'the banned member''s role cleanup is not recorded as role removals');
SELECT is(
    (SELECT reason FROM pg_temp.alice_rows('member.timeout')),
    'cool off', 'a timeout is recorded');
SELECT is(
    (SELECT count(*)::int FROM pg_temp.alice_rows('member.timeout_remove')),
    1, 'lifting it is recorded');

-- Moderator message deletion ------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.messages SET is_deleted = true, content = '[{"type":"text","text":"[deleted]"}]'::jsonb
 WHERE id = 'f1092000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.messages SET is_deleted = true, content = '[{"type":"text","text":"[deleted]"}]'::jsonb
 WHERE id = 'f1092000-0000-0000-0000-000000000002';
SELECT tests.clear_authentication();

SELECT is(
    (SELECT target_id || ' ' || (details ->> 'channel_name') || ' ' || (details #>> '{message_ids,0}')
       FROM pg_temp.alice_rows('message.delete') WHERE target_id = '22222222-0000-0000-0000-000000000002'),
    '22222222-0000-0000-0000-000000000002 general f1092000-0000-0000-0000-000000000001',
    'a moderator deleting another member''s message is recorded');
SELECT is(
    (SELECT count(*)::int FROM public.server_audit_log
      WHERE action = 'message.delete' AND details -> 'message_ids' ? 'f1092000-0000-0000-0000-000000000002'),
    0, 'a member deleting their own message is not');
SELECT is(
    (SELECT count(*)::int FROM public.server_audit_log l WHERE l::text LIKE '%secret words%'),
    0, 'message content is never stored');

-- Invites -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.invites (id, code, server_id, created_by)
VALUES ('f1095000-0000-0000-0000-000000000001', 'audit109', '55555555-0000-0000-0000-000000000005',
        '11111111-0000-0000-0000-000000000001');
UPDATE public.invites SET used = true WHERE id = 'f1095000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();

SELECT is(
    (SELECT string_agg(action || ':' || target_name, ',' ORDER BY created_at) FROM public.server_audit_log
      WHERE target_id = 'f1095000-0000-0000-0000-000000000001' AND actor_id = '11111111-0000-0000-0000-000000000001'),
    'invite.create:audit109,invite.delete:audit109', 'invite creation and revocation are recorded');

-- Server creation ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO public.servers (id, name, owner)
VALUES ('f1096000-0000-0000-0000-000000000001', 'Fresh 109', '22222222-0000-0000-0000-000000000002');
SELECT tests.clear_authentication();

SELECT ok(
    (SELECT count(*) FROM public.channels WHERE server_id = 'f1096000-0000-0000-0000-000000000001') > 0
      AND (SELECT count(*) FROM public.server_roles WHERE server_id = 'f1096000-0000-0000-0000-000000000001') > 0,
    'a new server gets its default channels and roles');
SELECT is(
    (SELECT count(*)::int FROM public.server_audit_log WHERE server_id = 'f1096000-0000-0000-0000-000000000001'),
    0, 'and none of them is recorded');

-- Bot attribution -----------------------------------------------------------------------------
INSERT INTO public.bots (id, username, display_name, owner_id, is_public) VALUES
  ('f1097000-0000-0000-0000-000000000001', 'builder109', 'Builder', '11111111-0000-0000-0000-000000000001', true);
SET LOCAL ROLE service_role;
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f1093000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'bot-made', 0);
INSERT INTO public.bot_audit_log (bot_id, action_type, success, metadata)
VALUES ('f1097000-0000-0000-0000-000000000001', 'channel_created', true,
        '{"server_id":"55555555-0000-0000-0000-000000000005","channel_id":"f1093000-0000-0000-0000-000000000002"}'::jsonb);
RESET ROLE;

SELECT is(
    (SELECT source || ' ' || actor_bot_id::text || ' ' || (actor_id IS NULL)::text FROM public.server_audit_log
      WHERE action = 'channel.create' AND target_id = 'f1093000-0000-0000-0000-000000000002'),
    'bot f1097000-0000-0000-0000-000000000001 true', 'a bot-gateway write is attributed to the bot that logged it');

-- Reading --------------------------------------------------------------------------------------
INSERT INTO public.server_audit_log (server_id, source, action, created_at)
SELECT '55555555-0000-0000-0000-000000000005', 'system', 'server.update', now() - interval '1 day' - make_interval(secs => g)
  FROM generate_series(1, 120) g;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(
    (SELECT count(*) FROM public.get_server_audit_log('55555555-0000-0000-0000-000000000005')) > 0,
    'the owner reads the audit log');
SELECT is(
    (SELECT actor_username || ' ' || target_display_name FROM public.get_server_audit_log(
        '55555555-0000-0000-0000-000000000005', NULL, 10, 'member.kick')),
    'alice Dave', 'entries carry the actor and the target member');
SELECT is(
    (SELECT array_agg(DISTINCT split_part(action, '.', 1))
       FROM public.get_server_audit_log('55555555-0000-0000-0000-000000000005', NULL, 100, 'role')),
    ARRAY['role'], 'a kind filter returns that kind only');
SELECT is(
    (SELECT array_agg(DISTINCT actor_id)
       FROM public.get_server_audit_log('55555555-0000-0000-0000-000000000005', NULL, 100, NULL,
                                        '11111111-0000-0000-0000-000000000001')),
    ARRAY['11111111-0000-0000-0000-000000000001'::uuid], 'an actor filter returns that actor only');
SELECT is(
    (SELECT count(*)::int FROM public.get_server_audit_log('55555555-0000-0000-0000-000000000005', NULL, 1000)),
    100, 'the page size is capped at 100');
SELECT ok(
    (SELECT max(created_at) FROM public.get_server_audit_log(
        '55555555-0000-0000-0000-000000000005',
        (SELECT min(created_at) FROM public.get_server_audit_log('55555555-0000-0000-0000-000000000005', NULL, 3)), 3))
      < (SELECT min(created_at) FROM public.get_server_audit_log('55555555-0000-0000-0000-000000000005', NULL, 3)),
    'p_before pages to older entries');

SELECT tests.authenticate_as('f1090000-0000-0000-0000-0000000000a1');
SELECT ok(
    (SELECT count(*) FROM public.get_server_audit_log('55555555-0000-0000-0000-000000000005')) > 0,
    'a VIEW_AUDIT_LOG holder reads the audit log');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT * FROM public.get_server_audit_log('55555555-0000-0000-0000-000000000005')$q$,
    '42501', NULL, 'a member without VIEW_AUDIT_LOG cannot');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT * FROM public.get_server_audit_log('55555555-0000-0000-0000-000000000005')$q$,
    '42501', NULL, 'a non-member cannot');
SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$SELECT * FROM public.get_server_audit_log('55555555-0000-0000-0000-000000000005')$q$,
    '42501', NULL, 'anon cannot');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT * FROM public.server_audit_log$q$,
    '42501', NULL, 'clients have no table access');

-- server_membership_events --------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM public.server_membership_events
      WHERE server_id = '55555555-0000-0000-0000-000000000005' AND event_type IN ('kick', 'ban')),
    0, 'a plain member does not see kick and ban events');
SELECT ok(
    (SELECT count(*) FROM public.server_membership_events
      WHERE server_id = '55555555-0000-0000-0000-000000000005' AND event_type = 'join') > 0,
    'but sees joins');
SELECT tests.authenticate_as('f1090000-0000-0000-0000-0000000000a1');
SELECT is(
    (SELECT count(*)::int FROM public.server_membership_events
      WHERE server_id = '55555555-0000-0000-0000-000000000005' AND event_type IN ('kick', 'ban')),
    2, 'a VIEW_AUDIT_LOG holder sees them');
SELECT tests.clear_authentication();

-- Retention ------------------------------------------------------------------------------------
INSERT INTO public.server_audit_log (id, server_id, source, action, created_at)
VALUES ('f1098000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'system', 'server.update',
        now() - interval '91 days');
SELECT public.server_audit_log_purge();
SELECT is(
    (SELECT count(*)::int FROM public.server_audit_log WHERE id = 'f1098000-0000-0000-0000-000000000001'),
    0, 'entries older than 90 days are purged');

SELECT * FROM finish();
ROLLBACK;
