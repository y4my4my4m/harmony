-- 20261016100005_permission_fixes.sql: MANAGE_MESSAGES resolved per channel for deleting
-- others' messages, the role hierarchy on timeouts, ADD_REACTIONS and ATTACH_FILES.
--
--   alice    owns server_1
--   bob      member; role mods (position 5: MANAGE_MESSAGES, TIMEOUT_MEMBERS)
--   mallory  member for this file; role helpers (position 1, no server permissions)
--
--   general       no overrides
--   helpers-only  helpers: Allow MANAGE_MESSAGES
--   mods-denied   mods: Deny MANAGE_MESSAGES; @everyone: Deny MANAGE_MESSAGES
--   locked        @everyone: Deny ADD_REACTIONS, ATTACH_FILES
--
-- Bits: MANAGE_MESSAGES 1 << 21 = 2097152, TIMEOUT_MEMBERS 1 << 11 = 2048,
-- ADD_REACTIONS 1 << 18 = 262144, ATTACH_FILES 1 << 17 = 131072, ADMINISTRATOR 1.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(46);

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted')
ON CONFLICT DO NOTHING;

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1510000-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005', 'helpers-only', 0),
  ('f1510000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'mods-denied', 0),
  ('f1510000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'locked', 0);

INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1511000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'helpers', 1, 0),
  ('f1511000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'mods', 5, 2097152 | 2048),
  ('f1511000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'admins', 8, 1),
  ('f1511000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'seniors', 7, 0),
  ('f1511000-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000005', 'peers', 5, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('33333333-0000-0000-0000-000000000003', 'f1511000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('22222222-0000-0000-0000-000000000002', 'f1511000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('f1510000-0000-0000-0000-0000000000b1', 'role', 'f1511000-0000-0000-0000-000000000001', 2097152, 0),
  ('f1510000-0000-0000-0000-0000000000c1', 'role', 'f1511000-0000-0000-0000-000000000002', 0, 2097152),
  ('f1510000-0000-0000-0000-0000000000c1', 'role',
   (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), 0, 2097152),
  ('f1510000-0000-0000-0000-0000000000d1', 'role',
   (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), 0, 262144 | 131072);

INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f1512000-0000-0000-0000-0000000000a1', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob in general"}]'),
  ('f1512000-0000-0000-0000-0000000000a2', '66666666-0000-0000-0000-000000000006', '33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"mallory in general"}]'),
  ('f1512000-0000-0000-0000-0000000000a3', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob in general again"}]'),
  ('f1512000-0000-0000-0000-0000000000a4', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"reported in general"}]'),
  ('f1512000-0000-0000-0000-0000000000b1', 'f1510000-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob in helpers-only"}]'),
  ('f1512000-0000-0000-0000-0000000000b2', 'f1510000-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob again"}]'),
  ('f1512000-0000-0000-0000-0000000000b3', 'f1510000-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"thread starter"}]'),
  ('f1512000-0000-0000-0000-0000000000c1', 'f1510000-0000-0000-0000-0000000000c1', '33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"mallory in mods-denied"}]'),
  ('f1512000-0000-0000-0000-0000000000c2', 'f1510000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob in mods-denied"}]'),
  ('f1512000-0000-0000-0000-0000000000c3', 'f1510000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob for the owner"}]'),
  ('f1512000-0000-0000-0000-0000000000c4', 'f1510000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob for an administrator"}]'),
  ('f1512000-0000-0000-0000-0000000000d1', 'f1510000-0000-0000-0000-0000000000d1', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"react here"}]'),
  ('f1512000-0000-0000-0000-0000000000d2', 'f1510000-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-000000000003',
   '[{"type":"text","text":"posted before the lock"},{"type":"file","url":"","path":"c/f1510000-0000-0000-0000-0000000000d1/cccccccc-0000-0000-0000-000000000003/old.png","fileType":"image"}]');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
VALUES ('f1513000-0000-0000-0000-000000000001', 'f1510000-0000-0000-0000-0000000000b1',
        'f1512000-0000-0000-0000-0000000000b3', 'side', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content)
VALUES ('f1512000-0000-0000-0000-0000000000b4', 'f1510000-0000-0000-0000-0000000000b1',
        'f1513000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"in the thread"}]');

INSERT INTO public.reports (id, reporter_id, reported_message_id, reason, report_type, scope_server_id, content_snapshot) VALUES
  ('f1514000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   'f1512000-0000-0000-0000-0000000000c1', 'spam', 'message', '55555555-0000-0000-0000-000000000005', '{}'),
  ('f1514000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   'f1512000-0000-0000-0000-0000000000a4', 'spam', 'message', '55555555-0000-0000-0000-000000000005', '{}');

-- Row counts as the client sees them: RLS filters, it does not raise.
CREATE FUNCTION pg_temp.soft_delete(p_id uuid) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  UPDATE public.messages SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true WHERE id = p_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
CREATE FUNCTION pg_temp.hard_delete(p_id uuid) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  DELETE FROM public.messages WHERE id = p_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
CREATE FUNCTION pg_temp.edit(p_id uuid, p_text text) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  UPDATE public.messages SET content = jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text)) WHERE id = p_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
CREATE FUNCTION pg_temp.post(p_user uuid, p_channel uuid, p_content jsonb, p_media text[] DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.messages (channel_id, user_id, content, media_paths) VALUES (p_channel, p_user, p_content, p_media);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
CREATE FUNCTION pg_temp.attachment(p_channel uuid, p_auth uuid) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'see attached'),
         jsonb_build_object('type', 'file', 'url', '', 'fileType', 'image',
                            'path', 'c/' || p_channel || '/' || p_auth || '/' || gen_random_uuid() || '.png'));
$fn$;
CREATE FUNCTION pg_temp.react(p_message uuid, p_user uuid, p_emoji text) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.reactions (message_id, user_id, custom_emoji_content) VALUES (p_message, p_user, p_emoji);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

-- A channel Allow grants MANAGE_MESSAGES in that channel alone. ----------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT ok(public.can_current_user_manage_messages_in_channel('f1510000-0000-0000-0000-0000000000b1')
          AND NOT public.can_current_user_manage_messages_in_channel('66666666-0000-0000-0000-000000000006')
          AND NOT public.can_current_user_manage_messages_in_channel(NULL),
          'the helper follows the channel override');
SELECT is(pg_temp.soft_delete('f1512000-0000-0000-0000-0000000000b1'), 1,
          'a channel Allow lets a member delete another member''s message there');
SELECT is(pg_temp.hard_delete('f1512000-0000-0000-0000-0000000000b2'), 1, 'and hard-delete it');
SELECT is(pg_temp.soft_delete('f1512000-0000-0000-0000-0000000000b4'), 1, 'and delete a message in a thread of that channel');
SELECT is(pg_temp.soft_delete('f1512000-0000-0000-0000-0000000000a1'), 0, 'but not in another channel');
SELECT is(pg_temp.hard_delete('f1512000-0000-0000-0000-0000000000a1'), 0, 'nor hard-delete there');
SELECT throws_ok($q$UPDATE public.messages SET content = '[{"type":"text","text":"rewritten"}]' WHERE id = 'f1512000-0000-0000-0000-0000000000b3'$q$,
                 '42501', NULL, 'an Allow does not let them edit another member''s message');

-- A channel Deny removes a server-wide grant there. ----------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.soft_delete('f1512000-0000-0000-0000-0000000000a2'), 1, 'a server-wide moderator deletes in general');
SELECT is(pg_temp.soft_delete('f1512000-0000-0000-0000-0000000000c1'), 0, 'not where the role is denied');
SELECT is(pg_temp.hard_delete('f1512000-0000-0000-0000-0000000000c1'), 0, 'nor hard-deletes there');
SELECT is(pg_temp.edit('f1512000-0000-0000-0000-0000000000c2', 'bob edited'), 1, 'the denied moderator still edits their own message');
SELECT is(pg_temp.soft_delete('f1512000-0000-0000-0000-0000000000c2'), 1, 'and deletes it');
SELECT is(pg_temp.soft_delete('99999999-0000-0000-0000-000000000009'), 0,
          'a server moderator does not delete another participant''s DM message');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.edit('f1512000-0000-0000-0000-0000000000c1', 'mallory edited'), 1,
          'a member without MANAGE_MESSAGES edits their own message');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.soft_delete('f1512000-0000-0000-0000-0000000000c3'), 1, 'the owner deletes despite the @everyone Deny');
