-- 20261026700001_sharing_membership_moderation.sql.
--
--   alice    owns server_1 (5555…5); DM 7777…7 with bob
--   bob      member of server_1; "Mods" role: MANAGE_MESSAGES, VIEW_AUDIT_LOG, MANAGE_SERVER
--   mallory  in no server and no conversation, until added to server_1 with the "Staff" role
--   staff channel (f177…c1) denies VIEW_CHANNEL to @everyone and allows "Staff"
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(43);

SELECT set_config('storage.allow_delete_query', 'true', true);
INSERT INTO storage.buckets (id, name, public) VALUES
  ('avatars', 'avatars', true), ('group-icons', 'group-icons', true), ('server_icons', 'server_icons', true)
ON CONFLICT (id) DO NOTHING;

-- Conversation membership -------------------------------------------------------------
SELECT public.bump_room_epoch('77777777-0000-0000-0000-000000000007', 'manual_rotate');
SELECT public.bump_room_epoch('77777777-0000-0000-0000-000000000007', 'manual_rotate');

-- tests.authenticate_as sets no role claim; a PostgREST request carries one, and the old
-- room_epoch_state policy read it through auth.role().
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000003","role":"authenticated"}', true);
SELECT is(public.is_conversation_participant('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001'),
          false, 'an outsider learns nothing about a DM''s participants');
SELECT is(public.is_room_member('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001'),
          false, 'is_room_member answers an outsider false about others');
SELECT is((SELECT count(*)::int FROM public.room_epoch_state WHERE room_id = '77777777-0000-0000-0000-000000000007'),
          0, 'an outsider reads no room_epoch_state row of the DM');
SELECT is(public.get_room_epoch('77777777-0000-0000-0000-000000000007'), 1,
          'get_room_epoch gives an outsider the default epoch');

SELECT tests.authenticate_as_anon();
SELECT is(public.is_conversation_participant('77777777-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002'),
          false, 'anon learns nothing about a DM''s participants');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claims',
    '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
SELECT is(public.is_conversation_participant('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001'),
          true, 'a participant asks about the other participant');
SELECT is(public.is_room_member('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001'),
          true, 'a participant checks a key requester''s membership');
SELECT is((SELECT count(*)::int FROM public.conversation_participants WHERE conversation_id = '77777777-0000-0000-0000-000000000007'),
          2, 'a participant still lists the conversation''s participants');
SELECT is((SELECT count(*)::int FROM public.room_epoch_state WHERE room_id = '77777777-0000-0000-0000-000000000007'),
          1, 'a participant reads the DM''s room_epoch_state row');
SELECT cmp_ok(public.get_room_epoch('77777777-0000-0000-0000-000000000007'), '>', 1,
          'a participant reads the DM''s epoch');

SELECT tests.clear_authentication();
SELECT is(public.is_conversation_participant('77777777-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002'),
          true, 'a service caller asks about anyone');

-- Public bucket rows ------------------------------------------------------------------
INSERT INTO storage.objects (bucket_id, name, owner) VALUES
  ('group-icons', '77777777-0000-0000-0000-000000000007/icon.png', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('avatars', 'aaaaaaaa-0000-0000-0000-000000000001/a.png', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('server_icons', '55555555-0000-0000-0000-000000000005/icon.png', 'aaaaaaaa-0000-0000-0000-000000000001');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'group-icons'), 0,
          'an outsider lists no group icon folder');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'avatars'), 0,
          'a user lists no one else''s avatar');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'server_icons'), 0,
          'a non-member lists no server icon folder');
SELECT tests.authenticate_as_anon();
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id IN ('group-icons', 'avatars', 'server_icons')), 0,
          'anon lists nothing in the public buckets');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'group-icons'), 1,
          'a participant reads the group icon row');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'server_icons'), 0,
          'a member without MANAGE_SERVER lists no server icon row');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE (bucket_id, name) IN (('avatars', 'aaaaaaaa-0000-0000-0000-000000000001/a.png'),
                                        ('server_icons', '55555555-0000-0000-0000-000000000005/icon.png'))), 2,
          'the uploader and owner reads its avatar and server icon rows');
WITH up AS (
    INSERT INTO storage.objects (bucket_id, name, owner)
    VALUES ('avatars', 'aaaaaaaa-0000-0000-0000-000000000001/b.png', 'aaaaaaaa-0000-0000-0000-000000000001')
    RETURNING name)
SELECT is((SELECT name FROM up), 'aaaaaaaa-0000-0000-0000-000000000001/b.png', 'an upload reads its own row back');

