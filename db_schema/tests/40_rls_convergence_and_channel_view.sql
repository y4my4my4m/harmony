-- 20261001200001_converge_rls_policies.sql and 20261001200002_enforce_channel_view_permission.sql.
--
-- Fixture roles: alice owns server_1 and is instance admin; bob is an accepted member with
-- @everyone only; mallory belongs to nothing; banned has status 'banned' on server_1.
--
-- Local roles, all on server_1:
--   pending  status 'pending'
--   carol    role Mods: MANAGE_CHANNELS server-wide, VIEW_CHANNEL and SEND_MESSAGES on #mods
--   eve      role Admins: ADMINISTRATOR
--   frank    member override on #mods allowing VIEW_CHANNEL and SEND_MESSAGES
--   gina     role Mods, member override on #mods denying VIEW_CHANNEL
--
-- Channels on server_1: #general (fixture, open); #mods, @everyone denied VIEW_CHANNEL;
-- #news, @everyone denied SEND_MESSAGES.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(68);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT ('f4000000-0000-0000-0000-0000000000' || k)::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'rls40-' || k || '@test.local'
  FROM unnest(ARRAY['a1','a2','a3','a4','a5']) k;

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
SELECT ('f4010000-0000-0000-0000-0000000000' || k)::uuid,
       ('f4000000-0000-0000-0000-0000000000' || k)::uuid, n, n, true
  FROM (VALUES ('a1', 'pending40'), ('a2', 'carol40'), ('a3', 'eve40'), ('a4', 'frank40'),
               ('a5', 'gina40')) v(k, n);

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f4010000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'pending'),
  ('f4010000-0000-0000-0000-0000000000a2', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f4010000-0000-0000-0000-0000000000a3', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f4010000-0000-0000-0000-0000000000a4', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f4010000-0000-0000-0000-0000000000a5', '55555555-0000-0000-0000-000000000005', 'accepted');

-- Bits: 0 ADMINISTRATOR, 1 VIEW_CHANNEL, 2 MANAGE_CHANNELS, 12 SEND_MESSAGES.
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f4050000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'Mods40', 10, 4),
  ('f4050000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'Admins40', 20, 1);

INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f4010000-0000-0000-0000-0000000000a2', 'f4050000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('f4010000-0000-0000-0000-0000000000a5', 'f4050000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('f4010000-0000-0000-0000-0000000000a3', 'f4050000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f4020000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'mods', 0),
  ('f4020000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'news', 0);

INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f4020000-0000-0000-0000-000000000001', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions) VALUES
  ('f4020000-0000-0000-0000-000000000001', 'role', 'f4050000-0000-0000-0000-000000000001', NULL, 4098, 0),
  ('f4020000-0000-0000-0000-000000000001', 'user', NULL, 'f4010000-0000-0000-0000-0000000000a4', 4098, 0),
  ('f4020000-0000-0000-0000-000000000001', 'user', NULL, 'f4010000-0000-0000-0000-0000000000a5', 0, 2);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f4020000-0000-0000-0000-000000000002', 'role', r.id, NULL, 0, 4096
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f4030000-0000-0000-0000-000000000001', 'f4020000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"mods secret"}]'),
  ('f4030000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"general news"}]'),
  ('f4030000-0000-0000-0000-000000000004', 'f4020000-0000-0000-0000-000000000002',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"announcement"}]'),
  ('f4030000-0000-0000-0000-000000000005', 'f4020000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"mods, no thread yet"}]');

INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by) VALUES
  ('f4040000-0000-0000-0000-000000000001', 'f4020000-0000-0000-0000-000000000001',
   'f4030000-0000-0000-0000-000000000001', 'mods thread', '11111111-0000-0000-0000-000000000001'),
  ('f4040000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006',
   'f4030000-0000-0000-0000-000000000002', 'general thread', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.thread_members (thread_id, user_id) VALUES
  ('f4040000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001');

INSERT INTO public.reactions (message_id, user_id, custom_emoji_content) VALUES
  ('f4030000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'x');

-- LEGACY POLICIES ------------------------------------------------------------------------
SELECT is_empty(
    $q$SELECT 1 FROM pg_policies WHERE (tablename, policyname) IN (
         ('messages', 'Users can view messages in conversations they participate in'),
         ('messages', 'Users can create messages in conversations they participate in'),
         ('message_search_index', 'Users can search messages they have access to'),
         ('reactions', 'Users can update their own reactions'),
         ('objects', 'Application controlled group icon uploads'),
         ('server_encryption_settings', 'Everyone can view server encryption settings'))$q$,
    'no production-only policy name survives on a converged install');

SELECT policies_are('public', 'messages', ARRAY[
    'messages_delete_authorized', 'messages_insert_member',
    'messages_select_channel_member', 'messages_update_authorized'],
    'messages carries exactly the canonical policies');

-- MEMBERSHIP STATUS ----------------------------------------------------------------------
SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a1');
SELECT is_empty($q$SELECT 1 FROM public.messages WHERE channel_id = '66666666-0000-0000-0000-000000000006'$q$,
    'a pending member reads no channel message');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', 'f4010000-0000-0000-0000-0000000000a1', '[{"type":"text","text":"t"}]')$q$,
    '42501'::char(5), NULL, 'a pending member cannot post');
SELECT is(public.can_subscribe_to_topic('channel-messages-66666666-0000-0000-0000-000000000006'), false,
    'a pending member cannot subscribe to a channel');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is_empty($q$SELECT 1 FROM public.messages WHERE channel_id IS NOT NULL$q$,
    'a banned member reads no channel message');
SELECT is_empty($q$SELECT 1 FROM public.message_search_index WHERE channel_id IS NOT NULL$q$,
    'a banned member searches no channel message');

-- DM BLOCK -------------------------------------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content)
       VALUES ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"t"}]')$q$,
    '42501'::char(5), NULL, 'a blocked user cannot post into the DM');

SELECT tests.clear_authentication();
DELETE FROM public.user_blocks WHERE blocker_id = '22222222-0000-0000-0000-000000000002';

-- MESSAGES -------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is_empty($q$SELECT 1 FROM public.messages WHERE channel_id = 'f4020000-0000-0000-0000-000000000001'$q$,
    'a plain member reads nothing in a channel @everyone cannot view');
SELECT isnt_empty($q$SELECT 1 FROM public.messages WHERE channel_id = '66666666-0000-0000-0000-000000000006'$q$,
    'a plain member reads an open channel');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('f4020000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"t"}]')$q$,
    '42501'::char(5), NULL, 'a plain member cannot post into a hidden channel');
SELECT isnt_empty($q$SELECT 1 FROM public.messages WHERE channel_id = 'f4020000-0000-0000-0000-000000000002'$q$,
    'a plain member reads a channel that denies only SEND_MESSAGES');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('f4020000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"t"}]')$q$,
    '42501'::char(5), NULL, 'a plain member cannot post without SEND_MESSAGES');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"t"}]')$q$,
    'a plain member posts into an open channel');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, thread_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', 'f4040000-0000-0000-0000-000000000002',
               '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"t"}]')$q$,
    'a plain member replies in a thread of an open channel');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, thread_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', 'f4040000-0000-0000-0000-000000000001',
               '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"t"}]')$q$,
    '42501'::char(5), NULL, 'a reply naming another channel than its thread''s is refused');

SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a2');
SELECT isnt_empty($q$SELECT 1 FROM public.messages WHERE channel_id = 'f4020000-0000-0000-0000-000000000001'$q$,
    'a role allowed VIEW_CHANNEL on the channel reads it');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('f4020000-0000-0000-0000-000000000001', 'f4010000-0000-0000-0000-0000000000a2', '[{"type":"text","text":"t"}]')$q$,
    'a role allowed SEND_MESSAGES on the channel posts into it');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty($q$SELECT 1 FROM public.messages WHERE channel_id = 'f4020000-0000-0000-0000-000000000001'$q$,
    'the server owner reads a hidden channel');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('f4020000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"t"}]')$q$,
    'the server owner posts where @everyone is denied SEND_MESSAGES');

SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a3');
SELECT isnt_empty($q$SELECT 1 FROM public.messages WHERE channel_id = 'f4020000-0000-0000-0000-000000000001'$q$,
    'ADMINISTRATOR reads a hidden channel');

SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a4');
SELECT isnt_empty($q$SELECT 1 FROM public.messages WHERE channel_id = 'f4020000-0000-0000-0000-000000000001'$q$,
    'a member override allowing VIEW_CHANNEL reads a hidden channel');

SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a5');
SELECT is_empty($q$SELECT 1 FROM public.messages WHERE channel_id = 'f4020000-0000-0000-0000-000000000001'$q$,
    'a member override denying VIEW_CHANNEL beats a role allow');

