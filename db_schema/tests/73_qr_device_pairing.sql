-- 20261007100001_qr_device_pairing.sql: pairing requests, token-gated approval with sealed
-- keys, expiry, single use, withdrawal, bundle consumption, the INSERT policy, the
-- broadcasts, server-controlled device trust and deny on pending requests only.
--
--   alice  devices: old (recovery, a day old, signing key published), new (account),
--          revoked, x (account, plain requests), y and z (registered by the test)
--   bob    device bob-1
--
-- Tokens are plain strings here; the server hashes whatever text it receives. The client
-- derives them from the QR secret.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(71);

-- Grants. ------------------------------------------------------------------------------
SELECT has_column('public', 'device_approval_requests', 'pairing_token_hash', 'pairing_token_hash exists');
SELECT has_column('public', 'device_approval_requests', 'pairing_proof', 'pairing_proof exists');
SELECT ok(to_regprocedure('public.approve_device_request(uuid, text, text)') IS NULL,
  'the three-argument approve_device_request is gone');
SELECT ok(NOT has_function_privilege('anon', 'public.create_device_pairing_request(text, text, text, text, text)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.approve_device_request(uuid, text, text, text)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.cancel_device_pairing_request(uuid, text)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.consume_device_sync_bundle(uuid, text)', 'EXECUTE'),
  'anon executes none of the pairing functions');
SELECT ok(has_function_privilege('authenticated', 'public.create_device_pairing_request(text, text, text, text, text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.approve_device_request(uuid, text, text, text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.cancel_device_pairing_request(uuid, text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.consume_device_sync_bundle(uuid, text)', 'EXECUTE'),
  'authenticated executes the pairing functions');
SELECT ok(NOT has_function_privilege('anon', 'public.revoke_device(text)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.claim_device_recovery_trust(text)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.deny_device_request(uuid)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.revoke_device(text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.claim_device_recovery_trust(text)', 'EXECUTE'),
  'device trust definers are for authenticated callers');
SELECT is(encode(sha256(convert_to('abc', 'UTF8')), 'hex'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'token hash is hex SHA-256 of the UTF-8 token, as devicePairing.tokenHash computes it');

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO public.user_devices (user_id, device_id, trust_state, created_at, revoked_at, device_signing_public_key) VALUES
  ('11111111-0000-0000-0000-000000000001', 'alice-old', 'recovery', now() - interval '1 day', NULL, 'KEY-OLD'),
  ('11111111-0000-0000-0000-000000000001', 'alice-new', 'account', now() - interval '1 minute', NULL, NULL),
  ('11111111-0000-0000-0000-000000000001', 'alice-revoked', 'revoked', now() - interval '2 days', now(), NULL),
  ('11111111-0000-0000-0000-000000000001', 'alice-x', 'account', now() - interval '1 minute', NULL, NULL),
  ('22222222-0000-0000-0000-000000000002', 'bob-1', 'recovery', now() - interval '1 day', NULL, NULL);

-- Direct inserts. -----------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.device_approval_requests (user_id, requesting_device_id, requesting_label)
                  VALUES ('11111111-0000-0000-0000-000000000001', 'alice-new', 'Plain')$q$,
  'a plain pending request inserts directly');
SELECT throws_ok($q$INSERT INTO public.device_approval_requests (user_id, requesting_device_id, status)
                   VALUES ('11111111-0000-0000-0000-000000000001', 'alice-new', 'approved')$q$,
  '42501', NULL, 'a client cannot insert an approved request');
SELECT throws_ok($q$INSERT INTO public.device_approval_requests (user_id, requesting_device_id, pairing_token_hash)
                   VALUES ('11111111-0000-0000-0000-000000000001', 'alice-new', repeat('a', 64))$q$,
  '42501', NULL, 'a pairing request cannot be inserted directly');
SELECT throws_ok($q$INSERT INTO public.device_approval_requests (user_id, requesting_device_id, encrypted_sync_bundle)
                   VALUES ('11111111-0000-0000-0000-000000000001', 'alice-new', 'pb1.x')$q$,
  '42501', NULL, 'a client cannot insert a bundle');
SELECT throws_ok($q$INSERT INTO public.device_approval_requests (user_id, requesting_device_id, expires_at)
                   VALUES ('11111111-0000-0000-0000-000000000001', 'alice-new', now() + interval '1 day')$q$,
  '42501', NULL, 'a client cannot extend the expiry');

-- create_device_pairing_request. --------------------------------------------------------
SELECT throws_ok($q$SELECT * FROM public.create_device_pairing_request('alice-revoked', 'L',
                   'B' || repeat('A', 86) || '=', repeat('a', 64))$q$,
  '42501', NULL, 'a revoked device cannot open a pairing request');