SELECT is(pg_temp.soft_delete('99999999-0000-0000-0000-000000000009'), 1, 'the author deletes their DM message');

-- ADMINISTRATOR outranks a member Deny; instance moderators keep their branch.
SELECT tests.clear_authentication();
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1511000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, user_id, deny_permissions)
VALUES ('f1510000-0000-0000-0000-0000000000c1', 'user', '33333333-0000-0000-0000-000000000003', 2097152);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.soft_delete('f1512000-0000-0000-0000-0000000000c4'), 1, 'ADMINISTRATOR deletes despite a member Deny');
SELECT tests.clear_authentication();
DELETE FROM public.user_roles WHERE role_id = 'f1511000-0000-0000-0000-000000000003';
UPDATE public.profiles SET is_moderator = true WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.soft_delete('f1512000-0000-0000-0000-0000000000a3'), 1, 'an instance moderator deletes in any channel');
SELECT tests.clear_authentication();
UPDATE public.profiles SET is_moderator = false WHERE id = '33333333-0000-0000-0000-000000000003';

-- The report queue takes the same per-channel answer. --------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.moderate_report('f1514000-0000-0000-0000-000000000001', 'delete_message')$q$,
                 '42501', 'Permission denied: MANAGE_MESSAGES required in the message''s channel',
                 'a server moderator cannot delete a reported message where they are denied');
