-- What a client names beyond its own row, and who speaks on a server's broadcast topics.
--
-- messages: a row names one room. messages_insert_member checks the branch of the room it names
-- and requires the other room absent, and no thread in a conversation. a_messages_room_guard
-- holds the same for every role, and a thread message in its thread's channel. It fires on those
-- columns only: a row stored with both before this migration stays editable.
--
-- reactions: channel_id and conversation_id are the message's, for every role. They pick the
-- broadcast topic (broadcast_message_reaction_event) and the gateway channel. A client's row
-- carries no metadata (discord_user and remote_emoji_url set the displayed reactor and image,
-- federated suppresses the job), no bot_id and no federation_status of its choosing.
--
-- drive_context_tree: rooms the caller reads, not every room a row points at.
--
-- current_user_server_ids: accepted rows, and rows of no status, which older paths left. It read
-- the roster, roles and sounds for a banned or pending row. current_user_requested_server_ids:
-- pending rows, which read the server row only.
--
-- server-presence, voice-channels and voice-channel topics: Realtime authorizes a topic at join,
-- not an event, and a broadcast carries no sender, so a member could send voice-moderation,
-- activity or profile events naming anyone. These topics are now written by the database and the
-- service role only, which also holds for clients older than this migration.
-- z_voice_participants_joined announces a row, as z_voice_participants_left does.
-- broadcast_profile_change already announces every profile field. voice_channel_announce speaks
-- for this instance's callers on a copy, who hold no row, with the caller as userId.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- One room per message
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_message_room()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NOT NULL THEN
        RAISE EXCEPTION 'A message is in one channel or one conversation' USING ERRCODE = '42501';
    END IF;
    IF NEW.thread_id IS NOT NULL
       AND (NEW.conversation_id IS NOT NULL
            OR (NEW.channel_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM public.threads t WHERE t.id = NEW.thread_id AND t.channel_id = NEW.channel_id))) THEN
        RAISE EXCEPTION 'A thread message is in the channel of its thread' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_message_room() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_room_guard ON public.messages;
CREATE TRIGGER a_messages_room_guard
    BEFORE INSERT OR UPDATE OF channel_id, conversation_id, thread_id ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.guard_message_room();

DROP POLICY IF EXISTS "messages_insert_member" ON public.messages;
CREATE POLICY "messages_insert_member" ON public.messages
    FOR INSERT
    WITH CHECK (
        user_id = (SELECT public.get_current_profile_id())
        AND (
            (channel_id IS NOT NULL
             AND conversation_id IS NULL
             AND channel_id IN (SELECT public.current_user_viewable_channel_ids())
             AND (thread_id IS NULL OR EXISTS (
                 SELECT 1 FROM public.threads t
                  WHERE t.id = messages.thread_id AND t.channel_id = messages.channel_id
             ))
             AND public.has_permission(
                 (SELECT public.get_current_profile_id()),
                 (SELECT c.server_id FROM public.channels c WHERE c.id = messages.channel_id),
                 CASE WHEN thread_id IS NULL THEN 'SEND_MESSAGES' ELSE 'SEND_MESSAGES_IN_THREADS' END,
                 channel_id))
            OR (conversation_id IS NOT NULL
                AND channel_id IS NULL
                AND thread_id IS NULL
                AND EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = messages.conversation_id
                       AND cp.user_id = (SELECT public.get_current_profile_id())
                       AND cp.left_at IS NULL
                )
                AND NOT EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = messages.conversation_id
                       AND cp.user_id <> (SELECT public.get_current_profile_id())
                       AND cp.left_at IS NULL
                       AND public.is_blocked_by(cp.user_id)
                ))
        )
    );

-- ---------------------------------------------------------------------------
-- A reaction's room is its message's
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.populate_reaction_context()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
    v_conversation uuid;
BEGIN
    SELECT m.channel_id, m.conversation_id
      INTO v_channel, v_conversation
      FROM public.messages m
     WHERE m.id = NEW.message_id;
    NEW.channel_id := v_channel;
    NEW.conversation_id := v_conversation;
    RETURN NEW;
END;
$$;

-- Before b_reactions_emoji_check, which sets metadata of its own for a pill.
CREATE OR REPLACE FUNCTION public.guard_reaction_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    NEW.metadata := '{}'::jsonb;
    NEW.bot_id := NULL;
    NEW.federation_status := 'pending';
    NEW.created_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_reaction_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_reactions_client_write_guard ON public.reactions;
