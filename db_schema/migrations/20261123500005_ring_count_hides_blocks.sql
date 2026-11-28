-- ring_dm_call answers the number of receivers that are participants of the conversation, rung or
-- held back by a block between them and the caller: the number rung would tell a caller a receiver
-- who blocks it from one who does not. Body otherwise, volatility, owner and grants as
-- 20261006800001_private_call_channels.sql.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

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
