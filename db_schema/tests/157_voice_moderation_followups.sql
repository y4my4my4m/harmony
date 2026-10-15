-- 20261017100005_voice_moderation_followups.sql: the permission decides, membership end clears
-- a server mute, permission changes queue grant resyncs, moderation of a remote member is
-- queued for the Group, copies hold a Group's state.
--
--   alice    owns server V
--   bob      role mods (position 1: MUTE_MEMBERS, DEAFEN_MEMBERS, MOVE_MEMBERS, KICK_MEMBERS)
--   mallory  role boss (position 9, no permissions)
--   rita     a remote profile, accepted member
--
--   lounge, annex   voice, no overrides
--   general         text
--   vault           voice; @everyone: Deny CONNECT
--   hideout         voice; @everyone: Deny VIEW_CHANNEL
--   quiet           voice; @everyone: Deny SPEAK, STREAM
--
-- queue_federation_job is replaced for the transaction by a stub that records its calls.
--
-- Bits: MUTE_MEMBERS 1 << 27, DEAFEN_MEMBERS 1 << 28, MOVE_MEMBERS 1 << 29, KICK_MEMBERS 1 << 9,
-- CONNECT 1 << 24, VIEW_CHANNEL 1 << 1, SPEAK 1 << 25, STREAM 1 << 26.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(74);

CREATE TEMP TABLE queued (name text, data jsonb, at timestamptz DEFAULT clock_timestamp());
GRANT ALL ON queued TO authenticated, service_role;
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE sql AS $fn$
  INSERT INTO pg_temp.queued (name, data) VALUES (p_job_name, p_job_data);
  SELECT gen_random_uuid();
$fn$;

INSERT INTO public.profiles (id, username, display_name, is_local, federated_id, domain)
SELECT ('f1570000-0000-0000-0000-' || lpad(to_hex(n), 12, '0'))::uuid, 'remote157_' || n, 'Remote ' || n, false,
       'https://remote157.test/users/r' || n, 'remote157.test'
  FROM generate_series(1, 27) n;
-- rita is the first remote profile.

INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled)
VALUES ('f1571000-0000-0000-0000-000000000001', 'Voice followups', '11111111-0000-0000-0000-000000000001', true, true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f1571000-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f1571000-0000-0000-0000-000000000001', 'accepted'),
  ('33333333-0000-0000-0000-000000000003', 'f1571000-0000-0000-0000-000000000001', 'accepted'),
  ('f1570000-0000-0000-0000-000000000001', 'f1571000-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT DO NOTHING;
INSERT INTO public.server_roles (server_id, name, position, permissions, is_default)
SELECT 'f1571000-0000-0000-0000-000000000001', '@everyone', 0, 2 | 16777216 | 33554432 | 67108864, true
 WHERE NOT EXISTS (SELECT 1 FROM public.server_roles
                    WHERE server_id = 'f1571000-0000-0000-0000-000000000001' AND is_default);

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1572000-0000-0000-0000-000000000001', 'f1571000-0000-0000-0000-000000000001', 'lounge', 1),
  ('f1572000-0000-0000-0000-000000000002', 'f1571000-0000-0000-0000-000000000001', 'annex', 1),
  ('f1572000-0000-0000-0000-000000000003', 'f1571000-0000-0000-0000-000000000001', 'general', 0),
  ('f1572000-0000-0000-0000-000000000004', 'f1571000-0000-0000-0000-000000000001', 'vault', 1),
  ('f1572000-0000-0000-0000-000000000005', 'f1571000-0000-0000-0000-000000000001', 'hideout', 1),
  ('f1572000-0000-0000-0000-000000000006', 'f1571000-0000-0000-0000-000000000001', 'quiet', 1);

INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1573000-0000-0000-0000-000000000001', 'f1571000-0000-0000-0000-000000000001', 'mods', 1, 134217728 | 268435456 | 536870912 | 512),
  ('f1573000-0000-0000-0000-000000000002', 'f1571000-0000-0000-0000-000000000001', 'boss', 9, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1573000-0000-0000-0000-000000000001', 'f1571000-0000-0000-0000-000000000001'),
  ('33333333-0000-0000-0000-000000000003', 'f1573000-0000-0000-0000-000000000002', 'f1571000-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.everyone() RETURNS uuid LANGUAGE sql AS $fn$
  SELECT id FROM public.server_roles WHERE server_id = 'f1571000-0000-0000-0000-000000000001' AND is_default;
$fn$;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('f1572000-0000-0000-0000-000000000004', 'role', pg_temp.everyone(), 0, 16777216),
  ('f1572000-0000-0000-0000-000000000005', 'role', pg_temp.everyone(), 0, 2),
  ('f1572000-0000-0000-0000-000000000006', 'role', pg_temp.everyone(), 0, 33554432 | 67108864);

-- A remote server's copy, with mallory as a member.
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, ap_id)
VALUES ('f1571000-0000-0000-0000-000000000002', 'Remote copy', 'f1570000-0000-0000-0000-000000000002', false, true,
        'https://remote157.test/servers/f1571000-0000-0000-0000-000000000002');
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1571000-0000-0000-0000-000000000002', 'accepted');
INSERT INTO public.channels (id, server_id, name, type, is_remote)
VALUES ('f1572000-0000-0000-0000-000000000007', 'f1571000-0000-0000-0000-000000000002', 'copy voice', 1, true);

CREATE FUNCTION pg_temp.seat(p_user uuid, p_channel uuid) RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
  SELECT p_channel, c.server_id, p_user FROM public.channels c WHERE c.id = p_channel
  ON CONFLICT (channel_id, user_id) DO NOTHING;
$fn$;
CREATE FUNCTION pg_temp.state(p_user uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT COALESCE((SELECT CASE WHEN muted THEN 'M' ELSE '-' END || CASE WHEN deafened THEN 'D' ELSE '-' END
                     FROM public.server_voice_moderation
                    WHERE server_id = 'f1571000-0000-0000-0000-000000000001' AND user_id = p_user), 'none');
$fn$;
CREATE FUNCTION pg_temp.resyncs() RETURNS text LANGUAGE sql AS $fn$
  SELECT COALESCE(string_agg(COALESCE(right(channel_id::text, 1), '*') || '/' || COALESCE(left(user_id::text, 8), '*'), ','
                             ORDER BY channel_id NULLS FIRST, user_id NULLS FIRST), '')
    FROM public.voice_grant_resyncs WHERE server_id = 'f1571000-0000-0000-0000-000000000001';
$fn$;
CREATE FUNCTION pg_temp.grants(p_channel uuid, p_user uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT COALESCE(g.reason, 'ok:' || CASE WHEN g.can_speak THEN 'S' ELSE '-' END || CASE WHEN g.can_stream THEN 'V' ELSE '-' END
                  || CASE WHEN g.can_soundboard THEN 'B' ELSE '-' END
                  || CASE WHEN g.server_muted THEN 'm' ELSE '-' END || CASE WHEN g.server_deafened THEN 'd' ELSE '-' END)
    FROM public.voice_participant_grants(ARRAY[p_channel], ARRAY[p_user]) g;
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.seat(uuid, uuid), pg_temp.state(uuid) TO authenticated;

-- The permission decides, not role order. ----------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_voice_state('f1571000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', true)
            ->> 'muted', 'true', 'a moderator mutes a member ranked above them');
SELECT is(public.set_server_voice_state('f1571000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', NULL, true)
            ->> 'deafened', 'true', 'and deafens the owner');
SELECT is(public.set_server_voice_state('f1571000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', true)
            ->> 'muted', 'true', 'and mutes themselves');
SELECT is(public.set_server_voice_state('f1571000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', false)
            ->> 'muted', 'false', 'and lifts it');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.set_server_voice_state('f1571000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', false)$q$,
                 '42501', 'Missing permission: MUTE_MEMBERS', 'a member without Mute Members does not lift their own mute');
SELECT tests.clear_authentication();
SELECT pg_temp.seat('22222222-0000-0000-0000-000000000002', 'f1572000-0000-0000-0000-000000000001');
SELECT pg_temp.seat('11111111-0000-0000-0000-000000000001', 'f1572000-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.move_voice_member('f1571000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'f1572000-0000-0000-0000-000000000002')
            ->> 'from_channel_id', 'f1572000-0000-0000-0000-000000000001', 'a moderator moves themselves');
SELECT is(public.move_voice_member('f1571000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001') ->> 'channel_id',
          NULL, 'and disconnects the owner');
SELECT throws_ok($q$SELECT public.kick_server_member('f1571000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003')$q$,
                 'Cannot kick a member with an equal or higher role', 'a kick still follows role order');
SELECT tests.clear_authentication();

-- Membership end clears server mute and deafen. ---------------------------------------------
SELECT is(pg_temp.state('33333333-0000-0000-0000-000000000003'), 'M-', 'mallory is server-muted');
DELETE FROM public.user_servers
 WHERE server_id = 'f1571000-0000-0000-0000-000000000001' AND user_id = '33333333-0000-0000-0000-000000000003';
SELECT is(pg_temp.state('33333333-0000-0000-0000-000000000003'), 'none', 'leaving the server clears it');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE topic = 'voice-channels:f1571000-0000-0000-0000-000000000001'
                     AND payload ->> 'event' = 'voice-moderation'
                     AND payload ->> 'userId' = '33333333-0000-0000-0000-000000000003'
                     AND payload ->> 'muted' = 'false'),
          'and the cleared state is broadcast to the server');
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1571000-0000-0000-0000-000000000001', 'accepted');
SELECT is(pg_temp.state('33333333-0000-0000-0000-000000000003'), 'none', 'rejoining does not bring it back');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_voice_state('f1571000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', true, true)
            ->> 'deafened', 'true', 'the moderator mutes and deafens mallory again');
