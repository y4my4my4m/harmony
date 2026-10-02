-- Client writes, notices, deleted recipients, moderate_user and memberships after
-- 20261005600001_message_path_security.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Added here:
--   carol   member of the group conversations, moderator flag for moderate_user
--   dave    participant of a DM and a group with alice; tombstoned midway
--   erin    auth user without a profile, for signup cases
--   frank   suspended instance admin
--   conv_dave   direct, alice + dave
--   conv_group  group, alice + carol + dave
--   conv_new    group created by alice: alice, bob (joined an hour ago), carol

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(86);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f5700000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol@test.local'),
  ('f5700000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave@test.local'),
  ('f5700000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin@test.local'),
  ('f5700000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'frank@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain) VALUES
  ('f5700000-0000-0000-0000-0000000000c1', 'f5700000-0000-0000-0000-0000000000a1', 'carol', 'Carol', true, 'localhost'),
  ('f5700000-0000-0000-0000-0000000000c2', 'f5700000-0000-0000-0000-0000000000a2', 'dave', 'Dave', true, 'localhost'),
  ('f5700000-0000-0000-0000-0000000000c4', 'f5700000-0000-0000-0000-0000000000a4', 'frank', 'Frank', true, 'localhost');

-- Signup checks compare against instance_config 'domain'; a schema-only clone has no row.
DELETE FROM public.instance_config WHERE config_key = 'domain';
INSERT INTO public.instance_config (config_key, config_value) VALUES ('domain', '"localhost"');

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
UPDATE public.profiles SET is_moderator = true WHERE id = 'f5700000-0000-0000-0000-0000000000c1';
UPDATE public.profiles SET is_admin = true, is_suspended = true WHERE id = 'f5700000-0000-0000-0000-0000000000c4';

INSERT INTO public.conversations (id, type, created_by) VALUES
  ('f5710000-0000-0000-0000-000000000001', 'direct', '11111111-0000-0000-0000-000000000001'),
  ('f5710000-0000-0000-0000-000000000002', 'group',  '11111111-0000-0000-0000-000000000001'),
  ('f5710000-0000-0000-0000-000000000003', 'group',  '11111111-0000-0000-0000-000000000001');
INSERT INTO public.conversation_participants (conversation_id, user_id, joined_at) VALUES
  ('f5710000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', now()),
  ('f5710000-0000-0000-0000-000000000001', 'f5700000-0000-0000-0000-0000000000c2', now()),
  ('f5710000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', now()),
  ('f5710000-0000-0000-0000-000000000002', 'f5700000-0000-0000-0000-0000000000c1', now()),
  ('f5710000-0000-0000-0000-000000000002', 'f5700000-0000-0000-0000-0000000000c2', now()),
  ('f5710000-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', now()),
  ('f5710000-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', now() - interval '1 hour'),
  ('f5710000-0000-0000-0000-000000000003', 'f5700000-0000-0000-0000-0000000000c1', now());

INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f5720000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob says hi"}]');

CREATE FUNCTION pg_temp.post_system_invoker() RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
  VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
          '[{"type":"text","text":"was banned from the server"}]', true, '{"type":"member_ban"}');
$fn$;
CREATE FUNCTION pg_temp.post_system_definer() RETURNS void LANGUAGE sql SECURITY DEFINER AS $fn$
  INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
  VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
          '[{"type":"text","text":"has joined the server"}]', true, '{"type":"member_join"}');
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.post_system_invoker() TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.post_system_definer() TO authenticated;

-- Messages: client inserts ------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"was banned from the server"}]', true,
               '{"type":"member_ban","banned_by":"22222222-0000-0000-0000-000000000002"}')$q$,
    '42501', NULL, 'a client cannot post a ban notice');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, is_system)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"Encryption was turned off by an administrator"}]', true)$q$,
    '42501', NULL, 'a client cannot post an authorless-looking notice');
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content, is_system, metadata)
       VALUES ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"Bob was added to the conversation"}]', true, '{"type":"group_created"}')$q$,
    '42501', NULL, 'a client cannot post a DM notice');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"started a thread"}]', true,
               '{"type":"thread_created","thread_id":"t","thread_name":"n"}')$q$,
    '42501', NULL, 'a client cannot post the thread notice directly');
