-- ---------------------------------------------------------------------------
-- Authorization-aware Megolm key requests.
--
-- Previously a key request was auto-fulfilled by any holder of the session,
-- with no proof the request came from the claimed requester and no check that
-- the requester is still in the room. This migration adds the server side of
-- the fix (the client enforces both checks in MegolmKeyBackupService):
--
--   1. broadcast_key_request_event() now forwards request_signature /
--      request_signing_fingerprint so the fulfiller can verify the request
--      signature directly from the realtime payload.
--   2. is_room_member(room_id, user_id) provides a server-authoritative
--      membership check (channel -> server membership, or conversation ->
--      active participant) used to deny removed / non-members.
--
-- Requires 20260530_align_megolm_encryption_schema.sql (adds request_signature
-- / request_signing_fingerprint columns) to have run first.
-- ---------------------------------------------------------------------------
BEGIN;

-- (1) Forward signature material in the key-request broadcast.
CREATE OR REPLACE FUNCTION public.broadcast_key_request_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.sender_user_id IS NOT NULL THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',               'encryption:key_request',
        'id',                 NEW.id,
        'requester_user_id',  NEW.requester_user_id,
        'sender_user_id',     NEW.sender_user_id,
        'room_id',            NEW.room_id,
        'session_id',         NEW.session_id,
        'status',             NEW.status,
        'request_signature',  NEW.request_signature,
        'request_signing_fingerprint', NEW.request_signing_fingerprint,
        'created_at',         NEW.created_at
      ),
      'user_event',
      'user:' || NEW.sender_user_id::text,
      true
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'fulfilled' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',               'encryption:key_fulfilled',
        'id',                 NEW.id,
        'requester_user_id',  NEW.requester_user_id,
        'sender_user_id',     NEW.sender_user_id,
        'room_id',            NEW.room_id,
        'session_id',         NEW.session_id,
        'encrypted_key',      NEW.encrypted_key,
        'fulfilled_at',       NEW.fulfilled_at
      ),
      'user_event',
      'user:' || NEW.requester_user_id::text,
      true
    );
  END IF;

  RETURN NEW;
END;
$$;

-- (2) Server-authoritative room membership check.
CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id text, p_user_id uuid)
RETURNS boolean
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_room_uuid uuid;
    v_server_id uuid;
BEGIN
    IF p_room_id IS NULL OR p_user_id IS NULL THEN
        RETURN false;
    END IF;

    BEGIN
        v_room_uuid := p_room_id::uuid;
    EXCEPTION WHEN others THEN
        RETURN false;
    END;

    SELECT server_id INTO v_server_id FROM public.channels WHERE id = v_room_uuid;
    IF v_server_id IS NOT NULL THEN
        RETURN EXISTS (
            SELECT 1 FROM public.user_servers
            WHERE server_id = v_server_id AND user_id = p_user_id
        );
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.conversation_participants
        WHERE conversation_id = v_room_uuid
          AND user_id = p_user_id
          AND left_at IS NULL
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_room_member(text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