-- CHANNELS -------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_eq(
    $q$SELECT id FROM public.channels
        WHERE id IN ('66666666-0000-0000-0000-000000000006', 'f4020000-0000-0000-0000-000000000001',
                     'f4020000-0000-0000-0000-000000000002')$q$,
    $q$VALUES ('66666666-0000-0000-0000-000000000006'::uuid), ('f4020000-0000-0000-0000-000000000002'::uuid)$q$,
    'a plain member lists no hidden channel');

SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a2');
SELECT isnt_empty($q$SELECT 1 FROM public.channels WHERE id = 'f4020000-0000-0000-0000-000000000001'$q$,
    'a role allowed VIEW_CHANNEL lists the channel');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM public.channels
             WHERE id IN ('66666666-0000-0000-0000-000000000006', 'f4020000-0000-0000-0000-000000000001',
                          'f4020000-0000-0000-0000-000000000002')), 3,
    'the server owner lists every channel');
SELECT lives_ok(
    $q$INSERT INTO public.channels (id, server_id, name, type)
       VALUES ('f4020000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'fresh', 0)
       RETURNING id$q$,
    'the owner inserts a channel with RETURNING');

-- THREADS, THREAD_MEMBERS ----------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT is_empty($q$SELECT 1 FROM public.threads$q$, 'anon reads no thread');
SELECT is_empty($q$SELECT 1 FROM public.thread_members$q$, 'anon reads no thread member');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_eq($q$SELECT id FROM public.threads$q$,
    $q$VALUES ('f4040000-0000-0000-0000-000000000002'::uuid)$q$,
    'a plain member reads threads of visible channels only');
SELECT is_empty($q$SELECT 1 FROM public.thread_members WHERE thread_id = 'f4040000-0000-0000-0000-000000000001'$q$,
    'a plain member reads no member of a hidden thread');
SELECT throws_ok(
    $q$SELECT public.create_thread('f4030000-0000-0000-0000-000000000001', 'probe')$q$,
    'P0001'::char(5), 'Message not found or not in a channel',
    'create_thread treats a hidden message as absent');
SELECT is_empty(
    $q$UPDATE public.threads SET locked = true WHERE id = 'f4040000-0000-0000-0000-000000000002' RETURNING id$q$,
    'a plain member cannot moderate another member''s thread');

SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a2');
SELECT isnt_empty($q$SELECT 1 FROM public.thread_members WHERE thread_id = 'f4040000-0000-0000-0000-000000000001'$q$,
    'a role allowed VIEW_CHANNEL reads the hidden thread''s members');
SELECT isnt_empty(
    $q$UPDATE public.threads SET locked = true WHERE id = 'f4040000-0000-0000-0000-000000000001' RETURNING id$q$,
    'MANAGE_CHANNELS locks another member''s thread');
SELECT throws_ok($q$SELECT public.create_thread('f4030000-0000-0000-0000-000000000001', 'mods followup')$q$,
    'P0001', 'Thread already exists for this message',
    'create_thread refuses a second thread on a message');
SELECT lives_ok($q$SELECT public.create_thread('f4030000-0000-0000-0000-000000000005', 'mods followup')$q$,
    'create_thread succeeds with VIEW_CHANNEL and CREATE_PUBLIC_THREADS');

-- REACTIONS ------------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT is_empty($q$SELECT 1 FROM public.reactions$q$, 'anon reads no reaction');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is_empty($q$SELECT 1 FROM public.reactions WHERE message_id = 'f4030000-0000-0000-0000-000000000001'$q$,
    'a plain member reads no reaction on a hidden message');
SELECT is_empty($q$SELECT 1 FROM public.get_batch_message_reactions(ARRAY['f4030000-0000-0000-0000-000000000001'::uuid])$q$,
    'get_batch_message_reactions returns nothing for a hidden message');
SELECT throws_ok(
    $q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
       VALUES ('f4030000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'y')$q$,
    '42501'::char(5), NULL, 'a plain member cannot react to a hidden message');

SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a2');
SELECT isnt_empty($q$SELECT 1 FROM public.reactions WHERE message_id = 'f4030000-0000-0000-0000-000000000001'$q$,
    'a role allowed VIEW_CHANNEL reads reactions on the hidden message');

-- SEARCH ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is_empty($q$SELECT 1 FROM public.search_messages('mods secret')$q$,
    'search_messages returns nothing from a hidden channel');
SELECT is_empty($q$SELECT 1 FROM public.message_search_index WHERE channel_id = 'f4020000-0000-0000-0000-000000000001'$q$,
    'message_search_index hides a hidden channel''s rows');

SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a2');
SELECT isnt_empty($q$SELECT 1 FROM public.search_messages('mods secret')$q$,
    'search_messages finds the hidden channel for a role allowed VIEW_CHANNEL');

-- REALTIME -------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.can_subscribe_to_topic('channel-messages-f4020000-0000-0000-0000-000000000001'), false,
    'a plain member cannot subscribe to a hidden channel');
SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a2');
SELECT is(public.can_subscribe_to_topic('channel-messages-f4020000-0000-0000-0000-000000000001'), true,
    'a role allowed VIEW_CHANNEL subscribes to the channel');
SELECT tests.authenticate_as('f4000000-0000-0000-0000-0000000000a5');
SELECT is(public.can_subscribe_to_topic('channel-messages-f4020000-0000-0000-0000-000000000001'), false,
    'a member override denying VIEW_CHANNEL blocks the subscription');

SELECT tests.clear_authentication();
UPDATE public.channels SET name = 'mods-renamed' WHERE id = 'f4020000-0000-0000-0000-000000000001';
SELECT is(
    (SELECT (payload->>'restricted') || ',' || (payload->'new' ? 'name')::text
       FROM realtime.messages
      WHERE topic = 'server-structure:55555555-0000-0000-0000-000000000005'
        AND payload->>'type' = 'channel:update'
      ORDER BY inserted_at DESC, id DESC LIMIT 1),
    'true,false',
    'a hidden channel''s change reaches server-structure without its name');
UPDATE public.channels SET name = 'general-renamed' WHERE id = '66666666-0000-0000-0000-000000000006';
SELECT is(
    (SELECT payload->'new'->>'name'
       FROM realtime.messages
      WHERE topic = 'server-structure:55555555-0000-0000-0000-000000000005'
        AND payload->>'type' = 'channel:update'
        AND payload->'new'->>'id' = '66666666-0000-0000-0000-000000000006'),
    'general-renamed',
    'an open channel''s change carries the row');

-- NOTIFICATIONS, UNREAD ------------------------------------------------------------------
CREATE TEMP TABLE notif40 AS
SELECT unnest(public.send_notification('mention',
         ARRAY['22222222-0000-0000-0000-000000000002', 'f4010000-0000-0000-0000-0000000000a2']::uuid[],
         '{"preview":"mods secret"}'::jsonb, '55555555-0000-0000-0000-000000000005',
         'f4020000-0000-0000-0000-000000000001', NULL, '11111111-0000-0000-0000-000000000001')) AS id;
SELECT set_eq(
    $q$SELECT n.user_id FROM public.notifications n JOIN notif40 USING (id)$q$,
    $q$VALUES ('f4010000-0000-0000-0000-0000000000a2'::uuid)$q$,
    'a channel-scoped notification reaches only recipients who can view the channel');

INSERT INTO public.messages (id, channel_id, user_id, content)
SELECT 'f4030000-0000-0000-0000-000000000003', 'f4020000-0000-0000-0000-000000000001',
       '11111111-0000-0000-0000-000000000001',
       jsonb_build_array(jsonb_build_object('type', 'role_mention', 'roleId', r.id),
                         jsonb_build_object('type', 'text', 'text', 'everyone secret'))
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
SELECT is_empty(
    $q$SELECT 1 FROM public.notifications
        WHERE user_id = '22222222-0000-0000-0000-000000000002'
          AND data->>'message_id' = 'f4030000-0000-0000-0000-000000000003'$q$,
    'an @everyone mention in a hidden channel does not notify a plain member');
SELECT isnt_empty(
    $q$SELECT 1 FROM public.notifications
        WHERE user_id = 'f4010000-0000-0000-0000-0000000000a2'
          AND data->>'message_id' = 'f4030000-0000-0000-0000-000000000003'$q$,
    'an @everyone mention in a hidden channel notifies a member who can view it');

SELECT is_empty(
    $q$SELECT 1 FROM public.unread_counts
        WHERE user_id = '22222222-0000-0000-0000-000000000002'
          AND channel_id = 'f4020000-0000-0000-0000-000000000001'$q$,
    'a hidden channel''s messages leave no unread row for a plain member');
SELECT isnt_empty(
    $q$SELECT 1 FROM public.unread_counts
        WHERE user_id = 'f4010000-0000-0000-0000-0000000000a2'
          AND channel_id = 'f4020000-0000-0000-0000-000000000001'$q$,
    'a hidden channel''s messages count as unread for a member who can view it');
SELECT isnt_empty(
    $q$SELECT 1 FROM public.unread_counts
        WHERE user_id = '22222222-0000-0000-0000-000000000002'
          AND channel_id = '66666666-0000-0000-0000-000000000006'$q$,
    'an open channel''s messages count as unread for a plain member');

-- EQUIVALENCE WITH has_permission --------------------------------------------------------
CREATE TEMP TABLE vis40 (user_id uuid, channel_id uuid);

DO $$
DECLARE
    r record;
    v_ids uuid[];
BEGIN
    FOR r IN SELECT p.id, p.auth_user_id FROM public.profiles p WHERE p.auth_user_id IS NOT NULL LOOP
        PERFORM tests.authenticate_as(r.auth_user_id);
        SELECT array_agg(x) INTO v_ids FROM public.current_user_viewable_channel_ids() x;
        PERFORM tests.clear_authentication();
        INSERT INTO vis40 SELECT r.id, unnest(v_ids);
    END LOOP;
END;
$$;

CREATE TEMP VIEW expected40 AS
SELECT p.id AS user_id, c.id AS channel_id
  FROM public.profiles p
 CROSS JOIN public.channels c
  JOIN public.servers s ON s.id = c.server_id
 WHERE (s.owner = p.id
        OR EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = c.server_id AND us.user_id = p.id AND us.status = 'accepted'))
   AND public.has_permission(p.id, c.server_id, 'VIEW_CHANNEL', c.id);

