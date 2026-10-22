-- 20261026100001_system_events.sql: a system row has no author; the people it names are in
-- metadata (subject_id, actor_id, actor_bot_id). Every writer, the notification its actor
-- sends, who may change a notice, and the conversion of existing rows.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Added here:
--   bot171      a bridge bot of alice's
--   enc171      a text channel of server_1, with server_1 encryption optional
--   grp171      group conversation created by alice: alice, bob, mallory
--   remote171   a server reference (is_local_server false), #lobby171, and rp171 of remote.test

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(33);

INSERT INTO public.bots (id, username, display_name, owner_id, is_public)
VALUES ('f1710000-0000-0000-0000-0000000000b1', 'bridge171', 'Bridge', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.server_encryption_settings (server_id, encryption_mode, voice_encryption_mode)
VALUES ('55555555-0000-0000-0000-000000000005', 'optional', 'disabled')
ON CONFLICT (server_id) DO UPDATE SET encryption_mode = 'optional', voice_encryption_mode = 'disabled';
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f1710000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005', 'enc171', 0);
INSERT INTO public.conversations (id, type, created_by)
VALUES ('f1710000-0000-0000-0000-0000000000c1', 'group', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.conversation_participants (conversation_id, user_id, joined_at) VALUES
  ('f1710000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', now()),
  ('f1710000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', now()),
  ('f1710000-0000-0000-0000-0000000000c1', '33333333-0000-0000-0000-000000000003', now());

CREATE TEMP TABLE t171 (k text PRIMARY KEY, id uuid);
GRANT ALL ON t171 TO authenticated, service_role;

CREATE FUNCTION pg_temp.notice(p_channel uuid, p_type text) RETURNS public.messages
LANGUAGE sql AS $$
    SELECT m.* FROM public.messages m
     WHERE m.channel_id = p_channel AND m.is_system AND m.metadata ->> 'type' = p_type
     ORDER BY m.created_at DESC, m.id DESC LIMIT 1
$$;

-- Shape. ------------------------------------------------------------------------------------------
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
       VALUES ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
               '[{"type":"text","text":"has joined the server"}]', true, '{"type":"member_join"}')$q$,
    '23514', NULL, 'a system row with an author is refused');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, bot_id, content, is_system, metadata)
       VALUES ('66666666-0000-0000-0000-000000000006', 'f1710000-0000-0000-0000-0000000000b1',
               '[{"type":"text","text":"started a thread"}]', true, '{"type":"thread_created"}')$q$,
    '23514', NULL, 'and one with a bot');

-- Joins and leaves. -------------------------------------------------------------------------------
SELECT set_config('t.mallory_count',
    (SELECT message_count::text FROM public.profiles WHERE id = '33333333-0000-0000-0000-000000000003'), true);

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted');
SELECT results_eq(
    $q$SELECT n.user_id, n.bot_id, n.metadata
         FROM pg_temp.notice(public.get_default_channel('55555555-0000-0000-0000-000000000005'), 'member_join') n$q$,
    $q$VALUES (NULL::uuid, NULL::uuid,
               '{"type":"member_join","subject_id":"33333333-0000-0000-0000-000000000003"}'::jsonb)$q$,
    'a join names its member as subject_id, with no author');
SELECT is((SELECT message_count::text FROM public.profiles WHERE id = '33333333-0000-0000-0000-000000000003'),
          current_setting('t.mallory_count'), 'the join notice counts toward nobody''s messages');

DELETE FROM public.user_servers
 WHERE user_id = '33333333-0000-0000-0000-000000000003' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT results_eq(
    $q$SELECT n.user_id, n.metadata
         FROM pg_temp.notice(public.get_default_channel('55555555-0000-0000-0000-000000000005'), 'member_leave') n$q$,
    $q$VALUES (NULL::uuid, '{"type":"member_leave","subject_id":"33333333-0000-0000-0000-000000000003"}'::jsonb)$q$,
    'a leave names its member as subject_id');