SELECT tests.clear_authentication();
UPDATE public.user_servers SET status = 'banned'
 WHERE server_id = 'f1571000-0000-0000-0000-000000000001' AND user_id = '33333333-0000-0000-0000-000000000003';
SELECT is(pg_temp.state('33333333-0000-0000-0000-000000000003'), 'none', 'a ban clears it');
UPDATE public.user_servers SET status = 'accepted'
 WHERE server_id = 'f1571000-0000-0000-0000-000000000001' AND user_id = '33333333-0000-0000-0000-000000000003';
SELECT is(public.voice_remove_member('f1571000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', 'moved'),
          NULL, 'a member in no voice channel leaves nothing');

DELETE FROM public.user_servers
 WHERE server_id = 'f1571000-0000-0000-0000-000000000002' AND user_id = '33333333-0000-0000-0000-000000000003';
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE topic = 'user:33333333-0000-0000-0000-000000000003'
                     AND payload ->> 'type' = 'voice:moved'
                     AND payload ->> 'server_id' = 'f1571000-0000-0000-0000-000000000002'
                     AND payload ->> 'reason' = 'removed'
                     AND payload ->> 'channel_id' IS NULL),
          'a local member leaving a remote server''s copy is told to leave its call');

-- voice_participant_grants, as authorizeVoiceChannel decides. -------------------------------
INSERT INTO public.server_voice_moderation (server_id, user_id, muted, deafened)
VALUES ('f1571000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', true, true);
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'), 'ok:SVB--',
          'an open channel: speak, stream, soundboard');
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002'), 'ok:-----',
          'a channel denying SPEAK and STREAM withholds both, and the soundboard with SPEAK');
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003'), 'ok:-V-md',
          'a server-muted, server-deafened member streams only');
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000002'), 'missing CONNECT',
          'without CONNECT: refused');
