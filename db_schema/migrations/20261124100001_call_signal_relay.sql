-- Call signals carry a sender the database names, and an account's signals and rings are limited.
--
-- Realtime authorizes a topic at join, not an event, and a broadcast carries no sender. A member of
-- a voice room, a DM call or a room's easter-egg topic could broadcast as another member: offer
-- media under their name, answer or hang up their call, start an effect in their name. These topics
-- take no client broadcast now; send_signal broadcasts there with the caller as the sender:
--
--   topic                    events               payload sent              payload broadcast
--   harmony-voice-<room>     signals              {messages}                {from, messages}
--   dm-call:<conversation>   call-signal          {type, callType, reason}  {type, callerId, callType, reason,
--                                                                             timestamp, conversationId}
--   easter-egg:<room>        activate, deactivate {type}                    {type, userId}
--
--   messages      1 to 64 objects, relayed as sent (unifiedWebRTC's SignalingMessage).
--   call-signal   type accept, decline, busy, join, leave or end (DMCallSignaling's CallSignal);
--                 callType voice or video; reason busy, blocked or dnd. Rings stay with ring_dm_call.
--                 accept, decline, busy and join also go to the sender's own dm-calls:<profile>,
--                 which every signed-in device of the account holds: its other devices stop ringing.
--   timestamp     epoch milliseconds, as ring_dm_call.
-- The caller is admitted as the topic's read rule admits it (topic_readable_by). A payload is at
-- most 65536 bytes as text: a batch of an offer and its candidates measures under 16 KiB.
--
-- Write rules of realtime.messages, read per extension (Realtime 2.153 checks a broadcast and a
-- presence write of a channel separately):
--   broadcast  can_send_to_topic    user:<own profile>, typing:<context>
--   presence   can_track_on_topic   dm-call:<conversation> (call membership), typing:<context>
--
-- Limits, keys of instance_config 'antispam' (antispam_settings, 0 is off), refused as
-- ANTISPAM_RATE_LIMITED:<seconds> naming the limit (20261118300001), for local accounts but staff
-- and limit_exempt_accounts (20261109200001):
--   account_signals_per_minute  300  send_signal calls, every topic together. Measured on the e2e
--                                    stack (journey voice-p2p-call): a two-member P2P join is 5 to 8
--                                    calls per member, a join and a rejoin 10 to 14; each further
--                                    member of a mesh adds about 4 (offer or answer and its candidate
--                                    batches), so a ten-member join is about 45 calls.
--   account_rings_per_minute     10  calls placed, local and federated on one count: ring_dm_call
--                                    'initiate' and the federation backend's invite take one each
--                                    (antispam_take_ring), a new call every 6 s. 'end' and 'timeout'
--                                    are not counted: a cancel is never refused.
-- antispam_take is the check-and-record of one limited write; antispam_write_guard calls it.
--
-- Clients of 1.9.7 and earlier broadcast on these topics themselves, and Realtime drops those sends:
-- their peer-to-peer calls do not connect, their answers and hang-ups of a DM call do not reach
-- updated clients, and their easter eggs show only to themselves. Calls over LiveKit do not use
-- harmony-voice-<room>.
--
-- Bodies otherwise, volatility, owner and grants: can_send_to_topic as 20261110100001;
-- antispam_settings, update_instance_antispam_settings and antispam_write_guard as 20261109200001;
-- ring_dm_call as 20261123500005.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Limits
-- ---------------------------------------------------------------------------

ALTER TABLE public.automod_recent_activity DROP CONSTRAINT IF EXISTS automod_recent_activity_kind_check;
ALTER TABLE public.automod_recent_activity ADD CONSTRAINT automod_recent_activity_kind_check
    CHECK (kind IN ('message', 'post', 'reaction', 'follow', 'join', 'server', 'stranger_dm', 'signal', 'ring'));

CREATE OR REPLACE FUNCTION public.antispam_settings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT '{"new_account_hours": 24, "new_account_messages_per_minute": 0, "new_account_posts_per_hour": 0,
             "new_account_max_stranger_mentions": 0, "new_account_block_links": false,
             "new_account_stranger_dms_per_hour": 5,
             "account_messages_per_minute": 120, "account_posts_per_hour": 100,
             "account_reactions_per_minute": 240, "account_follows_per_hour": 200,
             "account_joins_per_hour": 60, "account_servers_per_hour": 10,
             "account_stranger_dms_per_hour": 30,
             "account_signals_per_minute": 300, "account_rings_per_minute": 10,
             "bot_requests_per_minute": 600, "bridge_requests_per_minute": 3000,
             "federation_spam_mode": "flag", "federation_max_mentions": 15, "federation_new_actor_days": 7}'::jsonb
           || COALESCE((SELECT ic.config_value FROM public.instance_config ic
                         WHERE ic.config_key = 'antispam' AND jsonb_typeof(ic.config_value) = 'object'),
                       '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION public.update_instance_antispam_settings(p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    s jsonb := public.antispam_settings() || COALESCE(p_settings, '{}'::jsonb);
    v jsonb;
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Admin role required' USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(COALESCE(p_settings, '{}'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION 'ANTISPAM_INVALID_SETTINGS: settings must be an object' USING ERRCODE = '22023';
    END IF;
    IF s ->> 'federation_spam_mode' NOT IN ('off', 'flag', 'hold', 'reject') THEN
        RAISE EXCEPTION 'ANTISPAM_INVALID_SETTINGS: federation_spam_mode is off, flag, hold or reject' USING ERRCODE = '22023';
    END IF;

    v := jsonb_build_object(
        'new_account_hours', public.automod_int(s -> 'new_account_hours', 24, 1, 8760),
        'new_account_messages_per_minute', public.automod_int(s -> 'new_account_messages_per_minute', 0, 0, 600),
        'new_account_posts_per_hour', public.automod_int(s -> 'new_account_posts_per_hour', 0, 0, 1000),
        'new_account_max_stranger_mentions', public.automod_int(s -> 'new_account_max_stranger_mentions', 0, 0, 100),
        'new_account_block_links', COALESCE((s ->> 'new_account_block_links')::boolean, false),
        'new_account_stranger_dms_per_hour', public.automod_int(s -> 'new_account_stranger_dms_per_hour', 5, 0, 100000),
        'account_messages_per_minute', public.automod_int(s -> 'account_messages_per_minute', 120, 0, 100000),
        'account_posts_per_hour', public.automod_int(s -> 'account_posts_per_hour', 100, 0, 100000),
        'account_reactions_per_minute', public.automod_int(s -> 'account_reactions_per_minute', 240, 0, 100000),
        'account_follows_per_hour', public.automod_int(s -> 'account_follows_per_hour', 200, 0, 100000),
        'account_joins_per_hour', public.automod_int(s -> 'account_joins_per_hour', 60, 0, 100000),
        'account_servers_per_hour', public.automod_int(s -> 'account_servers_per_hour', 10, 0, 100000),
        'account_stranger_dms_per_hour', public.automod_int(s -> 'account_stranger_dms_per_hour', 30, 0, 100000),
        'account_signals_per_minute', public.automod_int(s -> 'account_signals_per_minute', 300, 0, 100000),
        'account_rings_per_minute', public.automod_int(s -> 'account_rings_per_minute', 10, 0, 100000),
        'bot_requests_per_minute', public.automod_int(s -> 'bot_requests_per_minute', 600, 0, 1000000),
        'bridge_requests_per_minute', public.automod_int(s -> 'bridge_requests_per_minute', 3000, 0, 1000000),
        'federation_spam_mode', s ->> 'federation_spam_mode',
        'federation_max_mentions', public.automod_int(s -> 'federation_max_mentions', 15, 2, 500),
        'federation_new_actor_days', public.automod_int(s -> 'federation_new_actor_days', 7, 0, 365));

    INSERT INTO public.instance_config (config_key, config_value, description, updated_at, updated_by)
    VALUES ('antispam', v, 'Instance anti-spam limits. 0/false disables a limit.', now(), public.get_current_profile_id())
    ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value, updated_at = now(), updated_by = EXCLUDED.updated_by;

    PERFORM public.log_admin_action(public.get_current_profile_id(), 'update_antispam_settings',
                                    'instance_config', 'antispam', v, NULL, NULL);
    RETURN v;
EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'ANTISPAM_INVALID_SETTINGS: malformed value' USING ERRCODE = '22023';
END;
$$;

-- One limited write of p_actor: refused past the antispam setting p_key over p_window_seconds,
-- recorded otherwise. Exempt accounts, a null actor and a limit of 0 pass unrecorded.
CREATE OR REPLACE FUNCTION public.antispam_take(p_actor uuid, p_kind text, p_key text, p_window_seconds integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit integer;
BEGIN
    IF p_actor IS NULL OR public.antispam_account_exempt(p_actor) THEN
        RETURN;
    END IF;
    v_limit := public.antispam_int(public.antispam_settings() -> p_key, 0);
    IF v_limit <= 0 THEN
        RETURN;
    END IF;
    PERFORM public.antispam_rate_check(p_actor, p_kind, v_limit, p_window_seconds,
                                       format('Limit reached: %s.', p_key));
    INSERT INTO public.automod_recent_activity (user_id, kind) VALUES (p_actor, p_kind);
END;
$$;

-- Rate limit on one kind of write. Arguments: kind, antispam key, window in seconds, and optionally the
-- column that must name the writer for the row to count. Depth above 1 is another trigger's row.
CREATE OR REPLACE FUNCTION public.antispam_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    v_actor := public.get_current_profile_id();
    IF v_actor IS NULL
       OR (TG_NARGS > 3 AND to_jsonb(NEW) ->> TG_ARGV[3] IS DISTINCT FROM v_actor::text) THEN
        RETURN NEW;
    END IF;
    PERFORM public.antispam_take(v_actor, TG_ARGV[0], TG_ARGV[1], TG_ARGV[2]::integer);
    RETURN NEW;
END;
$$;

-- One call placed by p_caller, local or federated.
CREATE OR REPLACE FUNCTION public.antispam_take_ring(p_caller uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.antispam_take(p_caller, 'ring', 'account_rings_per_minute', 60)
$$;

REVOKE ALL ON FUNCTION public.antispam_take(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.antispam_take(uuid, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.antispam_take_ring(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.antispam_take_ring(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Client writes on realtime.messages
-- ---------------------------------------------------------------------------

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
             OR p_topic LIKE 'typing:%') THEN
    RETURN false;
  END IF;
  RETURN public.can_subscribe_to_topic(p_topic);
END;
$$;

COMMENT ON FUNCTION public.can_send_to_topic(text) IS
'Authorizes a client Broadcast send on a topic: the gate on realtime.messages INSERT of extension broadcast.';

CREATE OR REPLACE FUNCTION public.can_track_on_topic(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_topic IS NULL
     OR NOT (p_topic LIKE 'dm-call:%'
             OR p_topic LIKE 'typing:%') THEN
    RETURN false;
  END IF;
  RETURN public.can_subscribe_to_topic(p_topic);
END;
$$;

COMMENT ON FUNCTION public.can_track_on_topic(text) IS
'Authorizes a client Presence track on a topic: the gate on realtime.messages INSERT of extension presence.';

REVOKE ALL ON FUNCTION public.can_send_to_topic(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_send_to_topic(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_track_on_topic(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_track_on_topic(text) TO authenticated, service_role;

DO $$
BEGIN
    IF to_regclass('realtime.messages') IS NULL THEN
        RAISE NOTICE 'realtime.messages absent, send policy skipped';
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy
                WHERE polrelid = 'realtime.messages'::regclass AND polname = 'authenticated_users_can_send') THEN
        ALTER POLICY "authenticated_users_can_send" ON realtime.messages
            WITH CHECK (CASE WHEN extension = 'presence' THEN public.can_track_on_topic(topic)
                             ELSE public.can_send_to_topic(topic) END);
    ELSE
        CREATE POLICY "authenticated_users_can_send" ON realtime.messages
            FOR INSERT TO authenticated
            WITH CHECK (CASE WHEN extension = 'presence' THEN public.can_track_on_topic(topic)
                             ELSE public.can_send_to_topic(topic) END);
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'realtime.messages send policy skipped: %', SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------------
-- The relay
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.send_signal(p_topic text, p_event text, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_sender uuid := public.get_current_profile_id();
    v_out    jsonb;
    v_type   text;
BEGIN
    IF v_sender IS NULL THEN
        RAISE EXCEPTION 'send_signal: no profile for the caller' USING ERRCODE = '42501';
    END IF;
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 65536 THEN
        RAISE EXCEPTION 'send_signal: the payload is an object of at most 64 KiB' USING ERRCODE = '22023';
    END IF;

    IF p_topic LIKE 'harmony-voice-%' THEN
        IF p_event IS DISTINCT FROM 'signals'
           OR jsonb_typeof(p_payload -> 'messages') IS DISTINCT FROM 'array'
           OR jsonb_array_length(p_payload -> 'messages') NOT BETWEEN 1 AND 64
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload -> 'messages') m
                       WHERE jsonb_typeof(m) <> 'object') THEN
            RAISE EXCEPTION 'send_signal: a voice room takes signals of 1 to 64 message objects' USING ERRCODE = '22023';
        END IF;
        v_out := jsonb_build_object('from', v_sender, 'messages', p_payload -> 'messages');
    ELSIF p_topic LIKE 'dm-call:%' THEN
        v_type := p_payload ->> 'type';
        IF p_event IS DISTINCT FROM 'call-signal'
           OR v_type IS NULL OR v_type NOT IN ('accept', 'decline', 'busy', 'join', 'leave', 'end')
           OR coalesce(p_payload ->> 'callType', 'voice') NOT IN ('voice', 'video')
           OR coalesce(p_payload ->> 'reason', 'busy') NOT IN ('busy', 'blocked', 'dnd') THEN
            RAISE EXCEPTION 'send_signal: invalid call signal' USING ERRCODE = '22023';
        END IF;
        v_out := jsonb_strip_nulls(jsonb_build_object(
            'type', v_type,
            'callerId', v_sender,
            'callType', coalesce(p_payload ->> 'callType', 'voice'),
            'reason', p_payload ->> 'reason',
            'timestamp', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
            'conversationId', substring(p_topic from 9)));
    ELSIF p_topic LIKE 'easter-egg:%' THEN
        v_type := p_payload ->> 'type';
        IF p_event IS NULL OR p_event NOT IN ('activate', 'deactivate')
           OR (p_event = 'activate' AND (v_type IS NULL OR v_type !~ '^[a-z0-9-]{1,32}$')) THEN
            RAISE EXCEPTION 'send_signal: invalid easter egg' USING ERRCODE = '22023';
        END IF;
        v_out := jsonb_strip_nulls(jsonb_build_object('type', v_type, 'userId', v_sender));
    ELSE
        RAISE EXCEPTION 'send_signal: no relay for this topic' USING ERRCODE = '22023';
    END IF;

    IF NOT coalesce(public.topic_readable_by(v_sender, p_topic), false) THEN
        RAISE EXCEPTION 'send_signal: not admitted to this topic' USING ERRCODE = '42501';
    END IF;

    PERFORM public.antispam_take(v_sender, 'signal', 'account_signals_per_minute', 60);
    PERFORM realtime.send(v_out, p_event, p_topic, true);
    IF p_topic LIKE 'dm-call:%' AND v_type IN ('accept', 'decline', 'busy', 'join') THEN
        PERFORM realtime.send(v_out, p_event, 'dm-calls:' || v_sender::text, true);
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.send_signal(text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_signal(text, text, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Rings
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
    IF p_signal = 'initiate' THEN
        PERFORM public.antispam_take_ring(v_caller);
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
        v_sent := v_sent + 1;
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM public.user_blocks b
             WHERE ((b.blocker_id = v_caller AND b.blocked_user_id = v_receiver)
                 OR (b.blocker_id = v_receiver AND b.blocked_user_id = v_caller))
               AND (b.expires_at IS NULL OR b.expires_at > now()));
        PERFORM realtime.send(v_payload, 'incoming-call', 'dm-calls:' || v_receiver::text, true);
    END LOOP;

    RETURN v_sent;
END;
$$;

REVOKE ALL ON FUNCTION public.ring_dm_call(uuid, uuid[], text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ring_dm_call(uuid, uuid[], text, text, uuid) TO authenticated, service_role;

COMMIT;