SELECT set_eq(
    $q$SELECT user_id, channel_id FROM vis40$q$,
    $q$SELECT user_id, channel_id FROM expected40 e
        WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = e.user_id AND p.auth_user_id IS NOT NULL)$q$,
    'current_user_viewable_channel_ids agrees with has_permission for every fixture user');
SELECT set_eq(
    $q$SELECT v AS user_id, c.id AS channel_id FROM public.channels c, public.channel_viewer_ids(c.id) v$q$,
    $q$SELECT user_id, channel_id FROM expected40$q$,
    'channel_viewer_ids agrees with has_permission for every channel');
SELECT set_eq(
    $q$SELECT p.id AS user_id, c.id AS channel_id FROM public.profiles p, public.channels c
        WHERE public.can_view_channel(p.id, c.id)$q$,
    $q$SELECT user_id, channel_id FROM expected40$q$,
    'can_view_channel agrees with has_permission for every pair');
SELECT is(
    (SELECT string_agg(c.name || '=' || public.channel_is_restricted(c.id)::text, ',' ORDER BY c.name)
       FROM public.channels c
      WHERE c.id IN ('66666666-0000-0000-0000-000000000006', 'f4020000-0000-0000-0000-000000000001',
                     'f4020000-0000-0000-0000-000000000002', 'f4020000-0000-0000-0000-000000000003')),
    'fresh=false,general-renamed=false,mods-renamed=true,news=false',
    'channel_is_restricted flags only the channel @everyone cannot view');

