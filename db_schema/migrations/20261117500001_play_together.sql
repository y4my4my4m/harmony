-- Play together: sandboxed activity apps in conversations and channels.
--
-- activity_apps, the apps this instance offers. Built-in apps ship with the web build under
-- /activities/<id>/ and are seeded here, enabled; an instance admin turns each on or off with
-- set_activity_app_enabled (logged as activity_app_toggle). Disabling an app ends its sessions.
--   contexts   where it may run: direct, group (conversations), channel (text), voice
--   min/max    players the app is built for; the relay admits at most max_players at once
--
-- activity_sessions, one row per session; at most one active session per conversation or channel.
--   context    direct | group | channel | voice, fixed at start
--   members    accounts connected to the relay now; played_by every account that ever joined
--   message_id the system row announcing it: metadata.type activity_started while active,
--              activity_ended (duration_seconds, players) once it ends
--   last_active_at
--              written by the relay on every member change and once a minute while anyone is
--              connected; an active session untouched for ACTIVITY_STALE (3 minutes) counts as
--              ended and is finished by the next start, read or reap in its context
--
-- Accounts reach sessions through RPCs only:
--   start_activity_session(app, conversation | channel)  the caller starts, or gets the session
--       already running there ({session, existing: true}); errors below
--   get_activity_sessions(conversation | channel)        active sessions the caller can see; a
--       viewer of a voice channel outside its call, and either side of a blocked DM, see who plays,
--       as they see who is in the call or the conversation
--   get_activity_session(session)                        one session, ended included
-- The relay (federation-backend, service_role):
--   activity_session_admit(session, profile)    {refusal} or {session, member, can_end}
--   activity_session_sync(session, members, host)   false once the session is no longer active
--   activity_session_finish(session, reason)    idempotent; rewrites the system row
--   reap_activity_sessions()                    finishes every stale active session
--
-- activity_join_refusal(profile, conversation, channel, starting): NULL or
--   ACTIVITY_CONTEXT       not exactly one of conversation and channel
--   NOT_LOCAL_ACCOUNT      the profile is not an account of this instance
--   NOT_FOUND              not an active participant of the conversation, or cannot view the channel
--   DM_BLOCKED             a direct conversation whose two accounts are blocked between them
--   SERVER_NOT_LOCAL       the channel's server is a copy of another instance's
--   CHANNEL_TYPE           a channel other than text (0) or voice (1)
--   NOT_IN_CALL            a voice channel the profile is not connected to
--   CANNOT_SEND            starting in a text channel without SEND_MESSAGES
--
-- start_activity_session errors (message prefix, SQLSTATE):
--   ACTIVITY_APP_UNAVAILABLE (P0002)   unknown or disabled app
--   ACTIVITY_CONTEXT_UNSUPPORTED (22023)  the app does not run in this kind of context
--   ACTIVITY_RATE_LIMITED (54000)      more than 6 sessions started by the caller in 10 minutes
--   a refusal code above (42501)
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Apps
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.activity_apps (
    id text NOT NULL PRIMARY KEY,
    name text NOT NULL,
    min_players smallint NOT NULL DEFAULT 1,
    max_players smallint NOT NULL DEFAULT 16,
    contexts text[] NOT NULL DEFAULT ARRAY['direct', 'group', 'channel', 'voice'],
    enabled boolean NOT NULL DEFAULT false,
    builtin boolean NOT NULL DEFAULT false,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    CONSTRAINT activity_apps_id_format CHECK (id ~ '^[a-z][a-z0-9-]{1,39}$'),
    CONSTRAINT activity_apps_name_length CHECK (char_length(name) BETWEEN 1 AND 60),
    CONSTRAINT activity_apps_players CHECK (min_players >= 1 AND max_players <= 64 AND min_players <= max_players),
    CONSTRAINT activity_apps_contexts CHECK (
        cardinality(contexts) >= 1 AND contexts <@ ARRAY['direct', 'group', 'channel', 'voice'])
);

ALTER TABLE public.activity_apps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS activity_apps_select ON public.activity_apps;
CREATE POLICY activity_apps_select ON public.activity_apps FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.activity_apps FROM anon, authenticated;
GRANT SELECT ON public.activity_apps TO authenticated;
GRANT ALL ON public.activity_apps TO service_role;

