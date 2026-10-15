-- 20261016100006_federation_fixes.sql: Group actor keys, the Group-signed delivery queue
-- column and nodeinfo_active_users.
--
--   act_signin    signed in 10 days ago
--   act_session   auth session refreshed 10 days ago
--   act_post      posted 10 days ago
--   act_message   sent a channel message 10 days ago
--   act_old       signed in 100 days ago: active in the half year, not the month
--   act_stale     signed in, posted and messaged 400 days ago
--   act_susp      suspended, posted 10 days ago
--   act_deleted   deleted, signed in 10 days ago
--   act_noauth    local profile without an auth user, posted 10 days ago
--   act_remote    remote profile, posted 10 days ago
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

-- Group actor keys. -------------------------------------------------------------------
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.server_actor_keys'::regclass),
  'server_actor_keys has row level security');
SELECT ok(NOT has_table_privilege('anon', 'public.server_actor_keys', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.server_actor_keys', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.server_actor_keys', 'INSERT'),
  'anon and authenticated cannot read or write Group keys');
SELECT ok(has_table_privilege('service_role', 'public.server_actor_keys', 'SELECT,INSERT'),
  'service_role reads and stores Group keys');

INSERT INTO public.servers (id, name, owner)
VALUES ('f1520000-0000-0000-0000-000000000001', 'Keyed 152', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.server_actor_keys (server_id, public_key, private_key)
VALUES ('f1520000-0000-0000-0000-000000000001', 'PUBLIC', 'PRIVATE');
INSERT INTO public.federation_delivery_queue (target_inbox_url, target_domain, activity_data, sender_server_id)
VALUES ('https://r152.example/inbox', 'r152.example', '{"type":"Accept"}', 'f1520000-0000-0000-0000-000000000001');

SELECT is((SELECT count(*)::int FROM public.federation_delivery_queue
            WHERE sender_server_id = 'f1520000-0000-0000-0000-000000000001' AND sender_id IS NULL), 1,
  'a delivery queues under a Group signer with no profile sender');

DELETE FROM public.servers WHERE id = 'f1520000-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM public.server_actor_keys
            WHERE server_id = 'f1520000-0000-0000-0000-000000000001'), 0,
  'a deleted server takes its Group key with it');
SELECT is((SELECT count(*)::int FROM public.federation_delivery_queue
            WHERE target_inbox_url = 'https://r152.example/inbox'), 0,
  'and its queued Group-signed deliveries');

-- nodeinfo_active_users. ---------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.nodeinfo_active_users(timestamptz)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.nodeinfo_active_users(timestamptz)', 'EXECUTE'),
  'anon and authenticated cannot count active users');
SELECT ok(has_function_privilege('service_role', 'public.nodeinfo_active_users(timestamptz)', 'EXECUTE'),
  'service_role counts active users');

CREATE TEMP TABLE base152 AS
SELECT public.nodeinfo_active_users(now() - interval '30 days') AS month,
       public.nodeinfo_active_users(now() - interval '180 days') AS halfyear,
       public.nodeinfo_active_users(now() - interval '500 days') AS ever;