SELECT throws_ok(
    $q$SELECT pg_temp.post_system_invoker()$q$,
    '42501', NULL, 'a SECURITY INVOKER function called by a client is a client write');
SELECT lives_ok(
    $q$SELECT pg_temp.post_system_definer()$q$,
    'a SECURITY DEFINER function owned by postgres still posts a notice');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, bot_id, content)
       SELECT '66666666-0000-0000-0000-000000000006', NULL, gen_random_uuid(), '[{"type":"text","text":"beep"}]'$q$,
    '42501', NULL, 'a client cannot set bot_id');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"hi"}]',
               '{"federated":true,"ap_id":"https://remote.test/messages/1","from_domain":"remote.test"}')$q$,
    '42501', NULL, 'a client cannot claim a federated origin or squat an ap_id');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"https://evil.test"}]',
               '{"embeds":{"https://evil.test":{"title":"PayPal"}}}')$q$,
    '42501', NULL, 'a client cannot supply link previews');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"hi"}]', '{"type":"call_started"}')$q$,
    '42501', NULL, 'a client cannot set a metadata type');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, is_pinned)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"hi"}]', true)$q$,
    '42501', NULL, 'a client cannot insert a pinned message');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, federation_status)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"hi"}]', 'completed')$q$,
    '42501', NULL, 'a client cannot set federation_status');
SELECT lives_ok(
    $q$INSERT INTO public.messages (id, channel_id, user_id, content, created_at, metadata)
       VALUES ('f5720000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006',
               '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"from the past"}]',
               '2001-01-01', '{"created_via":"harmony_client","client_nonce":"n1","voice_message":{"duration":3}}')$q$,
    'a client message with client metadata keys is accepted');
SELECT ok((SELECT created_at > now() - interval '1 minute' AND updated_at = created_at
             FROM public.messages WHERE id = 'f5720000-0000-0000-0000-000000000002'),
          'a client-supplied created_at is replaced by now()');

-- Messages: client updates ------------------------------------------------------------
SELECT throws_ok(
    $q$UPDATE public.messages SET is_system = true WHERE id = 'f5720000-0000-0000-0000-000000000002'$q$,
    '42501', NULL, 'an author cannot turn a message into a system notice');
SELECT throws_ok(
    $q$UPDATE public.messages SET created_at = '2001-01-01' WHERE id = 'f5720000-0000-0000-0000-000000000002'$q$,
    '42501', NULL, 'an author cannot backdate a message');
SELECT throws_ok(
    $q$UPDATE public.messages SET conversation_id = '77777777-0000-0000-0000-000000000007', channel_id = NULL
        WHERE id = 'f5720000-0000-0000-0000-000000000002'$q$,
    '42501', NULL, 'an author cannot move a message');
SELECT throws_ok(
    $q$UPDATE public.messages SET metadata = metadata || '{"ap_id":"https://remote.test/messages/2"}'
        WHERE id = 'f5720000-0000-0000-0000-000000000002'$q$,
    '42501', NULL, 'an author cannot add a reserved metadata key');
SELECT throws_ok(
    $q$UPDATE public.messages SET is_pinned = true WHERE id = 'f5720000-0000-0000-0000-000000000002'$q$,
    '42501', NULL, 'an author cannot pin by update');

SELECT lives_ok(
    $q$UPDATE public.messages SET metadata = metadata || '{"client_nonce":"n2"}', updated_at = '2099-01-01'
        WHERE id = 'f5720000-0000-0000-0000-000000000002'$q$,
    'an author updates client metadata');
