-- 20261106200001_empty_thread_delete.sql: a deletion that leaves a thread of a server hosted
-- here with no message deletes the thread, by the DELETE a manual thread delete issues; a
-- copy's thread waits for its host's Delete.
--
-- Fixture server_1: alice owns it, bob is a member. Channel general.
--   copy  e232…c0, a copy of https://host.test/servers/e232…c0, channel e232…c1; bob a member,
--         hostuser the remote profile https://host.test/users/hostuser
--
-- queue_federation_job is replaced for the transaction with a recorder into tests.fed_jobs:
-- pg_notify delivers only at commit and every file rolls back.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(35);

CREATE TABLE tests.fed_jobs (name text, data jsonb);
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.fed_jobs VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.has_thread(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $fn$ SELECT EXISTS (SELECT 1 FROM public.threads WHERE id = p_id) $fn$;

CREATE OR REPLACE FUNCTION pg_temp.thread_deletes(p_id uuid) RETURNS integer
LANGUAGE sql STABLE AS $fn$
  SELECT count(*)::int FROM tests.fed_jobs
   WHERE name = 'federate-thread' AND data ->> 'type' = 'delete' AND data ->> 'thread_id' = p_id::text
$fn$;

UPDATE public.server_automod_settings SET enabled = false WHERE server_id = '55555555-0000-0000-0000-000000000005';

-- ---------------------------------------------------------------------------
-- Standalone thread, its only message deleted by its author.
-- ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('t.solo', public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'Solo')::text, true);
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('e2320000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', current_setting('t.solo')::uuid,
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"only one"}]');
SELECT tests.clear_authentication();
SELECT ok(pg_temp.has_thread(current_setting('t.solo')::uuid), 'a standalone thread holds its first message');

DELETE FROM realtime.messages;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$UPDATE public.messages SET is_deleted = true, content = '[{"type":"text","text":"[deleted]"}]'
        WHERE id = 'e2320000-0000-0000-0000-000000000001'$q$,
    'its author deletes the only message');
SELECT tests.clear_authentication();
SELECT ok(NOT pg_temp.has_thread(current_setting('t.solo')::uuid), 'the thread is deleted');
SELECT is((SELECT count(*)::int FROM public.thread_members WHERE thread_id = current_setting('t.solo')::uuid),
          0, 'its members go with it');
SELECT is((SELECT count(*)::int FROM realtime.messages
            WHERE topic = 'server-structure:55555555-0000-0000-0000-000000000005'
              AND payload ->> 'type' = 'thread:delete'
              AND payload -> 'old' ->> 'id' = current_setting('t.solo')),
          1, 'thread:delete is broadcast to the server, as for a manual delete');
SELECT is((SELECT is_deleted FROM public.messages WHERE id = 'e2320000-0000-0000-0000-000000000001'),
          true, 'the message stays deleted');
SELECT is(pg_temp.thread_deletes(current_setting('t.solo')::uuid), 0,
          'a server with federation off queues no Delete');

-- ---------------------------------------------------------------------------
-- Two messages: one deleted, the thread stays; the second deleted, it goes.
-- ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('t.pair', public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'Pair')::text, true);
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('e2320000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006', current_setting('t.pair')::uuid,
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"first"}]');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('e2320000-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006', current_setting('t.pair')::uuid,
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"second"}]');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.messages SET is_deleted = true WHERE id = 'e2320000-0000-0000-0000-000000000002';
SELECT tests.clear_authentication();
SELECT ok(pg_temp.has_thread(current_setting('t.pair')::uuid), 'one of two messages deleted: the thread stays');
SELECT is((SELECT message_count FROM public.threads WHERE id = current_setting('t.pair')::uuid), 1,
          'and counts the one left');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.messages SET is_deleted = true WHERE id = 'e2320000-0000-0000-0000-000000000003';
SELECT tests.clear_authentication();
SELECT ok(NOT pg_temp.has_thread(current_setting('t.pair')::uuid), 'the last one deleted: the thread goes');

SELECT lives_ok(
    $q$UPDATE public.messages SET is_deleted = true WHERE id = 'e2320000-0000-0000-0000-000000000003'$q$,
    'deleting a deleted message of a deleted thread again is a no-op');
