-- DM call system messages ("started a call") must flip to "call ended" when
-- the call empties, but RLS only lets the message owner (the caller) update it.
-- If the caller refreshed or crashed, the message stayed "started a call"
-- forever. This SECURITY DEFINER RPC lets ANY conversation participant
-- finalize the call message. Companion code: DMCallSignaling.finalizeCallMessage.

CREATE OR REPLACE FUNCTION public.finalize_dm_call_message(
    p_message_id uuid,
    p_ended_at timestamptz,
    p_duration_seconds integer,
    p_participants uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_msg record;
    v_profile_id uuid;
BEGIN
    SELECT id, conversation_id, metadata
    INTO v_msg
    FROM messages
    WHERE id = p_message_id
      AND is_system = true
      AND conversation_id IS NOT NULL;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Idempotent: first finalizer wins, later calls are no-ops
    IF v_msg.metadata->>'type' = 'call_ended' THEN
        RETURN;
    END IF;

    IF v_msg.metadata->>'type' IS DISTINCT FROM 'call_started' THEN
        RAISE EXCEPTION 'message is not a call system message';
    END IF;

    SELECT id INTO v_profile_id
    FROM profiles
    WHERE auth_user_id = auth.uid();

    IF v_profile_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM conversation_participants cp
        WHERE cp.conversation_id = v_msg.conversation_id
          AND cp.user_id = v_profile_id
          AND cp.left_at IS NULL
    ) THEN
        RAISE EXCEPTION 'not a participant of this conversation';
    END IF;

    UPDATE messages
    SET metadata = jsonb_build_object(
            'type', 'call_ended',
            'call_type', v_msg.metadata->>'call_type',
            'started_at', v_msg.metadata->>'started_at',
            'ended_at', p_ended_at,
            'duration_seconds', p_duration_seconds,
            'participants', to_jsonb(p_participants)
        ),
        updated_at = now()
    WHERE id = p_message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_dm_call_message(uuid, timestamptz, integer, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_dm_call_message(uuid, timestamptz, integer, uuid[]) TO authenticated;
