-- A profile change reaches active local conversation partners on their user channel after
-- 20261118200001, beside the servers of the profile.
--
-- Added to the fixture: carol, in a group with alice, bob, a remote account and mallory, who left
-- it; dave, in a DM with alice, whom alice blocks; erin, in a DM alice left; frank, in a DM with
-- alice, whose block by alice has expired. sent() is every profile:updated event, as topic,
-- event and payload; realtime.send adds the payload's id key.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('c3060000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol@c306.test'),
  ('c3060000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave@c306.test'),
  ('c3060000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin@c306.test'),
  ('c3060000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'frank@c306.test'),
  ('c3060000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'remote@c306.test');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('c3061000-0000-0000-0000-000000000001', 'c3060000-0000-0000-0000-000000000001', 'carol306', 'Carol', true),
  ('c3061000-0000-0000-0000-000000000002', 'c3060000-0000-0000-0000-000000000002', 'dave306', 'Dave', true),
  ('c3061000-0000-0000-0000-000000000003', 'c3060000-0000-0000-0000-000000000003', 'erin306', 'Erin', true),
  ('c3061000-0000-0000-0000-000000000004', 'c3060000-0000-0000-0000-000000000004', 'frank306', 'Frank', true);
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain) VALUES
  ('c3061000-0000-0000-0000-000000000005', 'c3060000-0000-0000-0000-000000000005', 'remote306', 'Remote', false, 'remote.c306.test');

INSERT INTO public.conversations (id, type) VALUES
  ('c3062000-0000-0000-0000-000000000001', 'group'),
  ('c3062000-0000-0000-0000-000000000002', 'direct'),
  ('c3062000-0000-0000-0000-000000000003', 'direct'),
  ('c3062000-0000-0000-0000-000000000004', 'direct');
INSERT INTO public.conversation_participants (conversation_id, user_id, left_at) VALUES
  ('c3062000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', NULL),
  ('c3062000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', NULL),
  ('c3062000-0000-0000-0000-000000000001', 'c3061000-0000-0000-0000-000000000001', NULL),
  ('c3062000-0000-0000-0000-000000000001', 'c3061000-0000-0000-0000-000000000005', NULL),
  ('c3062000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', now()),
  ('c3062000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', NULL),
  ('c3062000-0000-0000-0000-000000000002', 'c3061000-0000-0000-0000-000000000002', NULL),
  ('c3062000-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', now()),
  ('c3062000-0000-0000-0000-000000000003', 'c3061000-0000-0000-0000-000000000003', NULL),
  ('c3062000-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001', NULL),
  ('c3062000-0000-0000-0000-000000000004', 'c3061000-0000-0000-0000-000000000004', NULL);

INSERT INTO public.user_blocks (blocker_id, blocked_user_id, expires_at) VALUES
  ('11111111-0000-0000-0000-000000000001', 'c3061000-0000-0000-0000-000000000002', NULL),
  ('11111111-0000-0000-0000-000000000001', 'c3061000-0000-0000-0000-000000000004', now() - interval '1 day');

CREATE FUNCTION pg_temp.sent() RETURNS TABLE (topic text, event text, payload jsonb) LANGUAGE sql AS $fn$
    SELECT m.topic, m.event, m.payload
      FROM realtime.messages m
     WHERE m.payload->>'type' = 'profile:updated'
     ORDER BY m.topic
$fn$;

-- A local profile ---------------------------------------------------------------------------------
DELETE FROM realtime.messages;
UPDATE public.profiles SET avatar_url = 'https://cdn.c306.test/alice.webp'
 WHERE id = '11111111-0000-0000-0000-000000000001';

SELECT results_eq(
    $q$SELECT topic FROM pg_temp.sent() WHERE topic LIKE 'user:%'$q$,
    ARRAY['user:22222222-0000-0000-0000-000000000002', 'user:c3061000-0000-0000-0000-000000000001',
          'user:c3061000-0000-0000-0000-000000000004'],
    'an avatar change reaches each active local partner once, direct and group alike');
SELECT results_eq(
    $q$SELECT topic FROM pg_temp.sent() WHERE topic NOT LIKE 'user:%'$q$,
    ARRAY['server-presence:55555555-0000-0000-0000-000000000005'],
    'and the server of the profile, as before');
SELECT is_empty(
    $q$SELECT 1 FROM pg_temp.sent() WHERE topic LIKE 'user:%' AND event <> 'user_event'$q$,
    'partners hear it as user_event, the event of the user channel');
SELECT is_empty(
    $q$SELECT 1 FROM pg_temp.sent() WHERE topic LIKE 'server-presence:%' AND event <> 'presence_event'$q$,
    'the server hears it as presence_event');
SELECT is((SELECT count(DISTINCT payload - 'id')::int FROM pg_temp.sent()), 1,
          'every recipient gets the same payload');
SELECT is((SELECT payload->>'avatar_url' FROM pg_temp.sent() LIMIT 1), 'https://cdn.c306.test/alice.webp',
          'which carries the new avatar');
SELECT is((SELECT payload->>'user_id' FROM pg_temp.sent() LIMIT 1), '11111111-0000-0000-0000-000000000001',
          'and names the profile');
SELECT is_empty(
    $q$SELECT 1 FROM pg_temp.sent()
        WHERE topic IN ('user:11111111-0000-0000-0000-000000000001', 'user:33333333-0000-0000-0000-000000000003',
                        'user:c3061000-0000-0000-0000-000000000002', 'user:c3061000-0000-0000-0000-000000000003',
                        'user:c3061000-0000-0000-0000-000000000005')$q$,
    'not the profile itself, a partner who left, a blocked partner, a conversation the profile left, nor a remote account');

DELETE FROM realtime.messages;
UPDATE public.profiles SET custom_status = '{"text":"away for lunch"}'
 WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM pg_temp.sent() WHERE topic LIKE 'user:%'), 3, 'a custom status change reaches the same partners');

DELETE FROM realtime.messages;
UPDATE public.profiles SET updated_at = now() + interval '1 minute'
 WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT is_empty('SELECT 1 FROM pg_temp.sent()', 'a write of no announced field sends nothing');

-- A remote profile --------------------------------------------------------------------------------
DELETE FROM realtime.messages;
UPDATE public.profiles SET display_name = 'Remote renamed'
 WHERE id = 'c3061000-0000-0000-0000-000000000005';
SELECT results_eq(
    'SELECT topic FROM pg_temp.sent()',
    ARRAY['user:11111111-0000-0000-0000-000000000001', 'user:22222222-0000-0000-0000-000000000002',
          'user:c3061000-0000-0000-0000-000000000001'],
    'a federated profile update reaches the local members of its group');

SELECT ok((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public, extensions, pg_temp']
             FROM pg_proc p WHERE p.oid = 'public.broadcast_profile_change()'::regprocedure),
          'the function stays a definer with the search_path of SURFACE.tsv');

SELECT * FROM finish();
ROLLBACK;
