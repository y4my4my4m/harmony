-- 20261028100001_megolm_key_relay.sql: fulfill_megolm_key_request, get_relayable_key_requests,
-- the key request broadcast to session holders, and the share sender guard.
--
--   alice    owns server_1; sent the session in channel 66666666-...-06
--   bob      member of server_1; holds alice's session through a share
--   carol    joined server_1 later; asks for alice's session
--   mallory  in no server
--   banned   user_servers row with status banned; holds an old share
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(36);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('eeeeeeee-0000-0000-0000-000000000189', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'carol189@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES ('18900000-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000189', 'carol189', 'Carol', true);
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('18900000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'accepted');

-- Shares of alice's session s189: bob claimed his, banned's predates the ban.
INSERT INTO public.megolm_session_shares
       (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key, is_claimed, claimed_at)
VALUES ('s189', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
        '22222222-0000-0000-0000-000000000002', 'k', true, now()),
       ('s189', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
        '44444444-0000-0000-0000-000000000004', 'k', true, now() - interval '1 day');

DELETE FROM realtime.messages;

-- Requests. -----------------------------------------------------------------------------
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000189');
INSERT INTO public.megolm_key_requests (id, requester_user_id, sender_user_id, room_id, session_id, accepts_relay)
VALUES ('18910000-0000-0000-0000-000000000001', '18900000-0000-0000-0000-000000000001',
        '11111111-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', 's189', true),
       ('18910000-0000-0000-0000-000000000002', '18900000-0000-0000-0000-000000000001',
        '11111111-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', 's189b', false);
SELECT tests.clear_authentication();

SELECT ok(NOT (SELECT accepts_relay FROM public.megolm_key_requests r
                WHERE r.id = '18910000-0000-0000-0000-000000000002'),
  'a request accepts relayed keys only when its requester says so');
SELECT is((SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'megolm_key_requests' AND column_name = 'accepts_relay'),
  'false', 'accepts_relay defaults to false for clients that do not set it');

SELECT is((SELECT string_agg(topic, ',' ORDER BY topic) FROM realtime.messages
            WHERE payload->>'id' = '18910000-0000-0000-0000-000000000001'),
  'user:11111111-0000-0000-0000-000000000001,user:22222222-0000-0000-0000-000000000002',
  'a relay-accepting request reaches its sender and the holders in the room, not a banned holder');
SELECT is((SELECT string_agg(topic, ',' ORDER BY topic) FROM realtime.messages
            WHERE payload->>'id' = '18910000-0000-0000-0000-000000000002'),
  'user:11111111-0000-0000-0000-000000000001',
  'any other request reaches its sender alone');
SELECT ok((SELECT bool_and((payload->>'accepts_relay')::boolean) FROM realtime.messages
            WHERE payload->>'id' = '18910000-0000-0000-0000-000000000001'),
  'the request event carries accepts_relay');

-- get_relayable_key_requests. -----------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT array_agg(id ORDER BY id)::text FROM public.get_relayable_key_requests()),
  '{18910000-0000-0000-0000-000000000001}',
  'a member lists the relay-accepting request in a room they share with its requester');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT array_agg(id ORDER BY id)::text FROM public.get_relayable_key_requests()),
  '{18910000-0000-0000-0000-000000000001,18910000-0000-0000-0000-000000000002}',
  'the sender lists every request addressed to them');
SELECT is((SELECT count(*)::int FROM public.get_relayable_key_requests(0)), 1,
  'a limit below one lists one');
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000189');
SELECT is((SELECT count(*)::int FROM public.get_relayable_key_requests()), 0,
  'the requester does not list their own requests');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM public.get_relayable_key_requests()), 0,
  'a user outside the room lists nothing');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is((SELECT count(*)::int FROM public.get_relayable_key_requests()), 0,
  'a banned member lists nothing');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT * FROM public.get_relayable_key_requests()$q$,
  '42501', NULL, 'anon cannot list requests');

SELECT tests.clear_authentication();
UPDATE public.megolm_key_requests SET created_at = now() - interval '31 days'
 WHERE id = '18910000-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT array_agg(id ORDER BY id)::text FROM public.get_relayable_key_requests()),
  '{18910000-0000-0000-0000-000000000001}', 'a request older than 30 days is not listed');

-- fulfill_megolm_key_request refusals. --------------------------------------------------
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000189');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000001', 'v2:k')$q$,
  '42501', 'a request is answered by another member', 'the requester cannot answer their own request');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000002', 'v2:k')$q$,
  '42501', 'the request is addressed to its sender only',
  'a member other than the sender cannot answer a request that does not accept relays');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000001', '')$q$,
  '22023', 'invalid encrypted key', 'an empty key is refused');
