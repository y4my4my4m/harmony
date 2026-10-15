-- 20261017100002_voice_moderation.sql: server mute, server deafen, move and disconnect; CONNECT
-- on voice presence rows.
--
--   alice    owns server_1
--   bob      role mods (position 5: MUTE_MEMBERS, DEAFEN_MEMBERS, MOVE_MEMBERS)
--   mallory  role helpers (position 1, no server permissions)
--   carol    role admins (position 3, ADMINISTRATOR)
--   dave     role peers (position 5, no server permissions)
--   erin     no role
--   frank    role stewards (position 4, no server permissions)
--
--   lounge   voice, no overrides
--   stage    voice; mods: Deny MUTE_MEMBERS
--   den      voice; stewards: Allow MUTE_MEMBERS
--   vault    voice; @everyone: Deny CONNECT; mods: Allow CONNECT
--   annex    voice, no overrides
--   hideout  voice; @everyone: Deny VIEW_CHANNEL; mods: Allow VIEW_CHANNEL
--   quiet    voice; @everyone: Deny SPEAK, USE_EXTERNAL_SOUNDS
--
-- Bits: MUTE_MEMBERS 1 << 27 = 134217728, DEAFEN_MEMBERS 1 << 28 = 268435456,
-- MOVE_MEMBERS 1 << 29 = 536870912, CONNECT 1 << 24 = 16777216, VIEW_CHANNEL 1 << 1 = 2,
-- SPEAK 1 << 25 = 33554432, STREAM 1 << 26 = 67108864, USE_EXTERNAL_SOUNDS 1 << 31 = 2147483648,
-- ADMINISTRATOR 1.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(71);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('cccccccc-1540-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol154@test.local'),
  ('dddddddd-1540-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave154@test.local'),
  ('eeeeeeee-1540-0000-0000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin154@test.local'),
  ('ffffffff-1540-0000-0000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'frank154@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1540000-0000-0000-0000-00000000000c', 'cccccccc-1540-0000-0000-000000000005', 'carol154', 'Carol', true),
  ('f1540000-0000-0000-0000-00000000000d', 'dddddddd-1540-0000-0000-000000000006', 'dave154', 'Dave', true),
  ('f1540000-0000-0000-0000-00000000000e', 'eeeeeeee-1540-0000-0000-000000000007', 'erin154', 'Erin', true),
  ('f1540000-0000-0000-0000-00000000000f', 'ffffffff-1540-0000-0000-000000000008', 'frank154', 'Frank', true);

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1540000-0000-0000-0000-00000000000c', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1540000-0000-0000-0000-00000000000d', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1540000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1540000-0000-0000-0000-00000000000f', '55555555-0000-0000-0000-000000000005', 'accepted')
ON CONFLICT DO NOTHING;

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1541000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'lounge', 1),
  ('f1541000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'stage', 1),
  ('f1541000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'den', 1),
  ('f1541000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'vault', 1),
  ('f1541000-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000005', 'annex', 1),
  ('f1541000-0000-0000-0000-000000000006', '55555555-0000-0000-0000-000000000005', 'hideout', 1),
  ('f1541000-0000-0000-0000-000000000007', '55555555-0000-0000-0000-000000000005', 'quiet', 1);

INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1542000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'mods', 5, 134217728 | 268435456 | 536870912),
  ('f1542000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'helpers', 1, 0),
  ('f1542000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'admins', 3, 1),
  ('f1542000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'peers', 5, 0),
  ('f1542000-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000005', 'stewards', 4, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1542000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('33333333-0000-0000-0000-000000000003', 'f1542000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005'),
  ('f1540000-0000-0000-0000-00000000000c', 'f1542000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005'),
  ('f1540000-0000-0000-0000-00000000000d', 'f1542000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005'),
  ('f1540000-0000-0000-0000-00000000000f', 'f1542000-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('f1541000-0000-0000-0000-000000000002', 'role', 'f1542000-0000-0000-0000-000000000001', 0, 134217728),
  ('f1541000-0000-0000-0000-000000000003', 'role', 'f1542000-0000-0000-0000-000000000005', 134217728, 0),
  ('f1541000-0000-0000-0000-000000000004', 'role',
   (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), 0, 16777216),
  ('f1541000-0000-0000-0000-000000000004', 'role', 'f1542000-0000-0000-0000-000000000001', 16777216, 0),
  ('f1541000-0000-0000-0000-000000000006', 'role',
   (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), 0, 2),
  ('f1541000-0000-0000-0000-000000000006', 'role', 'f1542000-0000-0000-0000-000000000001', 2, 0),
  ('f1541000-0000-0000-0000-000000000002', 'role',
   (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), 0, 67108864),
  ('f1541000-0000-0000-0000-000000000007', 'role',
   (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), 0, 33554432 | 2147483648);

-- A remote server's local copy.
INSERT INTO public.servers (id, name, owner, is_local_server)
VALUES ('f1543000-0000-0000-0000-000000000001', 'Remote copy', '22222222-0000-0000-0000-000000000002', false);
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1543000-0000-0000-0000-000000000001', 'accepted');

-- Voice presence as the service role writes it.
CREATE FUNCTION pg_temp.seat(p_user uuid, p_channel uuid) RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
  VALUES (p_channel, '55555555-0000-0000-0000-000000000005', p_user)
  ON CONFLICT (channel_id, user_id) DO NOTHING;
$fn$;
CREATE FUNCTION pg_temp.unseat(p_user uuid) RETURNS void LANGUAGE sql AS $fn$
  DELETE FROM public.voice_channel_participants WHERE user_id = p_user;
$fn$;
CREATE FUNCTION pg_temp.state(p_user uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT COALESCE((SELECT CASE WHEN muted THEN 'M' ELSE '-' END || CASE WHEN deafened THEN 'D' ELSE '-' END
                     FROM public.server_voice_moderation
                    WHERE server_id = '55555555-0000-0000-0000-000000000005' AND user_id = p_user), 'none');
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.seat(uuid, uuid), pg_temp.unseat(uuid), pg_temp.state(uuid) TO authenticated;

-- Clients reach the table only through the functions. ----------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT count(*) FROM public.server_voice_moderation$q$, '42501', NULL,
                 'a client cannot read the table');
SELECT throws_ok($q$INSERT INTO public.server_voice_moderation (server_id, user_id, muted)
                    VALUES ('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', true)$q$,
                 '42501', NULL, 'nor write it');

-- Server mute, server-wide while the member is in no voice channel. --------------------------
SELECT is(public.set_server_voice_state('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', true)
            ->> 'muted', 'true', 'a moderator server-mutes a member who is not in voice');
SELECT tests.clear_authentication();
SELECT is(pg_temp.state('33333333-0000-0000-0000-000000000003'), 'M-', 'the mute is stored');
SELECT is((SELECT muted_by FROM public.server_voice_moderation WHERE user_id = '33333333-0000-0000-0000-000000000003'),
          '22222222-0000-0000-0000-000000000002'::uuid, 'naming who set it');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND action = 'member.voice_mute'
              AND target_id = '33333333-0000-0000-0000-000000000003'), 1, 'and audited');

-- It survives joining, leaving and rejoining voice.
SELECT pg_temp.seat('33333333-0000-0000-0000-000000000003', 'f1541000-0000-0000-0000-000000000001');
SELECT pg_temp.unseat('33333333-0000-0000-0000-000000000003');
SELECT pg_temp.seat('33333333-0000-0000-0000-000000000003', 'f1541000-0000-0000-0000-000000000005');
SELECT is(pg_temp.state('33333333-0000-0000-0000-000000000003'), 'M-', 'the mute survives leaving and rejoining voice');
SELECT pg_temp.unseat('33333333-0000-0000-0000-000000000003');

-- Members read it; others do not.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_server_voice_moderation('55555555-0000-0000-0000-000000000005'),
          '[{"muted": true, "user_id": "33333333-0000-0000-0000-000000000003", "deafened": false}]'::jsonb,
          'the muted member reads their own state');
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', false)$q$,
                 '42501', 'You cannot moderate your own voice', 'and cannot lift it');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is(public.get_server_voice_moderation('55555555-0000-0000-0000-000000000005'), '[]'::jsonb,
          'a banned user reads nothing');
SELECT tests.authenticate_as('eeeeeeee-1540-0000-0000-000000000007');
SELECT is(jsonb_array_length(public.get_server_voice_moderation('55555555-0000-0000-0000-000000000005')), 1,
          'any accepted member reads it');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.my_voice_state('55555555-0000-0000-0000-000000000005'),
          '{"muted": true, "deafened": false, "channel_id": null, "move_channel_id": null}'::jsonb,
          'my_voice_state names the caller''s own mute');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.my_voice_state('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'and is not open to anon');

-- Permission. --------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e', true)$q$,
                 '42501', 'Missing permission: MUTE_MEMBERS', 'a member without MUTE_MEMBERS mutes nobody');
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e', NULL, true)$q$,
                 '42501', 'Missing permission: DEAFEN_MEMBERS', 'nor deafens');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e')$q$,
                 '22023', 'Nothing to change', 'a call naming no flag is refused');
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', '44444444-0000-0000-0000-000000000004', true)$q$,
                 '22023', 'Not a member of this server', 'a banned user is not muted');
