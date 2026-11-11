-- Server profiles: profiles.pronouns, user_servers.{avatar_url,banner_url,bio,pronouns}, and the RPCs
-- set_my_server_profile, moderate_server_profile, service_set_member_server_profile
-- (20261112100002_server_profiles.sql).
--
--   owner  mallory (33..)   owns the server
--   admin  banned  (44..)   position 9    no MANAGE_NICKNAMES
--   mod    bob     (22..)   position 5    MANAGE_NICKNAMES (bit 33)
--   target alice   (11..)   position 1    @everyone carries CHANGE_NICKNAME (bit 32)
--   pend   a pending member
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(40);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2470000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pend247@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f2470000-0000-0000-0000-0000000000c1', 'f2470000-0000-0000-0000-0000000000a1', 'pend247', 'Pend', true);
INSERT INTO public.servers (id, name, owner) VALUES
  ('f2470000-0000-0000-0000-000000000001', 'Profiles247', '33333333-0000-0000-0000-000000000003');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('33333333-0000-0000-0000-000000000003', 'f2470000-0000-0000-0000-000000000001', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', 'f2470000-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f2470000-0000-0000-0000-000000000001', 'accepted'),
  ('44444444-0000-0000-0000-000000000004', 'f2470000-0000-0000-0000-000000000001', 'accepted'),
  ('f2470000-0000-0000-0000-0000000000c1', 'f2470000-0000-0000-0000-000000000001', 'pending')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = EXCLUDED.status;
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f2471000-0000-0000-0000-000000000001', 'f2470000-0000-0000-0000-000000000001', 'low247', 1, 0),
  ('f2471000-0000-0000-0000-000000000002', 'f2470000-0000-0000-0000-000000000001', 'mod247', 5, 8589934592),
  ('f2471000-0000-0000-0000-000000000003', 'f2470000-0000-0000-0000-000000000001', 'admin247', 9, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2471000-0000-0000-0000-000000000001', 'f2470000-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000002', 'f2471000-0000-0000-0000-000000000002', 'f2470000-0000-0000-0000-000000000001'),
  ('44444444-0000-0000-0000-000000000004', 'f2471000-0000-0000-0000-000000000003', 'f2470000-0000-0000-0000-000000000001');

-- self_edit ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_my_server_profile('f2470000-0000-0000-0000-000000000001',
            '{"nickname":"Ally","pronouns":"she/her"}'::jsonb)->>'nickname', 'Ally',
          'set_my_server_profile returns the row''s fields');
SELECT tests.clear_authentication();
SELECT is((SELECT nickname || '|' || pronouns FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'),
          'Ally|she/her', 'the row has the nickname and pronouns');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.set_my_server_profile('f2470000-0000-0000-0000-000000000001', '{"bio":"  hi  "}'::jsonb);
SELECT tests.clear_authentication();
SELECT is((SELECT nickname || '|' || pronouns || '|' || bio FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'),
          'Ally|she/her|hi', 'a key left out is left alone; values are trimmed');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.set_my_server_profile('f2470000-0000-0000-0000-000000000001', '{"nickname":null}'::jsonb);
SELECT tests.clear_authentication();
SELECT is((SELECT nickname FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'),
          NULL, 'JSON null clears the nickname');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.set_my_server_profile('f2470000-0000-0000-0000-000000000001', '{"colour":"red"}'::jsonb)$$,
                 '22023', NULL, 'an unknown key raises 22023');
SELECT throws_ok($$SELECT public.set_my_server_profile('f2470000-0000-0000-0000-000000000001', '{"bio":5}'::jsonb)$$,
                 '22023', NULL, 'a non-string value raises 22023');
SELECT throws_ok($$SELECT public.set_my_server_profile('f2470000-0000-0000-0000-000000000001', '[]'::jsonb)$$,
                 '22023', NULL, 'a non-object raises 22023');
SELECT set_config('t247.pron41', repeat('p', 41), true);
SELECT throws_ok($$SELECT public.set_my_server_profile('f2470000-0000-0000-0000-000000000001',
                     jsonb_build_object('pronouns', current_setting('t247.pron41')))$$,
                 '23514', NULL, 'pronouns of 41 characters violate the check');
SELECT tests.clear_authentication();

-- limits and normalisation ---------------------------------------------------------------------
SELECT throws_ok($$UPDATE public.user_servers SET pronouns = repeat('p', 41)
                    WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'$$,
                 '23514', NULL, 'user_servers.pronouns is capped at 40');
SELECT lives_ok($$UPDATE public.user_servers SET pronouns = repeat('p', 40)
                    WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'$$,
                'and 40 is fine');
SELECT throws_ok($$UPDATE public.user_servers SET bio = repeat('b', 501)
                    WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'$$,
                 '23514', NULL, 'user_servers.bio is capped at 500');
UPDATE public.user_servers SET bio = '  ', pronouns = '  ', avatar_url = ' ', banner_url = ''
 WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'
              AND bio IS NULL AND pronouns IS NULL AND avatar_url IS NULL AND banner_url IS NULL), 1,
          'blank values are stored as NULL');
SELECT throws_ok($$UPDATE public.profiles SET pronouns = repeat('p', 41) WHERE id = '11111111-0000-0000-0000-000000000001'$$,
                 '23514', NULL, 'profiles.pronouns is capped at 40');
UPDATE public.profiles SET pronouns = '  they/them ' WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT is((SELECT pronouns FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'), 'they/them',
          'profiles.pronouns is trimmed');

-- direct writes -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$UPDATE public.user_servers SET nickname = 'Sneaky'
                    WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'$$,
                 '42501', NULL, 'a member cannot write nickname directly');
SELECT throws_ok($$UPDATE public.user_servers SET bio = 'Sneaky'
                    WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'$$,
                 '42501', NULL, 'nor the other profile columns');
SELECT lives_ok($$UPDATE public.user_servers SET muted = true
                    WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'$$,
                'muted is still writable');
SELECT lives_ok($$UPDATE public.user_servers SET position = 3, folder_id = NULL
                    WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'$$,
                'position and folder are still writable');
SELECT tests.clear_authentication();
SELECT is((SELECT muted FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'),
          true, 'and the mute took effect');
-- The owner's update arm does not reach the profile columns either.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$UPDATE public.user_servers SET nickname = 'Sneaky'
                    WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'$$,
                 '42501', NULL, 'the owner cannot write a member''s nickname directly');
SELECT tests.clear_authentication();

-- self_edit_requires_permission -------------------------------------------------------------
UPDATE public.user_servers SET nickname = 'Keep' WHERE user_id = '11111111-0000-0000-0000-000000000001'
   AND server_id = 'f2470000-0000-0000-0000-000000000001';
UPDATE public.server_roles SET permissions = permissions & ~(1::bigint << 32)
 WHERE server_id = 'f2470000-0000-0000-0000-000000000001' AND is_default;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.set_my_server_profile('f2470000-0000-0000-0000-000000000001', '{"nickname":"Nope"}'::jsonb)$$,
                 '42501', NULL, 'without CHANGE_NICKNAME set_my_server_profile raises 42501');