-- Built-in rows keep the admin's enabled choice on a rerun.
INSERT INTO public.activity_apps (id, name, min_players, max_players, contexts, enabled, builtin)
VALUES ('drawinphone', 'DrawinPhone', 2, 16, ARRAY['direct', 'group', 'channel', 'voice'], true, true)
ON CONFLICT (id) DO UPDATE
   SET name = EXCLUDED.name,
       min_players = EXCLUDED.min_players,
       max_players = EXCLUDED.max_players,
       contexts = EXCLUDED.contexts,
       builtin = true;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.activity_sessions (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    app_id text NOT NULL REFERENCES public.activity_apps(id) ON DELETE CASCADE,
    context text NOT NULL,
    conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
    channel_id uuid REFERENCES public.channels(id) ON DELETE CASCADE,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    started_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    host_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    message_id uuid,
    status text NOT NULL DEFAULT 'active',
    members uuid[] NOT NULL DEFAULT '{}',
    played_by uuid[] NOT NULL DEFAULT '{}',
    peak_members smallint NOT NULL DEFAULT 0,
    started_at timestamp with time zone NOT NULL DEFAULT now(),
    last_active_at timestamp with time zone NOT NULL DEFAULT now(),
    ended_at timestamp with time zone,
    end_reason text,
    CONSTRAINT activity_sessions_context CHECK (context IN ('direct', 'group', 'channel', 'voice')),
    CONSTRAINT activity_sessions_target CHECK (
        (conversation_id IS NOT NULL AND channel_id IS NULL AND context IN ('direct', 'group'))
        OR (channel_id IS NOT NULL AND conversation_id IS NULL AND server_id IS NOT NULL
            AND context IN ('channel', 'voice'))),
    CONSTRAINT activity_sessions_status CHECK (status IN ('active', 'ended')),
    CONSTRAINT activity_sessions_ended CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
    CONSTRAINT activity_sessions_members_size CHECK (cardinality(members) <= 64 AND cardinality(played_by) <= 256),
    CONSTRAINT activity_sessions_end_reason CHECK (end_reason IS NULL OR char_length(end_reason) <= 40)
);

CREATE UNIQUE INDEX IF NOT EXISTS activity_sessions_active_conversation
    ON public.activity_sessions (conversation_id) WHERE status = 'active' AND conversation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS activity_sessions_active_channel
    ON public.activity_sessions (channel_id) WHERE status = 'active' AND channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_sessions_started_by
    ON public.activity_sessions (started_by, started_at DESC);
CREATE INDEX IF NOT EXISTS activity_sessions_active
    ON public.activity_sessions (last_active_at) WHERE status = 'active';

ALTER TABLE public.activity_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS activity_sessions_service ON public.activity_sessions;
CREATE POLICY activity_sessions_service ON public.activity_sessions
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.activity_sessions FROM anon, authenticated;
GRANT ALL ON public.activity_sessions TO service_role;

-- ---------------------------------------------------------------------------
-- Contexts
-- ---------------------------------------------------------------------------