SELECT throws_ok($q$SELECT * FROM public.create_device_pairing_request('bob-1', 'L',
                   'B' || repeat('A', 86) || '=', repeat('a', 64))$q$,
  '42501', NULL, 'another account''s device cannot open a pairing request');
SELECT throws_ok($q$SELECT * FROM public.create_device_pairing_request('alice-new', 'L',
                   'not-a-key', repeat('a', 64))$q$,
  '22023', NULL, 'a malformed key is refused');
SELECT throws_ok($q$SELECT * FROM public.create_device_pairing_request('alice-new', 'L',
                   'B' || repeat('A', 86) || '=', 'nothex')$q$,
  '22023', NULL, 'a malformed token hash is refused');
SELECT throws_ok($q$SELECT * FROM public.create_device_pairing_request('alice-new', 'L',
                   'B' || repeat('A', 86) || '=', repeat('a', 64), 'short')$q$,
  '22023', NULL, 'a malformed proof is refused');

SELECT request_id AS r1, request_expires_at AS r1_exp
  FROM public.create_device_pairing_request('alice-new', 'Firefox on Linux', 'B' || repeat('A', 86) || '=',
         encode(sha256(convert_to('token-one', 'UTF8')), 'hex')) \gset
SELECT ok(:'r1_exp'::timestamptz BETWEEN now() + interval '9 minutes' AND now() + interval '11 minutes',
  'a pairing request lives ten minutes');
SELECT is((SELECT status FROM public.device_approval_requests
            WHERE requesting_device_id = 'alice-new' AND requesting_label = 'Plain'),
  'expired', 'opening a pairing request expires the device''s earlier pending request');

SELECT request_id AS r2
  FROM public.create_device_pairing_request('alice-new', 'Firefox on Linux', 'B' || repeat('B', 86) || '=',
         encode(sha256(convert_to('token-two', 'UTF8')), 'hex')) \gset
SELECT is((SELECT status FROM public.device_approval_requests WHERE id = :'r1'), 'expired',
  'a second pairing request expires the first');
SELECT tests.clear_authentication();
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE payload->>'type' = 'device:approval_expired' AND payload->>'id' = :'r1'),
  'the superseded request broadcasts device:approval_expired');
SELECT is((SELECT (payload->>'pairing')::boolean FROM realtime.messages
            WHERE payload->>'type' = 'device:approval_request' AND payload->>'id' = :'r2'),
  true, 'device:approval_request marks a pairing request');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

-- approve_device_request on a pairing request. ------------------------------------------
SELECT throws_ok(format('SELECT public.approve_device_request(%L, %L, %L)', :'r2', 'alice-old', 'pb1.sealed'),
  '42501', NULL, 'a pairing request is not approved without its token');
SELECT throws_ok(format('SELECT public.approve_device_request(%L, %L, %L, %L)', :'r2', 'alice-old', 'pb1.sealed', 'token-one'),
  '42501', NULL, 'the token of another request is refused');
SELECT throws_ok(format('SELECT public.approve_device_request(%L, %L, NULL, %L)', :'r2', 'alice-old', 'token-two'),
  '22023', NULL, 'a pairing approval without sealed keys is refused');
SELECT throws_ok(format('SELECT public.approve_device_request(%L, %L, %L, %L)', :'r2', 'alice-new', 'pb1.sealed', 'token-two'),
  '42501', NULL, 'the requesting device cannot approve itself');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format('SELECT public.approve_device_request(%L, %L, %L, %L)', :'r2', 'bob-1', 'pb1.sealed', 'token-two'),
  '42501', NULL, 'another account cannot approve the request');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.approve_device_request(:'r2', 'alice-old', 'pb1.sealed', 'token-two'), true,
  'the matching token with sealed keys approves');
SELECT is((SELECT status || ' ' || approved_by_device_id || ' ' || encrypted_sync_bundle
             FROM public.device_approval_requests WHERE id = :'r2'),
  'approved alice-old pb1.sealed', 'the request records the approver and the sealed keys');
SELECT is((SELECT trust_state FROM public.user_devices
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND device_id = 'alice-new'),
  'verified', 'the paired device is verified');
SELECT is(public.approve_device_request(:'r2', 'alice-old', 'pb1.other', 'token-two'), false,
  'the token is single use');
SELECT is((SELECT encrypted_sync_bundle FROM public.device_approval_requests WHERE id = :'r2'),
  'pb1.sealed', 'a replayed approval leaves the stored keys alone');
SELECT tests.clear_authentication();
SELECT is((SELECT payload ? 'encrypted_sync_bundle' FROM realtime.messages
            WHERE payload->>'type' = 'device:approved' AND payload->>'id' = :'r2'),
  false, 'device:approved does not broadcast the sealed keys');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