-- Kicks and bans. ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.kick_server_member('55555555-0000-0000-0000-000000000005',
                       '22222222-0000-0000-0000-000000000002', 'spam', 0)$q$, 'the owner kicks bob');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT n.user_id, n.metadata
         FROM pg_temp.notice(public.get_default_channel('55555555-0000-0000-0000-000000000005'), 'member_kick') n$q$,
    $q$VALUES (NULL::uuid, '{"type":"member_kick","subject_id":"22222222-0000-0000-0000-000000000002",
                             "actor_id":"11111111-0000-0000-0000-000000000001","reason":"spam"}'::jsonb)$q$,
    'a kick names the member as subject_id and the moderator as actor_id');

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO t171
SELECT 'bob-join', (pg_temp.notice(public.get_default_channel('55555555-0000-0000-0000-000000000005'), 'member_join')).id;

-- The member a notice names holds no author rights over it. ---------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.messages WHERE id = (SELECT id FROM t171 WHERE k = 'bob-join')),
          1, 'bob reads the notice of his join');
SELECT is_empty(
    $q$WITH u AS (UPDATE public.messages SET content = '[{"type":"text","text":"edited"}]'
                   WHERE id = (SELECT id FROM t171 WHERE k = 'bob-join') RETURNING 1) SELECT * FROM u$q$,
    'bob cannot edit it');
SELECT is_empty(
    $q$WITH u AS (UPDATE public.messages SET is_deleted = true
                   WHERE id = (SELECT id FROM t171 WHERE k = 'bob-join') RETURNING 1) SELECT * FROM u$q$,
    'nor soft-delete it');
SELECT is_empty(
    $q$WITH d AS (DELETE FROM public.messages
                   WHERE id = (SELECT id FROM t171 WHERE k = 'bob-join') RETURNING 1) SELECT * FROM d$q$,
    'nor delete it');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty(
    $q$WITH u AS (UPDATE public.messages SET is_deleted = true
                   WHERE id = (SELECT id FROM t171 WHERE k = 'bob-join') RETURNING 1) SELECT * FROM u$q$,
    'the owner removes it');

SELECT lives_ok($q$SELECT public.ban_server_member('55555555-0000-0000-0000-000000000005',
                       '22222222-0000-0000-0000-000000000002', 'raid', 0)$q$, 'the owner bans bob');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT n.user_id, n.metadata
         FROM pg_temp.notice(public.get_default_channel('55555555-0000-0000-0000-000000000005'), 'member_ban') n$q$,
    $q$VALUES (NULL::uuid, '{"type":"member_ban","subject_id":"22222222-0000-0000-0000-000000000002",
                             "actor_id":"11111111-0000-0000-0000-000000000001","reason":"raid"}'::jsonb)$q$,
    'a ban names the member as subject_id and the moderator as actor_id');
DELETE FROM public.server_bans
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND user_id = '22222222-0000-0000-0000-000000000002';
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'accepted');

-- Threads. ----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO t171 SELECT 'standalone',
    public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'Standalone 171');
INSERT INTO t171 SELECT 'on-message',
    public.create_thread('88888888-0000-0000-0000-000000000008', 'On message 171');
INSERT INTO t171 SELECT 'on-message-notice',
    public.post_thread_created_notice((SELECT id FROM t171 WHERE k = 'on-message'));
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT m.user_id, m.bot_id, m.metadata ->> 'actor_id', m.metadata ->> 'thread_name'
         FROM public.messages m
         JOIN public.threads t ON t.parent_message_id = m.id
        WHERE t.id = (SELECT id FROM t171 WHERE k = 'standalone')$q$,
    $q$VALUES (NULL::uuid, NULL::uuid, '11111111-0000-0000-0000-000000000001'::text, 'Standalone 171'::text)$q$,
    'a standalone thread''s notice is its starter, with the creator as actor_id');
SELECT results_eq(
    $q$SELECT m.user_id, m.metadata ->> 'actor_id', m.metadata ->> 'thread_id'
         FROM public.messages m WHERE m.id = (SELECT id FROM t171 WHERE k = 'on-message-notice')$q$,
    $q$VALUES (NULL::uuid, '11111111-0000-0000-0000-000000000001'::text,
               (SELECT id::text FROM t171 WHERE k = 'on-message'))$q$,
    'a thread on a message posts its notice with the creator as actor_id');

SET LOCAL ROLE service_role;
INSERT INTO t171 SELECT 'bridged', public.bot_create_thread(
    'f1710000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', 'Bridged 171',
    NULL, NULL, '{"id":"1710000000000000001","username":"discordian"}'::jsonb);
