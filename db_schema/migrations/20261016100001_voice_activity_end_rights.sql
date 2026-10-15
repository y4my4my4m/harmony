-- Ending a running voice activity, or replacing it by starting another, takes
-- voice_activity_may_end: its host, an instance admin or moderator, a member with MOVE_MEMBERS
-- in the channel, or anyone once the host has left the call. Playback (voice_activity_control)
-- follows the activity's controls setting.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.voice_activity_may_end(p_row public.voice_activities, p_profile uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_row.host_id = p_profile
        OR public.is_current_user_admin_or_mod()
        OR public.has_permission(p_profile, p_row.server_id, 'MOVE_MEMBERS', p_row.channel_id)
        OR NOT EXISTS (SELECT 1 FROM public.voice_channel_participants vp
                        WHERE vp.channel_id = p_row.channel_id AND vp.user_id = p_row.host_id);
$$;

REVOKE ALL ON FUNCTION public.voice_activity_may_end(public.voice_activities, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_activity_may_end(public.voice_activities, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.voice_activity_start(p_channel uuid, p_source text, p_item jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.voice_activity_participant(p_channel);
    v_item jsonb := public.voice_activity_item(p_source, p_item, v_profile);
    v_old public.voice_activities;
    v_row public.voice_activities;
BEGIN
    SELECT * INTO v_old FROM public.voice_activities a WHERE a.channel_id = p_channel FOR UPDATE;
    IF FOUND THEN
        IF NOT public.voice_activity_may_end(v_old, v_profile) THEN
            RAISE EXCEPTION 'Only the host or a moderator ends this activity' USING ERRCODE = '42501';
        END IF;
        IF v_old.share_id IS NOT NULL THEN
            PERFORM public.voice_activity_drop_share(v_old.share_id);
        END IF;
        DELETE FROM public.voice_activities a WHERE a.channel_id = p_channel;
    END IF;

    INSERT INTO public.voice_activities (channel_id, server_id, source, item, host_id, share_id, revision)
    SELECT p_channel, c.server_id, p_source, v_item, v_profile,
           public.voice_activity_share(p_source, v_item, p_channel),
           coalesce(v_old.revision, 0) + 1
      FROM public.channels c WHERE c.id = p_channel
    RETURNING * INTO v_row;
    RETURN jsonb_build_object('activity', public.voice_activity_json(v_row), 'server_now', public.server_now());
END;
$$;

CREATE OR REPLACE FUNCTION public.voice_activity_stop(p_channel uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.voice_activity_participant(p_channel);
    v_row public.voice_activities;
BEGIN
    SELECT * INTO v_row FROM public.voice_activities a WHERE a.channel_id = p_channel FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF NOT public.voice_activity_may_end(v_row, v_profile) THEN
        RAISE EXCEPTION 'Only the host or a moderator ends this activity' USING ERRCODE = '42501';
    END IF;
    IF v_row.share_id IS NOT NULL THEN
        PERFORM public.voice_activity_drop_share(v_row.share_id);
    END IF;
    DELETE FROM public.voice_activities a WHERE a.channel_id = p_channel;
    RETURN true;
END;
$$;

COMMIT;