SELECT lives_ok(
    $q$DELETE FROM public.messages WHERE id = 'e2320000-0000-0000-0000-000000000003'$q$,
    'and so is removing its row');

-- ---------------------------------------------------------------------------
-- Threads started from a channel message.
-- ---------------------------------------------------------------------------
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('e2320000-0000-0000-0000-000000000010', '66666666-0000-0000-0000-000000000006',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"starter, no replies"}]'),
  ('e2320000-0000-0000-0000-000000000020', '66666666-0000-0000-0000-000000000006',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"starter with a reply"}]'),
  ('e2320000-0000-0000-0000-000000000030', '66666666-0000-0000-0000-000000000006',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"starter kept"}]');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('t.bare', public.create_thread('e2320000-0000-0000-0000-000000000010', 'Bare', 1440)::text, true);
SELECT set_config('t.replied', public.create_thread('e2320000-0000-0000-0000-000000000020', 'Replied', 1440)::text, true);
SELECT set_config('t.kept', public.create_thread('e2320000-0000-0000-0000-000000000030', 'Kept', 1440)::text, true);
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('e2320000-0000-0000-0000-000000000021', '66666666-0000-0000-0000-000000000006', current_setting('t.replied')::uuid,
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"a reply"}]'),
  ('e2320000-0000-0000-0000-000000000031', '66666666-0000-0000-0000-000000000006', current_setting('t.kept')::uuid,
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"only reply"}]');

UPDATE public.messages SET is_deleted = true WHERE id = 'e2320000-0000-0000-0000-000000000010';
UPDATE public.messages SET is_deleted = true WHERE id = 'e2320000-0000-0000-0000-000000000020';
UPDATE public.messages SET is_deleted = true WHERE id = 'e2320000-0000-0000-0000-000000000031';
SELECT tests.clear_authentication();
SELECT ok(NOT pg_temp.has_thread(current_setting('t.bare')::uuid), 'a starter with no replies deleted: the thread goes');
SELECT ok(pg_temp.has_thread(current_setting('t.replied')::uuid), 'a starter with a reply deleted: the thread stays');
SELECT is((SELECT p.is_deleted FROM public.threads t JOIN public.messages p ON p.id = t.parent_message_id
            WHERE t.id = current_setting('t.replied')::uuid),
          true, 'and its parent reads as deleted');
SELECT ok(pg_temp.has_thread(current_setting('t.kept')::uuid), 'the only reply deleted under a live starter: the thread stays');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.messages SET is_deleted = true WHERE id = 'e2320000-0000-0000-0000-000000000021';
SELECT tests.clear_authentication();
SELECT ok(NOT pg_temp.has_thread(current_setting('t.replied')::uuid), 'its last reply deleted after the starter: the thread goes');

-- ---------------------------------------------------------------------------
-- Hard deletes: the bot API removes the row.
-- ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('t.bot', public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'Bot')::text, true);
SELECT tests.clear_authentication();
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('e2320000-0000-0000-0000-000000000040', '66666666-0000-0000-0000-000000000006', current_setting('t.bot')::uuid,
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"hard deleted"}]');
SET LOCAL ROLE service_role;
DELETE FROM public.messages WHERE id = 'e2320000-0000-0000-0000-000000000040';
RESET ROLE;
SELECT ok(NOT pg_temp.has_thread(current_setting('t.bot')::uuid), 'the only message hard-deleted: the thread goes');

SET LOCAL ROLE service_role;
DELETE FROM public.messages WHERE id = 'e2320000-0000-0000-0000-000000000031';
RESET ROLE;
SELECT ok(pg_temp.has_thread(current_setting('t.kept')::uuid), 'a deleted reply removed under a live starter: the thread stays');