CREATE TRIGGER a_reactions_client_write_guard
    BEFORE INSERT ON public.reactions
    FOR EACH ROW EXECUTE FUNCTION public.guard_reaction_client_write();

-- ---------------------------------------------------------------------------
-- Drive names rooms the caller reads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drive_context_tree()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_paths text[];
    v_result jsonb;
BEGIN
    SELECT coalesce(array_agg(f.path), '{}') INTO v_paths
      FROM public.drive_files f
     WHERE f.owner_id = v_profile AND f.bucket = 'message_media' AND f.state IN ('drive', 'ephemeral');

    WITH named AS (
        SELECT DISTINCT r.path, m.channel_id, m.conversation_id
          FROM public.messages m
         CROSS JOIN LATERAL unnest(public.message_media_refs(m.content, m.media_paths)) r(path)
         WHERE m.is_deleted IS NOT TRUE
           AND public.message_media_refs(m.content, m.media_paths) && v_paths
           AND r.path = ANY (v_paths)
           AND ((m.channel_id IS NOT NULL AND public.can_view_channel(v_profile, m.channel_id))
                OR (m.conversation_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM public.conversation_participants cp
                         WHERE cp.conversation_id = m.conversation_id
                           AND cp.user_id = v_profile
                           AND cp.left_at IS NULL)))
    ),
    channel_counts AS (
        SELECT c.server_id, c.id AS channel_id, c.name AS channel_name, count(DISTINCT n.path) AS files
          FROM named n JOIN public.channels c ON c.id = n.channel_id
         GROUP BY c.server_id, c.id, c.name
    ),
    servers_json AS (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'id', s.id, 'name', s.name, 'icon', s.icon,
                   'files', (SELECT count(DISTINCT n.path) FROM named n JOIN public.channels c2 ON c2.id = n.channel_id
                              WHERE c2.server_id = s.id),
                   'channels', (SELECT jsonb_agg(jsonb_build_object('id', cc.channel_id, 'name', cc.channel_name,
                                                                    'files', cc.files) ORDER BY lower(cc.channel_name))
                                  FROM channel_counts cc WHERE cc.server_id = s.id))
                 ORDER BY lower(s.name)), '[]'::jsonb) AS j
          FROM public.servers s
         WHERE s.id IN (SELECT cc.server_id FROM channel_counts cc)
    ),
    conversations_json AS (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'id', cv.id, 'type', cv.type,
                   'name', coalesce(cv.name, (
                       SELECT string_agg(coalesce(p.display_name, p.username), ', ' ORDER BY p.username)
                         FROM public.conversation_participants cp JOIN public.profiles p ON p.id = cp.user_id
                        WHERE cp.conversation_id = cv.id AND cp.user_id <> v_profile)),
                   'files', (SELECT count(DISTINCT n.path) FROM named n WHERE n.conversation_id = cv.id))
                 ORDER BY cv.updated_at DESC NULLS LAST), '[]'::jsonb) AS j
          FROM public.conversations cv
         WHERE cv.id IN (SELECT n.conversation_id FROM named n WHERE n.conversation_id IS NOT NULL)
    )
    SELECT jsonb_build_object(
        'servers', (SELECT j FROM servers_json),
        'conversations', (SELECT j FROM conversations_json),
        'fediverse', (SELECT count(*) FROM public.drive_files f
                       WHERE f.owner_id = v_profile AND f.bucket = 'user_media'
                         AND f.state IN ('drive', 'ephemeral') AND f.path ~ '(^|/)posts/'),
        'shared', (SELECT count(*) FROM public.drive_files f
                    WHERE f.owner_id <> v_profile AND f.state IN ('drive', 'ephemeral')
                      AND EXISTS (SELECT 1 FROM public.drive_shares s WHERE s.file_id = f.id AND s.scope <> 'link')
                      AND public.drive_file_shared_with(f.id, v_profile)))
      INTO v_result;
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Membership reads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_user_server_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT us.server_id
      FROM public.user_servers us
     WHERE us.user_id = (SELECT public.get_current_profile_id())
       AND COALESCE(us.status, 'accepted') = 'accepted';
$$;

CREATE OR REPLACE FUNCTION public.current_user_requested_server_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT us.server_id
      FROM public.user_servers us
     WHERE us.user_id = (SELECT public.get_current_profile_id())
       AND us.status = 'pending';
$$;

REVOKE ALL ON FUNCTION public.current_user_requested_server_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_requested_server_ids() TO authenticated, service_role;

