-- Who receives the keys of a room's earlier encrypted messages (keys travel by
-- 20261028100001_megolm_key_relay.sql and by megolm_session_shares).
--
-- channel_encryption_settings.history_visibility, for a member and a session that began before
-- the member joined:
--   all      the session key (default)
--   pinned   the key of one pinned message of the session, never the session key
--   none     nothing
-- A session that began after the member joined is theirs in every mode. Conversations are
-- 'none' and have no setting. Every channel converges to 'all': 'joined' and 'shared' were
-- stored without effect on key delivery. set_channel_encryption keeps its 'joined' / 'shared'
-- argument (written as 'none' / 'all' by normalize_channel_history_visibility);
-- set_channel_history_visibility(channel, value) takes the new values under the same
-- permission, checked by a set_channel_encryption call that changes nothing.
--
-- A member joined at user_servers.created_at (a server owner without a row: servers.created_at)
-- or, in a group conversation, at conversation_participants.joined_at; a direct conversation has
-- no earlier history for either participant. Access to a private channel granted after joining
-- the server counts from the server join. A session began before a time when its sender has a
-- message or a megolm_session_shares row in the room from before it
-- (megolm_session_began_before); only the session's sender writes either, so no one else moves
-- that start.
--
-- megolm_key_scope_allowed(room, session, sender, user, message) -> 'session' | 'message' | NULL
-- decides for:
--   fulfill_megolm_key_request    p_key_scope 'session' or 'message' (the key of
--                                 request.message_id alone); records key_scope.
--   guard_megolm_key_request      client updates: identity columns of a request are fixed; a
--                                 fulfil without key_scope (the megolm_key_requests_fulfill
--                                 policy of older apps) needs 'session'.
--   skip_share_hidden_history     a client share row the recipient may not receive is skipped.
--                                 A sender whose share is skipped rotates its session.
--   get_relayable_key_requests    requests without a scope are not listed; listed rows carry
--                                 key_scope, message_id, message_index.
--   broadcast_key_request_event   no event for a request without a scope.
-- megolm_key_requests.message_id is the message the requester could not read; message_index
-- is read from that row on insert (key_request_message_index), never taken from the client.
--
-- Keys already delivered stay delivered: a stricter mode, an unpin or a removal revokes
-- nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Setting
-- ---------------------------------------------------------------------------

ALTER TABLE public.channel_encryption_settings
    DROP CONSTRAINT IF EXISTS channel_encryption_settings_history_visibility_check;

-- One broadcast per channel row would flood server-structure topics; clients read the value
-- from effective_channel_encryption when the settings open.
ALTER TABLE public.channel_encryption_settings DISABLE TRIGGER trg_broadcast_channel_encryption;
UPDATE public.channel_encryption_settings
   SET history_visibility = 'all'
 WHERE history_visibility IS DISTINCT FROM 'all'
   AND history_visibility NOT IN ('pinned', 'none');
ALTER TABLE public.channel_encryption_settings ENABLE TRIGGER trg_broadcast_channel_encryption;

ALTER TABLE public.channel_encryption_settings
    ALTER COLUMN history_visibility SET DEFAULT 'all';
ALTER TABLE public.channel_encryption_settings
    ADD CONSTRAINT channel_encryption_settings_history_visibility_check
    CHECK (history_visibility IN ('all', 'pinned', 'none'));

COMMENT ON COLUMN public.channel_encryption_settings.history_visibility IS
'For a session that began before a member joined: all = its key, pinned = keys of its pinned messages, none = nothing.';

CREATE OR REPLACE FUNCTION public.normalize_channel_history_visibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.history_visibility := CASE NEW.history_visibility
                                  WHEN 'shared' THEN 'all'
                                  WHEN 'joined' THEN 'none'
                                  ELSE NEW.history_visibility
                              END;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_channel_history_visibility() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_channel_history_visibility() TO service_role;