SELECT is(public.set_server_voice_state('55555555-0000-0000-0000-000000000005', '44444444-0000-0000-0000-000000000004', false)
            ->> 'muted', 'false', 'clearing needs no membership');
SELECT throws_ok($q$SELECT public.set_server_voice_state('f1543000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', true)$q$,
                 '42501', 'Voice moderation happens on the server''s home instance', 'a remote server''s copy is not moderated here');

-- What LiveKit token issuance reads (authorizeVoiceChannel), resolved per channel. ---------
SELECT is(ARRAY[public.has_permission('f1540000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', 'SPEAK', 'f1541000-0000-0000-0000-000000000001'),
                public.has_permission('f1540000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', 'STREAM', 'f1541000-0000-0000-0000-000000000001'),
                public.has_permission('f1540000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', 'USE_SOUNDBOARD', 'f1541000-0000-0000-0000-000000000001'),
                public.has_permission('f1540000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', 'USE_EXTERNAL_SOUNDS', 'f1541000-0000-0000-0000-000000000001')],
          ARRAY[true, true, true, true], 'in an open channel @everyone speaks, streams and plays sounds');
SELECT is(ARRAY[public.has_permission('f1540000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', 'SPEAK', 'f1541000-0000-0000-0000-000000000002'),
                public.has_permission('f1540000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', 'STREAM', 'f1541000-0000-0000-0000-000000000002')],
          ARRAY[true, false], 'a channel Deny of STREAM withholds camera and screen share alone');
