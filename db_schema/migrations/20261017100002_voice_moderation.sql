-- Voice moderation, as Discord's Mute Members, Deafen Members and Move Members; voice presence
-- and voice topics follow CONNECT; kicked, banned and timed-out members leave voice.
--
-- server_voice_moderation(server, user): a server mute and a server deafen of a member, set by
-- a moderator. A row exists while either flag is set. It outlives leaving the voice channel and
-- the server, and is read by
--   federation-backend authorizeVoiceChannel: a muted or deafened member's LiveKit token
--     publishes no microphone; a deafened member's subscribes to nothing. The backend applies a
--     change to a connected participant through the LiveKit server API.
--   clients, through get_server_voice_moderation(server), for indicators, and
--     my_voice_state(server) for their own: the member's client locks its mute and deafen
--     controls. On the P2P transport the clients are the only enforcement.
-- Clients reach the table only through the functions below.
--
-- set_server_voice_state(server, user, mute, deafen)
--   A NULL flag is left as it is. Setting or clearing the mute needs MUTE_MEMBERS, the deafen
--   DEAFEN_MEMBERS, resolved in the voice channel of the server the member is in, server-wide
--   when the member is in none. Setting a flag needs an accepted member; clearing does not.
--
-- move_voice_member(server, user, channel)
--   Takes the member out of their voice channel of the server: into `channel`, a voice channel
--   of the same server, or out of voice when it is NULL (Discord's Disconnect). Needs
--   MOVE_MEMBERS in the member's channel, and MOVE_MEMBERS and CONNECT in the destination.
--   As in Discord the member needs no CONNECT there: the move leaves a voice_move_grants row
--   that stands in for it for 120 seconds, long enough for the moved client to join under its
--   own token. The member must be able to view the destination, unlike
--   Discord: their client reads the channel to join it.
--
-- Both act only on a server hosted here, on a member who is not the caller nor the owner and
-- who ranks below the caller (get_user_highest_role_position), as kick_server_member and
-- set_server_member_timeout require; the owner outranks everyone. Administrators are not
-- exempt, as in Discord. Discord applies no role hierarchy to voice moderation.
--
-- voice_channel_admits(profile, channel): VIEW_CHANNEL, CONNECT or a live move grant, and no
-- active timeout. It decides a client's voice_channel_participants row and the
-- harmony-voice-<channel> and easter-egg:<channel> topics, as authorizeVoiceChannel decides a
-- LiveKit token. Service-role writes (federated members) are unchanged.
--
-- Leaving voice. voice_remove_member(server, user, reason) deletes the member's rows in the
-- server's voice channels, which the AFTER DELETE triggers federate like a leave, and drops any
-- move grant. It runs for a move or disconnect (reason moved | disconnected), when accepted
-- membership ends (kick, ban, leave: removed) and when a timeout starts (timed_out). The
-- federation backend removes the participant from LiveKit.
--
-- Broadcasts. A changed state goes out as voice-channel-event {event: voice-moderation,
-- userId, serverId, muted, deafened} on voice-channels:<server>, which every accepted member
-- reads; it names no channel. A removed row goes out as {event: user-left, userId, channelId,
-- reason} on the channel's topic, as remove_voice_participant. The member hears of both on
-- user:<member> as user_event {type: voice:moderation, server_id, muted, deafened} and
-- {type: voice:moved, server_id, from_channel_id, channel_id, reason}.
--
-- Audit: member.voice_mute, member.voice_unmute, member.voice_deafen, member.voice_undeafen,
-- member.voice_move, member.voice_disconnect.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.server_voice_moderation (
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    muted boolean NOT NULL DEFAULT false,
    deafened boolean NOT NULL DEFAULT false,
    muted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    deafened_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, user_id),
    CONSTRAINT server_voice_moderation_set CHECK (muted OR deafened)
);

COMMENT ON TABLE public.server_voice_moderation IS
    'Server mute and server deafen of members. Written through set_server_voice_state(); read by LiveKit token issuance.';

CREATE TABLE IF NOT EXISTS public.voice_move_grants (
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    granted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (server_id, user_id)
);

COMMENT ON TABLE public.voice_move_grants IS
    'A moved member''s admission to the destination voice channel in place of CONNECT, until expires_at. Written by move_voice_member().';