INSERT INTO public.voice_move_grants (server_id, user_id, channel_id, expires_at)
VALUES ('f1571000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'f1572000-0000-0000-0000-000000000004', now() + interval '1 minute')
ON CONFLICT (server_id, user_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, expires_at = EXCLUDED.expires_at;
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000002'), 'ok:SVB--',
          'a live move grant stands in for CONNECT');
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002'), 'missing VIEW_CHANNEL',
          'without VIEW_CHANNEL: refused');
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001'), 'ok:-V--d',
          'the owner holds every permission; their server deafen still withholds the microphone');
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000004'), 'not an accepted member',
          'a non-member: refused');
INSERT INTO public.server_member_timeouts (server_id, user_id, until)
VALUES ('f1571000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', now() + interval '1 hour');
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'), 'timed out',
          'a timed-out member: refused');
DELETE FROM public.server_member_timeouts WHERE server_id = 'f1571000-0000-0000-0000-000000000001';
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000001', 'f1570000-0000-0000-0000-000000000001'), 'ok:SVB--',
          'a remote member of a federated server: admitted');
UPDATE public.servers SET federation_enabled = false WHERE id = 'f1571000-0000-0000-0000-000000000001';
SELECT is(pg_temp.grants('f1572000-0000-0000-0000-000000000001', 'f1570000-0000-0000-0000-000000000001'),
          'federation is disabled on the server', 'and refused once federation is off');
UPDATE public.servers SET federation_enabled = true WHERE id = 'f1571000-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM public.voice_participant_grants(
              ARRAY['f1572000-0000-0000-0000-000000000001', 'f1572000-0000-0000-0000-000000000001', 'f1572000-0000-0000-0000-000000000099']::uuid[],
              ARRAY['22222222-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002']::uuid[])),
          2, 'pairs are answered once each, an unknown channel included');
SELECT is((SELECT reason FROM public.voice_participant_grants(ARRAY['f1572000-0000-0000-0000-000000000099']::uuid[],
                                                              ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])),
          'channel not found', 'which is refused');

-- Permission changes queue grant resyncs. ---------------------------------------------------
DELETE FROM public.voice_grant_resyncs;
DELETE FROM public.voice_channel_participants WHERE server_id = 'f1571000-0000-0000-0000-000000000001';
UPDATE public.server_roles SET permissions = permissions & ~33554432::bigint WHERE id = pg_temp.everyone();
SELECT is(pg_temp.resyncs(), '', 'with nobody in voice a role change queues nothing');
SELECT pg_temp.seat('22222222-0000-0000-0000-000000000002', 'f1572000-0000-0000-0000-000000000001');
SELECT pg_temp.seat('33333333-0000-0000-0000-000000000003', 'f1572000-0000-0000-0000-000000000002');
UPDATE public.server_roles SET name = 'everyone' WHERE id = pg_temp.everyone();
SELECT is(pg_temp.resyncs(), '', 'a role change that leaves the permissions queues nothing');
UPDATE public.server_roles SET permissions = permissions | 33554432 WHERE id = pg_temp.everyone();
SELECT is(pg_temp.resyncs(), '*/*', 'an @everyone permission change queues the whole server');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE topic = 'voice-channels:f1571000-0000-0000-0000-000000000001'
                     AND payload ->> 'event' = 'voice-grants' AND payload ->> 'channelId' IS NULL
                     AND payload ->> 'userId' IS NULL),
          'and tells P2P clients of the server');
UPDATE public.server_roles SET permissions = permissions | 33554432 WHERE id = pg_temp.everyone();
SELECT is((SELECT count(*)::int FROM public.voice_grant_resyncs WHERE server_id = 'f1571000-0000-0000-0000-000000000001'), 1,
          'a pending scope is queued once');

DELETE FROM public.voice_grant_resyncs;
DELETE FROM public.user_roles WHERE user_id = '22222222-0000-0000-0000-000000000002' AND server_id = 'f1571000-0000-0000-0000-000000000001';
SELECT is(pg_temp.resyncs(), '*/22222222', 'removing a role from a member in voice queues that member');
DELETE FROM public.voice_grant_resyncs;
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('f1570000-0000-0000-0000-000000000003', 'f1573000-0000-0000-0000-000000000002', 'f1571000-0000-0000-0000-000000000001');
SELECT is(pg_temp.resyncs(), '', 'assigning a role to a member out of voice queues nothing');
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1573000-0000-0000-0000-000000000001', 'f1571000-0000-0000-0000-000000000001');
SELECT is(pg_temp.resyncs(), '*/22222222', 'assigning one to a member in voice queues them');
DELETE FROM public.voice_grant_resyncs;
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT p.id, 'f1571000-0000-0000-0000-000000000001', 'accepted'
  FROM public.profiles p WHERE p.username LIKE 'remote157_%'
