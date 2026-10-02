-- 20261005900001_security_hotfix_client_definers.sql: service-only definers, the
-- add_user_to_conversation and create_federated_profile client paths, and the
-- delivery-queue, endpoint-health and user_media policies.
--
--   alice, bob   participants of group G and of the fixture DM
--   mallory      in no conversation
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(28);

-- Service-only functions: no client EXECUTE. ------------------------------------------
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('get_or_create_dm_conversation', 'get_or_create_federated_group_conversation',
                       'safe_upsert_remote_profile', 'update_post_embeds', 'broadcast_user_event',
                       'create_federated_emoji', 'upsert_remote_emoji', 'upsert_ap_activity',
                       'claim_ap_activity', 'complete_ap_activity', 'update_endpoint_health',
                       'update_federation_health', 'touch_federated_instance', 'cleanup_old_metrics',
                       'aggregate_hourly_metrics', 'record_slow_query',
                       'check_and_increment_bot_rate_limit', 'check_key_consistency')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  'service-only definers are not executable by anon or authenticated');
SELECT ok(has_function_privilege('service_role', 'public.get_or_create_dm_conversation(uuid, uuid)', 'EXECUTE'),
  'service_role keeps get_or_create_dm_conversation');
SELECT ok(NOT has_function_privilege('anon', 'public.add_user_to_conversation(uuid, uuid, text)', 'EXECUTE'),
  'anon cannot call add_user_to_conversation');
SELECT ok(NOT has_function_privilege('anon',
  'public.create_federated_profile(text, text, text, text, text, text, text, text, text, text, text, text, text)', 'EXECUTE'),
  'anon cannot call create_federated_profile');

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO public.conversations (id, type, name) VALUES
  ('f6500000-0000-0000-0000-000000000001', 'group', 'G'),
  ('f6500000-0000-0000-0000-000000000002', 'direct', NULL);
INSERT INTO public.conversation_participants (conversation_id, user_id, role) VALUES
  ('f6500000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'admin'),
  ('f6500000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'member'),
  ('f6500000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'member'),
  ('f6500000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', 'member');
INSERT INTO public.profiles (id, username, display_name, domain, is_local, federated_id, public_key, inbox_url)
VALUES ('f6510000-0000-0000-0000-000000000001', 'remote', 'Remote', 'remote.example', false,
        'https://remote.example/users/remote', 'REAL-KEY', 'https://remote.example/users/remote/inbox');
-- add_user_to_conversation. ------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.add_user_to_conversation('f6500000-0000-0000-0000-000000000001',
                   '33333333-0000-0000-0000-000000000003')$q$,
  '42501', NULL, 'a non-participant cannot add themselves to a group');
SELECT throws_ok($q$SELECT public.add_user_to_conversation('f6500000-0000-0000-0000-000000000002',
                   '33333333-0000-0000-0000-000000000003')$q$,
  '42501', NULL, 'a non-participant cannot add themselves to a DM');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.add_user_to_conversation('f6500000-0000-0000-0000-000000000002',
                   '33333333-0000-0000-0000-000000000003')$q$,
  '42501', NULL, 'a DM participant cannot add a third person to the DM');
SELECT isnt(public.add_user_to_conversation('f6500000-0000-0000-0000-000000000001',
              '33333333-0000-0000-0000-000000000003', 'admin'), NULL,
  'a group participant adds a member');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.add_user_to_conversation('f6500000-0000-0000-0000-000000000001',
                  '22222222-0000-0000-0000-000000000002', 'admin')$q$,
  'a participant re-adding themselves succeeds');
SELECT tests.clear_authentication();

SELECT is((SELECT role FROM public.conversation_participants
            WHERE conversation_id = 'f6500000-0000-0000-0000-000000000001'
              AND user_id = '33333333-0000-0000-0000-000000000003'),
  'member', 'a client-added participant is a member whatever role was asked');
SELECT is((SELECT role FROM public.conversation_participants
            WHERE conversation_id = 'f6500000-0000-0000-0000-000000000001'
              AND user_id = '22222222-0000-0000-0000-000000000002'),
  'member', 'a client cannot raise an existing role');
SELECT is((SELECT role FROM public.conversation_participants
            WHERE conversation_id = 'f6500000-0000-0000-0000-000000000001'
              AND user_id = '11111111-0000-0000-0000-000000000001'),
  'admin', 'other participants keep their roles');