SELECT tests.authenticate_as_anon();
SELECT is_empty($q$SELECT public.current_user_viewable_channel_ids()$q$,
    'anon views no channel');
SELECT throws_ok($q$SELECT public.can_view_channel('22222222-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006')$q$,
    '42501'::char(5), NULL, 'can_view_channel is not callable by clients');

-- STORAGE, FOLLOWS -----------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('group-icons', '77777777-0000-0000-0000-000000000007/anon.png')$q$,
    '42501'::char(5), NULL, 'anon cannot upload a group icon');

-- Storage policies read auth.role(), which tests.authenticate_as leaves unset.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('group-icons', '77777777-0000-0000-0000-000000000007/mallory.png')$q$,
    '42501'::char(5), NULL, 'a non-participant cannot upload a group icon');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('group-icons', '77777777-0000-0000-0000-000000000007/alice.png')$q$,
    'a participant uploads a group icon');

SELECT tests.clear_authentication();
INSERT INTO storage.objects (bucket_id, name)
VALUES ('user_media', '22222222-0000-0000-0000-000000000002/reported.png');
INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'accepted');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'user_media'
        AND name = '22222222-0000-0000-0000-000000000002/reported.png' RETURNING id$q$,
    'a non-admin cannot delete another user''s file');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'user_media'
        AND name = '22222222-0000-0000-0000-000000000002/reported.png' RETURNING id$q$,
    'an instance admin deletes a reported file');
SELECT isnt_empty(
    $q$DELETE FROM public.follows WHERE follower_id = '22222222-0000-0000-0000-000000000002'
        AND following_id = '11111111-0000-0000-0000-000000000001' RETURNING id$q$,
    'the followed user removes a follower');

SELECT * FROM finish();
ROLLBACK;
