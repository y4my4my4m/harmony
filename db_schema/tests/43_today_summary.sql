-- get_today_summary (migration 20261003000001): grants, the invoker security model, and each
-- section's narrowing.
--
-- Fixture roles: alice owns server_1; bob is an accepted member with @everyone only; mallory
-- belongs to nothing. Local: carol, whose profile id equals her auth id as a signed-up local
-- user's does, and ghost, an auth user without a profile.
--
-- Channels on server_1: #open43 and ~voice43 (open), #hidden43 and ~hvoice43 (@everyone
-- denied VIEW_CHANNEL).
--
--   M1  #open43    bob    -3h    target of M3 and parent of T1
--   M2  #open43    alice  -2h    mentions bob
--   M3  #open43    alice  -1h    replies to M1
--   M4  #hidden43  alice  -1h    mentions bob; a stale notification points at it
--   M5  #hidden43  bob    -5h    target of M6
--   M6  #hidden43  alice  -30m   replies to M5
--   M7  #open43    alice  -20d   mentions bob; its notification is 20 days old
--   M8  #open43    alice  -40m   mentions bob, then deleted
--   Conversations: D1 (alice, bob) plain then encrypted; D2 muted by bob; D3 dismissed by bob;
--   G1 group bob has left.
--   Threads: T1 in #open43 (bob posted -3h, alice -2h and -1h); T2 in #hidden43; T3 muted.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(32);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f4300000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'carol43@test.local'),
  ('f4300000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ghost43@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES ('f4300000-0000-0000-0000-0000000000c1', 'f4300000-0000-0000-0000-0000000000c1', 'carol43', 'Carol', true);

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f4320000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'open43', 0),
  ('f4320000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'hidden43', 0),
  ('f4320000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'voice43', 1),
  ('f4320000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'hvoice43', 1);

-- Bit 2 is VIEW_CHANNEL.
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT c.id, 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 CROSS JOIN (VALUES ('f4320000-0000-0000-0000-000000000002'::uuid),
                    ('f4320000-0000-0000-0000-000000000004'::uuid)) c(id)
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

INSERT INTO public.messages (id, channel_id, user_id, content, created_at, reply_to) VALUES
  ('f4340000-0000-0000-0000-000000000001', 'f4320000-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"question"}]', now() - interval '3 hours', NULL),
  ('f4340000-0000-0000-0000-000000000002', 'f4320000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"hey "},{"type":"mention","userId":"22222222-0000-0000-0000-000000000002","username":"bob","domain":"localhost","isLocal":true}]',
   now() - interval '2 hours', NULL),
  ('f4340000-0000-0000-0000-000000000003', 'f4320000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"answer"}]', now() - interval '1 hour',
   'f4340000-0000-0000-0000-000000000001'),
  ('f4340000-0000-0000-0000-000000000004', 'f4320000-0000-0000-0000-000000000002',
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"secret "},{"type":"mention","userId":"22222222-0000-0000-0000-000000000002","username":"bob","domain":"localhost","isLocal":true}]',
   now() - interval '1 hour', NULL),
  ('f4340000-0000-0000-0000-000000000005', 'f4320000-0000-0000-0000-000000000002',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"before the deny"}]', now() - interval '5 hours', NULL),
  ('f4340000-0000-0000-0000-000000000006', 'f4320000-0000-0000-0000-000000000002',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"hidden reply"}]', now() - interval '30 minutes',
   'f4340000-0000-0000-0000-000000000005'),
  ('f4340000-0000-0000-0000-000000000007', 'f4320000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"old "},{"type":"mention","userId":"22222222-0000-0000-0000-000000000002","username":"bob","domain":"localhost","isLocal":true}]',
   now() - interval '20 days', NULL),
  ('f4340000-0000-0000-0000-000000000008', 'f4320000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"oops "},{"type":"mention","userId":"22222222-0000-0000-0000-000000000002","username":"bob","domain":"localhost","isLocal":true}]',
   now() - interval '40 minutes', NULL);

