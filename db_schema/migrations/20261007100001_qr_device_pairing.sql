-- QR device pairing. A signed-in device seals the account's recovery-derived keys to a new
-- device after checking, out of band, the public key the server holds for that device's
-- request. The protocol and its threat model are in src/services/encryption/devicePairing.ts.
--
-- device_approval_requests
--   requesting_ecdh_public_key  P-256 public key of the requesting device's pairing session:
--                               base64 of the 65-byte uncompressed point. The column predates
--                               this migration; no client wrote it.
--   pairing_token_hash          hex SHA-256 of the approval token, a value derived from the QR
--                               secret. A request carrying it is approved only with the token.
--                               The QR secret itself never reaches the server.
--   pairing_proof               set when the signed-in device showed the QR: an HMAC binding
--                               requesting_ecdh_public_key to the QR secret. The approver
--                               checks it; the server only stores it.
--   encrypted_sync_bundle       the keys sealed to requesting_ecdh_public_key. Accepted only on
--                               a request carrying pairing_token_hash; at most 4096 characters.
--
-- create_device_pairing_request   pairing request for an active device of the caller. Expires
--                                 that device's earlier pending requests; lives 10 minutes; at
--                                 most 20 requests per account per 10 minutes.
-- approve_device_request          gains p_pairing_token. An expired pending request is marked
--                                 'expired' and the call returns false. A bundle is refused on a
--                                 request without pairing_token_hash.
-- cancel_device_pairing_request   the requesting device withdraws its pending request
--                                 (pairing screen closed): status 'expired'.
-- consume_device_sync_bundle      the requesting device clears its bundle after import.
-- broadcast_device_approval_event device:approved no longer carries the bundle; the requesting
--                                 device reads its own row. device:approval_request carries
--                                 `pairing`. A pending request that expires broadcasts
--                                 device:approval_expired.
-- INSERT policy                   a direct insert is a plain pending request: no bundle,
--                                 approver, resolution, pairing columns or ECDH key, and an
--                                 expiry at most 15 minutes out. Pairing requests come only from
--                                 create_device_pairing_request.
--
-- user_devices. A client inserts its own row as 'untrusted' or 'account', updates label and
-- last_seen_at, sets device_signing_public_key once while it is NULL, and deletes only a
-- signed-out row (guard_user_device_client_write). trust_state and revoked_at change only in
-- definers:
--   approve_device_request       pending pairing request: requesting device 'verified'
--   deny_device_request          pending request: requesting device 'revoked'
--   revoke_device                own device 'revoked'; its pending requests expire
--   claim_device_recovery_trust  own active 'untrusted' or 'account' device: 'recovery'
-- The server cannot observe a recovery-phrase unlock, so 'recovery' is the device's own
-- claim; it grants no keys. 'verified' means a device holding the keys sealed them to this
-- device after the QR check.
--
-- approve_device_request refuses a request whose device is signed out. A plain approval
-- (no pairing token) resolves the request and changes no trust. deny_device_request acts on
-- a pending request only; an approved device is signed out with revoke_device.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.device_approval_requests
    ADD COLUMN IF NOT EXISTS pairing_token_hash text,
    ADD COLUMN IF NOT EXISTS pairing_proof text;

-- No client wrote these columns. A row that would fail the check below loses the value.
UPDATE public.device_approval_requests
   SET requesting_ecdh_public_key = NULL
 WHERE requesting_ecdh_public_key IS NOT NULL
   AND requesting_ecdh_public_key !~ '^B[A-Za-z0-9+/]{86}=$';
UPDATE public.device_approval_requests
   SET encrypted_sync_bundle = NULL
 WHERE encrypted_sync_bundle IS NOT NULL
   AND length(encrypted_sync_bundle) > 4096;

ALTER TABLE public.device_approval_requests
    DROP CONSTRAINT IF EXISTS device_approval_requests_pairing_check;
ALTER TABLE public.device_approval_requests
    ADD CONSTRAINT device_approval_requests_pairing_check CHECK (
        (pairing_token_hash IS NULL OR pairing_token_hash ~ '^[0-9a-f]{64}$')
        AND (pairing_proof IS NULL
             OR (pairing_token_hash IS NOT NULL AND pairing_proof ~ '^[A-Za-z0-9_-]{43}$'))
        AND (requesting_ecdh_public_key IS NULL
             OR requesting_ecdh_public_key ~ '^B[A-Za-z0-9+/]{86}=$')
        AND (encrypted_sync_bundle IS NULL OR length(encrypted_sync_bundle) <= 4096)
    );