SELECT is(ARRAY[public.has_permission('f1540000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', 'SPEAK', 'f1541000-0000-0000-0000-000000000007'),
                public.has_permission('f1540000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', 'USE_SOUNDBOARD', 'f1541000-0000-0000-0000-000000000007'),
                public.has_permission('f1540000-0000-0000-0000-00000000000e', '55555555-0000-0000-0000-000000000005', 'USE_EXTERNAL_SOUNDS', 'f1541000-0000-0000-0000-000000000007')],
          ARRAY[false, true, false], 'a channel Deny of SPEAK and USE_EXTERNAL_SOUNDS leaves USE_SOUNDBOARD, which the token pairs with SPEAK');

-- Role order and the owner. ------------------------------------------------------------------
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000d', true)$q$,
                 '42501', 'Cannot moderate a member with an equal or higher role', 'a moderator does not mute an equal role');
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', true)$q$,
                 '42501', 'The server owner cannot be voice-moderated', 'nor the owner');
SELECT is(public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000c', NULL, true)
            ->> 'deafened', 'true', 'an administrator ranked below is server-deafened');
SELECT tests.authenticate_as('cccccccc-1540-0000-0000-000000000005');
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', true)$q$,
                 '42501', 'Cannot moderate a member with an equal or higher role', 'an administrator does not mute a higher role');
SELECT is(public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e', true)
            ->> 'muted', 'true', 'an administrator mutes a member below them without the bit');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_server_voice_state('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', true, true)
            ->> 'deafened', 'true', 'the owner mutes and deafens the top moderator');
SELECT is(public.set_server_voice_state('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', false, false)
            ->> 'muted', 'false', 'and lifts both');
SELECT tests.clear_authentication();
SELECT is(pg_temp.state('22222222-0000-0000-0000-000000000002'), 'none', 'a member with neither flag has no row');
SELECT is(pg_temp.state('f1540000-0000-0000-0000-00000000000c'), '-D', 'the administrator stays deafened');

-- Resolution in the member's voice channel. --------------------------------------------------
SELECT pg_temp.seat('f1540000-0000-0000-0000-00000000000e', 'f1541000-0000-0000-0000-000000000002');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e', false)$q$,
                 '42501', 'Missing permission: MUTE_MEMBERS', 'a channel Deny keeps the moderator from unmuting a member there');
SELECT is(public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e', NULL, true)
            ->> 'channel_id', 'f1541000-0000-0000-0000-000000000002', 'deafening there is unaffected');
SELECT tests.clear_authentication();
SELECT pg_temp.unseat('f1540000-0000-0000-0000-00000000000e');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e', false, false)
            ->> 'muted', 'false', 'once the member leaves, the server-wide grant applies');