UPDATE public.messages SET is_deleted = true WHERE id = 'f4340000-0000-0000-0000-000000000008';
UPDATE public.notifications SET created_at = now() - interval '20 days'
 WHERE user_id = '22222222-0000-0000-0000-000000000002'
   AND data->>'message_id' = 'f4340000-0000-0000-0000-000000000007';
INSERT INTO public.notifications (user_id, type, data)
VALUES ('22222222-0000-0000-0000-000000000002', 'mention',
        '{"message_id":"f4340000-0000-0000-0000-000000000004"}');
UPDATE public.unread_counts SET last_read_at = now() - interval '4 hours'
 WHERE user_id = '22222222-0000-0000-0000-000000000002'
   AND channel_id = 'f4320000-0000-0000-0000-000000000001';
INSERT INTO public.unread_counts (user_id, server_id, channel_id, unread_messages)
VALUES ('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
        'f4320000-0000-0000-0000-000000000002', 4)
ON CONFLICT DO NOTHING;

-- Conversations.
INSERT INTO public.conversations (id, type, name) VALUES
  ('f4330000-0000-0000-0000-000000000001', 'direct', NULL),
  ('f4330000-0000-0000-0000-000000000002', 'direct', NULL),
  ('f4330000-0000-0000-0000-000000000003', 'direct', NULL),
  ('f4330000-0000-0000-0000-000000000004', 'group', 'crew43');
INSERT INTO public.conversation_participants (conversation_id, user_id, joined_at, left_at) VALUES
  ('f4330000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', now() - interval '2 days', NULL),
  ('f4330000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', now() - interval '2 days', NULL),
  ('f4330000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', now() - interval '2 days', NULL),
  ('f4330000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', now() - interval '2 days', NULL),
  ('f4330000-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', now() - interval '2 days', NULL),
  ('f4330000-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', now() - interval '2 days', NULL),
  ('f4330000-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001', now() - interval '2 days', NULL),
  ('f4330000-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000002', now() - interval '2 days', now() - interval '1 day');
INSERT INTO public.messages (id, conversation_id, user_id, content, created_at, encrypted) VALUES
  ('f4340000-0000-0000-0000-000000000011', 'f4330000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"plain dm"}]', now() - interval '10 minutes', false),
  ('f4340000-0000-0000-0000-000000000012', 'f4330000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"CIPHERTEXT43"}]', now() - interval '5 minutes', true),
  ('f4340000-0000-0000-0000-000000000013', 'f4330000-0000-0000-0000-000000000002',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"muted dm"}]', now() - interval '15 minutes', false),
  ('f4340000-0000-0000-0000-000000000014', 'f4330000-0000-0000-0000-000000000003',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"dismissed dm"}]', now() - interval '20 minutes', false),
  ('f4340000-0000-0000-0000-000000000015', 'f4330000-0000-0000-0000-000000000004',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"group"}]', now() - interval '25 minutes', false);
INSERT INTO public.unread_counts (user_id, conversation_id, unread_messages)
SELECT '22222222-0000-0000-0000-000000000002', c.id, 1
  FROM (VALUES ('f4330000-0000-0000-0000-000000000001'::uuid), ('f4330000-0000-0000-0000-000000000002'::uuid),
               ('f4330000-0000-0000-0000-000000000003'::uuid), ('f4330000-0000-0000-0000-000000000004'::uuid)) c(id)
ON CONFLICT DO NOTHING;
INSERT INTO public.notification_channels (user_id, conversation_id, muted)
VALUES ('22222222-0000-0000-0000-000000000002', 'f4330000-0000-0000-0000-000000000002', true);
UPDATE public.conversation_participants SET hidden_at = now()
 WHERE conversation_id = 'f4330000-0000-0000-0000-000000000003'
   AND user_id = '22222222-0000-0000-0000-000000000002';