SELECT ok((SELECT updated_at = created_at FROM public.messages WHERE id = 'f5720000-0000-0000-0000-000000000002'),
          'updated_at does not move without a content change');
SELECT lives_ok(
    $q$UPDATE public.messages SET content = '[{"type":"text","text":"edited"}]'
        WHERE id = 'f5720000-0000-0000-0000-000000000002'$q$,
    'an author edits content');

-- alice owns server_1 and passes the moderator branch of messages_update_authorized.
SELECT throws_ok(
    $q$UPDATE public.messages SET content = '[{"type":"text","text":"bob says something else"}]'
        WHERE id = 'f5720000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'a moderator cannot rewrite another member''s message');
SELECT throws_ok(
    $q$UPDATE public.messages SET metadata = '{"client_nonce":"x"}', is_deleted = true
        WHERE id = 'f5720000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'a moderator deletion leaves metadata alone');
SELECT lives_ok(
    $q$UPDATE public.messages SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true
        WHERE id = 'f5720000-0000-0000-0000-000000000001'$q$,
    'a moderator soft-deletes another member''s message');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$UPDATE public.messages SET is_deleted = false, content = '[{"type":"text","text":"bob says hi"}]'
        WHERE id = 'f5720000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'an author cannot restore a message a moderator deleted');
SELECT throws_ok(
    $q$UPDATE public.messages SET content = '[{"type":"text","text":"still here"}]'
        WHERE id = 'f5720000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'an author cannot edit a deleted message');

-- Thread notice -----------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('tests.thread_id',
    public.create_thread('88888888-0000-0000-0000-000000000008', 'Plans')::text, true);
SELECT set_config('tests.thread_notice',
    public.post_thread_created_notice(current_setting('tests.thread_id')::uuid)::text, true);
SELECT results_eq(
    format($q$SELECT is_system, user_id, content, metadata->>'type', metadata->>'thread_name'
                FROM public.messages WHERE id = %L$q$, current_setting('tests.thread_notice')),
    $q$VALUES (true, '11111111-0000-0000-0000-000000000001'::uuid,
               '[{"type":"text","text":"started a thread"}]'::jsonb, 'thread_created'::text, 'Plans'::text)$q$,
    'the thread creator posts the thread notice with server-built content');
SELECT is(public.post_thread_created_notice(current_setting('tests.thread_id')::uuid)::text,
          current_setting('tests.thread_notice'), 'the thread notice is posted once');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    format('SELECT public.post_thread_created_notice(%L)', current_setting('tests.thread_id')),
    'P0002', NULL, 'only the thread creator posts its notice');

-- Group notices -----------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('tests.group_notice',
    public.post_group_conversation_notice('f5710000-0000-0000-0000-000000000003')::text, true);
SELECT results_eq(
    format($q$SELECT is_system, content, metadata->>'type', metadata->>'event'
                FROM public.messages WHERE id = %L$q$, current_setting('tests.group_notice')),
    $q$VALUES (true, '[{"type":"text","text":"Group conversation created with 3 participants"}]'::jsonb,
               'group_created'::text, 'created'::text)$q$,
    'the creator announces the group with a server-counted size');
SELECT is(public.post_group_conversation_notice('f5710000-0000-0000-0000-000000000003')::text,
          current_setting('tests.group_notice'), 'the creation notice is posted once');
SELECT set_config('tests.added_notice',
    public.post_group_conversation_notice('f5710000-0000-0000-0000-000000000003',
        ARRAY['f5700000-0000-0000-0000-0000000000c1'::uuid, '33333333-0000-0000-0000-000000000003'::uuid])::text, true);
SELECT is((SELECT content->0->>'text' FROM public.messages WHERE id = current_setting('tests.added_notice')::uuid),
          'Carol was added to the conversation',
          'the added notice names only recently joined participants');
SELECT throws_ok(
    $q$SELECT public.post_group_conversation_notice('f5710000-0000-0000-0000-000000000003',
                ARRAY['22222222-0000-0000-0000-000000000002'::uuid])$q$,
    'P0002', NULL, 'a participant who joined long ago is not announced as added');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.post_group_conversation_notice('f5710000-0000-0000-0000-000000000003')$q$,
    '42501', NULL, 'only the creator announces the group');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.post_group_conversation_notice('f5710000-0000-0000-0000-000000000003',
                ARRAY['f5700000-0000-0000-0000-0000000000c1'::uuid])$q$,
    'P0002', NULL, 'a non-participant posts no group notice');