-- ---------------------------------------------------------------------------
-- Federation from the host: a thread delete queues its Delete.
-- ---------------------------------------------------------------------------
UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('t.fed', public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'Fed')::text, true);
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('e2320000-0000-0000-0000-000000000060', '66666666-0000-0000-0000-000000000006', current_setting('t.fed')::uuid,
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"federated"}]');
UPDATE public.messages SET is_deleted = true WHERE id = 'e2320000-0000-0000-0000-000000000060';
SELECT tests.clear_authentication();
SELECT ok(NOT pg_temp.has_thread(current_setting('t.fed')::uuid), 'on a federated server the emptied thread goes too');
SELECT is(pg_temp.thread_deletes(current_setting('t.fed')::uuid), 1, 'and one Delete of it is queued');
SELECT is((SELECT data - 'thread_id' FROM tests.fed_jobs
            WHERE name = 'federate-thread' AND data ->> 'type' = 'delete'
              AND data ->> 'thread_id' = current_setting('t.fed')),
          jsonb_build_object('type', 'delete', 'ap_id', null, 'channel_id', '66666666-0000-0000-0000-000000000006',
                             'server_id', '55555555-0000-0000-0000-000000000005', 'server_is_local', true,
                             'created_by', '22222222-0000-0000-0000-000000000002'),
          'naming the thread, its channel, server and creator');
SELECT is((SELECT count(*)::int FROM tests.fed_jobs
            WHERE name = 'federate-channel-message-delete' AND data ->> 'message_id' = 'e2320000-0000-0000-0000-000000000060'),
          1, 'beside the message''s own Delete');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('t.manual', public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'Manual')::text, true);
DELETE FROM public.threads WHERE id = current_setting('t.manual')::uuid;
SELECT tests.clear_authentication();
SELECT is(pg_temp.thread_deletes(current_setting('t.manual')::uuid), 1, 'a manual thread delete queues the same Delete');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('e2320000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'doomed', 0);
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('t.doomed', public.create_channel_thread('e2320000-0000-0000-0000-0000000000a1', 'Doomed')::text, true);
SELECT tests.clear_authentication();
DELETE FROM public.channels WHERE id = 'e2320000-0000-0000-0000-0000000000a1';
SELECT ok(NOT pg_temp.has_thread(current_setting('t.doomed')::uuid), 'a deleted channel takes its threads');
SELECT is(pg_temp.thread_deletes(current_setting('t.doomed')::uuid), 0, 'and queues no thread Delete: the channel''s covers it');

-- ---------------------------------------------------------------------------
-- Untouched: a thread nobody wrote in yet, a channel message without a thread.
-- ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('t.fresh', public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'Fresh')::text, true);
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('e2320000-0000-0000-0000-000000000070', '66666666-0000-0000-0000-000000000006',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"channel only"}]');
UPDATE public.messages SET is_deleted = true WHERE id = 'e2320000-0000-0000-0000-000000000070';
SELECT tests.clear_authentication();
SELECT ok(pg_temp.has_thread(current_setting('t.fresh')::uuid), 'a thread with no message yet is left alone');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'z_messages_empty_thread_delete'
                   AND tgrelid = 'public.messages'::regclass AND tgenabled = 'O'),
          'the trigger is installed on messages');

-- ---------------------------------------------------------------------------
-- A copy of a server hosted elsewhere.
-- ---------------------------------------------------------------------------
INSERT INTO public.profiles (id, username, display_name, domain, is_local, federated_id) VALUES
  ('e2320000-0000-0000-0000-0000000000e1', 'hostuser', 'Host User', 'host.test', false,
   'https://host.test/users/hostuser');
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, ap_id, host_domain,
                            federation_domain, federation_inbox_url) VALUES
  ('e2320000-0000-0000-0000-0000000000c0', 'Copy 232', 'e2320000-0000-0000-0000-0000000000e1', false, true,
   'https://host.test/servers/e2320000-0000-0000-0000-0000000000c0', 'host.test', 'host.test',
   'https://host.test/servers/e2320000-0000-0000-0000-0000000000c0/inbox');
INSERT INTO public.user_servers (user_id, server_id, status, member_instance) VALUES
  ('22222222-0000-0000-0000-000000000002', 'e2320000-0000-0000-0000-0000000000c0', 'accepted', 'localhost'),
  ('e2320000-0000-0000-0000-0000000000e1', 'e2320000-0000-0000-0000-0000000000c0', 'accepted', 'host.test');
INSERT INTO public.channels (id, server_id, name, type, is_remote, ap_id) VALUES
  ('e2320000-0000-0000-0000-0000000000c1', 'e2320000-0000-0000-0000-0000000000c0', 'general', 0, true,
   'https://host.test/servers/e2320000-0000-0000-0000-0000000000c0/channels/e2320000-0000-0000-0000-0000000000c1');