-- Threads.
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by) VALUES
  ('f4350000-0000-0000-0000-000000000001', 'f4320000-0000-0000-0000-000000000001',
   'f4340000-0000-0000-0000-000000000001', 'plans43', '22222222-0000-0000-0000-000000000002'),
  ('f4350000-0000-0000-0000-000000000002', 'f4320000-0000-0000-0000-000000000002',
   'f4340000-0000-0000-0000-000000000005', 'hidden thread43', '22222222-0000-0000-0000-000000000002'),
  ('f4350000-0000-0000-0000-000000000003', 'f4320000-0000-0000-0000-000000000001',
   'f4340000-0000-0000-0000-000000000002', 'muted thread43', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.thread_members (thread_id, user_id, joined_at, muted) VALUES
  ('f4350000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', now() - interval '6 hours', false),
  ('f4350000-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', now() - interval '6 hours', true);
INSERT INTO public.messages (id, channel_id, thread_id, user_id, content, created_at) VALUES
  ('f4340000-0000-0000-0000-000000000021', 'f4320000-0000-0000-0000-000000000001', 'f4350000-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob in thread"}]', now() - interval '3 hours'),
  ('f4340000-0000-0000-0000-000000000022', 'f4320000-0000-0000-0000-000000000001', 'f4350000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"first reply"}]', now() - interval '2 hours'),
  ('f4340000-0000-0000-0000-000000000023', 'f4320000-0000-0000-0000-000000000001', 'f4350000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"second reply"}]', now() - interval '1 hour'),
  ('f4340000-0000-0000-0000-000000000024', 'f4320000-0000-0000-0000-000000000002', 'f4350000-0000-0000-0000-000000000002',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"hidden thread reply"}]', now() - interval '1 hour'),
  ('f4340000-0000-0000-0000-000000000025', 'f4320000-0000-0000-0000-000000000001', 'f4350000-0000-0000-0000-000000000003',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"muted thread reply"}]', now() - interval '1 hour');
-- The member row written by bob's post carries the transaction's now(); the post is older.
UPDATE public.thread_members SET joined_at = now() - interval '3 hours 1 minute'
 WHERE thread_id = 'f4350000-0000-0000-0000-000000000001'
   AND user_id = '22222222-0000-0000-0000-000000000002';

-- Voice.
INSERT INTO public.voice_channel_participants (channel_id, user_id, server_id, joined_at) VALUES
  ('f4320000-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000005', now() - interval '10 minutes'),
  ('f4320000-0000-0000-0000-000000000003', 'f4300000-0000-0000-0000-0000000000c1',
   '55555555-0000-0000-0000-000000000005', now() - interval '13 hours'),
  ('f4320000-0000-0000-0000-000000000004', '33333333-0000-0000-0000-000000000003',
   '55555555-0000-0000-0000-000000000005', now() - interval '5 minutes');

-- Follows.
INSERT INTO public.follows (follower_id, following_id, status, created_at, accepted_at) VALUES
  ('f4300000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', 'pending', now() - interval '2 hours', NULL),
  ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'accepted', now() - interval '1 hour', now() - interval '1 hour'),
  ('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', 'accepted', now() - interval '3 days', now() - interval '3 days'),
  ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'accepted', now() - interval '10 days', now() - interval '10 days');

-- Posts.
INSERT INTO public.posts (id, author_id, content, visibility, created_at, in_reply_to, favorites_count) VALUES
  ('f4360000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"popular"}]', 'public', now() - interval '2 hours', NULL, 10),
  ('f4360000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"followers only"}]', 'followers', now() - interval '3 hours', NULL, 0),
  ('f4360000-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"direct"}]', 'direct', now() - interval '1 hour', NULL, 0),
  ('f4360000-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"self reply"}]', 'public', now() - interval '1 hour', 'f4360000-0000-0000-0000-000000000001', 0),
  ('f4360000-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000003',
   '[{"type":"text","text":"not followed"}]', 'public', now() - interval '1 hour', NULL, 50),
  ('f4360000-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"too old"}]', 'public', now() - interval '3 days', NULL, 99);