DROP POLICY IF EXISTS servers_select_member ON public.servers;
CREATE POLICY servers_select_member ON public.servers FOR SELECT TO authenticated
    USING (servers.owner = (SELECT public.get_current_profile_id())
           OR servers.id IN (SELECT public.current_user_server_ids())
           OR servers.id IN (SELECT public.current_user_requested_server_ids())
           OR (SELECT public.is_current_user_admin()));

-- ---------------------------------------------------------------------------
-- Server topics are written by the database
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
             OR p_topic LIKE 'dm-call:%'
             OR p_topic LIKE 'harmony-voice-%'
             OR p_topic LIKE 'easter-egg:%'
             OR p_topic LIKE 'typing:%') THEN
    RETURN false;
  END IF;
  RETURN public.can_subscribe_to_topic(p_topic);
END;
$$;

CREATE OR REPLACE FUNCTION public.voice_participant_joined_announce()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- A failed announcement never blocks the insert.
    BEGIN
        PERFORM realtime.send(
            jsonb_build_object(
                'event', 'user-joined',
                'userId', NEW.user_id,
                'channelId', NEW.channel_id,
                'callStartTime', (SELECT min(v.joined_at) FROM public.voice_channel_participants v
                                   WHERE v.channel_id = NEW.channel_id)
            ),
            'voice-channel-event',
            CASE WHEN public.channel_is_restricted(NEW.channel_id) IS DISTINCT FROM false
                 THEN 'voice-channel:' || NEW.channel_id::text
                 ELSE 'voice-channels:' || NEW.server_id::text END,
            true
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'voice_participant_joined_announce: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_participant_joined_announce() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_voice_participants_joined ON public.voice_channel_participants;
CREATE TRIGGER z_voice_participants_joined
    AFTER INSERT ON public.voice_channel_participants
    FOR EACH ROW EXECUTE FUNCTION public.voice_participant_joined_announce();

-- Occupancy of this instance's callers on a copy, who hold no row. userId is the caller. A copy's
-- roles are display-only, so CONNECT is not read here. The host decides who enters the call.
CREATE OR REPLACE FUNCTION public.voice_channel_announce(
    p_server_id uuid,
    p_channel_id uuid,
    p_event text,
    p_call_start timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_channel uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;
    IF p_event IS NULL OR p_event NOT IN ('user-joined', 'user-left', 'request-state') THEN
        RAISE EXCEPTION 'Unknown voice event: %', p_event USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.servers s
          JOIN public.user_servers us ON us.server_id = s.id
         WHERE s.id = p_server_id
           AND s.is_local_server IS FALSE
           AND us.user_id = v_caller
           AND us.status = 'accepted'
    ) THEN
        RAISE EXCEPTION 'Only an accepted member of a remote server announces here' USING ERRCODE = '42501';
    END IF;

    IF p_event = 'request-state' THEN
        PERFORM realtime.send(jsonb_build_object('event', 'request-state', 'userId', '', 'channelId', ''),
                              'voice-channel-event', 'voice-channels:' || p_server_id::text, true);
        FOR v_channel IN SELECT public.get_restricted_voice_channels(p_server_id) LOOP
            PERFORM realtime.send(jsonb_build_object('event', 'request-state', 'userId', '', 'channelId', ''),
                                  'voice-channel-event', 'voice-channel:' || v_channel::text, true);
        END LOOP;
        RETURN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.channels c WHERE c.id = p_channel_id AND c.server_id = p_server_id)
       OR (p_event = 'user-joined' AND NOT public.can_view_channel(v_caller, p_channel_id)) THEN
        RAISE EXCEPTION 'That channel is not open to the caller' USING ERRCODE = '42501';
    END IF;

    PERFORM realtime.send(
        jsonb_build_object(
            'event', p_event,
            'userId', v_caller,
            'channelId', p_channel_id,
            'callStartTime', CASE WHEN p_event = 'user-joined' AND p_call_start <= now()
                                       AND p_call_start > now() - interval '7 days'
                                  THEN p_call_start END
        ),
        'voice-channel-event',
        CASE WHEN public.channel_is_restricted(p_channel_id) IS DISTINCT FROM false
             THEN 'voice-channel:' || p_channel_id::text
             ELSE 'voice-channels:' || p_server_id::text END,
        true
    );
END;
$$;

REVOKE ALL ON FUNCTION public.voice_channel_announce(uuid, uuid, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.voice_channel_announce(uuid, uuid, text, timestamptz) TO authenticated;

COMMIT;