-- Moderation of a server without an owner ---------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.servers (id, name, owner) VALUES
  ('f1770000-0000-0000-0000-0000000000a5', 'Ownerless 177', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1770000-0000-0000-0000-0000000000a5', 'accepted');
INSERT INTO public.server_bans (server_id, user_id, banned_by, reason) VALUES
  ('f1770000-0000-0000-0000-0000000000a5', '44444444-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001', 'b177');
UPDATE public.servers SET owner = NULL WHERE id = 'f1770000-0000-0000-0000-0000000000a5';

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.ban_server_member('f1770000-0000-0000-0000-0000000000a5', '22222222-0000-0000-0000-000000000002', 'x', 0)$q$,
                 NULL, 'Missing BAN_MEMBERS permission', 'a stranger cannot ban in a server without an owner');
SELECT throws_ok($q$SELECT public.kick_server_member('f1770000-0000-0000-0000-0000000000a5', '22222222-0000-0000-0000-000000000002', 'x', 0)$q$,
                 NULL, 'Missing KICK_MEMBERS permission', 'a stranger cannot kick in a server without an owner');
SELECT throws_ok($q$SELECT public.get_server_bans('f1770000-0000-0000-0000-0000000000a5')$q$,
                 NULL, 'Missing BAN_MEMBERS permission', 'a stranger cannot read the ban list of a server without an owner');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($q$SELECT public.unban_server_member('f1770000-0000-0000-0000-0000000000a5', '44444444-0000-0000-0000-000000000004')$q$,
                 NULL, 'Missing BAN_MEMBERS permission', 'a banned account cannot unban itself in a server without an owner');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.kick_server_member('55555555-0000-0000-0000-000000000005', '44444444-0000-0000-0000-000000000004', 'k', 0))->>'success',
          'true', 'an owner still kicks in its own server');

-- Reports of a channel the moderator cannot view ---------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.server_roles (id, server_id, name, permissions, position) VALUES
  ('f1770000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'Mods 177',
   (1::bigint << 21) | (1::bigint << 5) | (1::bigint << 7), 5),
  ('f1770000-0000-0000-0000-0000000000d2', '55555555-0000-0000-0000-000000000005', 'Staff 177', 0, 4);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1770000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005'),
  ('33333333-0000-0000-0000-000000000003', 'f1770000-0000-0000-0000-0000000000d2', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1770000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'staff-177', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT 'f1770000-0000-0000-0000-0000000000c1', 'role', r.id, 0, 2
  FROM public.server_roles r WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('f1770000-0000-0000-0000-0000000000c1', 'role', 'f1770000-0000-0000-0000-0000000000d2', 2, 0);
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f1770000-0000-0000-0000-0000000000e1', 'f1770000-0000-0000-0000-0000000000c1', '33333333-0000-0000-0000-000000000003',
   '[{"type":"text","text":"STAFF-177"},{"type":"file","path":"c/f1770000-0000-0000-0000-0000000000c1/cccccccc-0000-0000-0000-000000000003/s.png","url":"x"}]'),
  ('f1770000-0000-0000-0000-0000000000e2', '66666666-0000-0000-0000-000000000006', '33333333-0000-0000-0000-000000000003',
   '[{"type":"text","text":"GENERAL-177"}]');
INSERT INTO public.automod_events (server_id, channel_id, event_type, content_excerpt) VALUES
  ('55555555-0000-0000-0000-000000000005', 'f1770000-0000-0000-0000-0000000000c1', 'message', 'STAFF-EXCERPT-177'),
  ('55555555-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006', 'message', 'GENERAL-EXCERPT-177');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE TEMP TABLE r177 (k text PRIMARY KEY, id uuid);
GRANT ALL ON r177 TO authenticated;
INSERT INTO r177 VALUES
  ('staff', public.create_report('message', NULL, NULL, 'f1770000-0000-0000-0000-0000000000e1', NULL, 'spam')),
  ('general', public.create_report('message', NULL, NULL, 'f1770000-0000-0000-0000-0000000000e2', NULL, 'spam'));

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.has_permission('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'VIEW_CHANNEL', 'f1770000-0000-0000-0000-0000000000c1'),
          false, 'the server moderator cannot view the staff channel');
SELECT is((SELECT count(*)::int FROM public.get_reports_with_details(NULL, 50, 0, '55555555-0000-0000-0000-000000000005') g
            WHERE g.id = (SELECT id FROM r177 WHERE k = 'staff')),
          0, 'get_reports_with_details withholds a report from a channel the moderator cannot view');