SELECT throws_ok(format($q$SELECT public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000001', %L)$q$,
                        repeat('k', 1025)),
  '22023', 'invalid encrypted key', 'a key longer than 1024 characters is refused');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000001', 'v2:k')$q$,
  '42501', 'caller and requester must both be in the room', 'a user outside the room cannot answer');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000001', 'v2:k')$q$,
  '42501', 'caller and requester must both be in the room', 'a banned holder cannot answer');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000001', 'v2:k')$q$,
  '42501', NULL, 'anon cannot answer');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is_empty($q$UPDATE public.megolm_key_requests SET status = 'fulfilled', encrypted_key = 'v2:x'
                   WHERE id = '18910000-0000-0000-0000-000000000001' RETURNING id$q$,
  'a relay cannot answer by updating the row');

-- A relay answers; the first answer wins. -----------------------------------------------
SELECT tests.clear_authentication();
DELETE FROM realtime.messages;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT ok(public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000001', 'v2:bob'),
  'a member answers a relay-accepting request');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(NOT public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000001', 'v2:alice'),
  'a second answer reports false');
SELECT tests.clear_authentication();
SELECT is((SELECT status || ' ' || encrypted_key || ' ' || fulfilled_by_user_id::text
             FROM public.megolm_key_requests WHERE id = '18910000-0000-0000-0000-000000000001'),
  'fulfilled v2:bob 22222222-0000-0000-0000-000000000002',
  'the first answer is kept and names its wrapper');
SELECT ok((SELECT fulfilled_at IS NOT NULL FROM public.megolm_key_requests
            WHERE id = '18910000-0000-0000-0000-000000000001'), 'fulfilled_at is set');
SELECT is((SELECT topic || ' ' || (payload->>'fulfilled_by_user_id') FROM realtime.messages
            WHERE payload->>'type' = 'encryption:key_fulfilled'),
  'user:18900000-0000-0000-0000-000000000001 22222222-0000-0000-0000-000000000002',
  'the requester is told who wrapped the key');
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000189');
SELECT is((SELECT fulfilled_by_user_id::text FROM public.megolm_key_requests
            WHERE id = '18910000-0000-0000-0000-000000000001'),
  '22222222-0000-0000-0000-000000000002', 'the requester reads the wrapper of their request');

-- The sender answers through the RPC too; a requester who left is refused. --------------
SELECT tests.clear_authentication();
UPDATE public.megolm_key_requests SET created_at = now()
 WHERE id = '18910000-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000002', 'v2:alice'),
  'the sender answers a request addressed to them');
SELECT tests.clear_authentication();
SELECT is((SELECT fulfilled_by_user_id::text FROM public.megolm_key_requests
            WHERE id = '18910000-0000-0000-0000-000000000002'),
  '11111111-0000-0000-0000-000000000001', 'the sender is recorded as the wrapper');

SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000189');
INSERT INTO public.megolm_key_requests (id, requester_user_id, sender_user_id, room_id, session_id, accepts_relay)
VALUES ('18910000-0000-0000-0000-000000000003', '18900000-0000-0000-0000-000000000001',
        '11111111-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', 's189', true);
SELECT tests.clear_authentication();
DELETE FROM public.user_servers
 WHERE user_id = '18900000-0000-0000-0000-000000000001' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('18910000-0000-0000-0000-000000000003', 'v2:k')$q$,
  '42501', 'caller and requester must both be in the room', 'a requester who left the room is refused');
SELECT is((SELECT count(*)::int FROM public.get_relayable_key_requests()), 0,
  'nor is their request listed');
SELECT tests.clear_authentication();

-- Share sender guard. -------------------------------------------------------------------
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('18900000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'accepted');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is_empty($q$INSERT INTO public.megolm_session_shares
                     (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                   VALUES ('s189', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
                           '18900000-0000-0000-0000-000000000001', 'k') RETURNING id$q$,
  'a share of a session another sender shared is skipped');
SELECT lives_ok($q$INSERT INTO public.megolm_session_shares
                     (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                   VALUES ('s189bob', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
                           '18900000-0000-0000-0000-000000000001', 'k')$q$,
  'a member shares their own session');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty($q$INSERT INTO public.megolm_session_shares
                       (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                     VALUES ('s189', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                             '18900000-0000-0000-0000-000000000001', 'k') RETURNING id$q$,
  'the session''s sender shares it with a newcomer');
SELECT tests.clear_authentication();
SELECT is((SELECT string_agg(DISTINCT sender_user_id::text, ',') FROM public.megolm_session_shares
            WHERE session_id = 's189'),
  '11111111-0000-0000-0000-000000000001', 'every share of the session names one sender');
SELECT lives_ok($q$INSERT INTO public.megolm_session_shares
                     (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                   VALUES ('s189', '66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
                           '33333333-0000-0000-0000-000000000003', 'k')$q$,
  'server-side writers are not guarded');

SELECT * FROM finish();
ROLLBACK;