-- Plain requests. -----------------------------------------------------------------------
INSERT INTO public.device_approval_requests (user_id, requesting_device_id, requesting_label)
VALUES ('11111111-0000-0000-0000-000000000001', 'alice-x', 'Plain X');
SELECT id AS rx FROM public.device_approval_requests WHERE requesting_label = 'Plain X' \gset
SELECT throws_ok(format('SELECT public.approve_device_request(%L, %L, %L)', :'rx', 'alice-old', 'pb1.sealed'),
  '42501', NULL, 'keys are refused on a request without a pairing token');
SELECT is(public.approve_device_request(:'rx', 'alice-old'), true,
  'a plain request still approves without keys');
SELECT is((SELECT trust_state FROM public.user_devices
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND device_id = 'alice-x'),
  'account', 'a plain approval changes no trust');

-- Expiry: approve_device_request checks it before anything pairing-specific. The request
-- is a client insert because postgres holds no UPDATE on the table in production.
INSERT INTO public.device_approval_requests (user_id, requesting_device_id, requesting_label, expires_at)
VALUES ('11111111-0000-0000-0000-000000000001', 'alice-x', 'Lapsed', now() - interval '1 minute');
SELECT id AS r3 FROM public.device_approval_requests WHERE requesting_label = 'Lapsed' \gset
SELECT is(public.approve_device_request(:'r3', 'alice-old'), false,
  'an expired request is not approved');
SELECT is((SELECT status FROM public.device_approval_requests WHERE id = :'r3'), 'expired',
  'the expired request is marked expired');

-- consume_device_sync_bundle. -----------------------------------------------------------
SELECT is(public.consume_device_sync_bundle(:'r2', 'alice-old'), false,
  'only the requesting device clears the bundle');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.consume_device_sync_bundle(:'r2', 'alice-new'), false,
  'another account cannot clear the bundle');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.consume_device_sync_bundle(:'r2', 'alice-new'), true,
  'the requesting device clears its bundle');
SELECT is((SELECT encrypted_sync_bundle FROM public.device_approval_requests WHERE id = :'r2'), NULL,
  'the bundle is gone');

-- cancel_device_pairing_request. --------------------------------------------------------
SELECT request_id AS r5
  FROM public.create_device_pairing_request('alice-new', 'L', 'B' || repeat('F', 86) || '=',
         encode(sha256(convert_to('token-five', 'UTF8')), 'hex')) \gset
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.cancel_device_pairing_request(:'r5', 'alice-new'), false,
  'another account cannot withdraw the request');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.cancel_device_pairing_request(:'r5', 'alice-old'), false,
  'a request is withdrawn only under its own device id');
SELECT is(public.cancel_device_pairing_request(:'r5', 'alice-new'), true,
  'the requesting device withdraws its pending request');
SELECT is((SELECT status FROM public.device_approval_requests WHERE id = :'r5'), 'expired',
  'a withdrawn request is expired');

-- Reverse direction: the proof is stored. -----------------------------------------------
SELECT request_id AS r4
  FROM public.create_device_pairing_request('alice-new', 'L', 'B' || repeat('D', 86) || '=',
         encode(sha256(convert_to('token-four', 'UTF8')), 'hex'), repeat('p', 43)) \gset
SELECT is((SELECT pairing_proof FROM public.device_approval_requests WHERE id = :'r4'), repeat('p', 43),
  'the proof is stored on the request');

-- user_devices client writes. ----------------------------------------------------------
SELECT throws_ok($q$UPDATE public.user_devices SET trust_state = 'verified' WHERE device_id = 'alice-x'$q$,
  '42501', NULL, 'a client cannot raise its own trust');
SELECT throws_ok($q$UPDATE public.user_devices SET revoked_at = NULL, trust_state = 'account'
                    WHERE device_id = 'alice-revoked'$q$,
  '42501', NULL, 'a client cannot bring a signed-out device back');
SELECT throws_ok($q$UPDATE public.user_devices SET device_signing_public_key = 'KEY-NEW'
                    WHERE device_id = 'alice-old'$q$,
  '42501', NULL, 'a published signing key is not replaced');
SELECT lives_ok($q$UPDATE public.user_devices
                      SET label = 'Laptop', last_seen_at = now(), device_signing_public_key = 'KEY-X'
                    WHERE device_id = 'alice-x'$q$,
  'label, last seen and a first signing key stay client-writable');
SELECT is((SELECT label || ' ' || device_signing_public_key FROM public.user_devices
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND device_id = 'alice-x'),
  'Laptop KEY-X', 'the client-writable columns are written');