SELECT tests.authenticate_as('ffffffff-1540-0000-0000-000000000008');
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e', true)$q$,
                 '42501', 'Missing permission: MUTE_MEMBERS', 'a channel Allow grants nothing for a member outside that channel');
SELECT tests.clear_authentication();
SELECT pg_temp.seat('f1540000-0000-0000-0000-00000000000e', 'f1541000-0000-0000-0000-000000000003');
SELECT tests.authenticate_as('ffffffff-1540-0000-0000-000000000008');
SELECT is(public.set_server_voice_state('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e', true)
            ->> 'muted', 'true', 'but mutes a member in the channel that allows it');
SELECT tests.clear_authentication();
SELECT pg_temp.unseat('f1540000-0000-0000-0000-00000000000e');

-- Audit trail of the changes above.
SELECT is((SELECT array_agg(action ORDER BY action) FROM (SELECT DISTINCT action FROM public.server_audit_log
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND action LIKE 'member.voice_%') a),
          ARRAY['member.voice_deafen', 'member.voice_mute', 'member.voice_undeafen', 'member.voice_unmute'],
          'mutes, unmutes, deafens and undeafens are audited');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND action = 'member.voice_unmute'
              AND target_id = '44444444-0000-0000-0000-000000000004'), 0, 'a call that changes nothing is not audited');

-- Move and disconnect. -----------------------------------------------------------------------
SELECT pg_temp.seat('33333333-0000-0000-0000-000000000003', 'f1541000-0000-0000-0000-000000000001');
SELECT pg_temp.seat('f1540000-0000-0000-0000-00000000000d', 'f1541000-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.move_voice_member('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e')$q$,
                 'P0002', 'Member is not in a voice channel of this server', 'nobody is moved out of voice they are not in');
SELECT tests.clear_authentication();
SELECT pg_temp.seat('f1540000-0000-0000-0000-00000000000e', 'f1541000-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.move_voice_member('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e')$q$,
                 '42501', 'Missing permission: MOVE_MEMBERS', 'a member without MOVE_MEMBERS disconnects nobody');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.move_voice_member('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000d')$q$,
                 '42501', 'Cannot moderate a member with an equal or higher role', 'a moderator does not disconnect an equal role');
SELECT throws_ok($q$SELECT public.move_voice_member('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', 'f1541000-0000-0000-0000-000000000001')$q$,
                 '22023', 'Member is already in that channel', 'a move names another channel');
SELECT throws_ok($q$SELECT public.move_voice_member('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006')$q$,
                 '22023', 'Not a voice channel of this server', 'a move names a voice channel');
SELECT throws_ok($q$SELECT public.move_voice_member('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', 'f1541000-0000-0000-0000-000000000006')$q$,
                 '42501', 'The member cannot see that channel', 'nor a channel the member cannot see');
SELECT is(public.move_voice_member('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', 'f1541000-0000-0000-0000-000000000005')
            ->> 'from_channel_id', 'f1541000-0000-0000-0000-000000000001', 'a moderator moves a member to another voice channel');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.voice_channel_participants WHERE user_id = '33333333-0000-0000-0000-000000000003'), 0,
          'the member''s row in the old channel is gone; their client joins the new one');

-- Discord's move into a channel the member cannot connect to.
SELECT pg_temp.seat('33333333-0000-0000-0000-000000000003', 'f1541000-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT ok(public.current_user_may_connect_voice('f1541000-0000-0000-0000-000000000001')
          AND NOT public.current_user_may_connect_voice('f1541000-0000-0000-0000-000000000004'),
          'without CONNECT in the vault the member may not join it');
SELECT throws_ok($q$INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
                    VALUES ('f1541000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003')$q$,
                 '42501', NULL, 'and writes no presence row there');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.move_voice_member('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', 'f1541000-0000-0000-0000-000000000004')
            ->> 'channel_id', 'f1541000-0000-0000-0000-000000000004', 'a moderator moves them into it');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.my_voice_state('55555555-0000-0000-0000-000000000005') ->> 'move_channel_id',
          'f1541000-0000-0000-0000-000000000004', 'the moved member reads where to go');
SELECT lives_ok($q$INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
                   VALUES ('f1541000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003')$q$,
                'the move grant admits the moved member');
SELECT tests.clear_authentication();
SELECT ok(public.topic_readable_by('33333333-0000-0000-0000-000000000003', 'harmony-voice-f1541000-0000-0000-0000-000000000004'),
          'to the channel''s P2P signalling topic as well');