-- Social notifications.
INSERT INTO public.notifications (user_id, type, data) VALUES
  ('22222222-0000-0000-0000-000000000002', 'activitypub_favorite', '{"post_id":"f4360000-0000-0000-0000-000000000001"}'),
  ('22222222-0000-0000-0000-000000000002', 'activitypub_mention', '{"post_id":"f4360000-0000-0000-0000-000000000001"}');

-- Announcements.
INSERT INTO public.instance_announcements (id, title, content, is_pinned, starts_at) VALUES
  ('f4370000-0000-0000-0000-000000000001', 'pinned43', 'p', true, '2000-01-01'),
  ('f4370000-0000-0000-0000-000000000002', 'ancient43', 'a', false, '2000-01-01'),
  ('f4370000-0000-0000-0000-000000000003', 'read43', 'r', false, now()),
  ('f4370000-0000-0000-0000-000000000004', 'fresh43', 'f', false, now());
INSERT INTO public.announcement_reads (announcement_id, user_id)
VALUES ('f4370000-0000-0000-0000-000000000003', 'f4300000-0000-0000-0000-0000000000c1');

-- GRANTS AND SECURITY --------------------------------------------------------------------
SELECT is((SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.get_today_summary(timestamp with time zone)'::regprocedure),
          false, 'get_today_summary runs as the caller');
SELECT ok(NOT has_function_privilege('anon', 'public.get_today_summary(timestamp with time zone)', 'EXECUTE')
          AND NOT has_function_privilege('service_role', 'public.get_today_summary(timestamp with time zone)', 'EXECUTE'),
          'anon and service_role cannot call get_today_summary');
SELECT ok(has_function_privilege('authenticated', 'public.get_today_summary(timestamp with time zone)', 'EXECUTE'),
          'authenticated can call get_today_summary');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.get_today_summary()$q$, '42501', NULL, 'anon is refused');

SELECT tests.authenticate_as('f4300000-0000-0000-0000-0000000000d1');
SELECT is(public.get_today_summary(), NULL, 'a caller without a profile gets NULL');

-- BOB ------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
CREATE TEMP TABLE s43 ON COMMIT DROP AS SELECT public.get_today_summary() AS j;

SELECT results_eq(
    $q$SELECT e->'message'->>'id', e->>'kind', (e->>'unread')::boolean
         FROM s43, jsonb_array_elements(j->'mentions') e
        WHERE e->'message'->>'id' LIKE 'f434%'$q$,
    $q$VALUES ('f4340000-0000-0000-0000-000000000003', 'reply', true),
              ('f4340000-0000-0000-0000-000000000002', 'mention', true)$q$,
    'mentions: a visible mention and a reply to the caller, newest first, both unread');
SELECT is((SELECT count(*)::int FROM s43, jsonb_array_elements(j->'mentions') e
            WHERE e->'message'->>'id' IN ('f4340000-0000-0000-0000-000000000004', 'f4340000-0000-0000-0000-000000000006')),
          0, 'mentions: nothing from a channel VIEW_CHANNEL hides, notification or reply');
SELECT is((SELECT count(*)::int FROM s43, jsonb_array_elements(j->'mentions') e
            WHERE e->'message'->>'id' IN ('f4340000-0000-0000-0000-000000000007', 'f4340000-0000-0000-0000-000000000008')),
          0, 'mentions: nothing older than 14 days or deleted');
SELECT results_eq(
    $q$SELECT e->>'channel_name', e->'server'->>'name', e->'author'->>'username'
         FROM s43, jsonb_array_elements(j->'mentions') e
        WHERE e->'message'->>'id' = 'f4340000-0000-0000-0000-000000000002'$q$,
    $q$VALUES ('open43', 'Test Server', 'alice')$q$,
    'mentions carry channel, server and author');

