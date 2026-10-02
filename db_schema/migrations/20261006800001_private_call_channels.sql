-- Call, voice and presence signalling on private Realtime channels, after 20261006700001.
--
-- A public channel admits any holder of the anon key: it reads and sends on any topic it
-- names. Call and voice topics move to private channels, where realtime.messages RLS
-- decides. SELECT reads can_subscribe_to_topic; INSERT, which covers broadcast sends and
-- presence tracking, reads can_send_to_topic. Both apply topic_readable_by to the caller's
-- profile; the federation backend applies it to a named profile.
--
--   topic                          read                              send
--   dm-call:<conversation>         active participant                active participant
--   dm-calls:<profile>             the profile                       nobody: ring_dm_call
--   voice-channels:<server>        accepted member                   accepted member
--   voice-channel:<channel>        can_view_channel                  can_view_channel
--   harmony-voice-<room>           voice room access                 voice room access
--   easter-egg:<room>              voice room access                 voice room access
--   typing:conversation:<conv>     active participant                active participant
--   typing:channel:<channel>       can_view_channel                  can_view_channel
--   typing:thread:<thread>         can_view_channel of its channel   can_view_channel of its channel
--   user:<profile>                 the profile (unchanged)           the profile (unchanged)
--   server-presence:<server>       accepted member (unchanged)       accepted member (unchanged)
--
-- Voice room, as webrtcManager names it: dm-<conversation> and
-- federated-dm-<conversation>-<millis> admit active participants; <channel> admits
-- can_view_channel plus CONNECT, without an active timeout, as authorizeVoiceChannel in
-- federation-backend/src/services/voiceAccess.ts.
--
-- Every other topic keeps its read rule and gains no send rule: server-structure,
-- dm-conversation, channel-messages and feed topics carry database broadcasts only.
-- harmony-global-presence has no rule: presence leaves Realtime Presence (below).
--
-- Voice occupancy of a channel some member cannot view (channel_is_restricted) goes on
-- voice-channel:<channel>, which only its viewers read; voice-channels:<server> carries
-- open channels. get_restricted_voice_channels(server) lists the restricted non-text
-- channels of a server the caller can view, the topics a client opens.
--
-- Presence. Realtime Presence lets a client track any key and payload on a topic it may
-- send on, so a shared topic cannot keep one user from posing as another. Presence is
-- kept here instead, keyed by the caller's profile:
--   presence_devices   one row per signed-in tab; live for PRESENCE_TTL (150 s) after its
--                      last heartbeat. Clients heartbeat every 60 s.
--   user_presence      chosen status (1 online, 2 away, 3 busy, 4 invisible), the online
--                      flag derived from live devices, and the state last published.
-- presence_heartbeat(device, status, mobile) and presence_offline(device) write the
-- caller's own rows; presence_sweep() (pg_cron, every minute) drops dead devices. A change
-- of what others see goes out as presence:update on server-presence:<server> for each
-- accepted server, and on user:<partner> for each local partner of an active conversation
-- the user has not blocked. Invisible publishes as offline.
-- get_presence(ids) answers for the caller itself and for profiles that are online, not
-- invisible, have not blocked the caller, and share an accepted server or an active
-- conversation with it, or that it follows (accepted); presence_related_ids applies the
-- same relation for the federation backend. Others read as absent, which is offline.
--
-- servers.is_local_server. NULL read as remote in some paths and local in others. The
-- column default is true and every insert path names it or takes the default; NULL rows
-- become true and the column is NOT NULL.
--
-- ring_dm_call(conversation, receivers, signal, call type, system message) rings each
-- receiver on dm-calls:<receiver>. The caller is an active participant; each receiver is
-- an active participant with no active block either way. callerId is the caller's profile,
-- set here, never by the client. signal is initiate, end or timeout.
--
-- federated_voice_calls.direction. inbound: a remote caller rang a local recipient
-- (VoiceActivityHandler.handleVoiceCallInvite). outbound: a local caller rang a remote
-- recipient (POST /api/livekit/federated-call/invite). The room of a live outbound row is
-- the one room LiveKitService grants that remote recipient. Rows from before this migration
-- are inbound; outbound rows were not stored.
--
-- Public and private channels are separate namespaces: clients built before this release
-- and the federation backend before it do not reach clients after it on these topics.
-- Clients built before this release keep their public harmony-global-presence among
-- themselves and see clients after it as offline.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Topic rules
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.topic_readable_by(p_profile_id uuid, p_topic text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_profile_id uuid;
  v_id         uuid;
  v_server_id  uuid;
  v_room       text;
  v_match      text[];
BEGIN
  IF p_topic IS NULL THEN
    RETURN false;
  END IF;

  v_profile_id := p_profile_id;
  IF v_profile_id IS NULL THEN
    RETURN false;
  END IF;

  IF p_topic LIKE 'dm-conversation-%' THEN
    BEGIN
      v_id := substring(p_topic from 17)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.is_conversation_participant(v_id, v_profile_id);
  END IF;

  -- Replaces messages_select_channel_member for delivery: accepted membership and
  -- VIEW_CHANNEL.
  IF p_topic LIKE 'channel-messages-%' THEN
    BEGIN
      v_id := substring(p_topic from 18)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.can_view_channel(v_profile_id, v_id);
  END IF;

  IF p_topic LIKE 'server-presence:%' OR p_topic LIKE 'server-structure:%'
     OR p_topic LIKE 'voice-channels:%' THEN
    BEGIN
      v_id := split_part(p_topic, ':', 2)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN EXISTS (
      SELECT 1 FROM public.user_servers
      WHERE server_id = v_id
        AND user_id = v_profile_id
        AND status = 'accepted'
    );
  END IF;

  IF p_topic LIKE 'user:%' THEN
    BEGIN
      v_id := substring(p_topic from 6)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN v_id = v_profile_id;
  END IF;

  IF p_topic LIKE 'dm-call:%' THEN
    BEGIN
      v_id := substring(p_topic from 9)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.is_conversation_participant(v_id, v_profile_id);
  END IF;

  IF p_topic LIKE 'voice-channel:%' THEN
    BEGIN
      v_id := substring(p_topic from 15)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.can_view_channel(v_profile_id, v_id);
  END IF;

  IF p_topic LIKE 'dm-calls:%' THEN
    BEGIN
      v_id := substring(p_topic from 10)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN v_id = v_profile_id;
  END IF;

  IF p_topic LIKE 'typing:%' THEN
    BEGIN
      v_id := split_part(p_topic, ':', 3)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    CASE split_part(p_topic, ':', 2)
      WHEN 'conversation' THEN
        RETURN public.is_conversation_participant(v_id, v_profile_id);
      WHEN 'channel' THEN
        RETURN public.can_view_channel(v_profile_id, v_id);
      WHEN 'thread' THEN
        RETURN COALESCE((SELECT public.can_view_channel(v_profile_id, t.channel_id)
                           FROM public.threads t WHERE t.id = v_id), false);
      ELSE
        RETURN false;
    END CASE;
  END IF;

  IF p_topic LIKE 'harmony-voice-%' OR p_topic LIKE 'easter-egg:%' THEN
    v_room := CASE WHEN p_topic LIKE 'harmony-voice-%'
                   THEN substring(p_topic from 15)
                   ELSE substring(p_topic from 12) END;

    v_match := regexp_match(v_room,
      '^(?:dm-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
      '|federated-dm-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9]{1,16})$', 'i');
    IF v_match IS NOT NULL THEN
      RETURN public.is_conversation_participant(COALESCE(v_match[1], v_match[2])::uuid, v_profile_id);
    END IF;

    BEGIN
      v_id := v_room::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    SELECT c.server_id INTO v_server_id FROM public.channels c WHERE c.id = v_id;
    IF v_server_id IS NULL THEN
      RETURN false;
    END IF;
    RETURN public.can_view_channel(v_profile_id, v_id)
       AND public.has_permission(v_profile_id, v_server_id, 'CONNECT', v_id)
       AND NOT EXISTS (
         SELECT 1 FROM public.server_member_timeouts t
          WHERE t.server_id = v_server_id
            AND t.user_id = v_profile_id
            AND t.until > now());
  END IF;

  -- Feed topics carry only public, non-deleted posts: broadcast_post_event
  -- gates every send on visibility = 'public'. No per-user check applies.
  IF p_topic IN ('feed:public', 'feed:local')
     OR p_topic LIKE 'feed:user:%'
     OR p_topic LIKE 'feed:hashtag:%' THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.topic_readable_by(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topic_readable_by(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.can_subscribe_to_topic(p_topic text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.topic_readable_by(public.get_current_profile_id(), p_topic);
$$;

COMMENT ON FUNCTION public.can_subscribe_to_topic(text) IS
'Authorizes a Broadcast topic for the current user. Broadcast carries no row context, so this is the only gate on realtime.messages SELECT.';

-- Sends: a topic clients write to, under its read rule.
CREATE OR REPLACE FUNCTION public.can_send_to_topic(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_topic IS NULL
     OR NOT (p_topic LIKE 'user:%'
             OR p_topic LIKE 'server-presence:%'
             OR p_topic LIKE 'voice-channels:%'
             OR p_topic LIKE 'voice-channel:%'
             OR p_topic LIKE 'dm-call:%'
             OR p_topic LIKE 'harmony-voice-%'
             OR p_topic LIKE 'easter-egg:%'
             OR p_topic LIKE 'typing:%') THEN
    RETURN false;
  END IF;
  RETURN public.can_subscribe_to_topic(p_topic);
END;
$$;

COMMENT ON FUNCTION public.can_send_to_topic(text) IS
'Authorizes a client Broadcast send or Presence track on a topic: the gate on realtime.messages INSERT.';

REVOKE ALL ON FUNCTION public.can_send_to_topic(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_send_to_topic(text) TO authenticated, service_role;

DO $$
BEGIN
    IF to_regclass('realtime.messages') IS NULL THEN
        RAISE NOTICE 'realtime.messages absent, send policy skipped';
        RETURN;
    END IF;
    DROP POLICY IF EXISTS "authenticated_users_can_send" ON realtime.messages;
    CREATE POLICY "authenticated_users_can_send" ON realtime.messages
        FOR INSERT TO authenticated
        WITH CHECK (public.can_send_to_topic(topic));
    RAISE NOTICE 'realtime.messages send policy installed';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'realtime.messages send policy skipped: %', SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------------
-- Ringing
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ring_dm_call(
    p_conversation_id uuid,
    p_receiver_ids uuid[],
    p_signal text,
    p_call_type text,
    p_system_message_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller   uuid := public.get_current_profile_id();
    v_receiver uuid;
    v_message  uuid;
    v_payload  jsonb;
    v_sent     integer := 0;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'ring_dm_call: no profile for the caller' USING ERRCODE = '42501';
    END IF;
    IF p_signal IS NULL OR p_signal NOT IN ('initiate', 'end', 'timeout')
       OR p_call_type IS NULL OR p_call_type NOT IN ('voice', 'video') THEN
        RAISE EXCEPTION 'ring_dm_call: invalid signal or call type' USING ERRCODE = '22023';
    END IF;
    IF cardinality(p_receiver_ids) > 50 THEN
        RAISE EXCEPTION 'ring_dm_call: at most 50 receivers' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_conversation_participant(p_conversation_id, v_caller) THEN
        RAISE EXCEPTION 'ring_dm_call: not a participant of the conversation' USING ERRCODE = '42501';
    END IF;

    SELECT m.id INTO v_message
      FROM public.messages m
     WHERE m.id = p_system_message_id
       AND m.conversation_id = p_conversation_id;

    -- Shape of DMCallSignaling's CallSignal; timestamp in epoch milliseconds.
    v_payload := jsonb_build_object(
        'type', p_signal,
        'callerId', v_caller,
        'callType', p_call_type,
        'timestamp', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
        'conversationId', p_conversation_id);
    IF v_message IS NOT NULL THEN
        v_payload := v_payload || jsonb_build_object('systemMessageId', v_message);
    END IF;
    IF p_signal = 'timeout' THEN
        v_payload := v_payload || jsonb_build_object('reason', 'timeout');
    END IF;

    FOR v_receiver IN
        SELECT DISTINCT r FROM unnest(p_receiver_ids) AS r
         WHERE r IS NOT NULL AND r <> v_caller
    LOOP
        CONTINUE WHEN NOT public.is_conversation_participant(p_conversation_id, v_receiver);
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM public.user_blocks b
             WHERE ((b.blocker_id = v_caller AND b.blocked_user_id = v_receiver)
                 OR (b.blocker_id = v_receiver AND b.blocked_user_id = v_caller))
               AND (b.expires_at IS NULL OR b.expires_at > now()));
        PERFORM realtime.send(v_payload, 'incoming-call', 'dm-calls:' || v_receiver::text, true);
        v_sent := v_sent + 1;
    END LOOP;

    RETURN v_sent;
END;
$$;

REVOKE ALL ON FUNCTION public.ring_dm_call(uuid, uuid[], text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ring_dm_call(uuid, uuid[], text, text, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- federated_voice_calls
-- ---------------------------------------------------------------------------

ALTER TABLE public.federated_voice_calls
    ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'inbound';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.federated_voice_calls'::regclass
           AND conname = 'federated_voice_calls_direction_check') THEN
        ALTER TABLE public.federated_voice_calls
            ADD CONSTRAINT federated_voice_calls_direction_check
            CHECK (direction = ANY (ARRAY['inbound'::text, 'outbound'::text]));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_outbound_room
    ON public.federated_voice_calls (room_name)
    WHERE direction = 'outbound';

-- Every writer is federation-backend as service_role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.federated_voice_calls FROM anon, authenticated;

COMMENT ON TABLE public.federated_voice_calls IS
'Federated DM voice/video calls. inbound: remote caller, local recipient. outbound: local caller, remote recipient.';
COMMENT ON COLUMN public.federated_voice_calls.direction IS
'inbound: caller_id is the mirror of a remote caller, recipient_id local. outbound: caller_id local, recipient_id the mirror of the remote recipient; a live row admits that recipient to room_name.';
COMMENT ON COLUMN public.federated_voice_calls.conversation_id IS
'This instance''s conversation shared by both parties.';

-- ---------------------------------------------------------------------------
-- Restricted voice channels
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_restricted_voice_channels(p_server_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT c.id
      FROM public.channels c
     WHERE c.server_id = p_server_id
       AND c.type <> 0
       AND public.channel_is_restricted(c.id)
       AND public.can_view_channel(public.get_current_profile_id(), c.id);
$$;

REVOKE ALL ON FUNCTION public.get_restricted_voice_channels(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_restricted_voice_channels(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Presence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.presence_devices (
    profile_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    device_id    text NOT NULL,
    is_mobile    boolean NOT NULL DEFAULT false,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, device_id),
    CONSTRAINT presence_devices_device_id_length CHECK (char_length(device_id) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS idx_presence_devices_last_seen ON public.presence_devices (last_seen_at);

-- published_*: the state others were last told; 0 is offline as they see it.
CREATE TABLE IF NOT EXISTS public.user_presence (
    profile_id       uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    status           smallint NOT NULL DEFAULT 1,
    online           boolean NOT NULL DEFAULT false,
    is_mobile        boolean NOT NULL DEFAULT false,
    last_seen_at     timestamptz,
    published_status smallint NOT NULL DEFAULT 0,
    published_mobile boolean NOT NULL DEFAULT false,
    published_at     timestamptz,
    CONSTRAINT user_presence_status_check CHECK (status BETWEEN 1 AND 4),
    CONSTRAINT user_presence_published_status_check CHECK (published_status BETWEEN 0 AND 3)
);

CREATE INDEX IF NOT EXISTS idx_user_presence_published ON public.user_presence (profile_id)
    WHERE published_status <> 0;

-- Prod's body reads user_presence(user_id, voice_channel_id, last_seen), a table no
-- migration created; the baseline body does not read it.
CREATE OR REPLACE FUNCTION public.cleanup_stale_voice_participants()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    DELETE FROM voice_channel_participants
    WHERE joined_at < NOW() - INTERVAL '24 hours';
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_stale_voice_participants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_voice_participants() TO service_role;

-- Clients reach both tables only through the functions below.
ALTER TABLE public.presence_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.presence_devices FROM anon, authenticated;
REVOKE ALL ON public.user_presence FROM anon, authenticated;
GRANT ALL ON public.presence_devices TO service_role;
GRANT ALL ON public.user_presence TO service_role;
DROP POLICY IF EXISTS presence_devices_service_role ON public.presence_devices;
CREATE POLICY presence_devices_service_role ON public.presence_devices
    TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS user_presence_service_role ON public.user_presence;
CREATE POLICY user_presence_service_role ON public.user_presence
    TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.presence_devices IS
'Signed-in tabs of a profile; live for 150 s after the last presence_heartbeat.';
COMMENT ON TABLE public.user_presence IS
'Chosen status, derived liveness and the state last published to others. Read through get_presence.';

-- Profiles among p_ids whose presence p_viewer may read: an accepted server or an active
-- conversation in common, or an accepted follow by p_viewer; never one that blocks p_viewer.
CREATE OR REPLACE FUNCTION public.presence_related_ids(p_viewer uuid, p_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT DISTINCT t.id
      FROM unnest(p_ids) AS t(id)
     WHERE p_viewer IS NOT NULL
       AND t.id IS NOT NULL
       AND t.id <> p_viewer
       AND (EXISTS (SELECT 1
                      FROM public.user_servers a
                      JOIN public.user_servers b ON b.server_id = a.server_id
                     WHERE a.user_id = p_viewer AND a.status = 'accepted'
                       AND b.user_id = t.id AND b.status = 'accepted')
            OR EXISTS (SELECT 1
                         FROM public.conversation_participants a
                         JOIN public.conversation_participants b ON b.conversation_id = a.conversation_id
                        WHERE a.user_id = p_viewer AND a.left_at IS NULL
                          AND b.user_id = t.id AND b.left_at IS NULL)
            OR EXISTS (SELECT 1
                         FROM public.follows f
                        WHERE f.follower_id = p_viewer AND f.following_id = t.id
                          AND f.status = 'accepted'))
       AND NOT EXISTS (SELECT 1
                         FROM public.user_blocks bl
                        WHERE bl.blocker_id = t.id AND bl.blocked_user_id = p_viewer
                          AND (bl.expires_at IS NULL OR bl.expires_at > now()));
$$;

-- Recomputes liveness from live devices and tells others when what they see changes: once
-- per second per profile at most; presence_sweep publishes what this skipped.
CREATE OR REPLACE FUNCTION public.presence_publish(p_profile_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row     public.user_presence%ROWTYPE;
    v_online  boolean;
    v_mobile  boolean;
    v_seen    timestamptz;
    v_status  smallint;
    v_pmobile boolean;
    v_payload jsonb;
    v_target  uuid;
BEGIN
    SELECT * INTO v_row FROM public.user_presence WHERE profile_id = p_profile_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT count(*) > 0, COALESCE(bool_and(d.is_mobile), false), max(d.last_seen_at)
      INTO v_online, v_mobile, v_seen
      FROM public.presence_devices d
     WHERE d.profile_id = p_profile_id
       AND d.last_seen_at > now() - interval '150 seconds';

    v_status := CASE WHEN v_online AND v_row.status <> 4 THEN v_row.status ELSE 0 END;
    v_pmobile := v_status <> 0 AND v_mobile;

    UPDATE public.user_presence
       SET online = v_online,
           is_mobile = v_mobile AND v_online,
           last_seen_at = COALESCE(v_seen, last_seen_at)
     WHERE profile_id = p_profile_id;

    IF v_status = v_row.published_status AND v_pmobile = v_row.published_mobile THEN
        RETURN;
    END IF;
    IF v_row.published_at > now() - interval '1 second' THEN
        RETURN;
    END IF;

    UPDATE public.user_presence
       SET published_status = v_status, published_mobile = v_pmobile, published_at = now()
     WHERE profile_id = p_profile_id;

    v_payload := jsonb_build_object(
        'type', 'presence:update',
        'user_id', p_profile_id,
        'online', v_status <> 0,
        'status', v_status,
        'is_mobile', v_pmobile);

    FOR v_target IN
        SELECT us.server_id FROM public.user_servers us
         WHERE us.user_id = p_profile_id AND us.status = 'accepted'
    LOOP
        PERFORM realtime.send(v_payload, 'presence_event', 'server-presence:' || v_target::text, true);
    END LOOP;

    FOR v_target IN
        SELECT DISTINCT other.user_id
          FROM public.conversation_participants mine
          JOIN public.conversation_participants other ON other.conversation_id = mine.conversation_id
          JOIN public.profiles p ON p.id = other.user_id
         WHERE mine.user_id = p_profile_id AND mine.left_at IS NULL
           AND other.left_at IS NULL AND other.user_id <> p_profile_id
           AND p.is_local IS TRUE
           AND NOT EXISTS (SELECT 1 FROM public.user_blocks bl
                            WHERE bl.blocker_id = p_profile_id AND bl.blocked_user_id = other.user_id
                              AND (bl.expires_at IS NULL OR bl.expires_at > now()))
    LOOP
        PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_target::text, true);
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.presence_heartbeat(
    p_device_id text,
    p_status smallint,
    p_is_mobile boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'presence_heartbeat: no profile for the caller' USING ERRCODE = '42501';
    END IF;
    IF p_device_id IS NULL OR char_length(p_device_id) NOT BETWEEN 1 AND 64
       OR p_status IS NULL OR p_status NOT BETWEEN 1 AND 4 THEN
        RAISE EXCEPTION 'presence_heartbeat: invalid device or status' USING ERRCODE = '22023';
    END IF;

    -- At most 20 devices per profile: the oldest gives way.
    DELETE FROM public.presence_devices
     WHERE profile_id = v_me
       AND device_id <> p_device_id
       AND device_id IN (SELECT d.device_id FROM public.presence_devices d
                          WHERE d.profile_id = v_me
                          ORDER BY d.last_seen_at DESC
                          OFFSET 19);

    INSERT INTO public.presence_devices (profile_id, device_id, is_mobile, last_seen_at)
    VALUES (v_me, p_device_id, COALESCE(p_is_mobile, false), now())
    ON CONFLICT (profile_id, device_id)
    DO UPDATE SET is_mobile = EXCLUDED.is_mobile, last_seen_at = EXCLUDED.last_seen_at;

    INSERT INTO public.user_presence (profile_id, status)
    VALUES (v_me, p_status)
    ON CONFLICT (profile_id) DO UPDATE SET status = EXCLUDED.status;

    PERFORM public.presence_publish(v_me);
END;
$$;

CREATE OR REPLACE FUNCTION public.presence_offline(p_device_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'presence_offline: no profile for the caller' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.presence_devices WHERE profile_id = v_me AND device_id = p_device_id;
    PERFORM public.presence_publish(v_me);
END;
$$;

-- Drops dead devices and publishes every profile whose published state is stale.
CREATE OR REPLACE FUNCTION public.presence_sweep()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid;
    v_count   integer := 0;
BEGIN
    DELETE FROM public.presence_devices WHERE last_seen_at <= now() - interval '150 seconds';

    FOR v_profile IN
        SELECT up.profile_id
          FROM public.user_presence up
         WHERE up.published_status <> CASE
                   WHEN up.status <> 4 AND EXISTS (SELECT 1 FROM public.presence_devices d
                                                    WHERE d.profile_id = up.profile_id)
                   THEN up.status ELSE 0 END
            OR up.online <> EXISTS (SELECT 1 FROM public.presence_devices d
                                     WHERE d.profile_id = up.profile_id)
    LOOP
        PERFORM public.presence_publish(v_profile);
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;

-- The caller's own row, and the published presence of related profiles that others see
-- online. Absent profiles read as offline.
CREATE OR REPLACE FUNCTION public.get_presence(p_profile_ids uuid[])
RETURNS TABLE (profile_id uuid, status smallint, online boolean, is_mobile boolean, last_seen_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL OR p_profile_ids IS NULL THEN
        RETURN;
    END IF;
    IF cardinality(p_profile_ids) > 1000 THEN
        RAISE EXCEPTION 'get_presence: at most 1000 profiles' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT up.profile_id, up.status, up.online, up.is_mobile, up.last_seen_at
      FROM public.user_presence up
     WHERE up.profile_id = v_me AND v_me = ANY (p_profile_ids)
    UNION ALL
    SELECT up.profile_id, up.published_status, true, up.published_mobile, up.last_seen_at
      FROM public.user_presence up
     WHERE up.published_status <> 0
       AND up.profile_id IN (SELECT r.id FROM public.presence_related_ids(v_me, p_profile_ids) AS r(id));
END;
$$;

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('presence_heartbeat', 'presence_offline', 'get_presence')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('presence_publish', 'presence_sweep', 'presence_related_ids')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- servers.is_local_server
-- ---------------------------------------------------------------------------

UPDATE public.servers SET is_local_server = true WHERE is_local_server IS NULL;
ALTER TABLE public.servers ALTER COLUMN is_local_server SET DEFAULT true;
ALTER TABLE public.servers ALTER COLUMN is_local_server SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Schedule. The outer $do$ tag keeps the inner command string intact.
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN PERFORM cron.unschedule('presence-sweep'); EXCEPTION WHEN OTHERS THEN NULL; END;
        PERFORM cron.schedule('presence-sweep', '* * * * *', 'SELECT public.presence_sweep()');
        RAISE NOTICE 'presence-sweep scheduled';
    ELSE
        RAISE NOTICE 'pg_cron not available: presence_sweep is not scheduled';
    END IF;
END
$do$;

COMMIT;

NOTIFY pgrst, 'reload schema';