-- Call notice -------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('tests.call_msg',
    public.start_dm_call_message('77777777-0000-0000-0000-000000000007', 'video')::text, true);
SELECT results_eq(
    format($q$SELECT is_system, content, metadata->>'type', metadata->>'call_type', metadata->'participants'
                FROM public.messages WHERE id = %L$q$, current_setting('tests.call_msg')),
    $q$VALUES (true, '[{"type":"text","text":"started a call"}]'::jsonb, 'call_started'::text, 'video'::text,
               '["11111111-0000-0000-0000-000000000001"]'::jsonb)$q$,
    'a participant starts a call notice');
SELECT throws_ok(
    $q$SELECT public.start_dm_call_message('77777777-0000-0000-0000-000000000007', 'screenshare')$q$,
    '22023', NULL, 'the call type is voice or video');
SELECT throws_ok(
    format($q$UPDATE public.messages SET metadata = '{"type":"call_ended","duration_seconds":99999}'
               WHERE id = %L$q$, current_setting('tests.call_msg')),
    '42501', NULL, 'a client cannot rewrite a call notice directly');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    format($q$SELECT public.finalize_dm_call_message(%L, now(), 42,
               ARRAY['11111111-0000-0000-0000-000000000001'::uuid, '22222222-0000-0000-0000-000000000002'::uuid])$q$,
           current_setting('tests.call_msg')),
    'finalize_dm_call_message still ends the call');
SELECT is((SELECT metadata->>'type' FROM public.messages WHERE id = current_setting('tests.call_msg')::uuid),
          'call_ended', 'the finalized notice reads call_ended');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.start_dm_call_message('77777777-0000-0000-0000-000000000007', 'voice')$q$,
    'P0002', NULL, 'a non-participant starts no call notice');

SELECT ok(NOT has_function_privilege('anon', 'public.start_dm_call_message(uuid,text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.post_thread_created_notice(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.post_group_conversation_notice(uuid,uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.moderate_user(uuid,uuid,text,text)', 'EXECUTE'),
          'anon cannot call the notice RPCs or moderate_user');

-- Definer notices are unaffected ------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$SELECT public.ban_server_member('55555555-0000-0000-0000-000000000005',
                                       '22222222-0000-0000-0000-000000000002', 'spam')$q$,
    'ban_server_member runs');
SELECT ok(EXISTS (SELECT 1 FROM public.messages
                   WHERE user_id = '22222222-0000-0000-0000-000000000002' AND is_system
                     AND metadata->>'type' = 'member_ban'),
          'ban_server_member still posts its notice');

-- Memberships -------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$INSERT INTO public.user_servers (server_id, user_id) VALUES
       ('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002')$q$,
    '42501', NULL, 'a banned user cannot rejoin by inserting a membership');
SELECT tests.clear_authentication();
SELECT throws_ok(
    $q$INSERT INTO public.user_servers (server_id, user_id, status) VALUES
       ('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', 'accepted')$q$,
    '42501', NULL, 'no writer restores a banned user''s membership');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok(
    $q$UPDATE public.user_servers SET status = 'accepted'
        WHERE user_id = '44444444-0000-0000-0000-000000000004'$q$,
    '42501', NULL, 'a member cannot lift their own banned status');