SELECT lives_ok($q$SELECT public.add_user_to_conversation('f6500000-0000-0000-0000-000000000002',
                  '33333333-0000-0000-0000-000000000003', 'member')$q$,
  'service and definer callers keep the unrestricted path');
SELECT ok(EXISTS (SELECT 1 FROM public.conversation_participants
                   WHERE conversation_id = 'f6500000-0000-0000-0000-000000000002'
                     AND user_id = '33333333-0000-0000-0000-000000000003'),
  'the service path wrote the row');

-- create_federated_profile. --------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.create_federated_profile(
            p_username => 'remote', p_domain => 'remote.example',
            p_federated_id => 'https://remote.example/users/remote',
            p_public_key => 'FORGED-KEY', p_inbox_url => 'https://evil.example/inbox',
            p_display_name => 'Forged'),
  'f6510000-0000-0000-0000-000000000001'::uuid,
  'a client call for an existing profile returns it');
SELECT is(public.create_federated_profile(
            p_username => 'someone', p_domain => 'remote.example',
            p_federated_id => 'https://remote.example/users/remote',
            p_public_key => 'FORGED-KEY'),
  'f6510000-0000-0000-0000-000000000001'::uuid,
  'a client call naming an existing federated_id returns that profile');
SELECT throws_ok($q$SELECT public.create_federated_profile(p_username => 'x', p_domain => 'a.example',
                   p_federated_id => 'https://b.example/users/x')$q$,
  '22023', NULL, 'a federated_id on another domain is refused');
SELECT throws_ok($q$SELECT public.create_federated_profile(p_username => 'x', p_domain => 'a.example',
                   p_federated_id => 'http://a.example/users/x')$q$,
  '22023', NULL, 'a non-https federated_id is refused');
SELECT isnt(public.create_federated_profile(
              p_username => 'newbie', p_domain => 'new.example', p_display_name => 'New',
              p_federated_id => 'https://new.example/users/newbie',
              p_public_key => 'CLIENT-KEY', p_inbox_url => 'https://evil.example/inbox'),
  NULL, 'a client creates a missing remote profile');
SELECT tests.clear_authentication();

SELECT is((SELECT public_key || '|' || inbox_url || '|' || display_name FROM public.profiles
            WHERE id = 'f6510000-0000-0000-0000-000000000001'),
  'REAL-KEY|https://remote.example/users/remote/inbox|Remote',
  'client calls leave an existing profile untouched');
SELECT is((SELECT row(public_key, inbox_url, is_local)::text FROM public.profiles
            WHERE username = 'newbie' AND domain = 'new.example'),
  '(,,f)', 'a client-created profile carries no key or inbox');

SELECT is(public.create_federated_profile(
            p_username => 'newbie', p_domain => 'new.example',
            p_federated_id => 'https://new.example/users/newbie',
            p_public_key => 'FETCHED-KEY', p_inbox_url => 'https://new.example/users/newbie/inbox'),
  (SELECT id FROM public.profiles WHERE username = 'newbie' AND domain = 'new.example'),
  'the service path upserts');
SELECT is((SELECT public_key FROM public.profiles WHERE username = 'newbie' AND domain = 'new.example'),
  'FETCHED-KEY', 'the service path writes the fetched key');

-- federation_delivery_queue and federation_endpoint_health. --------------------------
-- Catalog checks: staging's queue table carries NOT NULL columns production lacks.
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = 'federation_delivery_queue'
                         AND cmd IN ('SELECT', 'ALL') AND qual = 'true'
                         AND roles && ARRAY['public', 'anon', 'authenticated']::name[]),
  'no client policy reads every delivery-queue row');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = 'federation_delivery_queue'
                     AND policyname = 'Admins can view federation delivery queue'
                     AND qual LIKE '%is_current_user_admin%'),
  'instance admins read the delivery queue');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = 'federation_endpoint_health'
                         AND cmd IN ('INSERT', 'ALL')
                         AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
                         AND coalesce(with_check, qual, '') NOT LIKE '%service_role%'),
  'clients insert no endpoint-health rows');

-- storage user_media. --------------------------------------------------------------------
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage'
                       AND policyname = 'Public read access for user_media'),
  'user_media has no public SELECT policy');
SELECT is((SELECT qual LIKE '%foldername%' FROM pg_policies WHERE schemaname = 'storage'
            AND policyname = 'Users can read their own user_media'),
  true, 'user_media SELECT is limited to the caller''s folder');

SELECT * FROM finish();
ROLLBACK;
