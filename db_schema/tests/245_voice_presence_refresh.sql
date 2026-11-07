-- 20261108100001_voice_presence_refresh.sql: voice_presence_refresh_targets pairs each local
-- caller of a federated local server with the instances admitted to the channel; the minute
-- sweep drops a remote copy's row neither written nor re-announced for 30 minutes.
--
--   alice  owns hall245 (federated) and closed245 (federation off)
--   bob    member of hall245, in its open channel
--   rena   on peer245.test, member of hall245
--   copy245  a remote server's copy hosted on peer245.test
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(17);
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, shared_inbox_url) VALUES
  ('24500000-0000-0000-0000-0000000000f1', 'rena245', 'Rena', false, 'peer245.test',
   'https://peer245.test/users/rena245', 'https://peer245.test/inbox');
INSERT INTO public.servers (id, name, owner, public, federation_enabled) VALUES
  ('24500000-0000-0000-0000-00000000a001', 'hall245', '11111111-0000-0000-0000-000000000001', true, true),
  ('24500000-0000-0000-0000-00000000a002', 'closed245', '11111111-0000-0000-0000-000000000001', true, false);
INSERT INTO public.servers (id, name, public, federation_enabled, is_local_server, ap_id, host_domain) VALUES
  ('24500000-0000-0000-0000-00000000a003', 'copy245', true, true, false,
   'https://peer245.test/servers/24500000-0000-0000-0000-00000000a003', 'peer245.test');
INSERT INTO public.user_servers (server_id, user_id, status) VALUES
  ('24500000-0000-0000-0000-00000000a001', '22222222-0000-0000-0000-000000000002', 'accepted'),
  ('24500000-0000-0000-0000-00000000a001', '24500000-0000-0000-0000-0000000000f1', 'accepted'),
  ('24500000-0000-0000-0000-00000000a002', '24500000-0000-0000-0000-0000000000f1', 'accepted')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = 'accepted';

-- hall245: open, hidden from @everyone (bit 1 VIEW_CHANNEL); closed245 and the copy one each.
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('24500000-0000-0000-0000-0000000000c1', '24500000-0000-0000-0000-00000000a001', 'voice245', 1),
  ('24500000-0000-0000-0000-0000000000c2', '24500000-0000-0000-0000-00000000a001', 'staff245', 1),
  ('24500000-0000-0000-0000-0000000000c3', '24500000-0000-0000-0000-00000000a002', 'closedvoice245', 1),
  ('24500000-0000-0000-0000-0000000000c4', '24500000-0000-0000-0000-00000000a003', 'copyvoice245', 1);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT '24500000-0000-0000-0000-0000000000c2', 'role', r.id, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '24500000-0000-0000-0000-00000000a001' AND r.is_default;

-- Privileges. ------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.voice_presence_refresh_targets()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.voice_presence_refresh_targets()', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.voice_presence_refresh_targets()', 'EXECUTE'),
  'voice_presence_refresh_targets: service_role only');
SELECT is((SELECT p.prosecdef::text || ':' || array_to_string(p.proconfig, ',')
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'voice_presence_refresh_targets'),
  'true:search_path=public, pg_temp', 'SECURITY DEFINER with a pinned search_path');
SELECT ok(NOT has_function_privilege('authenticated', 'public.sweep_stale_voice_participants()', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.sweep_stale_voice_participants()', 'EXECUTE'),
  'sweep_stale_voice_participants keeps its grants');

-- Refresh targets. -------------------------------------------------------------------------
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, joined_at, is_federated) VALUES
  ('24500000-0000-0000-0000-0000000000c1', '24500000-0000-0000-0000-00000000a001',
   '22222222-0000-0000-0000-000000000002', now() - interval '20 minutes', false),
  ('24500000-0000-0000-0000-0000000000c1', '24500000-0000-0000-0000-00000000a001',
   '11111111-0000-0000-0000-000000000001', now() - interval '30 seconds', false),
  ('24500000-0000-0000-0000-0000000000c1', '24500000-0000-0000-0000-00000000a001',
   '24500000-0000-0000-0000-0000000000f1', now() - interval '20 minutes', true),
  ('24500000-0000-0000-0000-0000000000c2', '24500000-0000-0000-0000-00000000a001',
   '11111111-0000-0000-0000-000000000001', now() - interval '20 minutes', false),
  ('24500000-0000-0000-0000-0000000000c3', '24500000-0000-0000-0000-00000000a002',
   '22222222-0000-0000-0000-000000000002', now() - interval '20 minutes', false);

SELECT set_config('role', 'service_role', true);
CREATE TEMP TABLE targets245 AS
SELECT * FROM public.voice_presence_refresh_targets() t
 WHERE t.server_id::text LIKE '24500000-%';
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM targets245), 1, 'one pair: bob in the open channel, to peer245.test');
SELECT is((SELECT row(channel_id, channel_name, server_name, user_id, instance, shared_inbox)::text FROM targets245),
  '(24500000-0000-0000-0000-0000000000c1,voice245,hall245,22222222-0000-0000-0000-000000000002,peer245.test,https://peer245.test/inbox)',
  'the pair names the channel, server, caller and the instance inbox');