UPDATE public.voice_move_grants SET expires_at = now() - interval '1 second'
 WHERE user_id = '33333333-0000-0000-0000-000000000003';
SELECT ok(NOT public.topic_readable_by('33333333-0000-0000-0000-000000000003', 'harmony-voice-f1541000-0000-0000-0000-000000000004')
          AND public.topic_readable_by('33333333-0000-0000-0000-000000000003', 'harmony-voice-f1541000-0000-0000-0000-000000000001'),
          'an expired grant admits nothing; CONNECT still does');
SELECT pg_temp.unseat('33333333-0000-0000-0000-000000000003');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.move_voice_member('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e') ->> 'channel_id',
          NULL, 'a moderator disconnects a member');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.voice_channel_participants WHERE user_id = 'f1540000-0000-0000-0000-00000000000e'), 0,
          'leaving them out of voice');
SELECT is((SELECT array_agg(DISTINCT action ORDER BY action) FROM public.server_audit_log
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND action IN ('member.voice_move', 'member.voice_disconnect')),
          ARRAY['member.voice_disconnect', 'member.voice_move'], 'moves and disconnects are audited');
SELECT is((SELECT details ->> 'channel_name' FROM public.server_audit_log
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND action = 'member.voice_move'
            ORDER BY created_at LIMIT 1),
          'annex', 'naming the destination');

SELECT pg_temp.seat('11111111-0000-0000-0000-000000000001', 'f1541000-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.move_voice_member('55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001')$q$,
                 '42501', 'The server owner cannot be voice-moderated', 'the owner is not disconnected');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.move_voice_member('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000d', 'f1541000-0000-0000-0000-000000000005')
            ->> 'channel_id', 'f1541000-0000-0000-0000-000000000005', 'the owner moves a member of any rank');
SELECT tests.clear_authentication();
SELECT pg_temp.unseat('11111111-0000-0000-0000-000000000001');

-- Out of voice when membership ends or a timeout starts. -------------------------------------
SELECT pg_temp.seat('f1540000-0000-0000-0000-00000000000e', 'f1541000-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.kick_server_member('55555555-0000-0000-0000-000000000005', 'f1540000-0000-0000-0000-00000000000e')$q$,
                'the owner kicks a member in voice');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.voice_channel_participants WHERE user_id = 'f1540000-0000-0000-0000-00000000000e'), 0,
          'a kicked member leaves voice');
SELECT pg_temp.seat('f1540000-0000-0000-0000-00000000000d', 'f1541000-0000-0000-0000-000000000001');
UPDATE public.user_servers SET status = 'banned'
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND user_id = 'f1540000-0000-0000-0000-00000000000d';
SELECT is((SELECT count(*)::int FROM public.voice_channel_participants WHERE user_id = 'f1540000-0000-0000-0000-00000000000d'), 0,
          'so does a member whose membership turns banned');
SELECT pg_temp.seat('33333333-0000-0000-0000-000000000003', 'f1541000-0000-0000-0000-000000000001');
INSERT INTO public.server_member_timeouts (server_id, user_id, until)
VALUES ('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', now() + interval '1 hour');
SELECT is((SELECT count(*)::int FROM public.voice_channel_participants WHERE user_id = '33333333-0000-0000-0000-000000000003'), 0,
          'and a member timed out');

-- CONNECT on presence rows. ------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
                    VALUES ('f1541000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003')$q$,
                 '42501', NULL, 'a timed-out member writes no presence row');
SELECT tests.clear_authentication();
DELETE FROM public.server_member_timeouts WHERE user_id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok($q$INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
                   VALUES ('f1541000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003')$q$,
                'once the timeout is lifted, they write one where they hold CONNECT');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id)
                   VALUES ('f1541000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002')$q$,
                'a role Allow over an @everyone Deny admits the moderator');

-- Grants. ------------------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.set_server_voice_state('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', false)$q$,
                 '42501', NULL, 'anon cannot call set_server_voice_state');
SELECT throws_ok($q$SELECT public.move_voice_member('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003')$q$,
                 '42501', NULL, 'nor move_voice_member');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.voice_channel_admits('33333333-0000-0000-0000-000000000003', 'f1541000-0000-0000-0000-000000000001')$q$,
                 '42501', NULL, 'voice_channel_admits is internal');
SELECT throws_ok($q$SELECT public.voice_remove_member('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', 'removed')$q$,
                 '42501', NULL, 'as is voice_remove_member');
SELECT throws_ok($q$SELECT count(*) FROM public.voice_move_grants$q$, '42501', NULL, 'and the move grants');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
