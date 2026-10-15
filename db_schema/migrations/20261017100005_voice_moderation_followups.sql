-- Voice moderation follow-ups to 20261017100002_voice_moderation.sql: the permission decides,
-- membership end clears a server mute, permission changes reach connected participants, and
-- moderation of a remote member reaches the member's instance.
--
-- Permission, not rank. Discord applies the role hierarchy to kick, ban, nickname and role
-- management only ("Otherwise, permissions do not obey the role hierarchy",
-- https://discord.com/developers/docs/topics/permissions#permission-hierarchy). Mute Members,
-- Deafen Members and Move Members decide alone: a holder acts on any member, the owner and
-- the caller included. voice_moderation_actor keeps authentication and the home-instance
-- rule; kick_server_member, ban_server_member and set_server_member_timeout keep their rank
-- checks.
--
-- Membership end. A member's server_voice_moderation row is deleted when accepted membership
-- ends (leave, kick, ban), as the mute and deaf of a Discord guild member go with the member
-- object; the cleared state goes out on voice-channels:<server>. The row still outlives
-- leaving and rejoining voice. A local member of a remote server's copy whose membership ends
-- is told on user:<member> (voice:moved, reason removed): the call it holds on the host ends.
--
-- Permission changes. voice_grant_resyncs(server, channel, user) names participants whose
-- voice grants may have changed: NULL channel or user widens the scope to the server. Rows are
-- written by statement triggers on server_roles (permissions changed, role deleted),
-- user_roles (assigned, removed), channel_permission_overrides (any change) and servers
-- (owner changed), only for a local server with voice participants in scope; a user_roles
-- statement naming more than 25 members of one server writes one server row. Each write also
--   - notifies federation_jobs with {name: voice-grant-sync, data: {server_id}}: the worker
--     recomputes the scope's grants (voice_participant_grants), updates or removes the
--     LiveKit participants, removes presence rows no longer admitted (voice_remove_member,
--     reason revoked) and deletes the rows it handled; its voice sweep handles rows a lost
--     notification left behind;
--   - broadcasts voice-channel-event {event: voice-grants, serverId, channelId, userId} on
--     voice-channels:<server>, channelId NULL for a restricted channel: P2P clients in scope
--     re-read their grants and leave a channel that no longer admits them.
--
-- voice_participant_grants(channels[], users[]): for each (channel, user) pair, the decision
-- federation-backend authorizeVoiceChannel makes for a token, in one statement.
--
-- Federation. A remote member of a local, federated server is told of moderation by the
-- server's Group (federation-backend voiceModerationFederation.ts): a voice_remove_member of
-- such a member queues {kind: move | disconnect, server_id, user_id, from_channel_id,
-- channel_id, reason} as federate-voice-moderation; a change of an accepted such member's
-- server_voice_moderation row queues {kind: state, server_id, user_id, muted, deafened}.
-- apply_group_voice_state(server, user, muted, deafened) stores a Group's state of a member
-- in the copy of its server and broadcasts it as set_server_voice_state does;
-- get_server_voice_moderation reads copies as well. ap_activities takes the three activity
-- types.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Permission, not rank
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.voice_moderation_actor(p_server_id uuid, p_target uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_server_id IS NULL OR p_target IS NULL THEN
        RAISE EXCEPTION 'server and member are required' USING ERRCODE = '22004';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server) THEN
        RAISE EXCEPTION 'Voice moderation happens on the server''s home instance' USING ERRCODE = '42501';
    END IF;
    RETURN v_me;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_moderation_actor(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Federation helpers
-- ---------------------------------------------------------------------------

-- A remote profile in a local server that federates: the members its Group speaks for.
-- p_accepted: the profile also holds accepted membership.
CREATE OR REPLACE FUNCTION public.voice_member_federates(p_server_id uuid, p_user_id uuid, p_accepted boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server AND s.federation_enabled IS TRUE)
       AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND p.is_local IS FALSE)
       AND (NOT p_accepted
            OR EXISTS (SELECT 1 FROM public.user_servers us
                        WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted'));
$$;

REVOKE ALL ON FUNCTION public.voice_member_federates(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

-- As 20261017100002; a remote member's departure is queued for the server's Group.
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

-- An accepted remote member's server mute and deafen, queued for the server's Group.
CREATE OR REPLACE FUNCTION public.voice_moderation_federate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
    v_user uuid;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.muted = OLD.muted AND NEW.deafened = OLD.deafened THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
        v_server := OLD.server_id;
        v_user := OLD.user_id;
    ELSE
        v_server := NEW.server_id;
        v_user := NEW.user_id;
    END IF;
    IF NOT public.voice_member_federates(v_server, v_user, true) THEN
        RETURN NULL;
    END IF;
    PERFORM public.queue_federation_job('federate-voice-moderation', jsonb_build_object(
        'type', 'update', 'kind', 'state', 'server_id', v_server, 'user_id', v_user,
        'muted', TG_OP <> 'DELETE' AND NEW.muted,
        'deafened', TG_OP <> 'DELETE' AND NEW.deafened));
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_moderation_federate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_server_voice_moderation_federate ON public.server_voice_moderation;
CREATE TRIGGER z_server_voice_moderation_federate
    AFTER INSERT OR UPDATE OR DELETE ON public.server_voice_moderation
    FOR EACH ROW EXECUTE FUNCTION public.voice_moderation_federate();

-- As the baseline, with z_server_voice_moderation_federate.
CREATE OR REPLACE FUNCTION public.enable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_response;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads ENABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers ENABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_group_participant_left;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_conversation_participant_added;
    ALTER TABLE public.server_voice_moderation ENABLE TRIGGER z_server_voice_moderation_federate;
    RAISE NOTICE 'All federation triggers enabled';
END;
$$;

REVOKE ALL ON FUNCTION public.enable_federation_triggers() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.disable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_response;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads DISABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers DISABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_group_participant_left;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_conversation_participant_added;
    ALTER TABLE public.server_voice_moderation DISABLE TRIGGER z_server_voice_moderation_federate;
    RAISE NOTICE 'All federation triggers disabled';
END;
$$;

REVOKE ALL ON FUNCTION public.disable_federation_triggers() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Membership end
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

    DELETE FROM public.server_voice_moderation m
     WHERE m.server_id = OLD.server_id AND m.user_id = OLD.user_id;
    IF FOUND THEN
        PERFORM realtime.send(
            jsonb_build_object('event', 'voice-moderation', 'userId', OLD.user_id, 'serverId', OLD.server_id,
                               'muted', false, 'deafened', false),
            'voice-channel-event', 'voice-channels:' || OLD.server_id::text, true);
    END IF;

    IF OLD.status = 'accepted'
       AND EXISTS (SELECT 1 FROM public.servers s WHERE s.id = OLD.server_id AND s.is_local_server IS FALSE)
       AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = OLD.user_id AND p.is_local) THEN
        PERFORM public.broadcast_user_event(OLD.user_id,
            jsonb_build_object('type', 'voice:moved', 'server_id', OLD.server_id, 'from_channel_id', NULL,
                               'channel_id', NULL, 'reason', 'removed'));
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_leave_on_membership_end() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_user_servers_leave_voice ON public.user_servers;
CREATE TRIGGER z_user_servers_leave_voice
    AFTER DELETE OR UPDATE OF status ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.voice_leave_on_membership_end();

-- ---------------------------------------------------------------------------
-- Copies: a Group's server mute and deafen of a member
-- ---------------------------------------------------------------------------

-- Stores the state the Group of remote server p_server_id sent for p_user_id in the copy of
-- that server and broadcasts it as set_server_voice_state does. True when it changed.
CREATE OR REPLACE FUNCTION public.apply_group_voice_state(
    p_server_id uuid, p_user_id uuid, p_muted boolean, p_deafened boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_old public.server_voice_moderation%ROWTYPE;
    v_muted boolean := COALESCE(p_muted, false);
    v_deafened boolean := COALESCE(p_deafened, false);
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server IS FALSE) THEN
        RAISE EXCEPTION 'Not a remote server''s copy' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_old FROM public.server_voice_moderation
     WHERE server_id = p_server_id AND user_id = p_user_id FOR UPDATE;
    IF v_muted = COALESCE(v_old.muted, false) AND v_deafened = COALESCE(v_old.deafened, false) THEN
        RETURN false;
    END IF;

    IF v_muted OR v_deafened THEN
        INSERT INTO public.server_voice_moderation (server_id, user_id, muted, deafened, updated_at)
        VALUES (p_server_id, p_user_id, v_muted, v_deafened, now())
        ON CONFLICT (server_id, user_id) DO UPDATE
           SET muted = EXCLUDED.muted, deafened = EXCLUDED.deafened, updated_at = now();
    ELSE
        DELETE FROM public.server_voice_moderation WHERE server_id = p_server_id AND user_id = p_user_id;
    END IF;

    PERFORM realtime.send(
        jsonb_build_object('event', 'voice-moderation', 'userId', p_user_id, 'serverId', p_server_id,
                           'muted', v_muted, 'deafened', v_deafened),
        'voice-channel-event', 'voice-channels:' || p_server_id::text, true);
    PERFORM public.broadcast_user_event(p_user_id,
        jsonb_build_object('type', 'voice:moderation', 'server_id', p_server_id,
                           'muted', v_muted, 'deafened', v_deafened));
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_group_voice_state(uuid, uuid, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_group_voice_state(uuid, uuid, boolean, boolean) TO service_role;

-- As 20261017100002, copies included: their rows come from the server's Group.
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
         WHERE m.server_id = p_server_id), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.get_server_voice_moderation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_server_voice_moderation(uuid) TO authenticated, service_role;

ALTER TABLE public.ap_activities DROP CONSTRAINT IF EXISTS ap_activities_valid_type;
ALTER TABLE public.ap_activities ADD CONSTRAINT ap_activities_valid_type CHECK (ap_type IN (
    'Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', 'Undo',
    'Like', 'EmojiReaction', 'Announce', 'Add', 'Remove', 'Invite',
    'Join', 'Leave', 'Block', 'Flag', 'Move', 'Tombstone', 'QuoteRequest',
    'VoiceJoin', 'VoiceLeave', 'VoiceUpdate',
    'harmony:VoiceCallInvite', 'harmony:VoiceCallAccept',
    'harmony:VoiceCallReject', 'harmony:VoiceCallEnd',
    'harmony:VoiceChannelJoin', 'harmony:VoiceChannelLeave',
    'harmony:VoiceChannelJoinAccept', 'harmony:VoiceChannelJoinReject',
    'harmony:VoiceMemberMove', 'harmony:VoiceMemberDisconnect', 'harmony:VoiceMemberState'
));

-- ---------------------------------------------------------------------------
-- Voice grants of connected participants
-- ---------------------------------------------------------------------------

-- Mirrors federation-backend authorizeVoiceChannel (voiceAccess.ts) for many pairs: reason is
-- its refusal, NULL when admitted. A profile with is_local false is a remote actor.
CREATE OR REPLACE FUNCTION public.voice_participant_grants(p_channels uuid[], p_users uuid[])
RETURNS TABLE (
    channel_id uuid,
    user_id uuid,
    reason text,
    can_speak boolean,
    can_stream boolean,
    can_soundboard boolean,
    can_external_sounds boolean,
    server_muted boolean,
    server_deafened boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH pairs AS (
        SELECT DISTINCT t.c AS channel_id, t.u AS user_id
          FROM unnest(p_channels, p_users) AS t(c, u)
         WHERE t.c IS NOT NULL AND t.u IS NOT NULL
    ), facts AS (
        SELECT p.channel_id, p.user_id, ch.server_id, s.id AS found_server,
               s.is_local_server, s.federation_enabled,
               pr.is_local IS FALSE AS remote,
               s.owner IS NOT DISTINCT FROM p.user_id AS is_owner,
               EXISTS (SELECT 1 FROM public.user_servers us
                        WHERE us.server_id = ch.server_id AND us.user_id = p.user_id AND us.status = 'accepted') AS accepted,
               EXISTS (SELECT 1 FROM public.server_bans b
                        WHERE b.server_id = ch.server_id AND b.user_id = p.user_id) AS banned,
               EXISTS (SELECT 1 FROM public.server_member_timeouts t
                        WHERE t.server_id = ch.server_id AND t.user_id = p.user_id AND t.until > now()) AS timed_out,
               EXISTS (SELECT 1 FROM public.voice_move_grants g
                        WHERE g.server_id = ch.server_id AND g.user_id = p.user_id
                          AND g.channel_id = p.channel_id AND g.expires_at > now()) AS moved_here,
               COALESCE(m.muted, false) AS muted,
               COALESCE(m.deafened, false) AS deafened,
               CASE WHEN s.id IS NULL THEN '{}'::jsonb
                    ELSE public.get_user_permissions(p.user_id, ch.server_id, p.channel_id) END AS perms
          FROM pairs p
          LEFT JOIN public.channels ch ON ch.id = p.channel_id
          LEFT JOIN public.servers s ON s.id = ch.server_id
          LEFT JOIN public.profiles pr ON pr.id = p.user_id
          LEFT JOIN public.server_voice_moderation m ON m.server_id = ch.server_id AND m.user_id = p.user_id
    ), decided AS (
        SELECT f.*,
               CASE
                   WHEN f.server_id IS NULL THEN 'channel not found'
                   WHEN f.found_server IS NULL THEN 'server not found'
                   WHEN f.remote AND f.is_local_server IS FALSE THEN 'server is not hosted here'
                   WHEN f.remote AND f.federation_enabled IS NOT TRUE THEN 'federation is disabled on the server'
                   WHEN NOT f.is_owner AND NOT f.accepted THEN 'not an accepted member'
                   WHEN NOT f.is_owner AND f.banned THEN 'banned'
                   WHEN NOT f.is_owner AND f.timed_out THEN 'timed out'
                   WHEN (f.perms ->> 'VIEW_CHANNEL') IS DISTINCT FROM 'true' THEN 'missing VIEW_CHANNEL'
                   WHEN (f.perms ->> 'CONNECT') IS DISTINCT FROM 'true' AND NOT f.moved_here THEN 'missing CONNECT'
               END AS refusal,
               (f.perms ->> 'SPEAK') = 'true' AND NOT f.muted AND NOT f.deafened AS speak
          FROM facts f
    )
    SELECT d.channel_id, d.user_id, d.refusal,
           d.refusal IS NULL AND d.speak,
           d.refusal IS NULL AND (d.perms ->> 'STREAM') = 'true',
           d.refusal IS NULL AND d.speak AND (d.perms ->> 'USE_SOUNDBOARD') = 'true',
           d.refusal IS NULL AND d.speak AND (d.perms ->> 'USE_SOUNDBOARD') = 'true'
               AND (d.perms ->> 'USE_EXTERNAL_SOUNDS') = 'true',
           d.muted, d.deafened
      FROM decided d;
$$;

REVOKE ALL ON FUNCTION public.voice_participant_grants(uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_participant_grants(uuid[], uuid[]) TO service_role;

CREATE TABLE IF NOT EXISTS public.voice_grant_resyncs (
    id bigserial PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    channel_id uuid,
    user_id uuid,
    queued_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.voice_grant_resyncs IS
    'Voice participants whose grants may have changed; NULL channel or user widens to the server. Written by voice_grants_changed(), drained by the federation worker.';

CREATE UNIQUE INDEX IF NOT EXISTS voice_grant_resyncs_scope
    ON public.voice_grant_resyncs (server_id, channel_id, user_id) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS voice_grant_resyncs_queued ON public.voice_grant_resyncs (queued_at);

ALTER TABLE public.voice_grant_resyncs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_grant_resyncs_service_role ON public.voice_grant_resyncs;
CREATE POLICY voice_grant_resyncs_service_role ON public.voice_grant_resyncs
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.voice_grant_resyncs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.voice_grant_resyncs TO service_role;
REVOKE ALL ON SEQUENCE public.voice_grant_resyncs_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.voice_grant_resyncs_id_seq TO service_role;

-- Queues a resync of the participants in scope and tells P2P clients; nothing for a remote
-- server's copy or a scope with no voice participant.
CREATE OR REPLACE FUNCTION public.voice_grants_changed(p_server_id uuid, p_channel_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_server_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server)
       OR NOT EXISTS (SELECT 1 FROM public.voice_channel_participants v
                       WHERE v.server_id = p_server_id
                         AND (p_channel_id IS NULL OR v.channel_id = p_channel_id)
                         AND (p_user_id IS NULL OR v.user_id = p_user_id)) THEN
        RETURN;
    END IF;

    INSERT INTO public.voice_grant_resyncs (server_id, channel_id, user_id)
    VALUES (p_server_id, p_channel_id, p_user_id)
    ON CONFLICT DO NOTHING;

    -- Identical payloads collapse to one notification per transaction.
    BEGIN
        PERFORM pg_notify('federation_jobs', json_build_object(
            'name', 'voice-grant-sync',
            'data', json_build_object('type', 'update', 'server_id', p_server_id))::text);
    EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'voice-grant-sync notify failed for %: %', p_server_id, SQLERRM;
    END;

    -- A member who lost View Channel no longer reads the channel's own topic: the server's
    -- carries every change, naming no restricted channel.
    PERFORM realtime.send(
        jsonb_build_object('event', 'voice-grants', 'serverId', p_server_id,
                           'channelId', CASE WHEN public.channel_is_restricted(p_channel_id) IS FALSE
                                             THEN p_channel_id END,
                           'userId', p_user_id),
        'voice-channel-event', 'voice-channels:' || p_server_id::text, true);
END;
$$;

REVOKE ALL ON FUNCTION public.voice_grants_changed(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Transition tables: old_rows for DELETE and UPDATE, new_rows for INSERT and UPDATE.
CREATE OR REPLACE FUNCTION public.voice_grants_on_server_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        FOR v_server IN
            SELECT DISTINCT n.server_id FROM new_rows n JOIN old_rows o ON o.id = n.id
             WHERE n.permissions IS DISTINCT FROM o.permissions
        LOOP
            PERFORM public.voice_grants_changed(v_server, NULL, NULL);
        END LOOP;
    ELSE
        FOR v_server IN SELECT DISTINCT o.server_id FROM old_rows o LOOP
            PERFORM public.voice_grants_changed(v_server, NULL, NULL);
        END LOOP;
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_grants_on_server_roles() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_server_roles_voice_grants_update ON public.server_roles;
CREATE TRIGGER z_server_roles_voice_grants_update
    AFTER UPDATE ON public.server_roles
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.voice_grants_on_server_roles();
DROP TRIGGER IF EXISTS z_server_roles_voice_grants_delete ON public.server_roles;
CREATE TRIGGER z_server_roles_voice_grants_delete
    AFTER DELETE ON public.server_roles
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.voice_grants_on_server_roles();

-- Members of more than this many in one server and statement resync the whole server.
CREATE OR REPLACE FUNCTION public.voice_grants_on_user_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_servers uuid[] := '{}';
    v_users uuid[] := '{}';
    v_row record;
BEGIN
    -- A statement names only the transition tables its trigger declares.
    IF TG_OP <> 'DELETE' THEN
        SELECT v_servers || array_agg(n.server_id), v_users || array_agg(n.user_id)
          INTO v_servers, v_users FROM new_rows n;
    END IF;
    IF TG_OP <> 'INSERT' THEN
        SELECT v_servers || array_agg(o.server_id), v_users || array_agg(o.user_id)
          INTO v_servers, v_users FROM old_rows o;
    END IF;

    FOR v_row IN
        WITH changed AS (
            SELECT DISTINCT t.server_id, t.user_id FROM unnest(v_servers, v_users) AS t(server_id, user_id)
        ), counted AS (
            SELECT c.server_id, c.user_id, count(*) OVER (PARTITION BY c.server_id) AS members FROM changed c
        )
        SELECT DISTINCT c.server_id, CASE WHEN c.members > 25 THEN NULL ELSE c.user_id END AS user_id
          FROM counted c
    LOOP
        PERFORM public.voice_grants_changed(v_row.server_id, NULL, v_row.user_id);
    END LOOP;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_grants_on_user_roles() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_user_roles_voice_grants_insert ON public.user_roles;
CREATE TRIGGER z_user_roles_voice_grants_insert
    AFTER INSERT ON public.user_roles
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.voice_grants_on_user_roles();
DROP TRIGGER IF EXISTS z_user_roles_voice_grants_update ON public.user_roles;
CREATE TRIGGER z_user_roles_voice_grants_update
    AFTER UPDATE ON public.user_roles
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.voice_grants_on_user_roles();
DROP TRIGGER IF EXISTS z_user_roles_voice_grants_delete ON public.user_roles;
CREATE TRIGGER z_user_roles_voice_grants_delete
    AFTER DELETE ON public.user_roles
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.voice_grants_on_user_roles();

CREATE OR REPLACE FUNCTION public.voice_grants_on_channel_overrides()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channels uuid[] := '{}';
    v_row record;
BEGIN
    IF TG_OP <> 'DELETE' THEN
        SELECT v_channels || array_agg(n.channel_id) INTO v_channels FROM new_rows n;
    END IF;
    IF TG_OP <> 'INSERT' THEN
        SELECT v_channels || array_agg(o.channel_id) INTO v_channels FROM old_rows o;
    END IF;

    FOR v_row IN
        SELECT c.server_id, c.id AS channel_id
          FROM public.channels c
         WHERE c.id IN (SELECT DISTINCT unnest(v_channels)) AND c.type = 1
    LOOP
        PERFORM public.voice_grants_changed(v_row.server_id, v_row.channel_id, NULL);
    END LOOP;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_grants_on_channel_overrides() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_channel_overrides_voice_grants_insert ON public.channel_permission_overrides;
CREATE TRIGGER z_channel_overrides_voice_grants_insert
    AFTER INSERT ON public.channel_permission_overrides
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.voice_grants_on_channel_overrides();
DROP TRIGGER IF EXISTS z_channel_overrides_voice_grants_update ON public.channel_permission_overrides;
CREATE TRIGGER z_channel_overrides_voice_grants_update
    AFTER UPDATE ON public.channel_permission_overrides
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.voice_grants_on_channel_overrides();
DROP TRIGGER IF EXISTS z_channel_overrides_voice_grants_delete ON public.channel_permission_overrides;
CREATE TRIGGER z_channel_overrides_voice_grants_delete
    AFTER DELETE ON public.channel_permission_overrides
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.voice_grants_on_channel_overrides();

CREATE OR REPLACE FUNCTION public.voice_grants_on_owner_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.voice_grants_changed(NEW.id, NULL, NULL);
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_grants_on_owner_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_servers_voice_grants_owner ON public.servers;
CREATE TRIGGER z_servers_voice_grants_owner
    AFTER UPDATE OF owner ON public.servers
    FOR EACH ROW WHEN (OLD.owner IS DISTINCT FROM NEW.owner)
    EXECUTE FUNCTION public.voice_grants_on_owner_change();

COMMIT;
