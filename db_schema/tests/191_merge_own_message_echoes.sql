-- 20261028300001_merge_own_message_echoes.sql: a host's copy of a member's own message, cached
-- by the 1.8.12 channel refresh, folds into the member's row.
--
--   host     a remote server (is_local_server false), channel hc
--   own      alice's row in hc (microseconds, no ap_id); echo: the host's copy (ms, ap_id)
--   twice    alice's row the host stored twice: both copies fold into it
--   apart    alice's row and copy that both start a thread: left as they are
--   remote   a remote profile's cached row next to alice's: not hers, left
--   local    a copy-shaped row in server_1, a local server: left
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(24);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id)
VALUES ('19100000-0000-0000-0000-0000000000f1', 'hostie', 'Hostie', false, 'host.test', 'https://host.test/users/hostie');

INSERT INTO public.servers (id, name, is_local_server, federation_enabled, host_domain)
VALUES ('19100000-0000-0000-0000-000000000001', 'Host', false, true, 'host.test');
INSERT INTO public.channels (id, server_id, name, type, is_remote)
VALUES ('19100000-0000-0000-0000-000000000002', '19100000-0000-0000-0000-000000000001', 'hc', 0, true);

INSERT INTO public.messages (id, channel_id, user_id, content, created_at, metadata) VALUES
  ('19100000-0000-0000-0000-0000000000a1', '19100000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"own"}]', '2026-10-21 23:39:19.844123+00', '{"federated_to":["host.test"]}'),
  ('19100000-0000-0000-0000-0000000000b1', '19100000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"own"}]', '2026-10-21 23:39:19.844+00',
   '{"ap_id":"https://host.test/messages/19100000-0000-0000-0000-0000000000b1","is_remote":true,"federated":true}'),
  ('19100000-0000-0000-0000-0000000000a2', '19100000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"apart"}]', '2026-10-21 23:41:00.000500+00', '{}'),
  ('19100000-0000-0000-0000-0000000000b2', '19100000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"apart"}]', '2026-10-21 23:41:00+00',
   '{"ap_id":"https://host.test/messages/19100000-0000-0000-0000-0000000000b2","is_remote":true,"federated":true}'),
  ('19100000-0000-0000-0000-0000000000b3', '19100000-0000-0000-0000-000000000002', '19100000-0000-0000-0000-0000000000f1',
   '[{"type":"text","text":"theirs"}]', '2026-10-21 23:39:19.844+00',
   '{"ap_id":"https://host.test/messages/19100000-0000-0000-0000-0000000000b3","is_remote":true,"federated":true}'),
  ('19100000-0000-0000-0000-0000000000a5', '19100000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"twice"}]', '2026-10-21 23:45:00.000250+00', '{}'),
  ('19100000-0000-0000-0000-0000000000b5', '19100000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"twice"}]', '2026-10-21 23:45:00+00',
   '{"ap_id":"https://host.test/messages/19100000-0000-0000-0000-0000000000b5","is_remote":true,"federated":true}'),
  ('19100000-0000-0000-0000-0000000000b6', '19100000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"twice"}]', '2026-10-21 23:45:00+00',
   '{"ap_id":"https://host.test/messages/19100000-0000-0000-0000-0000000000b6","is_remote":true,"federated":true}'),
  ('19100000-0000-0000-0000-0000000000a4', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"local"}]', '2026-10-21 23:50:00.000700+00', '{}'),
  ('19100000-0000-0000-0000-0000000000b4', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"local"}]', '2026-10-21 23:50:00+00',
   '{"ap_id":"https://host.test/messages/19100000-0000-0000-0000-0000000000b4","is_remote":true,"federated":true}');

-- What points at the copy.
UPDATE public.messages SET is_pinned = true, pinned_at = '2026-10-22 00:00:00+00', pinned_by = '22222222-0000-0000-0000-000000000002'
WHERE id = '19100000-0000-0000-0000-0000000000b1';
INSERT INTO public.reactions (message_id, user_id, custom_emoji_content) VALUES
  ('19100000-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-000000000002', '🔥'),
  ('19100000-0000-0000-0000-0000000000b1', '11111111-0000-0000-0000-000000000001', '👍'),
  ('19100000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001', '👍'),
  ('19100000-0000-0000-0000-0000000000b5', '22222222-0000-0000-0000-000000000002', '🔥'),
  ('19100000-0000-0000-0000-0000000000b6', '22222222-0000-0000-0000-000000000002', '🔥');
INSERT INTO public.messages (id, channel_id, user_id, content, reply_to) VALUES
  ('19100000-0000-0000-0000-0000000000c1', '19100000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"a reply"}]', '19100000-0000-0000-0000-0000000000b1');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, last_message_id) VALUES
  ('19100000-0000-0000-0000-0000000000d1', '19100000-0000-0000-0000-000000000002', '19100000-0000-0000-0000-0000000000b1', 'on the copy', '19100000-0000-0000-0000-0000000000b1'),
  ('19100000-0000-0000-0000-0000000000d2', '19100000-0000-0000-0000-000000000002', '19100000-0000-0000-0000-0000000000a2', 'on the row', NULL),
  ('19100000-0000-0000-0000-0000000000d3', '19100000-0000-0000-0000-000000000002', '19100000-0000-0000-0000-0000000000b2', 'on its copy', NULL);