SELECT ok((SELECT username IS NOT NULL FROM targets245), 'the caller''s username for the actor fallback');
SELECT ok(NOT EXISTS (SELECT 1 FROM targets245 WHERE user_id = '11111111-0000-0000-0000-000000000001'
                                               AND channel_id = '24500000-0000-0000-0000-0000000000c1'),
  'a caller joined under 2 minutes ago is not re-announced');
SELECT ok(NOT EXISTS (SELECT 1 FROM targets245 WHERE user_id = '24500000-0000-0000-0000-0000000000f1'),
  'a remote caller is its own instance''s to announce');
SELECT ok(NOT EXISTS (SELECT 1 FROM targets245 WHERE channel_id = '24500000-0000-0000-0000-0000000000c2'),
  'a channel the instance''s members cannot view is not announced');
SELECT ok(NOT EXISTS (SELECT 1 FROM targets245 WHERE channel_id = '24500000-0000-0000-0000-0000000000c3'),
  'a server with federation off is not announced');

-- The sweep and a copy's rows. --------------------------------------------------------------
DELETE FROM public.voice_channel_participants WHERE channel_id::text LIKE '24500000-%';
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, joined_at, last_seen_at, is_federated) VALUES
  -- Announced 31 minutes ago.
  ('24500000-0000-0000-0000-0000000000c4', '24500000-0000-0000-0000-00000000a003',
   '24500000-0000-0000-0000-0000000000f1', now() - interval '2 hours', now() - interval '31 minutes', true),
  -- Joined 3 hours ago, re-announced 5 minutes ago.
  ('24500000-0000-0000-0000-0000000000c4', '24500000-0000-0000-0000-00000000a003',
   '22222222-0000-0000-0000-000000000002', now() - interval '3 hours', now() - interval '5 minutes', true),
  -- Written by an older backend: joined 40 minutes ago, never stamped.
  ('24500000-0000-0000-0000-0000000000c4', '24500000-0000-0000-0000-00000000a003',
   '11111111-0000-0000-0000-000000000001', now() - interval '40 minutes', NULL, true),
  -- A local server's row an hour old: the LiveKit reconciliation's to judge.
  ('24500000-0000-0000-0000-0000000000c1', '24500000-0000-0000-0000-00000000a001',
   '22222222-0000-0000-0000-000000000002', now() - interval '1 hour', NULL, false);

DELETE FROM realtime.messages WHERE topic LIKE 'voice-channel%';
SELECT set_config('role', 'service_role', true);
SELECT is(public.sweep_stale_voice_participants(), 2, 'the sweep removes the two stale copy rows');
SELECT tests.clear_authentication();

SELECT is((SELECT array_agg(user_id ORDER BY user_id) FROM public.voice_channel_participants
            WHERE channel_id = '24500000-0000-0000-0000-0000000000c4'),
  ARRAY['22222222-0000-0000-0000-000000000002']::uuid[], 'a copy row re-announced within 30 minutes stays');
SELECT ok(EXISTS (SELECT 1 FROM public.voice_channel_participants
                   WHERE channel_id = '24500000-0000-0000-0000-0000000000c1'
                     AND user_id = '22222222-0000-0000-0000-000000000002'),
  'a local server''s row is left to the reconciliation');
SELECT is((SELECT count(*)::int FROM realtime.messages
            WHERE topic = 'voice-channels:24500000-0000-0000-0000-00000000a003'
              AND payload ->> 'event' = 'user-left' AND payload ->> 'reason' = 'reconciled'),
  2, 'each removed copy row is announced as user-left, reason reconciled');

-- P2P rule unchanged (as 238).
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id, joined_at, last_seen_at, metadata) VALUES
  ('24500000-0000-0000-0000-0000000000c2', '24500000-0000-0000-0000-00000000a001',
   '11111111-0000-0000-0000-000000000001', now() - interval '10 minutes', now() - interval '4 minutes',
   '{"transport": "p2p"}');
SELECT set_config('role', 'service_role', true);
SELECT is(public.sweep_stale_voice_participants(), 1, 'a P2P row unseen for 3 minutes still goes');
SELECT tests.clear_authentication();

-- recordRemotePresence's upsert stamps last_seen_at; a later announcement moves it.
UPDATE public.voice_channel_participants SET last_seen_at = now() - interval '29 minutes'
 WHERE channel_id = '24500000-0000-0000-0000-0000000000c4';
SELECT set_config('role', 'service_role', true);
SELECT is(public.sweep_stale_voice_participants(), 0, 'a copy row announced 29 minutes ago stays');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.voice_channel_participants
            WHERE channel_id = '24500000-0000-0000-0000-0000000000c4'), 1, 'still listed');

SELECT * FROM finish();
ROLLBACK;
