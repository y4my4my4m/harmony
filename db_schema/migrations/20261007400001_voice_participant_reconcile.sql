-- Server-side removal of voice_channel_participants rows whose client is gone.
--
-- A row is written by the joining client and deleted by it on leave. A crashed, killed or
-- disconnected client never deletes it; get_today_summary lists it as in call for 12 hours
-- and the row outlives that indefinitely. The federation worker compares rows
-- against the LiveKit rooms (channel-<id>, stage-<id>) every minute, and the server does
-- the same for one room on a LiveKit participant_left / room_finished webhook. Each row
-- with no matching LiveKit participant goes through remove_voice_participant.
-- metadata.transport = 'p2p' marks a client on the P2P fallback; LiveKit cannot vouch for
-- it either way and the reconciler leaves its row.
--
-- remove_voice_participant(channel, user, joined_before) deletes the row only when its
-- joined_at precedes joined_before; a re-join upserts joined_at, so a row rewritten after
-- the caller's observation survives. A deleted row is announced as voice-channel-event
-- {event: user-left, userId, channelId, reason: reconciled} on the topic the clients
-- read for that channel: voice-channel:<channel> when channel_is_restricted, else
-- voice-channels:<server>, as broadcastVoicePresence in the federation backend. The
-- AFTER DELETE triggers (voice counter, federation leave) fire as for a client delete.
--
-- Service role only. Clients keep deleting their own rows under
-- voice_participants_delete_self.
--
-- joined_at of a client write is the database clock. The grace period compares joined_at
-- with the worker's clock; a client clock behind by minutes voids the grace, one ahead
-- delays removal by the same amount. Service-role writes keep the value they send.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.remove_voice_participant(
    p_channel_id    uuid,
    p_user_id       uuid,
    p_joined_before timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
    v_topic  text;
BEGIN
    -- Role GUC, not current_user: SECURITY DEFINER changes only the latter. Refuses a
    -- client even where a live instance's grants drifted.
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'remove_voice_participant is internal' USING ERRCODE = '42501';
    END IF;
    IF p_channel_id IS NULL OR p_user_id IS NULL OR p_joined_before IS NULL THEN
        RAISE EXCEPTION 'channel, user and joined_before are required' USING ERRCODE = '22004';
    END IF;

    DELETE FROM public.voice_channel_participants
     WHERE channel_id = p_channel_id
       AND user_id = p_user_id
       AND joined_at < p_joined_before
    RETURNING server_id INTO v_server;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    v_topic := CASE WHEN public.channel_is_restricted(p_channel_id) IS DISTINCT FROM false
                    THEN 'voice-channel:' || p_channel_id::text
                    ELSE 'voice-channels:' || v_server::text END;

    PERFORM realtime.send(
        jsonb_build_object(
            'event', 'user-left',
            'userId', p_user_id,
            'channelId', p_channel_id,
            'reason', 'reconciled'
        ),
        'voice-channel-event',
        v_topic,
        true
    );

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_voice_participant(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_voice_participant(uuid, uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.remove_voice_participant(uuid, uuid, timestamptz) IS
'Deletes a voice_channel_participants row joined before p_joined_before and broadcasts user-left. Service role only.';

CREATE OR REPLACE FUNCTION public.voice_participant_joined_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND (TG_OP = 'INSERT' OR NEW.joined_at IS DISTINCT FROM OLD.joined_at) THEN
        NEW.joined_at := now();
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_participant_joined_at() FROM PUBLIC, anon, authenticated;

-- Named to fire before trigger_federate_voice_channel_join.
DROP TRIGGER IF EXISTS a_voice_participants_joined_at ON public.voice_channel_participants;
CREATE TRIGGER a_voice_participants_joined_at
    BEFORE INSERT OR UPDATE OF joined_at ON public.voice_channel_participants
    FOR EACH ROW EXECUTE FUNCTION public.voice_participant_joined_at();

COMMIT;