-- Read up to 90 minutes ago: M2 (-2h) is read, M3 (-1h) is not.
SELECT tests.clear_authentication();
UPDATE public.unread_counts SET last_read_at = now() - interval '90 minutes'
 WHERE user_id = '22222222-0000-0000-0000-000000000002'
   AND channel_id = 'f4320000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT results_eq(
    $q$SELECT e->'message'->>'id', (e->>'unread')::boolean
         FROM jsonb_array_elements(public.get_today_summary()->'mentions') e
        WHERE e->'message'->>'id' LIKE 'f434%'$q$,
    $q$VALUES ('f4340000-0000-0000-0000-000000000003', true),
              ('f4340000-0000-0000-0000-000000000002', false)$q$,
    'unread follows the channel read position');

SELECT tests.clear_authentication();
UPDATE public.unread_counts SET last_read_at = now() - interval '4 hours'
 WHERE user_id = '22222222-0000-0000-0000-000000000002'
   AND channel_id = 'f4320000-0000-0000-0000-000000000001';
UPDATE public.notifications SET is_read = true
 WHERE user_id = '22222222-0000-0000-0000-000000000002'
   AND data->>'message_id' = 'f4340000-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT (e->>'unread')::boolean
             FROM jsonb_array_elements(public.get_today_summary()->'mentions') e
            WHERE e->'message'->>'id' = 'f4340000-0000-0000-0000-000000000002'),
          false, 'a mention whose notification is read is not unread');

SELECT set_eq(
    $q$SELECT e->>'id' FROM s43, jsonb_array_elements(j->'conversations') e WHERE e->>'id' LIKE 'f433%'$q$,
    ARRAY['f4330000-0000-0000-0000-000000000001'],
    'conversations: not muted, not dismissed, not left');
SELECT results_eq(
    $q$SELECT e->'last_message'->>'id', (e->'last_message'->>'encrypted')::boolean,
              (e->>'participant_count')::int, e->'participants'->0->>'username'
         FROM s43, jsonb_array_elements(j->'conversations') e
        WHERE e->>'id' = 'f4330000-0000-0000-0000-000000000001'$q$,
    $q$VALUES ('f4340000-0000-0000-0000-000000000012', true, 2, 'alice')$q$,
    'a conversation carries its latest message with its encrypted flag, and the other participants');

SELECT ok((SELECT bool_or(c->>'id' = 'f4320000-0000-0000-0000-000000000001')
             FROM s43, jsonb_array_elements(j->'servers') s, jsonb_array_elements(s->'channels') c),
          'servers: an unread open channel is listed');
SELECT ok(NOT (SELECT bool_or(c->>'id' = 'f4320000-0000-0000-0000-000000000002')
                 FROM s43, jsonb_array_elements(j->'servers') s, jsonb_array_elements(s->'channels') c),
          'servers: an unread row for a hidden channel is not');
SELECT is((SELECT (j->'totals'->>'channels')::int FROM s43),
          (SELECT count(*)::int FROM s43, jsonb_array_elements(j->'servers') s, jsonb_array_elements(s->'channels') c),
          'totals.channels counts the listed channels');

SELECT set_eq(
    $q$SELECT e->>'id' FROM s43, jsonb_array_elements(j->'threads') e$q$,
    ARRAY['f4350000-0000-0000-0000-000000000001'],
    'threads: not hidden, not muted');
SELECT results_eq(
    $q$SELECT (e->>'new_replies')::int, e->'repliers'->0->>'username', e->>'channel_name'
         FROM s43, jsonb_array_elements(j->'threads') e$q$,
    $q$VALUES (2, 'alice', 'open43')$q$,
    'a thread counts replies from others after the caller last posted');