SELECT tests.clear_authentication();
INSERT INTO public.user_servers (server_id, user_id, status)
VALUES ('55555555-0000-0000-0000-000000000005', 'f5700000-0000-0000-0000-0000000000c1', 'pending');
SELECT tests.authenticate_as('f5700000-0000-0000-0000-0000000000a1');
SELECT throws_ok(
    $q$UPDATE public.user_servers SET status = 'accepted'
        WHERE user_id = 'f5700000-0000-0000-0000-0000000000c1'$q$,
    '42501', NULL, 'a pending member cannot accept themselves');
SELECT throws_ok(
    $q$UPDATE public.user_servers SET member_instance = 'evil.test'
        WHERE user_id = 'f5700000-0000-0000-0000-0000000000c1'$q$,
    '42501', NULL, 'a member cannot redirect relays by rewriting member_instance');
SELECT throws_ok(
    $q$UPDATE public.user_servers SET server_id = 'e3920000-0000-0000-0000-00000000ffff'
        WHERE user_id = 'f5700000-0000-0000-0000-0000000000c1'$q$,
    '42501', NULL, 'a member cannot move their membership to another server');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$UPDATE public.user_servers SET status = 'accepted'
        WHERE user_id = 'f5700000-0000-0000-0000-0000000000c1'
          AND server_id = '55555555-0000-0000-0000-000000000005'$q$,
    'the server owner accepts a pending member');
SELECT is((SELECT status FROM public.user_servers
            WHERE user_id = 'f5700000-0000-0000-0000-0000000000c1'
              AND server_id = '55555555-0000-0000-0000-000000000005'),
          'accepted', 'the owner''s acceptance is stored');

-- Deleted DM recipient ----------------------------------------------------------------
SELECT lives_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content)
       VALUES ('f5710000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"hello dave"}]')$q$,
    'a DM to a live account is accepted');
SELECT tests.clear_authentication();
UPDATE public.profiles SET auth_user_id = NULL, username = 'deleted_f570c2', display_name = 'Deleted User'
 WHERE id = 'f5700000-0000-0000-0000-0000000000c2';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content)
       VALUES ('f5710000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"are you there?"}]')$q$,
    'P0001', 'RECIPIENT_DELETED: the other participant deleted their account',
    'a DM whose only other participant is deleted is refused');
SELECT throws_ok(
    $q$SELECT public.start_dm_call_message('f5710000-0000-0000-0000-000000000001', 'voice')$q$,
    'P0001', NULL, 'a call to a deleted account is refused');
SELECT lives_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content)
       VALUES ('f5710000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"hi carol"}]')$q$,
    'a group with a live participant left still accepts messages');
SELECT tests.clear_authentication();
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content)
       VALUES ('f5710000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"from the server"}]')$q$,
    'P0001', NULL, 'the refusal applies to every writer');

-- moderate_user -----------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.moderate_user('aaaaaaaa-0000-0000-0000-000000000001',
                                   'f5700000-0000-0000-0000-0000000000c1', 'suspend', 'x')$q$,
    '42501', NULL, 'moderate_user refuses an admin id that is not the caller');
SELECT throws_ok(
    $q$SELECT public.moderate_user(NULL, 'f5700000-0000-0000-0000-0000000000c1', 'suspend', 'x')$q$,
    '42501', NULL, 'moderate_user refuses a caller who is neither admin nor moderator');
SELECT tests.authenticate_as('f5700000-0000-0000-0000-0000000000a4');
SELECT throws_ok(
    $q$SELECT public.moderate_user(NULL, 'f5700000-0000-0000-0000-0000000000c1', 'silence', 'x')$q$,
    '42501', NULL, 'moderate_user refuses a suspended admin');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(public.moderate_user('aaaaaaaa-0000-0000-0000-000000000001',
                               '33333333-0000-0000-0000-000000000003', 'silence', 'spam'),
          'an admin passing their own auth uid moderates');
SELECT ok(EXISTS (SELECT 1 FROM public.admin_audit_log
                   WHERE admin_id = '11111111-0000-0000-0000-000000000001'
                     AND action_type = 'user_silence'
                     AND target_id = '33333333-0000-0000-0000-000000000003'),
          'the audit entry names the session''s profile');
