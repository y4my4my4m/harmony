-- Online count on the invite card, after 20261012000001_invite_preview_online_count.sql.
--
-- Fixture server_1: alice and bob accepted, banned has a banned row, mallory is not a member.
-- Added: carol and dave accepted, erin pending. Published presence (0 offline):
--   alice 1, bob 3 (busy), carol 0 (chosen invisible), dave none, erin 1, banned 2, mallory 1
-- server_2 (mallory's) has dave alone.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(8);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1230000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol123@test.local'),
  ('f1230000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave123@test.local'),
  ('f1230000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin123@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1230000-0000-0000-0000-0000000000c1', 'f1230000-0000-0000-0000-0000000000a1', 'carol123', 'Carol', true),
  ('f1230000-0000-0000-0000-0000000000c2', 'f1230000-0000-0000-0000-0000000000a2', 'dave123', 'Dave', true),
  ('f1230000-0000-0000-0000-0000000000c3', 'f1230000-0000-0000-0000-0000000000a3', 'erin123', 'Erin', true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1230000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1230000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1230000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'pending');

INSERT INTO public.user_presence (profile_id, status, online, published_status) VALUES
  ('11111111-0000-0000-0000-000000000001', 1, true, 1),
  ('22222222-0000-0000-0000-000000000002', 3, true, 3),
  ('f1230000-0000-0000-0000-0000000000c1', 4, true, 0),
  ('f1230000-0000-0000-0000-0000000000c3', 1, true, 1),
  ('44444444-0000-0000-0000-000000000004', 2, true, 2),
  ('33333333-0000-0000-0000-000000000003', 1, true, 1)
ON CONFLICT (profile_id) DO UPDATE
  SET status = EXCLUDED.status, online = EXCLUDED.online, published_status = EXCLUDED.published_status;

INSERT INTO public.servers (id, name, owner) VALUES
  ('f1232000-0000-0000-0000-000000000002', 'Quiet', '33333333-0000-0000-0000-000000000003');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1230000-0000-0000-0000-0000000000c2', 'f1232000-0000-0000-0000-000000000002', 'accepted');

INSERT INTO public.invites (code, server_id, created_by, max_uses, uses, used, expires_at) VALUES
  ('F123VALID',   '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 0, 0, false, NULL),
  ('F123QUIET',   'f1232000-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003', 0, 0, false, NULL),
  ('F123EXPIRED', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 0, 0, false, now() - interval '1 minute'),
  ('F123REVOKED', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 0, 0, true, NULL),
  ('F123SPENT',   '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 1, 1, false, NULL);

SELECT ok(has_function_privilege('anon', 'public.get_invite_preview(text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.get_invite_preview(text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.get_invite_preview(text)', 'EXECUTE'),
          'anon, authenticated and service_role execute get_invite_preview');
SELECT is_empty(
    $q$SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
        WHERE p.oid = 'public.get_invite_preview(text)'::regprocedure AND a.grantee = 0$q$,
    'PUBLIC holds no EXECUTE on get_invite_preview');

SELECT tests.authenticate_as_anon();
SELECT results_eq(
    $q$SELECT p ->> 'status', (p ->> 'member_count')::int, (p ->> 'online_count')::int,
              jsonb_typeof(p -> 'online_count')
         FROM public.get_invite_preview('F123VALID') p$q$,
    $q$VALUES ('valid'::text, 4, 2, 'number'::text)$q$,
    'anon sees accepted members published online, away or busy: not invisible, absent, pending, banned or non-members');
SELECT is((public.get_invite_preview('F123QUIET') -> 'online_count'), '0'::jsonb,
    'a server with no published presence counts 0 online');
SELECT is_empty(
    $q$SELECT c FROM unnest(ARRAY['F123EXPIRED', 'F123REVOKED', 'F123SPENT', 'F123NOPE']) AS c
        WHERE public.get_invite_preview(c) ? 'online_count'
           OR public.get_invite_preview(c) ? 'member_count'$q$,
    'an expired, revoked, spent or unknown invite carries no counts');
SELECT is((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(public.get_invite_preview('F123EXPIRED')) AS k),
          ARRAY['status'], 'an invalid invite answers its status alone');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT results_eq(
    $q$SELECT (p ->> 'online_count')::int, (p ->> 'is_member')::boolean
         FROM public.get_invite_preview('F123VALID') p$q$,
    $q$VALUES (2, true)$q$,
    'a member reads the same count');

SELECT tests.clear_authentication();
UPDATE public.user_presence SET published_status = 0 WHERE profile_id = '22222222-0000-0000-0000-000000000002';
SELECT tests.authenticate_as_anon();
SELECT is((public.get_invite_preview('F123VALID') ->> 'online_count')::int, 1,
    'a member going offline leaves the count');

SELECT * FROM finish();
ROLLBACK;