COMMENT ON COLUMN public.device_approval_requests.pairing_token_hash IS
    'hex SHA-256 of the approval token derived from the QR secret; NULL for a plain request.';
COMMENT ON COLUMN public.device_approval_requests.pairing_proof IS
    'base64url HMAC binding requesting_ecdh_public_key to the QR shown by the approving device.';

-- ---------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "device_approval_requests_insert_own" ON public.device_approval_requests;
CREATE POLICY "device_approval_requests_insert_own" ON public.device_approval_requests
    FOR INSERT WITH CHECK (
        user_id = ( SELECT public.get_current_profile_id() )
        AND status = 'pending'
        AND approved_by_device_id IS NULL
        AND encrypted_sync_bundle IS NULL
        AND resolved_at IS NULL
        AND requesting_ecdh_public_key IS NULL
        AND pairing_token_hash IS NULL
        AND pairing_proof IS NULL
        AND expires_at IS NOT NULL
        AND expires_at <= now() + interval '15 minutes'
    );

-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_device_approval_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',                  'device:approval_request',
        'id',                    NEW.id,
        'user_id',               NEW.user_id,
        'requesting_device_id',  NEW.requesting_device_id,
        'requesting_label',      NEW.requesting_label,
        'created_at',            NEW.created_at,
        'expires_at',            NEW.expires_at,
        'pairing',               NEW.pairing_token_hash IS NOT NULL
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',                  'device:approved',
        'id',                    NEW.id,
        'user_id',               NEW.user_id,
        'requesting_device_id',  NEW.requesting_device_id,
        'approved_by_device_id', NEW.approved_by_device_id,
        'resolved_at',           NEW.resolved_at
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'denied' AND OLD.status IS DISTINCT FROM 'denied' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',                  'device:denied',
        'id',                    NEW.id,
        'user_id',               NEW.user_id,
        'requesting_device_id',  NEW.requesting_device_id
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'expired' AND OLD.status = 'pending' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',                  'device:approval_expired',
        'id',                    NEW.id,
        'user_id',               NEW.user_id,
        'requesting_device_id',  NEW.requesting_device_id
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_device_pairing_request(
    p_device_id text,
    p_label text,
    p_ecdh_public_key text,
    p_token_hash text,
    p_proof text DEFAULT NULL
)
RETURNS TABLE (request_id uuid, request_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_id uuid;
    v_expires timestamptz := now() + interval '10 minutes';
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.user_devices d
         WHERE d.user_id = v_caller
           AND d.device_id = p_device_id
           AND d.revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Device is not an active device on this account' USING ERRCODE = '42501';
    END IF;

    IF p_ecdh_public_key IS NULL OR p_ecdh_public_key !~ '^B[A-Za-z0-9+/]{86}=$' THEN
        RAISE EXCEPTION 'Malformed pairing key' USING ERRCODE = '22023';
    END IF;
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Malformed pairing token hash' USING ERRCODE = '22023';
    END IF;
    IF p_proof IS NOT NULL AND p_proof !~ '^[A-Za-z0-9_-]{43}$' THEN
        RAISE EXCEPTION 'Malformed pairing proof' USING ERRCODE = '22023';
    END IF;

    IF (SELECT count(*) FROM public.device_approval_requests r
         WHERE r.user_id = v_caller
           AND r.pairing_token_hash IS NOT NULL
           AND r.created_at > now() - interval '10 minutes') >= 20 THEN
        RAISE EXCEPTION 'Too many pairing attempts; wait a few minutes' USING ERRCODE = '54000';
    END IF;

    UPDATE public.device_approval_requests r
       SET status = 'expired', resolved_at = now()
     WHERE r.user_id = v_caller
       AND r.requesting_device_id = p_device_id
       AND r.status = 'pending';

    INSERT INTO public.device_approval_requests AS r (
        user_id, requesting_device_id, requesting_label, requesting_ecdh_public_key,
        pairing_token_hash, pairing_proof, status, expires_at
    ) VALUES (
        v_caller, p_device_id, left(p_label, 120), p_ecdh_public_key,
        p_token_hash, p_proof, 'pending', v_expires
    )
    RETURNING r.id INTO v_id;

    RETURN QUERY SELECT v_id, v_expires;
END;
$$;

COMMENT ON FUNCTION public.create_device_pairing_request(text, text, text, text, text) IS
    'Opens a QR pairing request for an active device of the caller; expires its earlier pending requests.';

REVOKE ALL ON FUNCTION public.create_device_pairing_request(text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_device_pairing_request(text, text, text, text, text)
    TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- The three-argument form is replaced; a client calling it by name with three arguments
-- reaches this one through the defaults.
DROP FUNCTION IF EXISTS public.approve_device_request(uuid, text, text);

CREATE OR REPLACE FUNCTION public.approve_device_request(
    p_request_id uuid,
    p_approver_device_id text,
    p_encrypted_sync_bundle text DEFAULT NULL,
    p_pairing_token text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_req public.device_approval_requests%ROWTYPE;
    v_approver public.user_devices%ROWTYPE;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_req FROM public.device_approval_requests
     WHERE id = p_request_id
       FOR UPDATE;
    IF NOT FOUND OR v_req.user_id IS DISTINCT FROM v_caller THEN
        RAISE EXCEPTION 'Approval request not found' USING ERRCODE = '42501';
    END IF;
    IF v_req.status <> 'pending' THEN
        RETURN false;
    END IF;
    IF v_req.expires_at IS NOT NULL AND v_req.expires_at <= now() THEN
        UPDATE public.device_approval_requests
           SET status = 'expired', resolved_at = now()
         WHERE id = p_request_id;
        RETURN false;
    END IF;
    IF p_approver_device_id IS NULL OR p_approver_device_id = v_req.requesting_device_id THEN
        RAISE EXCEPTION 'A device cannot approve its own login' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_approver FROM public.user_devices
     WHERE user_id = v_caller AND device_id = p_approver_device_id;
    IF NOT FOUND OR v_approver.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Approving device is not a valid device on this account'
            USING ERRCODE = '42501';
    END IF;
    IF NOT (
        v_approver.trust_state IN ('verified', 'recovery')
        OR v_approver.created_at <= v_req.created_at - interval '5 seconds'
    ) THEN
        RAISE EXCEPTION 'Only an established device can approve a new login'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.user_devices d
         WHERE d.user_id = v_caller
           AND d.device_id = v_req.requesting_device_id
           AND d.revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'The requesting device is signed out' USING ERRCODE = '42501';
    END IF;

    IF v_req.pairing_token_hash IS NOT NULL THEN
        IF p_pairing_token IS NULL
           OR encode(sha256(convert_to(p_pairing_token, 'UTF8')), 'hex') <> v_req.pairing_token_hash THEN
            RAISE EXCEPTION 'Pairing code does not match this request' USING ERRCODE = '42501';
        END IF;
        IF p_encrypted_sync_bundle IS NULL
           OR p_encrypted_sync_bundle NOT LIKE 'pb1.%'
           OR length(p_encrypted_sync_bundle) > 4096 THEN
            RAISE EXCEPTION 'A pairing approval carries the sealed keys' USING ERRCODE = '22023';
        END IF;
    ELSIF p_encrypted_sync_bundle IS NOT NULL OR p_pairing_token IS NOT NULL THEN
        RAISE EXCEPTION 'Keys are only sent to a device verified by QR code'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.device_approval_requests
       SET status = 'approved',
           approved_by_device_id = p_approver_device_id,
           encrypted_sync_bundle = p_encrypted_sync_bundle,
           resolved_at = now()
     WHERE id = p_request_id;

    IF v_req.pairing_token_hash IS NOT NULL THEN
        UPDATE public.user_devices
           SET trust_state = 'verified'
         WHERE user_id = v_caller
           AND device_id = v_req.requesting_device_id
           AND revoked_at IS NULL;
    END IF;

    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.approve_device_request(uuid, text, text, text) IS
    'Approves a pending device request of the caller''s account; a pairing request needs its token and sealed keys.';

REVOKE ALL ON FUNCTION public.approve_device_request(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_device_request(uuid, text, text, text)
    TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_device_pairing_request(p_request_id uuid, p_device_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    UPDATE public.device_approval_requests
       SET status = 'expired', resolved_at = now()
     WHERE id = p_request_id
       AND user_id = v_caller
       AND requesting_device_id = p_device_id
       AND pairing_token_hash IS NOT NULL
       AND status = 'pending';
    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.cancel_device_pairing_request(uuid, text) IS
    'Withdraws a pending pairing request of the caller''s account for the named device.';

REVOKE ALL ON FUNCTION public.cancel_device_pairing_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_device_pairing_request(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_device_sync_bundle(p_request_id uuid, p_device_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    UPDATE public.device_approval_requests
       SET encrypted_sync_bundle = NULL
     WHERE id = p_request_id
       AND user_id = v_caller
       AND requesting_device_id = p_device_id
       AND encrypted_sync_bundle IS NOT NULL;
    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.consume_device_sync_bundle(uuid, text) IS
    'Clears the sealed keys of a request once the requesting device has imported them.';

REVOKE ALL ON FUNCTION public.consume_device_sync_bundle(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_device_sync_bundle(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deny_device_request(p_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_req public.device_approval_requests%ROWTYPE;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_req FROM public.device_approval_requests
     WHERE id = p_request_id
       FOR UPDATE;
    IF NOT FOUND OR v_req.user_id IS DISTINCT FROM v_caller THEN
        RAISE EXCEPTION 'Approval request not found' USING ERRCODE = '42501';
    END IF;
    IF v_req.status <> 'pending' THEN
        RETURN false;
    END IF;

    UPDATE public.device_approval_requests
       SET status = 'denied', resolved_at = now()
     WHERE id = p_request_id;

    UPDATE public.user_devices
       SET trust_state = 'revoked', revoked_at = COALESCE(revoked_at, now())
     WHERE user_id = v_caller
       AND device_id = v_req.requesting_device_id;

    UPDATE public.device_approval_requests
       SET status = 'expired', resolved_at = now()
     WHERE user_id = v_caller
       AND requesting_device_id = v_req.requesting_device_id
       AND status = 'pending';

    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.deny_device_request(uuid) IS
    'Denies a pending device request of the caller''s account and signs that device out.';

REVOKE ALL ON FUNCTION public.deny_device_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deny_device_request(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_device(p_device_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_found boolean;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    UPDATE public.user_devices
       SET trust_state = 'revoked', revoked_at = COALESCE(revoked_at, now())
     WHERE user_id = v_caller
       AND device_id = p_device_id;
    v_found := FOUND;

    UPDATE public.device_approval_requests
       SET status = 'expired', resolved_at = now()
     WHERE user_id = v_caller
       AND requesting_device_id = p_device_id
       AND status = 'pending';

    RETURN v_found;
END;
$$;

COMMENT ON FUNCTION public.revoke_device(text) IS
    'Signs a device of the caller''s account out of encryption; its pending requests expire.';

REVOKE ALL ON FUNCTION public.revoke_device(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_device(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_device_recovery_trust(p_device_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    UPDATE public.user_devices
       SET trust_state = 'recovery'
     WHERE user_id = v_caller
       AND device_id = p_device_id
       AND revoked_at IS NULL
       AND trust_state IN ('untrusted', 'account');
    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.claim_device_recovery_trust(text) IS
    'Raises an active device of the caller''s account from untrusted or account to recovery after a recovery-phrase unlock.';

REVOKE ALL ON FUNCTION public.claim_device_recovery_trust(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_device_recovery_trust(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- Definers run as their owner and pass; so do writes nested in another trigger (cascades
-- from profiles).
CREATE OR REPLACE FUNCTION public.guard_user_device_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.revoked_at IS NULL THEN
            RAISE EXCEPTION 'sign a device out before removing it' USING ERRCODE = '42501';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.trust_state NOT IN ('untrusted', 'account') OR NEW.revoked_at IS NOT NULL THEN
            RAISE EXCEPTION 'a new device starts active, untrusted or account'
                USING ERRCODE = '42501';
        END IF;
        NEW.device_ecdh_public_key := NULL;
        NEW.created_at := now();
        RETURN NEW;
    END IF;

    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.device_id IS DISTINCT FROM OLD.device_id
       OR NEW.trust_state IS DISTINCT FROM OLD.trust_state
       OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'device trust and sign-out change through the device RPCs'
            USING ERRCODE = '42501';
    END IF;
    IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'a signed-out device is not updated' USING ERRCODE = '42501';
    END IF;
    IF OLD.device_signing_public_key IS NOT NULL
       AND NEW.device_signing_public_key IS DISTINCT FROM OLD.device_signing_public_key THEN
        RAISE EXCEPTION 'a published device signing key is not replaced' USING ERRCODE = '42501';
    END IF;
    NEW.platform := OLD.platform;
    NEW.device_ecdh_public_key := OLD.device_ecdh_public_key;
    NEW.created_at := OLD.created_at;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_user_device_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_user_devices_client_write_guard ON public.user_devices;
CREATE TRIGGER a_user_devices_client_write_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.user_devices
    FOR EACH ROW EXECUTE FUNCTION public.guard_user_device_client_write();

COMMIT;