-- direct | group | channel | voice for exactly one of the two, else NULL.
CREATE OR REPLACE FUNCTION public.activity_context_kind(p_conversation uuid, p_channel uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_conversation IS NOT NULL AND p_channel IS NULL THEN
            (SELECT CASE c.type WHEN 'direct' THEN 'direct' WHEN 'group' THEN 'group' END
               FROM public.conversations c WHERE c.id = p_conversation)
        WHEN p_channel IS NOT NULL AND p_conversation IS NULL THEN
            (SELECT CASE ch.type WHEN 0 THEN 'channel' WHEN 1 THEN 'voice' END
               FROM public.channels ch WHERE ch.id = p_channel)
    END
$$;
REVOKE ALL ON FUNCTION public.activity_context_kind(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activity_context_kind(uuid, uuid) TO service_role;

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
    IF v_kind = 'voice' AND NOT EXISTS (
            SELECT 1 FROM public.voice_channel_participants vp
             WHERE vp.channel_id = p_channel AND vp.user_id = p_profile) THEN
        RETURN 'NOT_IN_CALL';
    END IF;
    IF p_starting AND v_kind = 'channel'
       AND NOT public.has_permission(p_profile, v_server, 'SEND_MESSAGES', p_channel) THEN
        RETURN 'CANNOT_SEND';
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.activity_join_refusal(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activity_join_refusal(uuid, uuid, uuid, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Session rows
-- ---------------------------------------------------------------------------

-- The client shape of a session: members as profiles, stale active sessions reported ended.
CREATE OR REPLACE FUNCTION public.activity_session_json(p_session public.activity_sessions)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', p_session.id,
        'app_id', p_session.app_id,
        'app_name', a.name,
        'max_players', a.max_players,
        'min_players', a.min_players,
        'context', p_session.context,
        'conversation_id', p_session.conversation_id,
        'channel_id', p_session.channel_id,
        'server_id', p_session.server_id,
        'started_by', p_session.started_by,
        'host_id', p_session.host_id,
        'message_id', p_session.message_id,
        'status', CASE WHEN p_session.status = 'active'
                        AND p_session.last_active_at < now() - interval '3 minutes'
                       THEN 'ended' ELSE p_session.status END,
        'started_at', p_session.started_at,
        'ended_at', p_session.ended_at,
        'members', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', p.id, 'username', p.username, 'display_name', p.display_name,
                       'avatar_url', p.avatar_url) ORDER BY m.ord)
              FROM unnest(p_session.members) WITH ORDINALITY AS m(id, ord)
              JOIN public.profiles p ON p.id = m.id), '[]'::jsonb),
        'played_count', cardinality(p_session.played_by))
      FROM public.activity_apps a
     WHERE a.id = p_session.app_id
$$;
REVOKE ALL ON FUNCTION public.activity_session_json(public.activity_sessions) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activity_session_json(public.activity_sessions) TO service_role;

-- Ends the session and rewrites its system row. False when it had already ended.
CREATE OR REPLACE FUNCTION public.activity_session_finish(p_session uuid, p_reason text DEFAULT 'ended')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.activity_sessions;
    v_name text;
    v_ended timestamptz;