SELECT tests.clear_authentication();
SELECT is((SELECT nickname FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'),
          'Keep', 'and the nickname is unchanged');

-- A pending member cannot, even with the permission.
UPDATE public.server_roles SET permissions = permissions | (1::bigint << 32)
 WHERE server_id = 'f2470000-0000-0000-0000-000000000001' AND is_default;
SELECT tests.authenticate_as('f2470000-0000-0000-0000-0000000000a1');
SELECT throws_ok($$SELECT public.set_my_server_profile('f2470000-0000-0000-0000-000000000001', '{"nickname":"Hi"}'::jsonb)$$,
                 '42501', NULL, 'a pending member cannot set a server profile');
SELECT tests.clear_authentication();

-- moderate_respects_hierarchy ---------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($$SELECT public.moderate_server_profile('f2470000-0000-0000-0000-000000000001',
                    '11111111-0000-0000-0000-000000000001', 'Renamed', true)$$,
                'a moderator renames a member ranked below');
SELECT throws_ok($$SELECT public.moderate_server_profile('f2470000-0000-0000-0000-000000000001',
                    '44444444-0000-0000-0000-000000000004', 'Nope', true)$$,
                 '42501', NULL, 'but not one ranked above');
SELECT throws_ok($$SELECT public.moderate_server_profile('f2470000-0000-0000-0000-000000000001',
                    '33333333-0000-0000-0000-000000000003', 'Nope', true)$$,
                 '42501', NULL, 'nor the owner');
SELECT tests.clear_authentication();
SELECT is((SELECT nickname FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'),
          'Renamed', 'the nickname was changed');
SELECT is((SELECT changes->'nickname' FROM public.server_audit_log
            WHERE server_id = 'f2470000-0000-0000-0000-000000000001' AND action = 'member.nickname_update'
              AND target_id = '11111111-0000-0000-0000-000000000001'),
          '{"old":"Keep","new":"Renamed"}'::jsonb, 'and audited old to new');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($$SELECT public.moderate_server_profile('f2470000-0000-0000-0000-000000000001',
                    '11111111-0000-0000-0000-000000000001', 'Nope', true)$$,
                 '42501', NULL, 'without MANAGE_NICKNAMES a higher rank is not enough');
SELECT tests.clear_authentication();

-- reset ---------------------------------------------------------------------------------------------
UPDATE public.user_servers SET avatar_url = 'https://x/a.png', banner_url = 'https://x/b.png', bio = 'b', pronouns = 'p'
 WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.moderate_server_profile('f2470000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
                                      NULL, false, true);
SELECT tests.clear_authentication();
SELECT is((SELECT (nickname IS NOT NULL AND avatar_url IS NULL AND banner_url IS NULL AND bio IS NULL AND pronouns IS NULL)
             FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'),
          true, 'a reset clears the four fields and keeps the nickname');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = 'f2470000-0000-0000-0000-000000000001' AND action = 'member.profile_reset'
              AND target_id = '11111111-0000-0000-0000-000000000001'), 1, 'and is audited');

-- service_set_member_server_profile ---------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.service_set_member_server_profile('f2470000-0000-0000-0000-000000000001',
                    '11111111-0000-0000-0000-000000000001', '{"bio":"x"}'::jsonb)$$,
                 '42501', NULL, 'authenticated cannot call the service RPC');
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;
SELECT set_config('t247.svc', public.service_set_member_server_profile('f2470000-0000-0000-0000-000000000001',
            '11111111-0000-0000-0000-000000000001', '{"bio":"from discord","pronouns":"he/him"}'::jsonb)->>'bio', true);
