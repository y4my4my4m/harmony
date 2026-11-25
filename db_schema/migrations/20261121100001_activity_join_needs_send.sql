-- activity_join_refusal: a text channel's activity takes the channel's Send Messages for joining as
-- for starting, and a server member's active timeout (server_member_timeouts) refuses both in text
-- and voice channels, as it refuses messages (refuse_timed_out_caller) and speaking. A game carries
-- free text and drawings to everyone playing; joining with view rights alone let a read-only or
-- timed-out member post there. activity_session_admit re-runs it on every relay readmit (30 s), so
-- a member who loses the permission mid-game is removed.
--
-- New refusal: MEMBER_TIMED_OUT. p_starting is kept for the signature and no longer changes the
-- answer. Body otherwise, volatility, owner and grants as 20261117500001_play_together.sql.
--
-- get_activity_sessions and get_activity_session show a running session, with the refusal, to a
-- member who sees the channel but may not play (CANNOT_SEND, MEMBER_TIMED_OUT), as they did for
-- NOT_IN_CALL and DM_BLOCKED; each listed session now carries the caller's refusal too. Other
-- refusals still return nothing.

BEGIN;

CREATE OR REPLACE FUNCTION public.activity_join_refusal(
    p_profile uuid,
    p_conversation uuid,
    p_channel uuid,
    p_starting boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_kind text;
    v_server uuid;
    v_local boolean;
BEGIN
    IF (p_conversation IS NULL) = (p_channel IS NULL) THEN
        RETURN 'ACTIVITY_CONTEXT';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_profile AND p.is_local) THEN
        RETURN 'NOT_LOCAL_ACCOUNT';
    END IF;

    IF p_conversation IS NOT NULL THEN
        IF NOT public.is_conversation_participant(p_conversation, p_profile) THEN
            RETURN 'NOT_FOUND';
        END IF;
        v_kind := public.activity_context_kind(p_conversation, NULL);
        IF v_kind IS NULL THEN
            RETURN 'NOT_FOUND';
        END IF;
        IF v_kind = 'direct' AND public.dm_conversation_blocked(p_conversation, p_profile) THEN
            RETURN 'DM_BLOCKED';
        END IF;
        RETURN NULL;
    END IF;

    IF NOT coalesce(public.can_view_channel(p_profile, p_channel), false) THEN
        RETURN 'NOT_FOUND';
    END IF;
    SELECT ch.server_id, coalesce(s.is_local_server, true) INTO v_server, v_local
      FROM public.channels ch JOIN public.servers s ON s.id = ch.server_id
     WHERE ch.id = p_channel;
    IF NOT v_local THEN
        RETURN 'SERVER_NOT_LOCAL';
    END IF;
    v_kind := public.activity_context_kind(NULL, p_channel);
    IF v_kind IS NULL THEN
        RETURN 'CHANNEL_TYPE';
    END IF;
    IF EXISTS (SELECT 1 FROM public.server_member_timeouts t
                WHERE t.server_id = v_server AND t.user_id = p_profile AND t.until > now()) THEN
        RETURN 'MEMBER_TIMED_OUT';
    END IF;
    IF v_kind = 'voice' AND NOT EXISTS (
            SELECT 1 FROM public.voice_channel_participants vp
             WHERE vp.channel_id = p_channel AND vp.user_id = p_profile) THEN
        RETURN 'NOT_IN_CALL';
    END IF;
    IF v_kind = 'channel'
       AND NOT public.has_permission(p_profile, v_server, 'SEND_MESSAGES', p_channel) THEN
        RETURN 'CANNOT_SEND';
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.activity_join_refusal(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activity_join_refusal(uuid, uuid, uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.get_activity_sessions(p_conversation uuid DEFAULT NULL, p_channel uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_refusal text;
BEGIN
    IF v_me IS NULL THEN
        RETURN '[]'::jsonb;
    END IF;
    v_refusal := public.activity_join_refusal(v_me, p_conversation, p_channel, false);
    IF v_refusal IS NOT NULL AND v_refusal NOT IN ('NOT_IN_CALL', 'DM_BLOCKED', 'CANNOT_SEND', 'MEMBER_TIMED_OUT') THEN
        RETURN '[]'::jsonb;
    END IF;
    RETURN coalesce((
        SELECT jsonb_agg(public.activity_session_json(s) || jsonb_build_object('refusal', v_refusal) ORDER BY s.started_at)
          FROM public.activity_sessions s
         WHERE s.status = 'active'
           AND s.last_active_at >= now() - interval '3 minutes'
           AND (s.conversation_id = p_conversation OR s.channel_id = p_channel)), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.get_activity_sessions(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_activity_sessions(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_activity_session(p_session uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_row public.activity_sessions;
    v_refusal text;
BEGIN
    SELECT * INTO v_row FROM public.activity_sessions WHERE id = p_session;
    IF NOT FOUND OR v_me IS NULL THEN
        RETURN NULL;
    END IF;
    v_refusal := public.activity_join_refusal(v_me, v_row.conversation_id, v_row.channel_id, false);
    IF v_refusal IS NOT NULL AND v_refusal NOT IN ('NOT_IN_CALL', 'DM_BLOCKED', 'CANNOT_SEND', 'MEMBER_TIMED_OUT') THEN
        RETURN NULL;
    END IF;
    RETURN public.activity_session_json(v_row) || jsonb_build_object('refusal', v_refusal);
END;
$$;
REVOKE ALL ON FUNCTION public.get_activity_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_activity_session(uuid) TO authenticated, service_role;

COMMIT;