BEGIN
    SELECT * INTO v_row FROM public.activity_sessions WHERE id = p_session FOR UPDATE;
    IF NOT FOUND OR v_row.status <> 'active' THEN
        RETURN false;
    END IF;
    -- A stale session ended when it was last seen.
    v_ended := CASE WHEN v_row.last_active_at < now() - interval '3 minutes'
                    THEN v_row.last_active_at ELSE now() END;

    UPDATE public.activity_sessions
       SET status = 'ended', ended_at = v_ended, members = '{}',
           end_reason = left(coalesce(nullif(btrim(p_reason), ''), 'ended'), 40)
     WHERE id = p_session;

    IF v_row.message_id IS NOT NULL THEN
        SELECT a.name INTO v_name FROM public.activity_apps a WHERE a.id = v_row.app_id;
        UPDATE public.messages m
           SET content = jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'played ' || coalesce(v_name, 'an activity'))),
               metadata = m.metadata || jsonb_build_object(
                   'type', 'activity_ended',
                   'ended_at', v_ended,
                   'duration_seconds', greatest(0, extract(epoch FROM v_ended - v_row.started_at))::int,
                   'players', to_jsonb(v_row.played_by[1:16]),
                   'player_count', cardinality(v_row.played_by))
         WHERE m.id = v_row.message_id
           AND m.is_system
           AND m.metadata ->> 'type' = 'activity_started';
    END IF;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.activity_session_finish(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activity_session_finish(uuid, text) TO service_role;

-- Finishes every active session the relay has not touched for 3 minutes. Returns how many.
CREATE OR REPLACE FUNCTION public.reap_activity_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id uuid;
    v_count integer := 0;
BEGIN
    FOR v_id IN
        SELECT s.id FROM public.activity_sessions s
         WHERE s.status = 'active' AND s.last_active_at < now() - interval '3 minutes'
         ORDER BY s.last_active_at
         LIMIT 500
    LOOP
        IF public.activity_session_finish(v_id, 'idle') THEN
            v_count := v_count + 1;
        END IF;
    END LOOP;
    RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.reap_activity_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_activity_sessions() TO service_role;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_activity_session(
    p_app text,
    p_conversation uuid DEFAULT NULL,
    p_channel uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_app public.activity_apps;
    v_kind text;
    v_refusal text;
    v_server uuid;
    v_existing public.activity_sessions;
    v_session public.activity_sessions;
    v_message uuid;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
    END IF;

    SELECT * INTO v_app FROM public.activity_apps WHERE id = p_app AND enabled;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ACTIVITY_APP_UNAVAILABLE' USING ERRCODE = 'P0002';
    END IF;

    v_refusal := public.activity_join_refusal(v_me, p_conversation, p_channel, true);
    IF v_refusal IS NOT NULL THEN
        RAISE EXCEPTION '%', v_refusal USING ERRCODE = '42501';
    END IF;
    v_kind := public.activity_context_kind(p_conversation, p_channel);
    IF NOT v_kind = ANY (v_app.contexts) THEN
        RAISE EXCEPTION 'ACTIVITY_CONTEXT_UNSUPPORTED' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('activity:' || coalesce(p_conversation, p_channel)::text, 0));

    SELECT * INTO v_existing FROM public.activity_sessions s
     WHERE s.status = 'active'
       AND (s.conversation_id = p_conversation OR s.channel_id = p_channel);
    IF FOUND AND v_existing.last_active_at < now() - interval '3 minutes' THEN
        PERFORM public.activity_session_finish(v_existing.id, 'idle');
    ELSIF FOUND THEN
        RETURN jsonb_build_object('session', public.activity_session_json(v_existing), 'existing', true);
    END IF;

    -- Serialises one account's starts across contexts, so concurrent calls cannot all pass the count.
    PERFORM pg_advisory_xact_lock(hashtextextended('activity-start:' || v_me::text, 0));
    IF (SELECT count(*) FROM public.activity_sessions s
         WHERE s.started_by = v_me AND s.started_at > now() - interval '10 minutes') >= 6 THEN
        RAISE EXCEPTION 'ACTIVITY_RATE_LIMITED' USING ERRCODE = '54000';
    END IF;

    IF p_channel IS NOT NULL THEN
        SELECT ch.server_id INTO v_server FROM public.channels ch WHERE ch.id = p_channel;
    END IF;

    INSERT INTO public.messages (conversation_id, channel_id, content, is_system, metadata)
    VALUES (p_conversation, p_channel,
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'started ' || v_app.name)),
            true,
            jsonb_build_object('type', 'activity_started', 'actor_id', v_me, 'app_id', v_app.id,
                               'app_name', v_app.name, 'started_at', now()))
    RETURNING id INTO v_message;

    INSERT INTO public.activity_sessions (app_id, context, conversation_id, channel_id, server_id,
                                          started_by, host_id, message_id)
    VALUES (v_app.id, v_kind, p_conversation, p_channel, v_server, v_me, v_me, v_message)
    RETURNING * INTO v_session;

    UPDATE public.messages SET metadata = metadata || jsonb_build_object('session_id', v_session.id)
     WHERE id = v_message;

    RETURN jsonb_build_object('session', public.activity_session_json(v_session), 'existing', false);