SELECT is(public.moderate_report('f1514000-0000-0000-0000-000000000002', 'delete_message')->>'status', 'resolved',
          'and deletes one where they are not');
SELECT tests.clear_authentication();
SELECT ok((SELECT NOT is_deleted FROM public.messages WHERE id = 'f1512000-0000-0000-0000-0000000000c1')
          AND (SELECT is_deleted FROM public.messages WHERE id = 'f1512000-0000-0000-0000-0000000000a4'),
          'only the permitted report removed its message');

-- Timeouts follow the role hierarchy. ------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005',
                   '33333333-0000-0000-0000-000000000003', 60)$q$, 'a moderator times out a lower member');
SELECT lives_ok($q$SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005',
                   '33333333-0000-0000-0000-000000000003', 0)$q$, 'and lifts it');
SELECT throws_ok($q$SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005',
                    '22222222-0000-0000-0000-000000000002', 60)$q$,
                 '42501', 'You cannot time yourself out', 'not themselves');
SELECT throws_ok($q$SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005',
                    '11111111-0000-0000-0000-000000000001', 60)$q$,
                 '42501', NULL, 'nor the owner');

SELECT tests.clear_authentication();
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1511000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005',
                    '33333333-0000-0000-0000-000000000003', 60)$q$,
                 '42501', 'Cannot time out a member with an equal or higher role', 'nor a higher-ranked member');
SELECT tests.clear_authentication();
INSERT INTO public.server_member_timeouts (server_id, user_id, until, source)
VALUES ('55555555-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003', now() + interval '1 hour', 'automod');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005',
                    '33333333-0000-0000-0000-000000000003', 0)$q$,
                 '42501', 'Cannot time out a member with an equal or higher role', 'nor lifts a higher-ranked member''s timeout');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005',
                   '33333333-0000-0000-0000-000000000003', 0)$q$, 'the owner lifts it');
SELECT lives_ok($q$SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005',
                   '33333333-0000-0000-0000-000000000003', 60)$q$, 'and times out anyone below them');
SELECT lives_ok($q$SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005',
                   '33333333-0000-0000-0000-000000000003', 0)$q$, 'and lifts it again');

SELECT tests.clear_authentication();
DELETE FROM public.user_roles WHERE role_id = 'f1511000-0000-0000-0000-000000000004';
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('33333333-0000-0000-0000-000000000003', 'f1511000-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_server_member_timeout('55555555-0000-0000-0000-000000000005',
                    '33333333-0000-0000-0000-000000000003', 60)$q$,
                 '42501', 'Cannot time out a member with an equal or higher role', 'nor an equally ranked member');