-- The message inserts above already gave bob an unread row for hc.
UPDATE public.unread_counts SET last_read_message_id = '19100000-0000-0000-0000-0000000000b1'
WHERE user_id = '22222222-0000-0000-0000-000000000002' AND channel_id = '19100000-0000-0000-0000-000000000002';
INSERT INTO public.unread_counts (user_id, channel_id, last_read_message_id)
SELECT '22222222-0000-0000-0000-000000000002', '19100000-0000-0000-0000-000000000002', '19100000-0000-0000-0000-0000000000b1'
WHERE NOT EXISTS (SELECT 1 FROM public.unread_counts
                  WHERE user_id = '22222222-0000-0000-0000-000000000002' AND channel_id = '19100000-0000-0000-0000-000000000002');

-- The merge. ------------------------------------------------------------------------------
SELECT is(public.merge_own_message_echoes(), 3, 'three copies are merged');

SELECT is((SELECT count(*)::int FROM public.messages WHERE id = '19100000-0000-0000-0000-0000000000b1'), 0,
  'the host''s copy is gone');
SELECT is((SELECT metadata ->> 'host_ap_id' FROM public.messages WHERE id = '19100000-0000-0000-0000-0000000000a1'),
  'https://host.test/messages/19100000-0000-0000-0000-0000000000b1', 'alice''s row keeps the copy''s id as host_ap_id');
SELECT is((SELECT metadata ->> 'ap_id' FROM public.messages WHERE id = '19100000-0000-0000-0000-0000000000a1'), NULL,
  'and stays hers: no ap_id');
SELECT is((SELECT count(*)::int FROM public.reactions WHERE message_id = '19100000-0000-0000-0000-0000000000a1'
            AND custom_emoji_content = '🔥' AND user_id = '22222222-0000-0000-0000-000000000002'), 1,
  'bob''s reaction on the copy moves to her row');
SELECT is((SELECT count(*)::int FROM public.reactions WHERE message_id = '19100000-0000-0000-0000-0000000000a1'
            AND custom_emoji_content = '👍'), 1, 'a reaction she made on both stays once');
SELECT is((SELECT reply_to FROM public.messages WHERE id = '19100000-0000-0000-0000-0000000000c1'),
  '19100000-0000-0000-0000-0000000000a1'::uuid, 'a reply to the copy replies to her row');
SELECT is((SELECT parent_message_id FROM public.threads WHERE id = '19100000-0000-0000-0000-0000000000d1'),
  '19100000-0000-0000-0000-0000000000a1'::uuid, 'the copy''s thread hangs from her row');
SELECT is((SELECT last_message_id FROM public.threads WHERE id = '19100000-0000-0000-0000-0000000000d1'),
  '19100000-0000-0000-0000-0000000000a1'::uuid, 'the thread''s last message is her row');
SELECT is((SELECT last_read_message_id FROM public.unread_counts
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND channel_id = '19100000-0000-0000-0000-000000000002'),
  '19100000-0000-0000-0000-0000000000a1'::uuid, 'bob''s read marker moves to her row');
SELECT ok((SELECT is_pinned FROM public.messages WHERE id = '19100000-0000-0000-0000-0000000000a1'),
  'the copy''s pin moves to her row');
SELECT is((SELECT pinned_by FROM public.messages WHERE id = '19100000-0000-0000-0000-0000000000a1'),
  '22222222-0000-0000-0000-000000000002'::uuid, 'pinned by whoever pinned the copy');

SELECT is((SELECT count(*)::int FROM public.messages WHERE id IN
            ('19100000-0000-0000-0000-0000000000b5', '19100000-0000-0000-0000-0000000000b6')), 0,
  'both copies of a message the host stored twice are gone');
SELECT is((SELECT count(*)::int FROM public.reactions WHERE message_id = '19100000-0000-0000-0000-0000000000a5'
            AND custom_emoji_content = '🔥' AND user_id = '22222222-0000-0000-0000-000000000002'), 1,
  'bob''s reaction on both copies is kept once');
SELECT is((SELECT metadata ->> 'host_ap_id' FROM public.messages WHERE id = '19100000-0000-0000-0000-0000000000a5'),
  'https://host.test/messages/19100000-0000-0000-0000-0000000000b5', 'the row names one copy');
SELECT is((SELECT count(*)::int FROM public.messages WHERE content = '[{"type":"text","text":"twice"}]'::jsonb
            AND channel_id = '19100000-0000-0000-0000-000000000002'), 1, 'the message reads once');
SELECT is((SELECT count(*)::int FROM public.messages WHERE id IN
            ('19100000-0000-0000-0000-0000000000a2', '19100000-0000-0000-0000-0000000000b2')), 2,
  'a row and copy that both start a thread stay apart');
SELECT is((SELECT count(*)::int FROM public.threads WHERE id IN
            ('19100000-0000-0000-0000-0000000000d2', '19100000-0000-0000-0000-0000000000d3')), 2,
  'and keep both threads');
SELECT is((SELECT count(*)::int FROM public.messages WHERE id = '19100000-0000-0000-0000-0000000000b3'), 1,
  'a cached row by a remote profile is not hers to merge');
SELECT is((SELECT count(*)::int FROM public.messages WHERE id IN
            ('19100000-0000-0000-0000-0000000000a4', '19100000-0000-0000-0000-0000000000b4')), 2,
  'rows in a local server are left');
SELECT is((SELECT metadata ->> 'host_ap_id' FROM public.messages WHERE id = '19100000-0000-0000-0000-0000000000a4'), NULL,
  'and gain no host_ap_id');

SELECT is(public.merge_own_message_echoes(), 0, 'a second run merges nothing');

SELECT ok(NOT has_function_privilege('authenticated', 'public.merge_own_message_echoes()', 'EXECUTE'),
  'signed-in users cannot run the merge');
SELECT ok(NOT has_function_privilege('anon', 'public.merge_own_message_echoes()', 'EXECUTE'),
  'nor can visitors');

SELECT * FROM finish();
ROLLBACK;