RESET ROLE;
SELECT results_eq(
    $q$SELECT m.user_id, m.bot_id, m.metadata ->> 'actor_bot_id', m.metadata -> 'discord_user' ->> 'username'
         FROM public.messages m
         JOIN public.threads t ON t.parent_message_id = m.id
        WHERE t.id = (SELECT id FROM t171 WHERE k = 'bridged')$q$,
    $q$VALUES (NULL::uuid, NULL::uuid, 'f1710000-0000-0000-0000-0000000000b1'::text, 'discordian'::text)$q$,
    'a bridge bot''s thread notice names the bot as actor_bot_id and keeps the Discord member');

-- Calls and groups. -------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO t171 SELECT 'call', public.start_dm_call_message('77777777-0000-0000-0000-000000000007', 'voice');
INSERT INTO t171 SELECT 'group', public.post_group_conversation_notice('f1710000-0000-0000-0000-0000000000c1');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT m.user_id, m.metadata ->> 'type', m.metadata ->> 'actor_id'
         FROM public.messages m WHERE m.id = (SELECT id FROM t171 WHERE k = 'call')$q$,
    $q$VALUES (NULL::uuid, 'call_started'::text, '11111111-0000-0000-0000-000000000001'::text)$q$,
    'a call notice names the caller as actor_id');
SELECT results_eq(
    $q$SELECT n.user_id, n.data ->> 'from_user_id', n.data -> 'sender' ->> 'username'
         FROM public.notifications n
        WHERE n.data ->> 'message_id' = (SELECT id::text FROM t171 WHERE k = 'call')$q$,
    $q$VALUES ('22222222-0000-0000-0000-000000000002'::uuid, '11111111-0000-0000-0000-000000000001'::text, 'alice'::text)$q$,
    'the callee is notified, from the caller; the caller is not');
SELECT results_eq(
    $q$SELECT m.user_id, m.metadata ->> 'actor_id', (m.metadata ->> 'participant_count')::int, m.metadata ->> 'event'
         FROM public.messages m WHERE m.id = (SELECT id FROM t171 WHERE k = 'group')$q$,
    $q$VALUES (NULL::uuid, '11111111-0000-0000-0000-000000000001'::text, 3, 'created'::text)$q$,
    'a group notice names its creator as actor_id and counts the participants');
SELECT set_eq(
    $q$SELECT n.user_id FROM public.notifications n
        WHERE n.data ->> 'message_id' = (SELECT id::text FROM t171 WHERE k = 'group')$q$,
    $q$VALUES ('22222222-0000-0000-0000-000000000002'::uuid), ('33333333-0000-0000-0000-000000000003'::uuid)$q$,
    'every participant but the creator is notified of the group');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$SELECT public.finalize_dm_call_message((SELECT id FROM t171 WHERE k = 'call'), now(), 42,
             ARRAY['11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002']::uuid[])$q$,
    'the callee ends the call');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT m.user_id, m.metadata ->> 'type', m.metadata ->> 'actor_id', (m.metadata ->> 'duration_seconds')::int
         FROM public.messages m WHERE m.id = (SELECT id FROM t171 WHERE k = 'call')$q$,
    $q$VALUES (NULL::uuid, 'call_ended'::text, '11111111-0000-0000-0000-000000000001'::text, 42)$q$,
    'the ended call keeps the caller as actor_id');

-- Channel encryption. -----------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.set_channel_encryption('f1710000-0000-0000-0000-0000000000e1', true)$q$,
                'the owner turns encryption on');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT n.user_id, n.metadata
         FROM pg_temp.notice('f1710000-0000-0000-0000-0000000000e1', 'channel_encryption_enabled') n$q$,
    $q$VALUES (NULL::uuid, '{"type":"channel_encryption_enabled","actor_id":"11111111-0000-0000-0000-000000000001"}'::jsonb)$q$,
    'an encryption notice names the moderator as actor_id');

-- Federation and search. -------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT m.metadata ->> 'type', m.federation_status FROM public.messages m
        JOIN t171 t ON t.id = m.id WHERE t.k IN ('bob-join', 'on-message-notice')
        ORDER BY t.k$q$,
    $q$VALUES ('member_join'::text, 'queued'::text), ('thread_created', 'skipped')$q$,
    'a member event is queued for the Group to deliver; a thread notice is not federated');