SELECT tests.authenticate_as('f5700000-0000-0000-0000-0000000000a1');
SELECT ok(public.moderate_user(NULL, '33333333-0000-0000-0000-000000000003', 'unsilence'),
          'a moderator passes moderate_user''s own check');

-- Posts -------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content, visibility, is_local)
       VALUES ('11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"x"}]', 'public', false)$q$,
    '42501', NULL, 'a client cannot insert a remote post');
SELECT throws_ok(
    $q$INSERT INTO public.posts (author_id, content, visibility, ap_id)
       VALUES ('11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"x"}]', 'public',
               'https://mastodon.test/users/bob/statuses/1')$q$,
    '42501', NULL, 'a client cannot claim a remote post id');
SELECT lives_ok(
    $q$INSERT INTO public.posts (id, author_id, content, visibility, favorites_count, reblogs_count,
                                 replies_count, created_at, ap_id)
       VALUES ('f5730000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"hello"}]', 'public', 999, 999, 999, '2001-01-01',
               'https://localhost/activities/f5730000-0000-0000-0000-0000000000ff')$q$,
    'a client post with a boost-style id is accepted');
SELECT ok((SELECT favorites_count = 0 AND reblogs_count = 0 AND replies_count = 0
                  AND created_at > now() - interval '1 minute'
             FROM public.posts WHERE id = 'f5730000-0000-0000-0000-000000000001'),
          'client-supplied counters and created_at are reset');
SELECT lives_ok(
    $q$UPDATE public.posts SET favorites_count = 500, is_local = false, ap_id = 'https://evil.test/x',
                               content = '[{"type":"text","text":"hello again"}]'
        WHERE id = 'f5730000-0000-0000-0000-000000000001'$q$,
    'a post update naming server fields runs');
SELECT results_eq(
    $q$SELECT favorites_count, is_local, ap_id, content->0->>'text' FROM public.posts
        WHERE id = 'f5730000-0000-0000-0000-000000000001'$q$,
    $q$VALUES (0, true, 'https://localhost/activities/f5730000-0000-0000-0000-0000000000ff'::text, 'hello again'::text)$q$,
    'server fields keep their values while content changes');
UPDATE public.posts SET is_deleted = true WHERE id = 'f5730000-0000-0000-0000-000000000001';
SELECT throws_ok(
    $q$UPDATE public.posts SET is_deleted = false WHERE id = 'f5730000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'a deleted post cannot be restored by its author');

-- Profiles ----------------------------------------------------------------------------
SELECT tests.authenticate_as('f5700000-0000-0000-0000-0000000000a3');
SELECT throws_ok(
    $q$INSERT INTO public.profiles (id, auth_user_id, username, is_local, domain)
       VALUES ('f5700000-0000-0000-0000-0000000000a3', 'f5700000-0000-0000-0000-0000000000a3', 'erin', false, 'localhost')$q$,
    '42501', NULL, 'a client cannot create a remote profile');
SELECT throws_ok(
    $q$INSERT INTO public.profiles (id, auth_user_id, username, is_local, domain)
       VALUES ('f5700000-0000-0000-0000-0000000000a3', 'f5700000-0000-0000-0000-0000000000a3', 'gargron', true, 'mastodon.test')$q$,
    '42501', NULL, 'a client cannot take a handle on another domain');
SELECT throws_ok(
    $q$INSERT INTO public.profiles (id, auth_user_id, username, is_local, domain, federated_id)
       VALUES ('f5700000-0000-0000-0000-0000000000a3', 'f5700000-0000-0000-0000-0000000000a3', 'erin', true, 'localhost',
               'https://mastodon.test/users/gargron')$q$,
    '42501', NULL, 'a client cannot claim a remote actor URL');
SELECT throws_ok(
    $q$INSERT INTO public.profiles (id, auth_user_id, username, is_local, domain, public_key)
       VALUES ('f5700000-0000-0000-0000-0000000000a3', 'f5700000-0000-0000-0000-0000000000a3', 'erin', true, 'localhost', 'KEY')$q$,
    '42501', NULL, 'a client cannot supply its actor key');
SELECT lives_ok(
    $q$INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain, federated_id,
                                   inbox_url, outbox_url, followers_url, following_url, followers_count, created_at)
       VALUES ('f5700000-0000-0000-0000-0000000000a3', 'f5700000-0000-0000-0000-0000000000a3', 'erin', 'Erin', true,
               'localhost', 'https://localhost/users/erin', 'https://localhost/users/erin/inbox',
               'https://localhost/users/erin/outbox', 'https://localhost/users/erin/followers',
               'https://localhost/users/erin/following', 5000, '2001-01-01')$q$,
    'the signup profile shape is accepted');
