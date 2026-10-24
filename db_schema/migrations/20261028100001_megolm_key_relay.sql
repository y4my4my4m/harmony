-- Megolm key relay: any current member of a room answers a member's key request with a session
-- key it holds, so a member who joined after a message was sent reads it while its author is
-- offline, gone or out of the server.
--
-- megolm_key_requests.accepts_relay          set by a requester that verifies a relayed key
--                                            before importing it. Without it only
--                                            sender_user_id answers, as before.
-- megolm_key_requests.fulfilled_by_user_id   profile whose identity key wrapped encrypted_key.
--                                            NULL: sender_user_id wrapped it (rows answered
--                                            through the megolm_key_requests_fulfill policy).
-- fulfill_megolm_key_request(id, key)         pending -> fulfilled, first answer wins. Caller
--                                            and requester pass is_room_member for the room;
--                                            a caller other than sender_user_id needs
--                                            accepts_relay; the requester cannot answer.
-- get_relayable_key_requests(limit)           pending requests of the last 30 days the caller
--                                            may answer under the same rule. The client
--                                            answers only for sessions it holds.
-- broadcast_key_request_event                 an accepts_relay request also reaches up to 5
--                                            recipients of the session's megolm_session_shares
--                                            rows who are in the room; key_fulfilled carries
--                                            fulfilled_by_user_id.
-- skip_share_from_other_sender                a client share row for a session already shared
--                                            by another sender, and never by this one, is
--                                            skipped. Clients before this migration answer a
--                                            relayed request by sharing the key under their
--                                            own id; the recipient's session store, keyed by
--                                            session id, would replace the author's copy.
--
-- The server cannot read a key, so it cannot tell a relay's key from garbage. The requester
-- imports a relayed key only once it decrypts and authenticates a signed ciphertext of that
-- session; a key that does not is refused and the request expired.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.megolm_key_requests
    ADD COLUMN IF NOT EXISTS accepts_relay boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS fulfilled_by_user_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.megolm_key_requests'::regclass
                      AND conname = 'megolm_key_requests_fulfilled_by_user_id_fkey') THEN
        ALTER TABLE public.megolm_key_requests
            ADD CONSTRAINT megolm_key_requests_fulfilled_by_user_id_fkey
            FOREIGN KEY (fulfilled_by_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_fulfilled_by
    ON public.megolm_key_requests (fulfilled_by_user_id);

COMMENT ON COLUMN public.megolm_key_requests.accepts_relay IS
    'Any member of the room holding the session may answer, not only sender_user_id';
COMMENT ON COLUMN public.megolm_key_requests.fulfilled_by_user_id IS
    'Profile whose identity key wrapped encrypted_key; NULL means sender_user_id';

CREATE OR REPLACE FUNCTION public.fulfill_megolm_key_request(p_request_id uuid, p_encrypted_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_request public.megolm_key_requests%ROWTYPE;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;
    -- A v2 wrap of a 32-byte session key is 99 characters.
    IF p_encrypted_key IS NULL OR length(p_encrypted_key) = 0 OR length(p_encrypted_key) > 1024 THEN
        RAISE EXCEPTION 'invalid encrypted key' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_request FROM public.megolm_key_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND OR v_request.status IS DISTINCT FROM 'pending' THEN
        RETURN false;
    END IF;
    IF v_request.requester_user_id = v_caller THEN
        RAISE EXCEPTION 'a request is answered by another member' USING ERRCODE = '42501';
    END IF;
    IF v_request.sender_user_id IS DISTINCT FROM v_caller AND NOT v_request.accepts_relay THEN
        RAISE EXCEPTION 'the request is addressed to its sender only' USING ERRCODE = '42501';
    END IF;
    IF NOT public.is_room_member(v_request.room_id, v_caller)
       OR NOT public.is_room_member(v_request.room_id, v_request.requester_user_id) THEN
        RAISE EXCEPTION 'caller and requester must both be in the room' USING ERRCODE = '42501';
    END IF;

    UPDATE public.megolm_key_requests
       SET status = 'fulfilled',
           encrypted_key = p_encrypted_key,
           fulfilled_at = now(),
           fulfilled_by_user_id = v_caller,
           updated_at = now()
     WHERE id = p_request_id;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fulfill_megolm_key_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fulfill_megolm_key_request(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_relayable_key_requests(p_limit integer DEFAULT 200)
RETURNS TABLE(
    id uuid,
    requester_user_id uuid,
    sender_user_id uuid,
    room_id text,
    session_id text,
    status text,
    request_signature text,
    request_signing_fingerprint text,
    accepts_relay boolean,
    created_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_caller IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT r.id, r.requester_user_id, r.sender_user_id, r.room_id, r.session_id, r.status,
           r.request_signature, r.request_signing_fingerprint, r.accepts_relay, r.created_at
      FROM public.megolm_key_requests r
     WHERE r.status = 'pending'
       AND r.created_at > now() - interval '30 days'
       AND r.requester_user_id <> v_caller
       AND (r.sender_user_id = v_caller OR r.accepts_relay)
       AND public.is_room_member(r.room_id, v_caller)
       AND public.is_room_member(r.room_id, r.requester_user_id)
     ORDER BY r.created_at DESC
     LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
END;
$$;

REVOKE ALL ON FUNCTION public.get_relayable_key_requests(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_relayable_key_requests(integer) TO authenticated, service_role;

-- Megolm key request/fulfilled -> user:{user_id}
CREATE OR REPLACE FUNCTION public.broadcast_key_request_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_payload jsonb;
    v_holder uuid;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_payload := jsonb_build_object(
            'type',               'encryption:key_request',
            'id',                 NEW.id,
            'requester_user_id',  NEW.requester_user_id,
            'sender_user_id',     NEW.sender_user_id,
            'room_id',            NEW.room_id,
            'session_id',         NEW.session_id,
            'status',             NEW.status,
            'request_signature',  NEW.request_signature,
            'request_signing_fingerprint', NEW.request_signing_fingerprint,
            'accepts_relay',      NEW.accepts_relay,
            'created_at',         NEW.created_at
        );
        IF NEW.sender_user_id IS NOT NULL THEN
            PERFORM realtime.send(v_payload, 'user_event', 'user:' || NEW.sender_user_id::text, true);
        END IF;
        IF NEW.accepts_relay THEN
            -- Most recent claims first: a recently active device most likely holds the key.
            FOR v_holder IN
                SELECT h.recipient_user_id
                  FROM (SELECT s.recipient_user_id
                          FROM public.megolm_session_shares s
                         WHERE s.room_id = NEW.room_id
                           AND s.session_id = NEW.session_id
                           AND s.recipient_user_id <> NEW.requester_user_id
                           AND s.recipient_user_id IS DISTINCT FROM NEW.sender_user_id
                         GROUP BY s.recipient_user_id
                         ORDER BY max(s.claimed_at) DESC NULLS LAST
                         LIMIT 5) h
                 WHERE public.is_room_member(NEW.room_id, h.recipient_user_id)
            LOOP
                PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_holder::text, true);
            END LOOP;
        END IF;
    ELSIF TG_OP = 'UPDATE' AND NEW.status = 'fulfilled' THEN
        PERFORM realtime.send(
            jsonb_build_object(
                'type',                 'encryption:key_fulfilled',
                'id',                   NEW.id,
                'requester_user_id',    NEW.requester_user_id,
                'sender_user_id',       NEW.sender_user_id,
                'fulfilled_by_user_id', NEW.fulfilled_by_user_id,
                'room_id',              NEW.room_id,
                'session_id',           NEW.session_id,
                'encrypted_key',        NEW.encrypted_key,
                'fulfilled_at',         NEW.fulfilled_at
            ),
            'user_event',
            'user:' || NEW.requester_user_id::text,
            true
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.skip_share_from_other_sender()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
       AND NOT EXISTS (SELECT 1 FROM public.megolm_session_shares s
                        WHERE s.session_id = NEW.session_id AND s.room_id = NEW.room_id
                          AND s.sender_user_id = NEW.sender_user_id)
       AND EXISTS (SELECT 1 FROM public.megolm_session_shares s
                    WHERE s.session_id = NEW.session_id AND s.room_id = NEW.room_id
                      AND s.sender_user_id IS DISTINCT FROM NEW.sender_user_id) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.skip_share_from_other_sender() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.skip_share_from_other_sender() TO service_role;

DROP TRIGGER IF EXISTS b_megolm_session_shares_sender_guard ON public.megolm_session_shares;
CREATE TRIGGER b_megolm_session_shares_sender_guard
    BEFORE INSERT ON public.megolm_session_shares
    FOR EACH ROW EXECUTE FUNCTION public.skip_share_from_other_sender();

COMMIT;

NOTIFY pgrst, 'reload schema';