INSERT INTO auth.users (id, instance_id, aud, role, email, last_sign_in_at)
SELECT ('f1520000-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'act' || n || '@test152.local',
       CASE n WHEN 1 THEN now() - interval '10 days'
              WHEN 5 THEN now() - interval '100 days'
              WHEN 6 THEN now() - interval '400 days'
              WHEN 8 THEN now() - interval '10 days' END
  FROM generate_series(1, 8) n;

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_suspended, deleted_at)
VALUES
  ('f1520000-0000-0000-0002-000000000001', 'f1520000-0000-0000-0001-000000000001', 'act_signin',  'A', true, false, NULL),
  ('f1520000-0000-0000-0002-000000000002', 'f1520000-0000-0000-0001-000000000002', 'act_session', 'A', true, false, NULL),
  ('f1520000-0000-0000-0002-000000000003', 'f1520000-0000-0000-0001-000000000003', 'act_post',    'A', true, false, NULL),
  ('f1520000-0000-0000-0002-000000000004', 'f1520000-0000-0000-0001-000000000004', 'act_message', 'A', true, false, NULL),
  ('f1520000-0000-0000-0002-000000000005', 'f1520000-0000-0000-0001-000000000005', 'act_old',     'A', true, false, NULL),
  ('f1520000-0000-0000-0002-000000000006', 'f1520000-0000-0000-0001-000000000006', 'act_stale',   'A', true, false, NULL),
  ('f1520000-0000-0000-0002-000000000007', 'f1520000-0000-0000-0001-000000000007', 'act_susp',    'A', true, true,  NULL),
  ('f1520000-0000-0000-0002-000000000008', 'f1520000-0000-0000-0001-000000000008', 'act_deleted', 'A', true, false, now()),
  ('f1520000-0000-0000-0002-000000000009', NULL,                                   'act_noauth',  'A', true, false, NULL);
INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, inbox_url)
VALUES ('f1520000-0000-0000-0002-000000000010', 'act_remote', 'A', false, 'r152.example',
        'https://r152.example/users/act_remote', 'https://r152.example/users/act_remote/inbox');

INSERT INTO auth.sessions (id, user_id, created_at, updated_at, refreshed_at, aal)
VALUES ('f1520000-0000-0000-0003-000000000002', 'f1520000-0000-0000-0001-000000000002',
        now() - interval '300 days', now() - interval '300 days',
        (now() - interval '10 days') AT TIME ZONE 'UTC', 'aal1');

INSERT INTO public.posts (author_id, content, visibility, is_local, created_at)
SELECT ('f1520000-0000-0000-0002-' || lpad(n::text, 12, '0'))::uuid,
       '[{"type":"text","text":"active"}]'::jsonb, 'public', n <> 10,
       CASE n WHEN 6 THEN now() - interval '400 days' ELSE now() - interval '10 days' END
  FROM unnest(ARRAY[3, 6, 7, 9, 10]) n;

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1520000-0000-0000-0002-000000000004', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1520000-0000-0000-0002-000000000006', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO public.messages (channel_id, user_id, content, created_at) VALUES
  ('66666666-0000-0000-0000-000000000006', 'f1520000-0000-0000-0002-000000000004',
   '[{"type":"text","text":"active"}]'::jsonb, now() - interval '10 days'),
  ('66666666-0000-0000-0000-000000000006', 'f1520000-0000-0000-0002-000000000006',
   '[{"type":"text","text":"stale"}]'::jsonb, now() - interval '400 days');

SELECT is(public.nodeinfo_active_users(now() - interval '30 days') - (SELECT month FROM base152), 4::bigint,
  'the month counts a sign-in, a session refresh, a post and a message');
SELECT is(public.nodeinfo_active_users(now() - interval '180 days') - (SELECT halfyear FROM base152), 5::bigint,
  'the half year adds the sign-in 100 days ago');
SELECT is(public.nodeinfo_active_users(now() - interval '500 days') - (SELECT ever FROM base152), 6::bigint,
  'activity 400 days ago counts only in a window reaching it');
SELECT ok(public.nodeinfo_active_users(now() - interval '30 days')
          < public.nodeinfo_active_users(now() - interval '500 days'),
  'a wider window counts more accounts than a narrower one');
SELECT is((SELECT count(*)::int FROM public.posts
            WHERE author_id IN ('f1520000-0000-0000-0002-000000000007', 'f1520000-0000-0000-0002-000000000009',
                                'f1520000-0000-0000-0002-000000000010')), 3,
  'the suspended, unauthenticated and remote authors posted and are not counted');
SELECT is(public.nodeinfo_active_users(NULL), 0::bigint, 'no window counts nobody');

SELECT * FROM finish();
ROLLBACK;