ALTER TABLE public.server_voice_moderation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_move_grants ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['server_voice_moderation', 'voice_move_grants'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role', t);
        EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role', t);
    END LOOP;
END;
$$;

-- Default privileges grant anon and authenticated ALL on new tables.
REVOKE ALL ON public.server_voice_moderation, public.voice_move_grants FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.server_voice_moderation, public.voice_move_grants TO service_role;

-- ---------------------------------------------------------------------------
-- Voice channel admission
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.voice_channel_admits(p_profile uuid, p_channel uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    IF p_profile IS NULL OR p_channel IS NULL THEN
        RETURN false;
    END IF;
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel;
    IF v_server IS NULL THEN
        RETURN false;
    END IF;
    RETURN public.can_view_channel(p_profile, p_channel)
       AND (public.has_permission(p_profile, v_server, 'CONNECT', p_channel)
            OR EXISTS (SELECT 1 FROM public.voice_move_grants g
                        WHERE g.server_id = v_server AND g.user_id = p_profile
                          AND g.channel_id = p_channel AND g.expires_at > now()))
       AND NOT EXISTS (SELECT 1 FROM public.server_member_timeouts t
                        WHERE t.server_id = v_server AND t.user_id = p_profile AND t.until > now());
END;
$$;

REVOKE ALL ON FUNCTION public.voice_channel_admits(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_channel_admits(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.current_user_may_connect_voice(p_channel uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.voice_channel_admits(public.get_current_profile_id(), p_channel);
$$;

REVOKE ALL ON FUNCTION public.current_user_may_connect_voice(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_may_connect_voice(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS voice_participants_insert_self ON public.voice_channel_participants;
CREATE POLICY voice_participants_insert_self ON public.voice_channel_participants
    FOR INSERT TO public
    WITH CHECK (
        user_id = (SELECT public.get_current_profile_id())
        AND channel_id IN (SELECT public.current_user_viewable_channel_ids())
        AND server_id = (SELECT c.server_id FROM public.channels c
                          WHERE c.id = voice_channel_participants.channel_id)
        AND public.current_user_may_connect_voice(channel_id)
    );

DROP POLICY IF EXISTS voice_participants_update_self ON public.voice_channel_participants;
CREATE POLICY voice_participants_update_self ON public.voice_channel_participants
    FOR UPDATE TO public
    USING (user_id = (SELECT public.get_current_profile_id()))
    WITH CHECK (
        user_id = (SELECT public.get_current_profile_id())
        AND channel_id IN (SELECT public.current_user_viewable_channel_ids())
        AND server_id = (SELECT c.server_id FROM public.channels c
                          WHERE c.id = voice_channel_participants.channel_id)
        AND public.current_user_may_connect_voice(channel_id)
    );

-- As 20261006800001, with voice rooms admitted by voice_channel_admits.
CREATE OR REPLACE FUNCTION public.topic_readable_by(p_profile_id uuid, p_topic text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_profile_id uuid;
  v_id         uuid;
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
    RETURN public.voice_channel_admits(v_profile_id, v_id);
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


-- ---------------------------------------------------------------------------
-- Shared checks
-- ---------------------------------------------------------------------------

-- The caller's profile when it may act on p_target's voice in a server hosted here; raises
-- otherwise. Permission checks stay with the callers: they resolve in different channels.
CREATE OR REPLACE FUNCTION public.voice_moderation_actor(p_server_id uuid, p_target uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_owner uuid;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_server_id IS NULL OR p_target IS NULL THEN
        RAISE EXCEPTION 'server and member are required' USING ERRCODE = '22004';
    END IF;
    SELECT s.owner INTO v_owner FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Voice moderation happens on the server''s home instance' USING ERRCODE = '42501';
    END IF;
    IF p_target = v_me THEN
        RAISE EXCEPTION 'You cannot moderate your own voice' USING ERRCODE = '42501';
    END IF;
    IF p_target = v_owner THEN
        RAISE EXCEPTION 'The server owner cannot be voice-moderated' USING ERRCODE = '42501';
    END IF;
    IF v_me IS DISTINCT FROM v_owner
       AND public.get_user_highest_role_position(v_me, p_server_id)
           <= public.get_user_highest_role_position(p_target, p_server_id) THEN
        RAISE EXCEPTION 'Cannot moderate a member with an equal or higher role' USING ERRCODE = '42501';
    END IF;
    RETURN v_me;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_moderation_actor(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Voice channel of the server the profile is in, latest join first; NULL when none.
CREATE OR REPLACE FUNCTION public.member_voice_channel(p_server_id uuid, p_profile uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT v.channel_id
      FROM public.voice_channel_participants v
     WHERE v.server_id = p_server_id AND v.user_id = p_profile
     ORDER BY v.joined_at DESC
     LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.member_voice_channel(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_voice_channel(uuid, uuid) TO service_role;

-- Deletes the member's rows in the server's voice channels and its move grant; announces each
-- row as user-left with p_reason, and the member's departure on user:<member> naming
-- p_to_channel (NULL: out of voice). Returns the channel left, NULL when the member was in none.
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

    FOR v_row IN
        DELETE FROM public.voice_channel_participants v
         WHERE v.server_id = p_server_id AND v.user_id = p_user_id
        RETURNING v.channel_id, v.joined_at
    LOOP
        IF v_left IS NULL THEN
            v_left := v_row.channel_id;
        END IF;
        PERFORM realtime.send(
            jsonb_build_object('event', 'user-left', 'userId', p_user_id, 'channelId', v_row.channel_id,
                               'reason', p_reason),
            'voice-channel-event',
            CASE WHEN public.channel_is_restricted(v_row.channel_id) IS DISTINCT FROM false
                 THEN 'voice-channel:' || v_row.channel_id::text
                 ELSE 'voice-channels:' || p_server_id::text END,
            true);
    END LOOP;

    IF v_left IS NOT NULL THEN
        PERFORM public.broadcast_user_event(p_user_id,
            jsonb_build_object('type', 'voice:moved', 'server_id', p_server_id, 'from_channel_id', v_left,
                               'channel_id', p_to_channel, 'reason', p_reason));
    END IF;
    RETURN v_left;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_remove_member(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_remove_member(uuid, uuid, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Server mute and server deafen
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_server_voice_state(
    p_server_id uuid,
    p_user_id uuid,
    p_mute boolean DEFAULT NULL,
    p_deafen boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid;
    v_channel uuid;
    v_old public.server_voice_moderation%ROWTYPE;
    v_muted boolean;
    v_deafened boolean;
    v_name text;
BEGIN
    IF p_mute IS NULL AND p_deafen IS NULL THEN
        RAISE EXCEPTION 'Nothing to change' USING ERRCODE = '22023';
    END IF;
    v_me := public.voice_moderation_actor(p_server_id, p_user_id);
    v_channel := public.member_voice_channel(p_server_id, p_user_id);

    IF p_mute IS NOT NULL AND NOT public.has_permission(v_me, p_server_id, 'MUTE_MEMBERS', v_channel) THEN
        RAISE EXCEPTION 'Missing permission: MUTE_MEMBERS' USING ERRCODE = '42501';
    END IF;
    IF p_deafen IS NOT NULL AND NOT public.has_permission(v_me, p_server_id, 'DEAFEN_MEMBERS', v_channel) THEN
        RAISE EXCEPTION 'Missing permission: DEAFEN_MEMBERS' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_old FROM public.server_voice_moderation
     WHERE server_id = p_server_id AND user_id = p_user_id FOR UPDATE;
    v_muted := COALESCE(p_mute, v_old.muted, false);
    v_deafened := COALESCE(p_deafen, v_old.deafened, false);

    IF (p_mute IS TRUE OR p_deafen IS TRUE)
       AND NOT EXISTS (SELECT 1 FROM public.user_servers us
                        WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted') THEN
        RAISE EXCEPTION 'Not a member of this server' USING ERRCODE = '22023';
    END IF;

    IF v_muted OR v_deafened THEN
        INSERT INTO public.server_voice_moderation AS m
            (server_id, user_id, muted, deafened, muted_by, deafened_by, updated_at)
        VALUES (p_server_id, p_user_id, v_muted, v_deafened,
                CASE WHEN v_muted THEN v_me END, CASE WHEN v_deafened THEN v_me END, now())
        ON CONFLICT (server_id, user_id) DO UPDATE
           SET muted = EXCLUDED.muted,
               deafened = EXCLUDED.deafened,
               muted_by = CASE WHEN NOT EXCLUDED.muted THEN NULL
                               WHEN NOT m.muted THEN v_me
                               ELSE m.muted_by END,
               deafened_by = CASE WHEN NOT EXCLUDED.deafened THEN NULL
                                  WHEN NOT m.deafened THEN v_me
                                  ELSE m.deafened_by END,
               updated_at = now();
    ELSE
        DELETE FROM public.server_voice_moderation WHERE server_id = p_server_id AND user_id = p_user_id;
    END IF;

    IF v_muted IS DISTINCT FROM COALESCE(v_old.muted, false)
       OR v_deafened IS DISTINCT FROM COALESCE(v_old.deafened, false) THEN
        SELECT p.username INTO v_name FROM public.profiles p WHERE p.id = p_user_id;
        IF v_muted IS DISTINCT FROM COALESCE(v_old.muted, false) THEN
            PERFORM public.server_audit_write(p_server_id,
                CASE WHEN v_muted THEN 'member.voice_mute' ELSE 'member.voice_unmute' END,
                'user', p_user_id::text, v_name);
        END IF;
        IF v_deafened IS DISTINCT FROM COALESCE(v_old.deafened, false) THEN
            PERFORM public.server_audit_write(p_server_id,
                CASE WHEN v_deafened THEN 'member.voice_deafen' ELSE 'member.voice_undeafen' END,
                'user', p_user_id::text, v_name);
        END IF;

        PERFORM realtime.send(
            jsonb_build_object('event', 'voice-moderation', 'userId', p_user_id, 'serverId', p_server_id,
                               'muted', v_muted, 'deafened', v_deafened),
            'voice-channel-event', 'voice-channels:' || p_server_id::text, true);
        PERFORM public.broadcast_user_event(p_user_id,
            jsonb_build_object('type', 'voice:moderation', 'server_id', p_server_id,
                               'muted', v_muted, 'deafened', v_deafened));
    END IF;

    RETURN jsonb_build_object('server_id', p_server_id, 'user_id', p_user_id, 'channel_id', v_channel,
                              'muted', v_muted, 'deafened', v_deafened);
END;
$$;

REVOKE ALL ON FUNCTION public.set_server_voice_state(uuid, uuid, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_server_voice_state(uuid, uuid, boolean, boolean) TO authenticated, service_role;

-- Muted and deafened members of a local server, for its owner, accepted members and instance
-- admins. Empty for anyone else and for a remote server's copy.
CREATE OR REPLACE FUNCTION public.get_server_voice_moderation(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL OR NOT (
           EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v_me)
        OR EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted')
        OR public.is_current_user_admin()) THEN
        RETURN '[]'::jsonb;
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object('user_id', m.user_id, 'muted', m.muted, 'deafened', m.deafened)
                         ORDER BY m.user_id)
          FROM public.server_voice_moderation m
          JOIN public.servers s ON s.id = m.server_id AND s.is_local_server
         WHERE m.server_id = p_server_id), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.get_server_voice_moderation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_server_voice_moderation(uuid) TO authenticated, service_role;

-- The caller's own voice in a local server: the channel it is in, a live move grant's
-- channel, and its server mute and deafen. Clients poll it while realtime is down.
CREATE OR REPLACE FUNCTION public.my_voice_state(p_server_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'channel_id', public.member_voice_channel(p_server_id, me.id),
        'move_channel_id', (SELECT g.channel_id FROM public.voice_move_grants g
                             WHERE g.server_id = p_server_id AND g.user_id = me.id AND g.expires_at > now()),
        'muted', COALESCE(m.muted, false),
        'deafened', COALESCE(m.deafened, false))
      FROM (SELECT public.get_current_profile_id() AS id) me
      LEFT JOIN public.server_voice_moderation m ON m.server_id = p_server_id AND m.user_id = me.id
     WHERE me.id IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.my_voice_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_voice_state(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Move and disconnect
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.move_voice_member(
    p_server_id uuid,
    p_user_id uuid,
    p_channel_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid;
    v_from uuid;
    v_from_name text;
    v_to_name text;
BEGIN
    v_me := public.voice_moderation_actor(p_server_id, p_user_id);
    v_from := public.member_voice_channel(p_server_id, p_user_id);
    IF v_from IS NULL THEN
        RAISE EXCEPTION 'Member is not in a voice channel of this server' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.has_permission(v_me, p_server_id, 'MOVE_MEMBERS', v_from) THEN
        RAISE EXCEPTION 'Missing permission: MOVE_MEMBERS' USING ERRCODE = '42501';
    END IF;

    IF p_channel_id IS NOT NULL THEN
        SELECT c.name INTO v_to_name FROM public.channels c
         WHERE c.id = p_channel_id AND c.server_id = p_server_id AND c.type = 1;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Not a voice channel of this server' USING ERRCODE = '22023';
        END IF;
        IF p_channel_id = v_from THEN
            RAISE EXCEPTION 'Member is already in that channel' USING ERRCODE = '22023';
        END IF;
        IF NOT (public.has_permission(v_me, p_server_id, 'MOVE_MEMBERS', p_channel_id)
                AND public.has_permission(v_me, p_server_id, 'CONNECT', p_channel_id)) THEN
            RAISE EXCEPTION 'Missing permission: MOVE_MEMBERS and CONNECT in the destination' USING ERRCODE = '42501';
        END IF;
        IF NOT public.can_view_channel(p_user_id, p_channel_id)
           OR EXISTS (SELECT 1 FROM public.server_member_timeouts t
                       WHERE t.server_id = p_server_id AND t.user_id = p_user_id AND t.until > now()) THEN
            RAISE EXCEPTION 'The member cannot see that channel' USING ERRCODE = '42501';
        END IF;
        INSERT INTO public.voice_move_grants (server_id, user_id, channel_id, granted_by, expires_at)
        VALUES (p_server_id, p_user_id, p_channel_id, v_me, now() + interval '120 seconds')
        ON CONFLICT (server_id, user_id) DO UPDATE
           SET channel_id = EXCLUDED.channel_id, granted_by = EXCLUDED.granted_by, expires_at = EXCLUDED.expires_at;
    END IF;

    PERFORM public.voice_remove_member(p_server_id, p_user_id,
        CASE WHEN p_channel_id IS NULL THEN 'disconnected' ELSE 'moved' END, p_channel_id);

    SELECT c.name INTO v_from_name FROM public.channels c WHERE c.id = v_from;
    PERFORM public.server_audit_write(p_server_id,
        CASE WHEN p_channel_id IS NULL THEN 'member.voice_disconnect' ELSE 'member.voice_move' END,
        'user', p_user_id::text, (SELECT p.username FROM public.profiles p WHERE p.id = p_user_id),
        NULL,
        jsonb_build_object('from_channel_name', v_from_name, 'channel_name', v_to_name));

    RETURN jsonb_build_object('server_id', p_server_id, 'user_id', p_user_id,
                              'from_channel_id', v_from, 'channel_id', p_channel_id);
END;
$$;

REVOKE ALL ON FUNCTION public.move_voice_member(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_voice_member(uuid, uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Membership ends, timeout starts: out of voice
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.voice_leave_on_membership_end()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM 'accepted' OR NEW.status = 'accepted') THEN
        RETURN NULL;
    END IF;
    PERFORM public.voice_remove_member(OLD.server_id, OLD.user_id, 'removed');
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_leave_on_membership_end() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_user_servers_leave_voice ON public.user_servers;
CREATE TRIGGER z_user_servers_leave_voice
    AFTER DELETE OR UPDATE OF status ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.voice_leave_on_membership_end();

CREATE OR REPLACE FUNCTION public.voice_leave_on_timeout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.until > now() THEN
        PERFORM public.voice_remove_member(NEW.server_id, NEW.user_id, 'timed_out');
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_leave_on_timeout() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_member_timeouts_leave_voice ON public.server_member_timeouts;
CREATE TRIGGER z_member_timeouts_leave_voice
    AFTER INSERT OR UPDATE OF until ON public.server_member_timeouts
    FOR EACH ROW EXECUTE FUNCTION public.voice_leave_on_timeout();

COMMIT;
