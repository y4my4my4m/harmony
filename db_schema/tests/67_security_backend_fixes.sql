-- 20261006600001_security_backend_fixes.sql: federated call expiry, thread stubs,
-- suspension cleanup and the bot_server_permissions columns.
--
--   r67    remote profile: caller of the federated calls, a member of server_1
--   r67b   remote profile on another host
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(29);

-- Privileges. ---------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.cleanup_expired_voice_calls()', 'EXECUTE'),
  'anon cannot run cleanup_expired_voice_calls');
SELECT ok(NOT has_function_privilege('authenticated', 'public.cleanup_expired_voice_calls()', 'EXECUTE'),
  'authenticated cannot run cleanup_expired_voice_calls');
SELECT ok(has_function_privilege('service_role', 'public.cleanup_expired_voice_calls()', 'EXECUTE'),
  'service_role runs cleanup_expired_voice_calls');
SELECT ok(NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.cleanup_expired_voice_calls()'::regprocedure),
  'cleanup_expired_voice_calls is SECURITY INVOKER');
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']
             FROM pg_proc WHERE oid = 'public.handle_remote_user_suspension()'::regprocedure),
  'handle_remote_user_suspension is a definer with a pinned search_path');
SELECT ok((SELECT proconfig @> ARRAY['search_path=public, pg_temp']
             FROM pg_proc WHERE oid = 'public.trigger_queue_thread_federation()'::regprocedure),
  'trigger_queue_thread_federation pins its search_path');
SELECT ok(NOT has_function_privilege('authenticated', 'public.handle_remote_user_suspension()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.trigger_queue_thread_federation()', 'EXECUTE'),
  'clients hold no EXECUTE on the trigger functions');

SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
  THEN ok(EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-federated-voice-calls'
                    AND schedule = '* * * * *' AND command = 'SELECT public.cleanup_expired_voice_calls()'),
          'expiry runs every minute')
  ELSE pass('pg_cron absent; expiry is not scheduled')
END;

-- bot_server_permissions. ---------------------------------------------------------------
SELECT has_column('public', 'bot_server_permissions', 'manage_roles', 'bot installs carry manage_roles');
SELECT col_default_is('public', 'bot_server_permissions', 'manage_roles', 'false',
  'no install gains role management by default');
SELECT has_column('public', 'bot_server_permissions', 'allowed_channel_ids', 'bot installs carry allowed_channel_ids');

-- Fixture rows. -------------------------------------------------------------------------
INSERT INTO public.profiles (id, username, display_name, domain, is_local, federated_id) VALUES
  ('67000000-0000-0000-0000-0000000000a1', 'r67', 'R67', 'remote.example', false, 'https://remote.example/users/r67'),
  ('67000000-0000-0000-0000-0000000000a2', 'r67b', 'R67b', 'other.example', false, 'https://other.example/users/r67b');

-- Call expiry. --------------------------------------------------------------------------
INSERT INTO public.federated_voice_calls
  (id, ap_id, caller_id, caller_federated_id, recipient_id, call_type, livekit_url, room_name,
   status, created_at, accepted_at, ended_at, expires_at)
VALUES
  ('67100000-0000-0000-0000-000000000001', 'https://remote.example/a/1', '67000000-0000-0000-0000-0000000000a1',
   'https://remote.example/users/r67', '11111111-0000-0000-0000-000000000001', 'voice', 'wss://lk', 'r1',
   'pending', now() - interval '2 minutes', NULL, NULL, now() - interval '1 minute'),
  ('67100000-0000-0000-0000-000000000002', 'https://remote.example/a/2', '67000000-0000-0000-0000-0000000000a1',
   'https://remote.example/users/r67', '11111111-0000-0000-0000-000000000001', 'voice', 'wss://lk', 'r2',
   'pending', now(), NULL, NULL, now() + interval '1 minute'),
  ('67100000-0000-0000-0000-000000000003', 'https://remote.example/a/3', '67000000-0000-0000-0000-0000000000a1',
   'https://remote.example/users/r67', '11111111-0000-0000-0000-000000000001', 'voice', 'wss://lk', 'r3',
   'accepted', now() - interval '5 hours', now() - interval '5 hours', NULL, now() - interval '5 hours'),
  ('67100000-0000-0000-0000-000000000004', 'https://remote.example/a/4', '67000000-0000-0000-0000-0000000000a1',
   'https://remote.example/users/r67', '11111111-0000-0000-0000-000000000001', 'voice', 'wss://lk', 'r4',
   'accepted', now() - interval '10 minutes', now() - interval '9 minutes', NULL, now() - interval '9 minutes'),
  ('67100000-0000-0000-0000-000000000005', 'https://remote.example/a/5', '67000000-0000-0000-0000-0000000000a1',
   'https://remote.example/users/r67', '11111111-0000-0000-0000-000000000001', 'voice', 'wss://lk', 'r5',
   'ended', now() - interval '9 days', now() - interval '9 days', now() - interval '8 days', now() - interval '9 days'),
  ('67100000-0000-0000-0000-000000000006', 'https://remote.example/a/6', '67000000-0000-0000-0000-0000000000a1',
   'https://remote.example/users/r67', '11111111-0000-0000-0000-000000000001', 'voice', 'wss://lk', 'r6',
   'rejected', now() - interval '1 day', NULL, now() - interval '1 day', now() - interval '1 day');