END;
$$;
REVOKE ALL ON FUNCTION public.start_activity_session(text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_activity_session(text, uuid, uuid) TO authenticated, service_role;

-- Active sessions of a conversation or channel the caller can see.
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
    IF v_refusal IS NOT NULL AND v_refusal NOT IN ('NOT_IN_CALL', 'DM_BLOCKED') THEN
        RETURN '[]'::jsonb;
    END IF;
    RETURN coalesce((
        SELECT jsonb_agg(public.activity_session_json(s) ORDER BY s.started_at)
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
    IF v_refusal IS NOT NULL AND v_refusal NOT IN ('NOT_IN_CALL', 'DM_BLOCKED') THEN
        RETURN NULL;
    END IF;
    RETURN public.activity_session_json(v_row) || jsonb_build_object('refusal', v_refusal);
END;
$$;
REVOKE ALL ON FUNCTION public.get_activity_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_activity_session(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_activity_app_enabled(p_app text, p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_old boolean;
    v_id uuid;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    IF p_enabled IS NULL THEN
        RAISE EXCEPTION 'p_enabled is required' USING ERRCODE = '22023';
    END IF;
    SELECT enabled INTO v_old FROM public.activity_apps WHERE id = p_app FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ACTIVITY_APP_UNAVAILABLE' USING ERRCODE = 'P0002';
    END IF;
    IF v_old IS DISTINCT FROM p_enabled THEN
        UPDATE public.activity_apps SET enabled = p_enabled, updated_at = now(), updated_by = v_me
         WHERE id = p_app;
        PERFORM public.log_admin_action(v_me, 'activity_app_toggle', 'activity_app', p_app,
            jsonb_build_object('enabled', p_enabled));
        IF NOT p_enabled THEN
            FOR v_id IN SELECT s.id FROM public.activity_sessions s WHERE s.app_id = p_app AND s.status = 'active' LOOP
                PERFORM public.activity_session_finish(v_id, 'disabled');
            END LOOP;
        END IF;
    END IF;
    RETURN p_enabled;
END;
$$;
REVOKE ALL ON FUNCTION public.set_activity_app_enabled(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_activity_app_enabled(text, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Relay
-- ---------------------------------------------------------------------------

-- Whether p_profile may connect to the session now. can_end: the starter, the host, or in a channel
-- a member with MANAGE_MESSAGES there.
CREATE OR REPLACE FUNCTION public.activity_session_admit(p_session uuid, p_profile uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.activity_sessions;
    v_app public.activity_apps;
    v_refusal text;
    v_member jsonb;
BEGIN
    SELECT * INTO v_row FROM public.activity_sessions WHERE id = p_session;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('refusal', 'NOT_FOUND');
    END IF;
    IF v_row.status <> 'active' THEN
        RETURN jsonb_build_object('refusal', 'ENDED');
    END IF;
    IF v_row.last_active_at < now() - interval '3 minutes' THEN
        PERFORM public.activity_session_finish(p_session, 'idle');
        RETURN jsonb_build_object('refusal', 'ENDED');
    END IF;
    SELECT * INTO v_app FROM public.activity_apps WHERE id = v_row.app_id;
    IF NOT v_app.enabled THEN
        RETURN jsonb_build_object('refusal', 'ACTIVITY_APP_UNAVAILABLE');
    END IF;
    v_refusal := public.activity_join_refusal(p_profile, v_row.conversation_id, v_row.channel_id, false);
    IF v_refusal IS NOT NULL THEN
        RETURN jsonb_build_object('refusal', v_refusal);
    END IF;

    SELECT jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name,
                              'avatar_url', p.avatar_url)
      INTO v_member FROM public.profiles p WHERE p.id = p_profile;

    RETURN jsonb_build_object(
        'session', public.activity_session_json(v_row),
        'member', v_member,
        'can_end', p_profile = v_row.started_by
                   OR (v_row.channel_id IS NOT NULL
                       AND public.has_permission(p_profile, v_row.server_id, 'MANAGE_MESSAGES', v_row.channel_id)));
END;
$$;
REVOKE ALL ON FUNCTION public.activity_session_admit(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activity_session_admit(uuid, uuid) TO service_role;

-- Members connected now and the host, as the relay holds them. False once the session is not active.
CREATE OR REPLACE FUNCTION public.activity_session_sync(p_session uuid, p_members uuid[], p_host uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_members uuid[] := coalesce((SELECT array_agg(DISTINCT m) FROM unnest(p_members) m WHERE m IS NOT NULL), '{}');
BEGIN
    UPDATE public.activity_sessions s
       SET members = v_members[1:64],
           host_id = coalesce(p_host, s.host_id),
           played_by = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(s.played_by || v_members[1:64]) x)[1:256],
           peak_members = greatest(s.peak_members, least(cardinality(v_members), 64)),
           last_active_at = now()
     WHERE s.id = p_session AND s.status = 'active';
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.activity_session_sync(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activity_session_sync(uuid, uuid[], uuid) TO service_role;

COMMIT;