INSERT INTO public.messages (id, channel_id, content, is_system, metadata) VALUES
  ('e2320000-0000-0000-0000-0000000000c2', 'e2320000-0000-0000-0000-0000000000c1',
   '[{"type":"text","text":"started a thread"}]', true,
   '{"type":"thread_created","standalone":true,"thread_id":"e2320000-0000-0000-0000-0000000000c3"}');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, ap_id) VALUES
  ('e2320000-0000-0000-0000-0000000000c3', 'e2320000-0000-0000-0000-0000000000c1', 'e2320000-0000-0000-0000-0000000000c2',
   'Copied', 'e2320000-0000-0000-0000-0000000000e1', 'https://host.test/threads/e2320000-0000-0000-0000-0000000000c3');
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content, metadata) VALUES
  ('e2320000-0000-0000-0000-0000000000c4', 'e2320000-0000-0000-0000-0000000000c1', 'e2320000-0000-0000-0000-0000000000c3',
   'e2320000-0000-0000-0000-0000000000e1', '[{"type":"text","text":"from the host"}]',
   '{"federated":true,"ap_id":"https://host.test/messages/e2320000-0000-0000-0000-0000000000c4"}');
DELETE FROM tests.fed_jobs;

SET LOCAL ROLE service_role;
UPDATE public.messages SET is_deleted = true WHERE id = 'e2320000-0000-0000-0000-0000000000c4';
RESET ROLE;
SELECT ok(pg_temp.has_thread('e2320000-0000-0000-0000-0000000000c3'),
          'a copy''s thread stays when the host''s Delete of its only message lands');
SET LOCAL ROLE service_role;
DELETE FROM public.messages WHERE id = 'e2320000-0000-0000-0000-0000000000c4';
RESET ROLE;
SELECT ok(pg_temp.has_thread('e2320000-0000-0000-0000-0000000000c3'), 'or when the row is removed');

SET LOCAL ROLE service_role;
DELETE FROM public.threads WHERE id = 'e2320000-0000-0000-0000-0000000000c3';
RESET ROLE;
SELECT ok(NOT pg_temp.has_thread('e2320000-0000-0000-0000-0000000000c3'), 'the host''s thread Delete removes it');
SELECT is((SELECT count(*)::int FROM tests.fed_jobs WHERE name = 'federate-thread'), 0,
          'and the copy queues no Delete of its own');

-- ---------------------------------------------------------------------------
-- Moderation: a ban that deletes the member's recent messages, one statement.
-- ---------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('t.ban1', public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'Ban one')::text, true);
SELECT set_config('t.ban2', public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'Ban two')::text, true);
SELECT set_config('t.ban3', public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'Ban three')::text, true);
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('e2320000-0000-0000-0000-000000000051', '66666666-0000-0000-0000-000000000006', current_setting('t.ban1')::uuid,
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob 1"}]'),
  ('e2320000-0000-0000-0000-000000000052', '66666666-0000-0000-0000-000000000006', current_setting('t.ban1')::uuid,
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob 1 again"}]'),
  ('e2320000-0000-0000-0000-000000000053', '66666666-0000-0000-0000-000000000006', current_setting('t.ban2')::uuid,
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob 2"}]'),
  ('e2320000-0000-0000-0000-000000000054', '66666666-0000-0000-0000-000000000006', current_setting('t.ban3')::uuid,
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob 3"}]');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content) VALUES
  ('e2320000-0000-0000-0000-000000000055', '66666666-0000-0000-0000-000000000006', current_setting('t.ban3')::uuid,
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"alice stays"}]');
SELECT lives_ok(
    $q$SELECT public.ban_server_member('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', 'spam', 3600)$q$,
    'the owner bans bob, deleting his last hour');
SELECT tests.clear_authentication();
SELECT ok(NOT pg_temp.has_thread(current_setting('t.ban1')::uuid) AND NOT pg_temp.has_thread(current_setting('t.ban2')::uuid),
          'each thread holding only his messages goes');
SELECT ok(pg_temp.has_thread(current_setting('t.ban3')::uuid), 'a thread with another member''s message stays');

SELECT * FROM finish();
ROLLBACK;