SELECT public.cleanup_expired_voice_calls();

SELECT is((SELECT status FROM public.federated_voice_calls WHERE id = '67100000-0000-0000-0000-000000000001'),
  'expired', 'an unanswered ring past expires_at expires');
SELECT is((SELECT status FROM public.federated_voice_calls WHERE id = '67100000-0000-0000-0000-000000000002'),
  'pending', 'a ring before expires_at keeps ringing');
SELECT is((SELECT status FROM public.federated_voice_calls WHERE id = '67100000-0000-0000-0000-000000000003'),
  'ended', 'an accepted call ends 4 h after acceptance');
SELECT is((SELECT status FROM public.federated_voice_calls WHERE id = '67100000-0000-0000-0000-000000000004'),
  'accepted', 'a recent accepted call stays');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.federated_voice_calls WHERE id = '67100000-0000-0000-0000-000000000005'),
  'a call settled over 7 days ago is deleted');
SELECT ok(EXISTS (SELECT 1 FROM public.federated_voice_calls WHERE id = '67100000-0000-0000-0000-000000000006'),
  'a call settled yesterday is kept');

-- Thread stubs. -------------------------------------------------------------------------
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, ap_id, federation_status) VALUES
  ('67200000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', '88888888-0000-0000-0000-000000000008',
   'stub', '67000000-0000-0000-0000-0000000000a1', 'https://remote.example/threads/67200000-0000-0000-0000-000000000001', 'stub'),
  ('67200000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006', '88888888-0000-0000-0000-000000000008',
   'thread', '67000000-0000-0000-0000-0000000000a1', 'https://remote.example/threads/67200000-0000-0000-0000-000000000002', 'queued');

SELECT is((SELECT federation_status FROM public.threads WHERE id = '67200000-0000-0000-0000-000000000001'),
  'stub', 'an inbound thread inserted as a stub stays a stub');
SELECT is((SELECT federation_status FROM public.threads WHERE id = '67200000-0000-0000-0000-000000000002'),
  'synced', 'any other inbound thread is synced');

UPDATE public.threads SET federation_status = 'synced', name = 'claimed'
 WHERE id = '67200000-0000-0000-0000-000000000001';
UPDATE public.threads SET federation_status = 'stub'
 WHERE id = '67200000-0000-0000-0000-000000000002';
SELECT is((SELECT federation_status FROM public.threads WHERE id = '67200000-0000-0000-0000-000000000001'),
  'synced', 'a claimed stub becomes synced');
SELECT is((SELECT federation_status FROM public.threads WHERE id = '67200000-0000-0000-0000-000000000002'),
  'synced', 'no update turns a thread into a stub');

INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by) VALUES
  ('67200000-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006', '88888888-0000-0000-0000-000000000008',
   'local', '11111111-0000-0000-0000-000000000001');
SELECT is((SELECT federation_status FROM public.threads WHERE id = '67200000-0000-0000-0000-000000000003'),
  'queued', 'a local thread is queued for federation as before');

-- Suspension. ---------------------------------------------------------------------------
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('67000000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('67000000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', '67000000-0000-0000-0000-0000000000a1', 'accepted'),
  ('67000000-0000-0000-0000-0000000000a1', '67000000-0000-0000-0000-0000000000a2', 'accepted');
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, is_federated)
VALUES ('66666666-0000-0000-0000-000000000006', '55555555-0000-0000-0000-000000000005',
        '67000000-0000-0000-0000-0000000000a1', true);

UPDATE public.profiles SET is_suspended = true WHERE id = '67000000-0000-0000-0000-0000000000a1';

SELECT is((SELECT count(*)::int FROM public.follows f
            JOIN public.profiles p ON p.id IN (f.follower_id, f.following_id) AND p.is_local
           WHERE '67000000-0000-0000-0000-0000000000a1' IN (f.follower_id, f.following_id)),
  0, 'follows between the suspended profile and local profiles are removed');
SELECT ok(EXISTS (SELECT 1 FROM public.follows
                   WHERE follower_id = '67000000-0000-0000-0000-0000000000a1'
                     AND following_id = '67000000-0000-0000-0000-0000000000a2'),
  'follows with other remote profiles are left');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.voice_channel_participants
                       WHERE user_id = '67000000-0000-0000-0000-0000000000a1'),
  'voice presence of the suspended profile is removed');
SELECT is((SELECT status FROM public.federated_voice_calls WHERE id = '67100000-0000-0000-0000-000000000002'),
  'ended', 'a ringing call from the suspended profile ends');
SELECT is((SELECT status FROM public.federated_voice_calls WHERE id = '67100000-0000-0000-0000-000000000004'),
  'ended', 'an accepted call with the suspended profile ends');
SELECT is((SELECT status FROM public.federated_voice_calls WHERE id = '67100000-0000-0000-0000-000000000006'),
  'rejected', 'a settled call keeps its status');
SELECT is((SELECT status FROM public.user_servers
            WHERE user_id = '67000000-0000-0000-0000-0000000000a1'
              AND server_id = '55555555-0000-0000-0000-000000000005'),
  'accepted', 'suspension keeps server memberships');

SELECT * FROM finish();
ROLLBACK;