SELECT is((SELECT count(*)::int FROM public.get_reports_with_details(NULL, 50, 0, '55555555-0000-0000-0000-000000000005') g
            WHERE g.id = (SELECT id FROM r177 WHERE k = 'general')),
          1, 'get_reports_with_details lists a report from a channel the moderator views');
SELECT is(public.message_media_reported('c/f1770000-0000-0000-0000-0000000000c1/cccccccc-0000-0000-0000-000000000003/s.png'),
          false, 'a reported attachment of the staff channel is not readable to the server moderator');
SELECT throws_ok(format($q$SELECT public.moderate_report(%L, 'dismiss')$q$, (SELECT id FROM r177 WHERE k = 'staff')),
                 '42501', NULL, 'the server moderator cannot dismiss a report it cannot read');
SELECT is((SELECT count(*)::int FROM public.reports), 0,
          'the reports table gives a server moderator no rows, reporter ids included');
SELECT ok(public.get_server_automod_events('55555555-0000-0000-0000-000000000005')::text NOT LIKE '%STAFF-EXCERPT-177%',
          'automod events of the staff channel are withheld');
SELECT ok(public.get_server_automod_events('55555555-0000-0000-0000-000000000005')::text LIKE '%GENERAL-EXCERPT-177%',
          'automod events of a viewable channel are listed');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.reports), 0, 'a member reads no one else''s reports');

-- Bot channel grants -----------------------------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.bots (id, username, owner_id) VALUES
  ('f1770000-0000-0000-0000-0000000000b0', 'bot177', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.bot_server_permissions (id, bot_id, server_id, installed_by, read_messages) VALUES
  ('f1770000-0000-0000-0000-0000000000b1', 'f1770000-0000-0000-0000-0000000000b0', '55555555-0000-0000-0000-000000000005',
   '22222222-0000-0000-0000-000000000002', true);

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$UPDATE public.bot_server_permissions
                      SET allowed_channel_ids = ARRAY['f1770000-0000-0000-0000-0000000000c1']::uuid[]
                    WHERE id = 'f1770000-0000-0000-0000-0000000000b1'$q$,
                 '42501', NULL, 'a manager cannot grant a bot a hidden channel by writing the row');
SELECT throws_ok($q$SELECT public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                      'f1770000-0000-0000-0000-0000000000b0', ARRAY['f1770000-0000-0000-0000-0000000000c1']::uuid[])$q$,
                 '42501', NULL, 'set_bot_allowed_channels refuses a channel the manager cannot view');
SELECT is(public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
              'f1770000-0000-0000-0000-0000000000b0', ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]),
          ARRAY['66666666-0000-0000-0000-000000000006']::uuid[], 'set_bot_allowed_channels grants a viewable channel');
SELECT lives_ok($q$UPDATE public.bot_server_permissions SET send_messages = true
                    WHERE id = 'f1770000-0000-0000-0000-0000000000b1'$q$,
                'a manager still edits the install''s flags');

-- Lesser reads -----------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok($q$SELECT public.get_server_encryption_stats('55555555-0000-0000-0000-000000000005')$q$,
                'a member reads its server''s encryption stats');
SELECT throws_ok($q$SELECT public.get_server_encryption_stats('f1770000-0000-0000-0000-0000000000a5')$q$,
                 '42501', NULL, 'a non-member cannot read a server''s encryption stats');

SELECT tests.clear_authentication();
UPDATE public.profiles SET is_moderator = true, is_suspended = true WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.is_current_user_admin_or_mod(), false, 'a suspended moderator holds no staff rights');
SELECT tests.clear_authentication();
UPDATE public.profiles SET is_suspended = false WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.is_current_user_admin_or_mod(), true, 'an active moderator holds staff rights');

SELECT tests.clear_authentication();
INSERT INTO public.threads (id, channel_id, parent_message_id, name) VALUES
  ('f1770000-0000-0000-0000-0000000000f1', 'f1770000-0000-0000-0000-0000000000c1', 'f1770000-0000-0000-0000-0000000000e1', 'staff thread');
DELETE FROM public.user_roles WHERE role_id = 'f1770000-0000-0000-0000-0000000000d2';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$INSERT INTO public.thread_members (thread_id, user_id)
                    VALUES ('f1770000-0000-0000-0000-0000000000f1', '33333333-0000-0000-0000-000000000003')$q$,
                 '42501', NULL, 'a member cannot join a thread of a channel it cannot view');

-- Last: before the fix the delete succeeds and takes alice's rows with it.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$DELETE FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'$q$,
                 '42501', NULL, 'a client cannot delete its profile row around delete_my_account');

SELECT * FROM finish();
ROLLBACK;
