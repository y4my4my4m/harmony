-- Voice occupancy that outlives its client.
--
-- A voice_channel_participants row deleted by its own client (a leave, or the keepalive DELETE
-- of a closing page) was announced only by that client's Realtime broadcast, which a closing
-- page often never sends: viewers kept the user listed. Every deleted row is now announced by
-- the AFTER DELETE trigger z_voice_participants_left as
-- voice-channel-event {event: user-left, userId, channelId, reason} on the topic the clients
-- read for that channel: voice-channel:<channel> when channel_is_restricted, else
-- voice-channels:<server>. reason is the transaction-local harmony.voice_left_reason the
-- deleting function set (remove_voice_participant, sweep_stale_voice_participants:
-- 'reconciled'; voice_remove_member: its p_reason), else 'left'. remove_voice_participant
-- (as 20261007400001) and voice_remove_member (as 20261017100005) no longer send their own.
--
-- A client on the P2P fallback is in no LiveKit room; the LiveKit reconciliation skips its row
-- and a crashed one stayed forever. A connected P2P client calls touch_voice_participant every
-- 60 s, which stamps last_seen_at with the database clock. sweep_stale_voice_participants
-- (pg_cron, every minute; service role) deletes a P2P row last seen or joined more than
-- 3 minutes ago, and one never touched (a client older than last_seen_at) joined more than
-- 12 hours ago.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.voice_channel_participants ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- user-left for every deleted row
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.voice_participant_left_announce()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- A failed announcement never blocks the delete.
    BEGIN
        PERFORM realtime.send(
            jsonb_build_object(
                'event', 'user-left',
                'userId', OLD.user_id,
                'channelId', OLD.channel_id,
                'reason', COALESCE(NULLIF(current_setting('harmony.voice_left_reason', true), ''), 'left')
            ),
            'voice-channel-event',
            CASE WHEN public.channel_is_restricted(OLD.channel_id) IS DISTINCT FROM false
                 THEN 'voice-channel:' || OLD.channel_id::text
                 ELSE 'voice-channels:' || OLD.server_id::text END,
            true
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'voice_participant_left_announce: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_participant_left_announce() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_voice_participants_left ON public.voice_channel_participants;
CREATE TRIGGER z_voice_participants_left
    AFTER DELETE ON public.voice_channel_participants
    FOR EACH ROW EXECUTE FUNCTION public.voice_participant_left_announce();

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
    v_removed integer;
BEGIN
    -- Role GUC, not current_user: SECURITY DEFINER changes only the latter. Refuses a
    -- client even where a live instance's grants drifted.
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'remove_voice_participant is internal' USING ERRCODE = '42501';
    END IF;
    IF p_channel_id IS NULL OR p_user_id IS NULL OR p_joined_before IS NULL THEN
        RAISE EXCEPTION 'channel, user and joined_before are required' USING ERRCODE = '22004';
    END IF;

    PERFORM set_config('harmony.voice_left_reason', 'reconciled', true);
    DELETE FROM public.voice_channel_participants
     WHERE channel_id = p_channel_id
       AND user_id = p_user_id
       AND joined_at < p_joined_before;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    PERFORM set_config('harmony.voice_left_reason', '', true);

    RETURN v_removed > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_voice_participant(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_voice_participant(uuid, uuid, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.voice_remove_member(
    p_server_id uuid, p_user_id uuid, p_reason text, p_to_channel uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row record;
    v_left uuid;
BEGIN
    DELETE FROM public.voice_move_grants g
     WHERE g.server_id = p_server_id AND g.user_id = p_user_id
       AND g.channel_id IS DISTINCT FROM p_to_channel;

    PERFORM set_config('harmony.voice_left_reason', COALESCE(p_reason, ''), true);
    FOR v_row IN
        DELETE FROM public.voice_channel_participants v
         WHERE v.server_id = p_server_id AND v.user_id = p_user_id
        RETURNING v.channel_id
    LOOP
        IF v_left IS NULL THEN
            v_left := v_row.channel_id;
        END IF;
    END LOOP;
    PERFORM set_config('harmony.voice_left_reason', '', true);

    IF v_left IS NOT NULL THEN
        PERFORM public.broadcast_user_event(p_user_id,
            jsonb_build_object('type', 'voice:moved', 'server_id', p_server_id, 'from_channel_id', v_left,
                               'channel_id', p_to_channel, 'reason', p_reason));
        IF public.voice_member_federates(p_server_id, p_user_id, false) THEN
            PERFORM public.queue_federation_job('federate-voice-moderation', jsonb_build_object(
                'type', 'update',
                'kind', CASE WHEN p_to_channel IS NULL THEN 'disconnect' ELSE 'move' END,
                'server_id', p_server_id, 'user_id', p_user_id,
                'from_channel_id', v_left, 'channel_id', p_to_channel, 'reason', p_reason));
        END IF;
    END IF;
    RETURN v_left;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_remove_member(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_remove_member(uuid, uuid, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- P2P liveness
-- ---------------------------------------------------------------------------

-- false: the caller has no row in the channel.
CREATE OR REPLACE FUNCTION public.touch_voice_participant(p_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'touch_voice_participant: no profile for the caller' USING ERRCODE = '42501';
    END IF;
    UPDATE public.voice_channel_participants
       SET last_seen_at = now()
     WHERE channel_id = p_channel_id AND user_id = v_me;
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_voice_participant(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_voice_participant(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sweep_stale_voice_participants()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'sweep_stale_voice_participants is internal' USING ERRCODE = '42501';
    END IF;

    PERFORM set_config('harmony.voice_left_reason', 'reconciled', true);
    DELETE FROM public.voice_channel_participants v
     WHERE v.metadata ->> 'transport' = 'p2p'
       AND CASE WHEN v.last_seen_at IS NULL
                THEN v.joined_at < now() - interval '12 hours'
                ELSE GREATEST(v.last_seen_at, v.joined_at) < now() - interval '3 minutes' END;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    PERFORM set_config('harmony.voice_left_reason', '', true);
    RETURN v_count;
END;
$$;

DO $$
DECLARE
    grantee text;
BEGIN
    REVOKE ALL ON FUNCTION public.sweep_stale_voice_participants() FROM PUBLIC, anon, authenticated;
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.sweep_stale_voice_participants() TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;

-- The outer $do$ tag keeps the inner command string intact.
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN PERFORM cron.unschedule('voice-participant-sweep'); EXCEPTION WHEN OTHERS THEN NULL; END;
        PERFORM cron.schedule('voice-participant-sweep', '* * * * *', 'SELECT public.sweep_stale_voice_participants()');
        RAISE NOTICE 'voice-participant-sweep scheduled';
    ELSE
        RAISE NOTICE 'pg_cron not available: sweep_stale_voice_participants is not scheduled';
    END IF;
END
$do$;

COMMIT;

NOTIFY pgrst, 'reload schema';