SELECT ok((SELECT followers_count = 0 AND created_at > now() - interval '1 minute'
             FROM public.profiles WHERE id = 'f5700000-0000-0000-0000-0000000000a3'),
          'a new profile starts with zero counters and a current created_at');
SELECT set_config('tests.alice_domain',
    (SELECT domain FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'), true);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$UPDATE public.profiles SET federated_id = 'https://mastodon.test/users/gargron', public_key = 'KEY',
                                  domain = 'mastodon.test', is_local = false, followers_count = 9000,
                                  display_name = 'Alice A.'
        WHERE id = '11111111-0000-0000-0000-000000000001'$q$,
    'a profile update naming federation fields runs');
SELECT results_eq(
    $q$SELECT federated_id, public_key, domain, is_local, followers_count, display_name
         FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'$q$,
    $q$VALUES (NULL::text, NULL::text, current_setting('tests.alice_domain'), true, 0, 'Alice A.'::text)$q$,
    'federation identity, key and counters keep their values');

-- Servers and channels ----------------------------------------------------------------
SELECT throws_ok(
    $q$INSERT INTO public.servers (name, owner, is_local_server, federation_inbox_url)
       VALUES ('Mirror', '11111111-0000-0000-0000-000000000001', false, 'https://evil.test/inbox')$q$,
    '42501', NULL, 'a client cannot create a remote server');
SELECT throws_ok(
    $q$INSERT INTO public.servers (name, owner, is_featured) VALUES ('Shiny', '11111111-0000-0000-0000-000000000001', true)$q$,
    '42501', NULL, 'a client cannot feature its own server');
SELECT lives_ok(
    $q$UPDATE public.servers SET is_featured = true, featured_order = 1, name = 'Renamed',
                                 ap_id = 'https://evil.test/servers/x'
        WHERE id = '55555555-0000-0000-0000-000000000005'$q$,
    'a server update naming server fields runs');
SELECT results_eq(
    $q$SELECT is_featured, ap_id, name FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'$q$,
    $q$VALUES (false, NULL::text, 'Renamed'::text)$q$,
    'featuring and federation identity keep their values');
SELECT throws_ok(
    $q$INSERT INTO public.channels (server_id, name, type, ap_id)
       VALUES ('55555555-0000-0000-0000-000000000005', 'squat', 0, 'https://remote.test/servers/x/channels/y')$q$,
    '42501', NULL, 'a client cannot create a channel with a federation id');
SELECT lives_ok(
    $q$UPDATE public.channels SET ap_id = 'https://remote.test/servers/x/channels/y', is_remote = true, name = 'general2'
        WHERE id = '66666666-0000-0000-0000-000000000006'$q$,
    'a channel update naming federation fields runs');
SELECT results_eq(
    $q$SELECT ap_id, COALESCE(is_remote, false), name FROM public.channels WHERE id = '66666666-0000-0000-0000-000000000006'$q$,
    $q$VALUES (NULL::text, false, 'general2'::text)$q$,
    'channel federation fields keep their values');

SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