SELECT throws_ok($q$INSERT INTO public.user_devices (user_id, device_id, trust_state)
                   VALUES ('11111111-0000-0000-0000-000000000001', 'alice-v', 'verified')$q$,
  '42501', NULL, 'a client cannot register a verified device');
SELECT lives_ok($q$INSERT INTO public.user_devices (user_id, device_id, trust_state)
                  VALUES ('11111111-0000-0000-0000-000000000001', 'alice-y', 'account')$q$,
  'a client registers a device as account');
SELECT throws_ok($q$DELETE FROM public.user_devices WHERE device_id = 'alice-y'$q$,
  '42501', NULL, 'an active device is not removed directly');

SELECT is(public.claim_device_recovery_trust('alice-y'), true, 'a device claims recovery trust');
SELECT is(public.claim_device_recovery_trust('alice-new'), false, 'a verified device stays verified');
SELECT is(public.claim_device_recovery_trust('alice-revoked'), false, 'a signed-out device claims nothing');

SELECT request_id AS r6
  FROM public.create_device_pairing_request('alice-y', 'L', 'B' || repeat('G', 86) || '=', repeat('c', 64)) \gset
SELECT is(public.revoke_device('alice-y'), true, 'revoke_device signs a device out');
SELECT is((SELECT trust_state || ' ' || (revoked_at IS NOT NULL) FROM public.user_devices
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND device_id = 'alice-y'),
  'revoked true', 'the device is revoked');
SELECT is((SELECT status FROM public.device_approval_requests WHERE id = :'r6'), 'expired',
  'its pending request expires');
SELECT lives_ok($q$DELETE FROM public.user_devices WHERE device_id = 'alice-y'$q$,
  'a signed-out device is removed');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.revoke_device('alice-old'), false, 'another account cannot sign a device out');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

-- deny_device_request. ------------------------------------------------------------------
SELECT is(public.deny_device_request(:'r2'), false, 'deny leaves an approved request alone');
SELECT is((SELECT trust_state FROM public.user_devices
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND device_id = 'alice-new'),
  'verified', 'and does not sign the approved device out');
SELECT request_id AS r7
  FROM public.create_device_pairing_request('alice-x', 'L', 'B' || repeat('H', 86) || '=', repeat('d', 64)) \gset
SELECT is(public.deny_device_request(:'r7'), true, 'deny resolves a pending request');
SELECT is((SELECT trust_state FROM public.user_devices
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND device_id = 'alice-x'),
  'revoked', 'and signs its device out');

-- approve_device_request refuses a signed-out requesting device. ------------------------
INSERT INTO public.user_devices (user_id, device_id, trust_state)
VALUES ('11111111-0000-0000-0000-000000000001', 'alice-z', 'account');
INSERT INTO public.device_approval_requests (user_id, requesting_device_id, requesting_label)
VALUES ('11111111-0000-0000-0000-000000000001', 'alice-z', 'Plain Z');
SELECT id AS rz FROM public.device_approval_requests WHERE requesting_label = 'Plain Z' \gset
SELECT tests.clear_authentication();
UPDATE public.user_devices SET trust_state = 'revoked', revoked_at = now()
 WHERE user_id = '11111111-0000-0000-0000-000000000001' AND device_id = 'alice-z';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(format('SELECT public.approve_device_request(%L, %L)', :'rz', 'alice-old'),
  '42501', NULL, 'a request from a signed-out device is not approved');

-- Rate limit and constraint. ------------------------------------------------------------
DO $$
BEGIN
  FOR i IN 1..20 LOOP
    BEGIN
      PERFORM * FROM public.create_device_pairing_request('alice-new', 'L', 'B' || repeat('E', 86) || '=',
                       repeat('b', 64));
    EXCEPTION WHEN program_limit_exceeded THEN
      EXIT;
    END;
  END LOOP;
END $$;
SELECT throws_ok($q$SELECT * FROM public.create_device_pairing_request('alice-new', 'L',
                   'B' || repeat('E', 86) || '=', repeat('b', 64))$q$,
  '54000', NULL, 'pairing requests are rate limited per account');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT * FROM public.create_device_pairing_request('alice-new', 'L',
                   'B' || repeat('A', 86) || '=', repeat('a', 64))$q$,
  '42501', NULL, 'anon cannot open a pairing request');

SELECT tests.clear_authentication();
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.device_approval_requests'::regclass
                     AND conname = 'device_approval_requests_pairing_check'
                     AND convalidated
                     AND pg_get_constraintdef(oid) LIKE '%requesting_ecdh_public_key%'),
  'the table constrains the key, token hash, proof and bundle formats whoever writes them');

SELECT * FROM finish();
ROLLBACK;
