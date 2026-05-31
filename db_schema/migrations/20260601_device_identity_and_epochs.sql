-- ---------------------------------------------------------------------------
-- Device-aware E2EE: per-device identities, device approval, membership epochs.
--
-- Adds the Phase 3 server-side objects:
--   * user_devices               - per-device public keys + trust state
--   * device_approval_requests   - "new login - was this you?" cross-device sync
--   * room_epoch_state           - membership epoch per room (rotates sessions)
--   * bump_room_epoch / get_room_epoch / bump_server_channel_epochs
--   * epoch-bump triggers on conversation_participants and user_servers
--
-- Idempotent; safe to run on existing deploys.
-- ---------------------------------------------------------------------------
BEGIN;

-- ===========================================================================
-- Tables
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.user_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    device_id text NOT NULL,
    device_ecdh_public_key text,
    device_signing_public_key text,
    trust_state text NOT NULL DEFAULT 'account',
    platform text,
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now(),
    revoked_at timestamp with time zone,
    UNIQUE(user_id, device_id),
    CONSTRAINT user_devices_trust_check
        CHECK (trust_state IN ('untrusted', 'account', 'recovery', 'verified', 'revoked'))
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user ON public.user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_active ON public.user_devices(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.device_approval_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    requesting_device_id text NOT NULL,
    requesting_label text,
    requesting_ecdh_public_key text,
    status text NOT NULL DEFAULT 'pending',
    approved_by_device_id text,
    encrypted_sync_bundle text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + interval '15 minutes'),
    CONSTRAINT device_approval_requests_status_check
        CHECK (status IN ('pending', 'approved', 'denied', 'expired'))
);
CREATE INDEX IF NOT EXISTS idx_device_approval_user ON public.device_approval_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_device_approval_pending ON public.device_approval_requests(user_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.room_epoch_state (
    room_id text NOT NULL PRIMARY KEY,
    current_epoch integer NOT NULL DEFAULT 1,
    member_set_hash text,
    reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- ===========================================================================
-- RLS
-- ===========================================================================
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_devices_select" ON public.user_devices;
CREATE POLICY "user_devices_select" ON public.user_devices
    FOR SELECT USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');
DROP POLICY IF EXISTS "user_devices_insert_own" ON public.user_devices;
CREATE POLICY "user_devices_insert_own" ON public.user_devices
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());
DROP POLICY IF EXISTS "user_devices_update_own" ON public.user_devices;
CREATE POLICY "user_devices_update_own" ON public.user_devices
    FOR UPDATE USING (user_id = public.get_current_profile_id());
DROP POLICY IF EXISTS "user_devices_delete_own" ON public.user_devices;
CREATE POLICY "user_devices_delete_own" ON public.user_devices
    FOR DELETE USING (user_id = public.get_current_profile_id());

ALTER TABLE public.device_approval_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "device_approval_requests_own" ON public.device_approval_requests;
CREATE POLICY "device_approval_requests_own" ON public.device_approval_requests
    FOR ALL USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id());

ALTER TABLE public.room_epoch_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "room_epoch_state_select" ON public.room_epoch_state;
CREATE POLICY "room_epoch_state_select" ON public.room_epoch_state
    FOR SELECT USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

-- ===========================================================================
-- Functions
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.bump_room_epoch(p_room_id text, p_reason text DEFAULT 'manual_rotate')
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
    AS $$
DECLARE
    v_epoch integer;
BEGIN
    IF p_room_id IS NULL THEN RETURN NULL; END IF;
    INSERT INTO public.room_epoch_state (room_id, current_epoch, reason, updated_at)
    VALUES (p_room_id, 2, p_reason, now())
    ON CONFLICT (room_id) DO UPDATE
        SET current_epoch = public.room_epoch_state.current_epoch + 1,
            reason = EXCLUDED.reason,
            updated_at = now()
    RETURNING current_epoch INTO v_epoch;
    RETURN v_epoch;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_room_epoch(p_room_id text)
RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$
    SELECT COALESCE((SELECT current_epoch FROM public.room_epoch_state WHERE room_id = p_room_id), 1);
$$;

GRANT EXECUTE ON FUNCTION public.bump_room_epoch(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_room_epoch(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.bump_server_channel_epochs(p_server_id uuid, p_reason text)
RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
    AS $$
DECLARE
    v_channel RECORD;
BEGIN
    FOR v_channel IN SELECT id FROM public.channels WHERE server_id = p_server_id LOOP
        PERFORM public.bump_room_epoch(v_channel.id::text, p_reason);
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_conversation_epoch_bump()
RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
    AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.bump_room_epoch(NEW.conversation_id::text, 'member_join');
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.bump_room_epoch(OLD.conversation_id::text, 'member_leave');
    ELSIF TG_OP = 'UPDATE' AND OLD.left_at IS NULL AND NEW.left_at IS NOT NULL THEN
        PERFORM public.bump_room_epoch(NEW.conversation_id::text, 'member_leave');
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_server_epoch_bump()
RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
    AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.bump_server_channel_epochs(NEW.server_id, 'member_join');
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.bump_server_channel_epochs(OLD.server_id, 'member_leave');
    END IF;
    RETURN NULL;
END;
$$;

-- ===========================================================================
-- Triggers
-- ===========================================================================
DROP TRIGGER IF EXISTS trg_conversation_epoch_bump ON public.conversation_participants;
CREATE TRIGGER trg_conversation_epoch_bump
    AFTER INSERT OR UPDATE OR DELETE ON public.conversation_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_conversation_epoch_bump();

DROP TRIGGER IF EXISTS trg_server_epoch_bump ON public.user_servers;
CREATE TRIGGER trg_server_epoch_bump
    AFTER INSERT OR DELETE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_server_epoch_bump();

-- ===========================================================================
-- Device approval broadcasts (Discord-style "new login - was this you?")
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.broadcast_device_approval_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
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
        'expires_at',            NEW.expires_at
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
        'encrypted_sync_bundle', NEW.encrypted_sync_bundle,
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
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_device_approval_event ON public.device_approval_requests;
CREATE TRIGGER trg_broadcast_device_approval_event
    AFTER INSERT OR UPDATE ON public.device_approval_requests
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_device_approval_event();

NOTIFY pgrst, 'reload schema';

COMMIT;