DROP TRIGGER IF EXISTS trg_normalize_channel_history_visibility ON public.channel_encryption_settings;
CREATE TRIGGER trg_normalize_channel_history_visibility
    BEFORE INSERT OR UPDATE OF history_visibility ON public.channel_encryption_settings
    FOR EACH ROW EXECUTE FUNCTION public.normalize_channel_history_visibility();

CREATE OR REPLACE FUNCTION public.set_channel_history_visibility(p_channel_id uuid, p_history_visibility text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_history_visibility IS NULL OR p_history_visibility NOT IN ('all', 'pinned', 'none') THEN
        RAISE EXCEPTION 'Unknown history visibility: %', p_history_visibility USING ERRCODE = '22023';
    END IF;

    -- Authentication, MANAGE_CHANNELS, local server and the settings row.
    PERFORM public.set_channel_encryption(p_channel_id);

    UPDATE public.channel_encryption_settings
       SET history_visibility = p_history_visibility,
           updated_at = now()
     WHERE channel_id = p_channel_id;

    RETURN public.effective_channel_encryption(p_channel_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_channel_history_visibility(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_channel_history_visibility(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Rule
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_messages_encrypted_session
    ON public.messages ((encryption_metadata->>'session_id'), created_at)
    WHERE encrypted IS TRUE;
CREATE INDEX IF NOT EXISTS idx_megolm_session_shares_session_created
    ON public.megolm_session_shares (session_id, room_id, created_at);

CREATE OR REPLACE FUNCTION public.room_history_visibility(p_room_id text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_room uuid;
    v_mode text;
BEGIN
    BEGIN
        v_room := p_room_id::uuid;
    EXCEPTION WHEN others THEN
        RETURN 'none';
    END;

    SELECT COALESCE(ces.history_visibility, 'all') INTO v_mode
      FROM public.channels c
      LEFT JOIN public.channel_encryption_settings ces ON ces.channel_id = c.id
     WHERE c.id = v_room;

    RETURN COALESCE(v_mode, 'none');
END;
$$;

CREATE OR REPLACE FUNCTION public.room_joined_at(p_room_id text, p_user_id uuid)
RETURNS timestamp with time zone
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_room uuid;
    v_server uuid;
    v_owner uuid;
    v_server_created timestamp with time zone;
    v_joined timestamp with time zone;
BEGIN
    BEGIN
        v_room := p_room_id::uuid;
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;

    SELECT c.server_id, s.owner, s.created_at INTO v_server, v_owner, v_server_created
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = v_room;

    IF v_server IS NOT NULL THEN
        SELECT us.created_at INTO v_joined
          FROM public.user_servers us
         WHERE us.server_id = v_server AND us.user_id = p_user_id AND us.status = 'accepted';
        IF v_joined IS NULL AND v_owner = p_user_id THEN
            v_joined := v_server_created;
        END IF;
        RETURN v_joined;
    END IF;

    -- A direct conversation has its two participants for life: nothing predates either.
    SELECT CASE WHEN c.type = 'direct' THEN '-infinity'::timestamp with time zone ELSE max(cp.joined_at) END
      INTO v_joined
      FROM public.conversation_participants cp
      JOIN public.conversations c ON c.id = cp.conversation_id
     WHERE cp.conversation_id = v_room AND cp.user_id = p_user_id AND cp.left_at IS NULL
     GROUP BY c.type;
    RETURN v_joined;
END;
$$;

CREATE OR REPLACE FUNCTION public.megolm_session_began_before(
    p_room_id text,
    p_session_id text,
    p_sender uuid,
    p_at timestamp with time zone
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
               SELECT 1 FROM public.megolm_session_shares s
                WHERE s.session_id = p_session_id
                  AND s.room_id = p_room_id
                  AND s.created_at < p_at
                  AND (p_sender IS NULL OR s.sender_user_id = p_sender))
        OR EXISTS (
               SELECT 1 FROM public.messages m
                WHERE m.encrypted IS TRUE
                  AND (m.encryption_metadata->>'session_id') = p_session_id
                  AND m.created_at < p_at
                  AND (m.channel_id::text = p_room_id OR m.conversation_id::text = p_room_id)
                  AND (p_sender IS NULL OR m.user_id = p_sender));
$$;

CREATE OR REPLACE FUNCTION public.megolm_key_scope_allowed(
    p_room_id text,
    p_session_id text,
    p_sender uuid,
    p_user_id uuid,
    p_message_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_mode text := public.room_history_visibility(p_room_id);
    v_joined timestamp with time zone;
BEGIN
    IF v_mode = 'all' THEN
        RETURN 'session';
    END IF;

    v_joined := public.room_joined_at(p_room_id, p_user_id);
    IF v_joined IS NULL THEN
        RETURN NULL;
    END IF;
    IF NOT public.megolm_session_began_before(p_room_id, p_session_id, p_sender, v_joined) THEN
        RETURN 'session';
    END IF;

    IF v_mode = 'pinned' AND p_message_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.messages m
         WHERE m.id = p_message_id
           AND m.is_pinned IS TRUE
           AND m.is_deleted IS NOT TRUE
           AND m.encrypted IS TRUE
           AND (m.encryption_metadata->>'session_id') = p_session_id
           AND (m.channel_id::text = p_room_id OR m.conversation_id::text = p_room_id)
           AND (p_sender IS NULL OR m.user_id = p_sender)
    ) THEN
        RETURN 'message';
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.room_history_visibility(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.room_joined_at(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.megolm_session_began_before(text, text, uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.megolm_key_scope_allowed(text, text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.room_history_visibility(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.room_joined_at(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.megolm_session_began_before(text, text, uuid, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.megolm_key_scope_allowed(text, text, uuid, uuid, uuid) TO service_role;

-- room_joined_at decides which history a member reads: a client never sets the join time. An
-- insert takes now(), an update keeps the stored value. Pinned, not refused: clients writing
-- whole rows keep working.
CREATE OR REPLACE FUNCTION public.pin_membership_join_time()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_TABLE_NAME = 'user_servers' THEN
        NEW.created_at := CASE WHEN TG_OP = 'INSERT' THEN now() ELSE OLD.created_at END;
    ELSE
        NEW.joined_at := CASE WHEN TG_OP = 'INSERT' THEN now() ELSE OLD.joined_at END;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.pin_membership_join_time() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_user_servers_pin_join_time ON public.user_servers;
CREATE TRIGGER a_user_servers_pin_join_time
    BEFORE INSERT OR UPDATE ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.pin_membership_join_time();

DROP TRIGGER IF EXISTS a_conversation_participants_pin_join_time ON public.conversation_participants;
CREATE TRIGGER a_conversation_participants_pin_join_time
    BEFORE INSERT OR UPDATE ON public.conversation_participants
    FOR EACH ROW EXECUTE FUNCTION public.pin_membership_join_time();

-- ---------------------------------------------------------------------------
-- Key requests
-- ---------------------------------------------------------------------------

ALTER TABLE public.megolm_key_requests
    ADD COLUMN IF NOT EXISTS message_id uuid,
    ADD COLUMN IF NOT EXISTS message_index integer,
    ADD COLUMN IF NOT EXISTS key_scope text;

ALTER TABLE public.megolm_key_requests DROP CONSTRAINT IF EXISTS megolm_key_requests_key_scope_check;
ALTER TABLE public.megolm_key_requests
    ADD CONSTRAINT megolm_key_requests_key_scope_check CHECK (key_scope IN ('session', 'message'));

COMMENT ON COLUMN public.megolm_key_requests.message_id IS
    'Message the requester could not read; pinned-only rooms answer for it alone';
COMMENT ON COLUMN public.megolm_key_requests.message_index IS
    'Megolm index of message_id, read from the message row on insert';
COMMENT ON COLUMN public.megolm_key_requests.key_scope IS
    'What encrypted_key holds: session = the session key, message = the key of message_id';

CREATE OR REPLACE FUNCTION public.key_request_message_index()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_index text;
BEGIN
    NEW.key_scope := NULL;
    NEW.message_index := NULL;
    IF NEW.message_id IS NOT NULL THEN
        SELECT m.encryption_metadata->>'message_index' INTO v_index
          FROM public.messages m
         WHERE m.id = NEW.message_id
           AND m.encrypted IS TRUE
           AND (m.encryption_metadata->>'session_id') = NEW.session_id
           AND (m.channel_id::text = NEW.room_id OR m.conversation_id::text = NEW.room_id);
        IF v_index ~ '^[0-9]{1,9}$' THEN
            NEW.message_index := v_index::integer;
        ELSE
            NEW.message_id := NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.key_request_message_index() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.key_request_message_index() TO service_role;

DROP TRIGGER IF EXISTS a_key_request_message_index ON public.megolm_key_requests;
CREATE TRIGGER a_key_request_message_index
    BEFORE INSERT ON public.megolm_key_requests
    FOR EACH ROW EXECUTE FUNCTION public.key_request_message_index();

CREATE OR REPLACE FUNCTION public.guard_megolm_key_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_allowed text;
BEGIN
    IF COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated') THEN
        RETURN NEW;
    END IF;

    IF NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
       OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
       OR NEW.room_id IS DISTINCT FROM OLD.room_id
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.message_id IS DISTINCT FROM OLD.message_id
       OR NEW.message_index IS DISTINCT FROM OLD.message_index THEN
        RAISE EXCEPTION 'a key request names its room, session, message and parties once'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.status = 'fulfilled' AND OLD.status IS DISTINCT FROM 'fulfilled' THEN
        v_allowed := public.megolm_key_scope_allowed(NEW.room_id, NEW.session_id, NEW.sender_user_id,
                                                     NEW.requester_user_id, NEW.message_id);
        IF v_allowed IS NULL OR (COALESCE(NEW.key_scope, 'session') = 'session' AND v_allowed <> 'session') THEN
            RAISE EXCEPTION 'the requester may not receive this key' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_megolm_key_request() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_megolm_key_request() TO service_role;

DROP TRIGGER IF EXISTS a_guard_megolm_key_request ON public.megolm_key_requests;
CREATE TRIGGER a_guard_megolm_key_request
    BEFORE UPDATE ON public.megolm_key_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_megolm_key_request();

DROP FUNCTION IF EXISTS public.fulfill_megolm_key_request(uuid, text);

CREATE OR REPLACE FUNCTION public.fulfill_megolm_key_request(
    p_request_id uuid,
    p_encrypted_key text,
    p_key_scope text DEFAULT 'session'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_request public.megolm_key_requests%ROWTYPE;
    v_allowed text;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;
    -- A v2 wrap of a 32-byte session key is 99 characters.
    IF p_encrypted_key IS NULL OR length(p_encrypted_key) = 0 OR length(p_encrypted_key) > 1024 THEN
        RAISE EXCEPTION 'invalid encrypted key' USING ERRCODE = '22023';
    END IF;
    IF p_key_scope IS NULL OR p_key_scope NOT IN ('session', 'message') THEN
        RAISE EXCEPTION 'invalid key scope' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_request FROM public.megolm_key_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND OR v_request.status IS DISTINCT FROM 'pending' THEN
        RETURN false;
    END IF;
    -- A member's own request is answered by another member, or by their own other device for a
    -- session they sent: own sessions have no share row.
    IF v_request.requester_user_id = v_caller AND v_request.sender_user_id IS DISTINCT FROM v_caller THEN
        RAISE EXCEPTION 'a request is answered by another member' USING ERRCODE = '42501';
    END IF;
    IF v_request.sender_user_id IS DISTINCT FROM v_caller AND NOT v_request.accepts_relay THEN
        RAISE EXCEPTION 'the request is addressed to its sender only' USING ERRCODE = '42501';
    END IF;
    IF NOT public.is_room_member(v_request.room_id, v_caller)
       OR NOT public.is_room_member(v_request.room_id, v_request.requester_user_id) THEN
        RAISE EXCEPTION 'caller and requester must both be in the room' USING ERRCODE = '42501';
    END IF;
    IF p_key_scope = 'message' AND v_request.message_id IS NULL THEN
        RAISE EXCEPTION 'the request names no message' USING ERRCODE = '22023';
    END IF;

    v_allowed := CASE WHEN v_request.requester_user_id = v_request.sender_user_id THEN 'session'
                      ELSE public.megolm_key_scope_allowed(v_request.room_id, v_request.session_id,
                                                           v_request.sender_user_id, v_request.requester_user_id,
                                                           v_request.message_id) END;
    IF v_allowed IS NULL OR (p_key_scope = 'session' AND v_allowed <> 'session') THEN
        RAISE EXCEPTION 'the requester may not receive this key' USING ERRCODE = '42501';
    END IF;

    UPDATE public.megolm_key_requests
       SET status = 'fulfilled',
           encrypted_key = p_encrypted_key,
           key_scope = p_key_scope,
           fulfilled_at = now(),
           fulfilled_by_user_id = v_caller,
           updated_at = now()
     WHERE id = p_request_id;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fulfill_megolm_key_request(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fulfill_megolm_key_request(uuid, text, text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_relayable_key_requests(integer);

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
    message_id uuid,
    message_index integer,
    key_scope text,
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
           r.request_signature, r.request_signing_fingerprint, r.accepts_relay,
           r.message_id, r.message_index, a.scope, r.created_at
      FROM public.megolm_key_requests r
      CROSS JOIN LATERAL (
            SELECT CASE WHEN r.requester_user_id = r.sender_user_id THEN 'session'
                        ELSE public.megolm_key_scope_allowed(r.room_id, r.session_id, r.sender_user_id,
                                                             r.requester_user_id, r.message_id) END AS scope
      ) a
     WHERE r.status = 'pending'
       AND r.created_at > now() - interval '30 days'
       AND (r.requester_user_id <> v_caller OR r.sender_user_id = v_caller)
       AND (r.sender_user_id = v_caller OR r.accepts_relay)
       AND public.is_room_member(r.room_id, v_caller)
       AND public.is_room_member(r.room_id, r.requester_user_id)
       AND a.scope IS NOT NULL
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
    v_scope text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_scope := public.megolm_key_scope_allowed(NEW.room_id, NEW.session_id, NEW.sender_user_id,
                                                   NEW.requester_user_id, NEW.message_id);
        IF v_scope IS NULL THEN
            RETURN NEW;
        END IF;
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
            'message_id',         NEW.message_id,
            'message_index',      NEW.message_index,
            'key_scope',          v_scope,
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
                'message_id',           NEW.message_id,
                'key_scope',            NEW.key_scope,
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

-- ---------------------------------------------------------------------------
-- Session shares
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.skip_share_hidden_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
       AND public.megolm_key_scope_allowed(NEW.room_id, NEW.session_id, NEW.sender_user_id,
                                           NEW.recipient_user_id, NULL) IS DISTINCT FROM 'session' THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.skip_share_hidden_history() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.skip_share_hidden_history() TO service_role;

DROP TRIGGER IF EXISTS c_megolm_session_shares_history_guard ON public.megolm_session_shares;
CREATE TRIGGER c_megolm_session_shares_history_guard
    BEFORE INSERT ON public.megolm_session_shares
    FOR EACH ROW EXECUTE FUNCTION public.skip_share_hidden_history();

COMMIT;

NOTIFY pgrst, 'reload schema';