SELECT is((SELECT count(*)::int FROM public.message_search_index
            WHERE message_id IN (SELECT id FROM t171 WHERE k IN ('bob-join', 'on-message-notice'))),
          0, 'notices are not in the search index');
SELECT is((SELECT count(*)::int FROM public.message_search_index
            WHERE message_id = '88888888-0000-0000-0000-000000000008'),
          1, 'an ordinary message is');

-- Existing rows. ----------------------------------------------------------------------------------
-- Rows as the writers before 20261026100001 left them, and the cache of a remote server's
-- channel collection.
ALTER TABLE public.messages DROP CONSTRAINT messages_system_authorless;

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, inbox_url, is_local)
VALUES ('f1710000-0000-0000-0000-0000000000f1', 'rp171', 'Remote 171', 'remote.test',
        'https://remote.test/users/rp171', 'https://remote.test/users/rp171/inbox', false);
INSERT INTO public.servers (id, name, owner, is_local_server)
VALUES ('f1710000-0000-0000-0000-0000000000a1', 'Remote 171', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f1710000-0000-0000-0000-0000000000a2', 'f1710000-0000-0000-0000-0000000000a1', 'lobby171', 0);

CREATE TEMP TABLE count171 AS
SELECT id, message_count FROM public.profiles
 WHERE id IN ('22222222-0000-0000-0000-000000000002', 'f1710000-0000-0000-0000-0000000000f1');

INSERT INTO public.messages (id, channel_id, conversation_id, user_id, bot_id, content, is_system, metadata) VALUES
  ('f1710000-0000-0000-0000-000000000101', '66666666-0000-0000-0000-000000000006', NULL,
   '22222222-0000-0000-0000-000000000002', NULL,
   '[{"type":"text","text":"has joined the server"}]', true, '{"type":"member_join"}'),
  ('f1710000-0000-0000-0000-000000000102', '66666666-0000-0000-0000-000000000006', NULL,
   '22222222-0000-0000-0000-000000000002', NULL,
   '[{"type":"text","text":"was kicked from the server"}]', true,
   '{"type":"member_kick","kicked_by":"11111111-0000-0000-0000-000000000001","reason":""}'),
  ('f1710000-0000-0000-0000-000000000103', NULL, 'f1710000-0000-0000-0000-0000000000c1',
   '11111111-0000-0000-0000-000000000001', NULL,
   '[{"type":"text","text":"Group conversation created with 3 participants"}]', true,
   '{"type":"group_created","event":"created","user_ids":[]}'),
  ('f1710000-0000-0000-0000-000000000104', NULL, '77777777-0000-0000-0000-000000000007',
   '11111111-0000-0000-0000-000000000001', NULL,
   '[{"type":"text","text":"started a call"}]', true,
   '{"type":"call_ended","call_type":"voice","duration_seconds":5}'),
  ('f1710000-0000-0000-0000-000000000105', '66666666-0000-0000-0000-000000000006', NULL,
   NULL, 'f1710000-0000-0000-0000-0000000000b1',
   '[{"type":"text","text":"started a thread"}]', true,
   '{"type":"thread_created","thread_name":"Old bridged","bridge_source":"discord"}'),
  ('f1710000-0000-0000-0000-000000000106', '66666666-0000-0000-0000-000000000006', NULL,
   '11111111-0000-0000-0000-000000000001', NULL,
   '[{"type":"text","text":"something happened"}]', true, '{}'),
  ('f1710000-0000-0000-0000-000000000107', 'f1710000-0000-0000-0000-0000000000a2', NULL,
   'f1710000-0000-0000-0000-0000000000f1', NULL,
   '[{"type":"text","text":"has joined the server"}]', false,
   '{"federated":true,"ap_id":"https://remote.test/servers/x/messages/107"}'),
  ('f1710000-0000-0000-0000-000000000108', 'f1710000-0000-0000-0000-0000000000a2', NULL,
   'f1710000-0000-0000-0000-0000000000f1', NULL,
   '[{"type":"text","text":"has joined the server"},{"type":"text","text":" twice"}]', false,
   '{"federated":true}'),
  ('f1710000-0000-0000-0000-000000000109', '66666666-0000-0000-0000-000000000006', NULL,
   '22222222-0000-0000-0000-000000000002', NULL,
   '[{"type":"text","text":"has joined the server"}]', false, '{"federated":true}');

\! sed -n '/^-- Existing rows\. /,/^COMMIT;$/{/^COMMIT;$/!p}' /db_schema/migrations/20261026100001_system_events.sql > /tmp/convert171.sql
\! test -s /tmp/convert171.sql || echo 'ERROR: /db_schema/migrations/20261026100001_system_events.sql is not in the container; copy db_schema to /db_schema'
\i /tmp/convert171.sql

SELECT results_eq(
    $q$SELECT id, user_id, bot_id, is_system, metadata FROM public.messages
        WHERE id::text LIKE 'f1710000-0000-0000-0000-0000000001%' ORDER BY id$q$,
    $q$VALUES
      ('f1710000-0000-0000-0000-000000000101'::uuid, NULL::uuid, NULL::uuid, true,
       '{"type":"member_join","subject_id":"22222222-0000-0000-0000-000000000002"}'::jsonb),
      ('f1710000-0000-0000-0000-000000000102', NULL, NULL, true,
       '{"type":"member_kick","subject_id":"22222222-0000-0000-0000-000000000002",
         "actor_id":"11111111-0000-0000-0000-000000000001","reason":""}'),
      ('f1710000-0000-0000-0000-000000000103', NULL, NULL, true,
       '{"type":"group_created","event":"created","user_ids":[],
         "actor_id":"11111111-0000-0000-0000-000000000001","participant_count":3}'),
      ('f1710000-0000-0000-0000-000000000104', NULL, NULL, true,
       '{"type":"call_ended","call_type":"voice","duration_seconds":5,
         "actor_id":"11111111-0000-0000-0000-000000000001"}'),
      ('f1710000-0000-0000-0000-000000000105', NULL, NULL, true,
       '{"type":"thread_created","thread_name":"Old bridged","bridge_source":"discord",
         "actor_bot_id":"f1710000-0000-0000-0000-0000000000b1"}'),
      ('f1710000-0000-0000-0000-000000000106', NULL, NULL, true,
       '{"actor_id":"11111111-0000-0000-0000-000000000001"}'),
      ('f1710000-0000-0000-0000-000000000107', NULL, NULL, true,
       '{"federated":true,"ap_id":"https://remote.test/servers/x/messages/107",
         "type":"member_join","subject_id":"f1710000-0000-0000-0000-0000000000f1"}'),
      ('f1710000-0000-0000-0000-000000000108', 'f1710000-0000-0000-0000-0000000000f1', NULL, false,
       '{"federated":true}'),
      ('f1710000-0000-0000-0000-000000000109', '22222222-0000-0000-0000-000000000002', NULL, false,
       '{"federated":true}')$q$,
    'each author moves into subject_id, actor_id or actor_bot_id; a remote server''s cached notice becomes a system row, a longer message or a local server''s message does not');
SELECT set_eq(
    $q$SELECT p.id, p.message_count FROM public.profiles p JOIN count171 c ON c.id = p.id$q$,
    $q$SELECT c.id, c.message_count + 1 FROM count171 c$q$,
    'message counts keep each one''s ordinary message and lose the notices moved');
SELECT is((SELECT count(*)::int FROM public.messages WHERE is_system AND (user_id IS NOT NULL OR bot_id IS NOT NULL)),
          0, 'no system row keeps an author');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.messages'::regclass AND conname = 'messages_system_authorless'
                     AND convalidated),
          'the constraint is back and validated');

CREATE TEMP TABLE after171 AS SELECT id, user_id, bot_id, is_system, metadata FROM public.messages;
CREATE TEMP TABLE counts_after171 AS SELECT id, message_count FROM public.profiles;
\i /tmp/convert171.sql
SELECT ok(NOT EXISTS (SELECT id, user_id, bot_id, is_system, metadata FROM public.messages
                      EXCEPT SELECT * FROM after171)
          AND NOT EXISTS (SELECT id, message_count FROM public.profiles
                          EXCEPT SELECT * FROM counts_after171),
          'a second run changes nothing');

SELECT * FROM finish();
ROLLBACK;