ON CONFLICT DO NOTHING;
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, is_federated)
SELECT 'f1572000-0000-0000-0000-000000000001', 'f1571000-0000-0000-0000-000000000001', p.id, true
  FROM public.profiles p WHERE p.username LIKE 'remote157_%';
DELETE FROM public.voice_grant_resyncs;
INSERT INTO public.user_roles (user_id, role_id, server_id)
SELECT p.id, 'f1573000-0000-0000-0000-000000000002', 'f1571000-0000-0000-0000-000000000001'
  FROM public.profiles p WHERE p.username LIKE 'remote157_%'
ON CONFLICT DO NOTHING;
SELECT is(pg_temp.resyncs(), '*/*', 'a statement assigning more than 25 members queues the server once');

DELETE FROM public.voice_grant_resyncs;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
VALUES ('f1572000-0000-0000-0000-000000000001', 'role', 'f1573000-0000-0000-0000-000000000002', 0, 33554432);
SELECT is(pg_temp.resyncs(), '1/*', 'an override on a voice channel with participants queues that channel');
DELETE FROM public.voice_grant_resyncs;
UPDATE public.channel_permission_overrides SET deny_permissions = 16777216
 WHERE channel_id = 'f1572000-0000-0000-0000-000000000006';
SELECT is(pg_temp.resyncs(), '', 'one on an empty voice channel queues nothing');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
VALUES ('f1572000-0000-0000-0000-000000000003', 'role', 'f1573000-0000-0000-0000-000000000002', 0, 2);
SELECT is(pg_temp.resyncs(), '', 'nor one on a text channel');
DELETE FROM public.channel_permission_overrides
 WHERE channel_id = 'f1572000-0000-0000-0000-000000000001' AND role_id = 'f1573000-0000-0000-0000-000000000002';
SELECT is(pg_temp.resyncs(), '1/*', 'deleting an override queues its channel');

DELETE FROM public.voice_grant_resyncs;
DELETE FROM public.server_roles WHERE id = 'f1573000-0000-0000-0000-000000000002';
SELECT is(pg_temp.resyncs(), '*/*', 'deleting a role queues the server');
DELETE FROM public.voice_grant_resyncs;
UPDATE public.servers SET owner = '22222222-0000-0000-0000-000000000002' WHERE id = 'f1571000-0000-0000-0000-000000000001';
SELECT is(pg_temp.resyncs(), '*/*', 'an ownership transfer queues the server');
UPDATE public.servers SET owner = '11111111-0000-0000-0000-000000000001' WHERE id = 'f1571000-0000-0000-0000-000000000001';

DELETE FROM public.voice_grant_resyncs;
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, is_federated)
VALUES ('f1572000-0000-0000-0000-000000000007', 'f1571000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', true);
UPDATE public.servers SET owner = '11111111-0000-0000-0000-000000000001' WHERE id = 'f1571000-0000-0000-0000-000000000002';
SELECT is((SELECT count(*)::int FROM public.voice_grant_resyncs WHERE server_id = 'f1571000-0000-0000-0000-000000000002'), 0,
          'a remote server''s copy queues nothing');
DELETE FROM public.voice_channel_participants WHERE server_id = 'f1571000-0000-0000-0000-000000000002';

-- A restricted channel's change goes out on the server's topic, naming no channel.
UPDATE public.channel_permission_overrides SET deny_permissions = 2 | 16777216
 WHERE channel_id = 'f1572000-0000-0000-0000-000000000005';