SELECT results_eq(
    $q$SELECT e->>'channel_id', (e->>'participant_count')::int, (e->>'includes_me')::boolean,
              e->'participants'->0->>'username'
         FROM s43, jsonb_array_elements(j->'voice') e$q$,
    $q$VALUES ('f4320000-0000-0000-0000-000000000003', 1, false, 'alice')$q$,
    'voice: visible channels only, rows older than 12 hours left out');

SELECT results_eq(
    $q$SELECT (j->'totals'->>'follow_requests')::int, j->'follow_requests'->0->>'username' FROM s43$q$,
    $q$VALUES (1, 'carol43')$q$,
    'follow requests');
SELECT set_eq(
    $q$SELECT e->>'username' FROM s43, jsonb_array_elements(j->'new_followers') e$q$,
    ARRAY['alice'],
    'new followers default to the last day');
SELECT set_eq(
    $q$SELECT e->>'username' FROM jsonb_array_elements(public.get_today_summary(now() - interval '5 days')->'new_followers') e$q$,
    ARRAY['alice', 'mallory'],
    'p_since widens the window');
SELECT results_eq(
    $q$SELECT (j->>'since')::timestamptz, jsonb_array_length(j->'new_followers')
         FROM (SELECT public.get_today_summary(now()) AS j) x$q$,
    $q$VALUES (now() - interval '12 hours', 1)$q$,
    'p_since is clamped to at least 12 hours back');
SELECT is((SELECT (public.get_today_summary(now() - interval '30 days')->>'since')::timestamptz),
          now() - interval '7 days', 'p_since is clamped to at most 7 days back');

SELECT is((SELECT (j->'social'->'unread'->>'activitypub_favorite')::int FROM s43), 1,
          'social counts unread favourites');
SELECT results_eq(
    $q$SELECT e->>'type', e->'post'->>'id', e->'author'->>'username'
         FROM s43, jsonb_array_elements(j->'social'->'items') e$q$,
    $q$VALUES ('activitypub_mention', 'f4360000-0000-0000-0000-000000000001', 'alice')$q$,
    'social items carry the post and its author');

SELECT results_eq(
    $q$SELECT e->>'id' FROM s43, jsonb_array_elements(j->'followed_posts') e$q$,
    $q$VALUES ('f4360000-0000-0000-0000-000000000001'), ('f4360000-0000-0000-0000-000000000002')$q$,
    'followed posts: top-level, visible, in the window, ranked');

SELECT set_eq(
    $q$SELECT e->>'title' FROM s43, jsonb_array_elements(j->'announcements') e$q$,
    ARRAY['pinned43', 'read43', 'fresh43'],
    'announcements: unread, and older than the profile only when pinned');

-- CAROL ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('f4300000-0000-0000-0000-0000000000c1');
SELECT set_eq(
    $q$SELECT e->>'title' FROM jsonb_array_elements(public.get_today_summary()->'announcements') e$q$,
    ARRAY['pinned43', 'fresh43'],
    'an announcement the caller read is left out');
SELECT is(jsonb_array_length(public.get_today_summary()->'voice'), 0,
          'a caller in no server sees no voice channel');

-- ALICE ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT results_eq(
    $q$SELECT e->>'channel_id', (e->>'includes_me')::boolean
         FROM jsonb_array_elements(public.get_today_summary()->'voice') e$q$,
    $q$VALUES ('f4320000-0000-0000-0000-000000000003', true),
              ('f4320000-0000-0000-0000-000000000004', false)$q$,
    'the owner sees the hidden voice channel; the caller''s own channel leads');

-- MALLORY --------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT results_eq(
    $q$SELECT jsonb_array_length(j->'mentions'), jsonb_array_length(j->'conversations'),
              jsonb_array_length(j->'servers'), jsonb_array_length(j->'threads'),
              jsonb_array_length(j->'voice')
         FROM (SELECT public.get_today_summary() AS j) x$q$,
    $q$VALUES (0, 0, 0, 0, 0)$q$,
    'a user in no server gets empty chat sections, their own voice row included');

SELECT * FROM finish();
ROLLBACK;