SELECT tests.clear_authentication();
DELETE FROM public.user_roles WHERE role_id = 'f1511000-0000-0000-0000-000000000005';

-- ADD_REACTIONS. --------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT pg_temp.react('f1512000-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-000000000003', '🎉')$q$,
                 '42501', 'Missing permission: ADD_REACTIONS', 'a member denied ADD_REACTIONS cannot add a reaction');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.react('f1512000-0000-0000-0000-0000000000d1', '11111111-0000-0000-0000-000000000001', '👍'), 1,
          'the owner reacts there');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.react('f1512000-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-000000000003', '👍'), 1,
          'the member joins an existing reaction');
SELECT is(pg_temp.react('f1512000-0000-0000-0000-0000000000a2', '33333333-0000-0000-0000-000000000003', '🎉'), 1,
          'and reacts freely in another channel');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.react('99999999-0000-0000-0000-000000000009', '22222222-0000-0000-0000-000000000002', '🎉'), 1,
          'a conversation is exempt');

-- ATTACH_FILES. ---------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1510000-0000-0000-0000-0000000000d1',
                    pg_temp.attachment('f1510000-0000-0000-0000-0000000000d1', 'cccccccc-0000-0000-0000-000000000003'))$q$,
                 '42501', 'Missing permission: ATTACH_FILES', 'a member denied ATTACH_FILES cannot upload');
SELECT throws_ok($q$SELECT pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1510000-0000-0000-0000-0000000000d1',
                    '[{"type":"text","text":"sealed"}]',
                    ARRAY['c/f1510000-0000-0000-0000-0000000000d1/cccccccc-0000-0000-0000-000000000003/sealed.bin'])$q$,
                 '42501', 'Missing permission: ATTACH_FILES', 'nor name an upload through media_paths');
SELECT is(pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1510000-0000-0000-0000-0000000000d1',
                       '[{"type":"text","text":"just words"}]'), 1, 'text still posts');
SELECT is(pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1510000-0000-0000-0000-0000000000d1',
                       '[{"type":"file","url":"https://media.tenor.com/x.gif","fileType":"image"}]'), 1,
          'a linked GIF is not an upload');
SELECT throws_ok($q$UPDATE public.messages
                       SET content = content || pg_temp.attachment('f1510000-0000-0000-0000-0000000000d1', 'cccccccc-0000-0000-0000-000000000003')
                     WHERE id = 'f1512000-0000-0000-0000-0000000000d2'$q$,
                 '42501', 'Missing permission: ATTACH_FILES', 'an edit cannot add an upload');
SELECT lives_ok($q$UPDATE public.messages
                      SET content = jsonb_set(content, '{0,text}', '"reworded"')
                    WHERE id = 'f1512000-0000-0000-0000-0000000000d2'$q$,
                'an edit keeping the existing upload passes');
SELECT is(pg_temp.post('33333333-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006',
                       pg_temp.attachment('66666666-0000-0000-0000-000000000006', 'cccccccc-0000-0000-0000-000000000003')), 1,
          'the member uploads in another channel');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.post('11111111-0000-0000-0000-000000000001', 'f1510000-0000-0000-0000-0000000000d1',
                       pg_temp.attachment('f1510000-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001')), 1,
          'the owner uploads in the locked channel');

-- A role Allow outranks the @everyone Deny. -----------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions)
VALUES ('f1510000-0000-0000-0000-0000000000d1', 'role', 'f1511000-0000-0000-0000-000000000001', 262144 | 131072);
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.react('f1512000-0000-0000-0000-0000000000d1', '33333333-0000-0000-0000-000000000003', '🎉'), 1,
          'a role Allow restores ADD_REACTIONS');
SELECT is(pg_temp.post('33333333-0000-0000-0000-000000000003', 'f1510000-0000-0000-0000-0000000000d1',
                       pg_temp.attachment('f1510000-0000-0000-0000-0000000000d1', 'cccccccc-0000-0000-0000-000000000003')), 1,
          'and ATTACH_FILES');

SELECT tests.clear_authentication();
SELECT * FROM finish();
ROLLBACK;