SELECT pg_temp.seat('11111111-0000-0000-0000-000000000001', 'f1572000-0000-0000-0000-000000000005');
DELETE FROM public.voice_grant_resyncs;
UPDATE public.channel_permission_overrides SET deny_permissions = 2
 WHERE channel_id = 'f1572000-0000-0000-0000-000000000005';
SELECT ok(NOT EXISTS (SELECT 1 FROM realtime.messages
                       WHERE payload ->> 'event' = 'voice-grants'
                         AND (topic = 'voice-channel:f1572000-0000-0000-0000-000000000005'
                              OR payload ->> 'channelId' = 'f1572000-0000-0000-0000-000000000005')),
          'a restricted channel''s change is told to the whole server, naming no channel');
SELECT is(pg_temp.resyncs(), '5/*', 'and queued for it');

-- Moderation of a remote member is queued for the Group. ------------------------------------
DELETE FROM pg_temp.queued;
DELETE FROM public.voice_channel_participants WHERE server_id = 'f1571000-0000-0000-0000-000000000001';
SELECT pg_temp.seat('f1570000-0000-0000-0000-000000000001', 'f1572000-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_voice_state('f1571000-0000-0000-0000-000000000001', 'f1570000-0000-0000-0000-000000000001', true)
            ->> 'muted', 'true', 'the moderator mutes rita, a remote member');
SELECT tests.clear_authentication();
SELECT is((SELECT data FROM pg_temp.queued WHERE name = 'federate-voice-moderation' ORDER BY at DESC LIMIT 1)
            - 'type',
          jsonb_build_object('kind', 'state', 'server_id', 'f1571000-0000-0000-0000-000000000001',
                             'user_id', 'f1570000-0000-0000-0000-000000000001', 'muted', true, 'deafened', false),
          'the state is queued for her instance');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.move_voice_member('f1571000-0000-0000-0000-000000000001', 'f1570000-0000-0000-0000-000000000001', 'f1572000-0000-0000-0000-000000000002')
            ->> 'channel_id', 'f1572000-0000-0000-0000-000000000002', 'the moderator moves her to annex');
SELECT tests.clear_authentication();
SELECT is((SELECT data FROM pg_temp.queued WHERE name = 'federate-voice-moderation' ORDER BY at DESC LIMIT 1)
            - 'type',
          jsonb_build_object('kind', 'move', 'server_id', 'f1571000-0000-0000-0000-000000000001',
                             'user_id', 'f1570000-0000-0000-0000-000000000001',
                             'from_channel_id', 'f1572000-0000-0000-0000-000000000001',
                             'channel_id', 'f1572000-0000-0000-0000-000000000002', 'reason', 'moved'),
          'the move is queued, naming both channels');
SELECT pg_temp.seat('f1570000-0000-0000-0000-000000000001', 'f1572000-0000-0000-0000-000000000002');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.move_voice_member('f1571000-0000-0000-0000-000000000001', 'f1570000-0000-0000-0000-000000000001') ->> 'channel_id',
          NULL, 'the moderator disconnects her');
SELECT tests.clear_authentication();
SELECT is((SELECT data ->> 'kind' || '/' || COALESCE(data ->> 'channel_id', '-') || '/' || (data ->> 'reason')
             FROM pg_temp.queued WHERE name = 'federate-voice-moderation' ORDER BY at DESC LIMIT 1),
          'disconnect/-/disconnected', 'the disconnect is queued');
SELECT pg_temp.seat('f1570000-0000-0000-0000-000000000001', 'f1572000-0000-0000-0000-000000000001');
SELECT is(public.voice_remove_member('f1571000-0000-0000-0000-000000000001', 'f1570000-0000-0000-0000-000000000001', 'revoked'),
          'f1572000-0000-0000-0000-000000000001'::uuid, 'a revoked remote member leaves voice');
SELECT is((SELECT data ->> 'kind' || '/' || (data ->> 'reason')
             FROM pg_temp.queued WHERE name = 'federate-voice-moderation' ORDER BY at DESC LIMIT 1),
          'disconnect/revoked', 'with the reason queued');

