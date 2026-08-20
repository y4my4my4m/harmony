BEGIN;

-- ============================================================================
-- Step 3b: Replace CDC on megolm_key_requests with user:{id} broadcast.
--
-- Two CDC channels per user are replaced by targeted broadcasts:
--   1. INSERT → broadcast key_request to user:{sender_user_id}
--   2. UPDATE to 'fulfilled' → broadcast key_fulfilled to user:{requester_user_id}
-- ============================================================================

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

DROP TRIGGER IF EXISTS trg_broadcast_key_request_event ON megolm_key_requests;
CREATE TRIGGER trg_broadcast_key_request_event
  AFTER INSERT OR UPDATE ON megolm_key_requests
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_key_request_event();

COMMIT;