RESET ROLE;
SELECT is(current_setting('t247.svc'), 'from discord', 'service_role writes a member''s profile');
SELECT is((SELECT bio || '|' || pronouns FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000001'),
          'from discord|he/him', 'and the row has it');

-- fix round 1 ----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($$SELECT public.moderate_server_profile('f2470000-0000-0000-0000-000000000001',
                    '11111111-0000-0000-0000-000000000001', NULL, false, true)$$,
                 '42501', NULL, 'without MANAGE_NICKNAMES a reset is refused too');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.moderate_server_profile('f2470000-0000-0000-0000-000000000001',
                    '11111111-0000-0000-0000-000000000001')$$,
                 '22023', NULL, 'moderate_server_profile with nothing to change raises 22023');
SELECT tests.clear_authentication();

-- A remote server copy: both RPCs refuse, even to the member holding the permissions.
INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('f2470000-0000-0000-0000-000000000002', 'Remote247', '33333333-0000-0000-0000-000000000003', false);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2470000-0000-0000-0000-000000000002', 'accepted'),
  ('33333333-0000-0000-0000-000000000003', 'f2470000-0000-0000-0000-000000000002', 'accepted')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = EXCLUDED.status;
UPDATE public.server_roles SET permissions = permissions | (1::bigint << 32) | (1::bigint << 33)
 WHERE server_id = 'f2470000-0000-0000-0000-000000000002' AND is_default;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.set_my_server_profile('f2470000-0000-0000-0000-000000000002', '{"nickname":"R"}'::jsonb)$$,
                 '42501', NULL, 'set_my_server_profile refuses a remote server copy');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$SELECT public.moderate_server_profile('f2470000-0000-0000-0000-000000000002',
                    '11111111-0000-0000-0000-000000000001', 'R', true)$$,
                 '42501', NULL, 'moderate_server_profile refuses a remote server copy, even to its owner row');
SELECT tests.clear_authentication();
SELECT is((SELECT nickname FROM public.user_servers
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2470000-0000-0000-0000-000000000002'),
          NULL, 'and nothing was written');
SELECT is((SELECT count(*)::int FROM public.server_audit_log WHERE server_id = 'f2470000-0000-0000-0000-000000000002'), 0,
          'and nothing was audited');

SELECT * FROM finish();
ROLLBACK;