DELETE FROM pg_temp.queued;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_voice_state('f1571000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', false)
            ->> 'muted', 'false', 'a local member''s change');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM pg_temp.queued WHERE name = 'federate-voice-moderation'), 0, 'queues nothing');
UPDATE public.servers SET federation_enabled = false WHERE id = 'f1571000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_voice_state('f1571000-0000-0000-0000-000000000001', 'f1570000-0000-0000-0000-000000000001', false)
            ->> 'muted', 'false', 'nor does a change while the server does not federate');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM pg_temp.queued WHERE name = 'federate-voice-moderation'), 0, 'its Group sends nothing');
UPDATE public.servers SET federation_enabled = true WHERE id = 'f1571000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_voice_state('f1571000-0000-0000-0000-000000000001', 'f1570000-0000-0000-0000-000000000001', NULL, true)
            ->> 'deafened', 'true', 'the moderator deafens rita');
SELECT tests.clear_authentication();
DELETE FROM pg_temp.queued;
DELETE FROM public.user_servers
 WHERE server_id = 'f1571000-0000-0000-0000-000000000001' AND user_id = 'f1570000-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM pg_temp.queued WHERE name = 'federate-voice-moderation' AND data ->> 'kind' = 'state'), 0,
          'clearing a departed member''s state is not sent');

-- Copies hold a Group's state. ---------------------------------------------------------------
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1571000-0000-0000-0000-000000000002', 'accepted');
SELECT ok(public.apply_group_voice_state('f1571000-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003', true, false),
          'a Group''s server mute is stored in the copy');
SELECT ok(NOT public.apply_group_voice_state('f1571000-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003', true, false),
          'the same state again changes nothing');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE topic = 'user:33333333-0000-0000-0000-000000000003'
                     AND payload ->> 'type' = 'voice:moderation'
                     AND payload ->> 'server_id' = 'f1571000-0000-0000-0000-000000000002'
                     AND payload ->> 'muted' = 'true'),
          'the member hears of it');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_server_voice_moderation('f1571000-0000-0000-0000-000000000002'),
          '[{"muted": true, "user_id": "33333333-0000-0000-0000-000000000003", "deafened": false}]'::jsonb,
          'members of the copy read it');
SELECT is(public.my_voice_state('f1571000-0000-0000-0000-000000000002') ->> 'muted', 'true', 'and the member reads their own');
SELECT tests.clear_authentication();
SELECT ok(public.apply_group_voice_state('f1571000-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003', false, false),
          'lifting it');
SELECT is((SELECT count(*)::int FROM public.server_voice_moderation WHERE server_id = 'f1571000-0000-0000-0000-000000000002'), 0,
          'leaves no row');
SELECT throws_ok($q$SELECT public.apply_group_voice_state('f1571000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', true, false)$q$,
                 '22023', 'Not a remote server''s copy', 'a local server takes no Group state');
SELECT lives_ok($q$SELECT public.upsert_ap_activity(p_ap_id => 'https://remote157.test/servers/x/voice/1',
                     p_ap_type => 'harmony:VoiceMemberMove', p_actor_ap_id => 'https://remote157.test/servers/x',
                     p_activity_data => '{}'::jsonb)$q$,
                'ap_activities stores harmony:VoiceMemberMove');

-- Grants. ------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT * FROM public.voice_participant_grants(ARRAY['f1572000-0000-0000-0000-000000000001']::uuid[], ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
                 '42501', NULL, 'voice_participant_grants is internal');
SELECT throws_ok($q$SELECT public.apply_group_voice_state('f1571000-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003', true, false)$q$,
                 '42501', NULL, 'as is apply_group_voice_state');
SELECT throws_ok($q$SELECT count(*) FROM public.voice_grant_resyncs$q$, '42501', NULL, 'and the resync queue');
SELECT throws_ok($q$SELECT public.voice_grants_changed('f1571000-0000-0000-0000-000000000001', NULL, NULL)$q$,
                 '42501', NULL, 'and voice_grants_changed');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
