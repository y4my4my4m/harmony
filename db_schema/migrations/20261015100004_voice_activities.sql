-- Voice channel activities: one shared player per voice channel (watch or listen together).
--
-- voice_activities, one row per voice channel while an activity runs:
--   source     file (a Drive file of the starter), url (a direct https media URL),
--              youtube, soundcloud, spotify
--   item       what plays: {title, ...} plus by source
--                file        bucket, path, mime_type
--                url         url, mime_type
--                youtube     video_id
--                soundcloud  url (https://soundcloud.com/...)
--                spotify     uri (spotify:<type>:<id>)
--   queue      items to play next, at most 50
--   playing, position_ms, position_at, rate
--              the position at position_at (database clock); while playing it advances by
--              rate ms per ms. Clients add their clock offset from server_now.
--   controls   everyone | host. With host, only host_id controls while it is in the channel.
--   revision   increments on every change; an auto-advance names the revision it ends.
--
-- Callers must be in the channel (voice_channel_participants) to start, control or stop. A file
-- activity shares the file with the voice channel (drive_shares, scope channel) for as long as
-- the activity plays it. The row goes when the last participant leaves.
--
-- Every change is announced as voice-channel-event {event: activity, channelId, activity}
-- (activity NULL when it ends) on voice-channel:<channel> when channel_is_restricted, else
-- voice-channels:<server>, the topics of voice presence.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.voice_activities (
    channel_id uuid NOT NULL PRIMARY KEY REFERENCES public.channels(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    source text NOT NULL,
    item jsonb NOT NULL,
    queue jsonb DEFAULT '[]'::jsonb NOT NULL,
    playing boolean DEFAULT true NOT NULL,
    position_ms bigint DEFAULT 0 NOT NULL,
    position_at timestamp with time zone DEFAULT now() NOT NULL,
    rate numeric DEFAULT 1 NOT NULL,
    controls text DEFAULT 'everyone' NOT NULL,
    host_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    share_id uuid REFERENCES public.drive_shares(id) ON DELETE SET NULL,
    revision bigint DEFAULT 1 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_activities_source_check CHECK (source IN ('file', 'url', 'youtube', 'soundcloud', 'spotify')),
    CONSTRAINT voice_activities_queue_check CHECK (jsonb_typeof(queue) = 'array' AND jsonb_array_length(queue) <= 50),
    CONSTRAINT voice_activities_position_check CHECK (position_ms >= 0),
    CONSTRAINT voice_activities_rate_check CHECK (rate BETWEEN 0.25 AND 4),
    CONSTRAINT voice_activities_controls_check CHECK (controls IN ('everyone', 'host'))
);

CREATE INDEX IF NOT EXISTS voice_activities_server ON public.voice_activities (server_id);

-- Who views the channel reads its activity; writes go through the voice_activity_ functions.
CREATE OR REPLACE FUNCTION public.voice_activity_viewable(p_channel uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(public.can_view_channel(public.get_current_profile_id(), p_channel), false);
$$;
REVOKE ALL ON FUNCTION public.voice_activity_viewable(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.voice_activity_viewable(uuid) TO authenticated, service_role;

ALTER TABLE public.voice_activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_activities_select_viewer ON public.voice_activities;
CREATE POLICY voice_activities_select_viewer ON public.voice_activities
    FOR SELECT TO authenticated
    USING (public.voice_activity_viewable(channel_id));
REVOKE ALL ON public.voice_activities FROM anon, authenticated;
GRANT SELECT ON public.voice_activities TO authenticated;
GRANT ALL ON public.voice_activities TO service_role;

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------

-- A validated item of p_source, or an exception. Titles are trimmed to 300 characters.
CREATE OR REPLACE FUNCTION public.voice_activity_item(p_source text, p_item jsonb, p_profile uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_title text := left(btrim(coalesce(p_item ->> 'title', '')), 300);
    v_thumb text := p_item ->> 'thumbnail';
    v_duration bigint;
    v_file public.drive_files;
BEGIN
    IF jsonb_typeof(p_item) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'An activity item is an object' USING ERRCODE = '22023';
    END IF;
    IF v_thumb IS NOT NULL AND (v_thumb !~ '^https://' OR length(v_thumb) > 2000) THEN
        v_thumb := NULL;
    END IF;
    IF p_item ->> 'duration_ms' ~ '^\d{1,10}$' THEN
        v_duration := (p_item ->> 'duration_ms')::bigint;
    END IF;

    IF p_source = 'file' THEN
        SELECT * INTO v_file FROM public.drive_files f
         WHERE f.bucket = p_item ->> 'bucket' AND f.path = p_item ->> 'path'
           AND f.owner_id = p_profile AND f.state IN ('drive', 'ephemeral');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Only your own Drive files can be played' USING ERRCODE = '42501';
        END IF;
        IF public.drive_mime_kind(v_file.mime_type) NOT IN ('video', 'audio') THEN
            RAISE EXCEPTION 'Only video and audio files can be played' USING ERRCODE = '22023';
        END IF;
        RETURN jsonb_strip_nulls(jsonb_build_object(
            'bucket', v_file.bucket, 'path', v_file.path, 'mime_type', v_file.mime_type,
            'file_id', v_file.id,
            'title', coalesce(nullif(v_title, ''), v_file.name, 'Video'),
            'duration_ms', v_duration));
    ELSIF p_source = 'url' THEN
        IF NOT (p_item ->> 'url' ~ '^https://[^\s/]+/\S+$') OR length(p_item ->> 'url') > 2000 THEN
            RAISE EXCEPTION 'A media URL is an https URL' USING ERRCODE = '22023';
        END IF;
        RETURN jsonb_strip_nulls(jsonb_build_object(
            'url', p_item ->> 'url', 'mime_type', left(p_item ->> 'mime_type', 100),
            'title', coalesce(nullif(v_title, ''), p_item ->> 'url'), 'thumbnail', v_thumb,
            'duration_ms', v_duration));
    ELSIF p_source = 'youtube' THEN
        IF coalesce(p_item ->> 'video_id', '') !~ '^[A-Za-z0-9_-]{6,20}$' THEN
            RAISE EXCEPTION 'Not a YouTube video id' USING ERRCODE = '22023';
        END IF;
        RETURN jsonb_strip_nulls(jsonb_build_object(
            'video_id', p_item ->> 'video_id', 'title', nullif(v_title, ''), 'thumbnail', v_thumb,
            'duration_ms', v_duration));
    ELSIF p_source = 'soundcloud' THEN
        IF coalesce(p_item ->> 'url', '') !~ '^https://(www\.|m\.)?soundcloud\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_/-]+$'
           OR length(p_item ->> 'url') > 500 THEN
            RAISE EXCEPTION 'Not a SoundCloud track or playlist URL' USING ERRCODE = '22023';
        END IF;
        RETURN jsonb_strip_nulls(jsonb_build_object(
            'url', p_item ->> 'url', 'title', nullif(v_title, ''), 'thumbnail', v_thumb,
            'duration_ms', v_duration));
    ELSIF p_source = 'spotify' THEN
        IF coalesce(p_item ->> 'uri', '') !~ '^spotify:(track|album|playlist|episode|show):[A-Za-z0-9]{10,40}$' THEN
            RAISE EXCEPTION 'Not a Spotify URI' USING ERRCODE = '22023';
        END IF;
        RETURN jsonb_strip_nulls(jsonb_build_object(
            'uri', p_item ->> 'uri', 'title', nullif(v_title, ''), 'thumbnail', v_thumb,
            'duration_ms', v_duration));
    END IF;
    RAISE EXCEPTION 'Unknown activity source %', p_source USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.voice_activity_json(a public.voice_activities)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN a.channel_id IS NULL THEN NULL ELSE jsonb_build_object(
        'channel_id', a.channel_id, 'server_id', a.server_id, 'source', a.source, 'item', a.item,
        'queue', a.queue, 'playing', a.playing, 'position_ms', a.position_ms,
        'position_at', (extract(epoch FROM a.position_at) * 1000)::bigint,
        'rate', a.rate, 'controls', a.controls, 'host_id', a.host_id, 'revision', a.revision,
        'started_at', a.started_at) END;
$$;

-- The caller's profile when it is in the voice channel, else an exception.
CREATE OR REPLACE FUNCTION public.voice_activity_participant(p_channel uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
BEGIN
    IF v_profile IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.voice_channel_participants vp
         WHERE vp.channel_id = p_channel AND vp.user_id = v_profile) THEN
        RAISE EXCEPTION 'Join the voice channel first' USING ERRCODE = '42501';
    END IF;
    RETURN v_profile;
END;
$$;

-- Ends a file activity's share of the file it played.
CREATE OR REPLACE FUNCTION public.voice_activity_drop_share(p_share uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    DELETE FROM public.drive_shares WHERE id = p_share;
$$;

-- Shares a file item with the voice channel; the share id, or NULL for other sources.
CREATE OR REPLACE FUNCTION public.voice_activity_share(p_source text, p_item jsonb, p_channel uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_share uuid;
BEGIN
    IF p_source <> 'file' THEN
        RETURN NULL;
    END IF;
    SELECT s.id INTO v_share FROM public.drive_shares s
     WHERE s.file_id = (p_item ->> 'file_id')::uuid AND s.scope = 'channel' AND s.target_id = p_channel;
    IF FOUND THEN
        -- Shared already by its owner: the activity does not own that share.
        RETURN NULL;
    END IF;
    INSERT INTO public.drive_shares (file_id, scope, target_id)
    VALUES ((p_item ->> 'file_id')::uuid, 'channel', p_channel)
    RETURNING id INTO v_share;
    RETURN v_share;
END;
$$;

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_now()
RETURNS bigint
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
$$;

CREATE OR REPLACE FUNCTION public.get_voice_activity(p_channel uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
    v_row public.voice_activities;
BEGIN
    IF v_profile IS NULL OR NOT public.can_view_channel(v_profile, p_channel) THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;
    SELECT * INTO v_row FROM public.voice_activities a WHERE a.channel_id = p_channel;
    RETURN jsonb_build_object('activity', CASE WHEN FOUND THEN public.voice_activity_json(v_row) END,
                              'server_now', public.server_now());
END;
$$;

-- Activities of the voice channels of a server the caller views.
CREATE OR REPLACE FUNCTION public.get_server_voice_activities(p_server uuid)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.voice_activity_json(a)
      FROM public.voice_activities a
     WHERE a.server_id = p_server
       AND public.can_view_channel(public.get_current_profile_id(), a.channel_id);
$$;

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
        IF v_old.controls = 'host' AND v_old.host_id IS DISTINCT FROM v_profile
           AND EXISTS (SELECT 1 FROM public.voice_channel_participants vp
                        WHERE vp.channel_id = p_channel AND vp.user_id = v_old.host_id) THEN
            RAISE EXCEPTION 'Only the host controls this activity' USING ERRCODE = '42501';
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

-- p_action: play {position_ms?}, pause {position_ms?}, seek {position_ms}, rate {rate},
-- next {revision?} (with revision: only if it still is the current one, so several clients
-- reporting the same end advance once), jump {index}, enqueue {source, item},
-- dequeue {index}, controls {mode} (host only).
CREATE OR REPLACE FUNCTION public.voice_activity_control(p_channel uuid, p_action text, p_value jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.voice_activity_participant(p_channel);
    v_row public.voice_activities;
    v_now timestamptz := clock_timestamp();
    v_position bigint;
    v_next jsonb;
    v_index integer;
    v_value jsonb := coalesce(p_value, '{}'::jsonb);
BEGIN
    SELECT * INTO v_row FROM public.voice_activities a WHERE a.channel_id = p_channel FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No activity in this channel' USING ERRCODE = 'P0002';
    END IF;

    IF (v_row.controls = 'host' OR p_action = 'controls')
       AND v_row.host_id IS DISTINCT FROM v_profile
       AND EXISTS (SELECT 1 FROM public.voice_channel_participants vp
                    WHERE vp.channel_id = p_channel AND vp.user_id = v_row.host_id) THEN
        RAISE EXCEPTION 'Only the host controls this activity' USING ERRCODE = '42501';
    END IF;

    -- Position now, from the stored one.
    v_position := v_row.position_ms + CASE WHEN v_row.playing
        THEN (extract(epoch FROM (v_now - v_row.position_at)) * 1000 * v_row.rate)::bigint ELSE 0 END;
    IF v_value ->> 'position_ms' ~ '^\d{1,12}$' THEN
        v_position := (v_value ->> 'position_ms')::bigint;
    END IF;

    IF p_action = 'play' THEN
        v_row.playing := true;
        v_row.position_ms := v_position;
        v_row.position_at := v_now;
    ELSIF p_action = 'pause' THEN
        v_row.playing := false;
        v_row.position_ms := v_position;
        v_row.position_at := v_now;
    ELSIF p_action = 'seek' THEN
        IF NOT (v_value ->> 'position_ms' ~ '^\d{1,12}$') THEN
            RAISE EXCEPTION 'seek needs position_ms' USING ERRCODE = '22023';
        END IF;
        v_row.position_ms := v_position;
        v_row.position_at := v_now;
    ELSIF p_action = 'rate' THEN
        IF NOT (v_value ->> 'rate' ~ '^\d+(\.\d+)?$') OR (v_value ->> 'rate')::numeric NOT BETWEEN 0.25 AND 4 THEN
            RAISE EXCEPTION 'rate is between 0.25 and 4' USING ERRCODE = '22023';
        END IF;
        v_row.position_ms := v_position;
        v_row.position_at := v_now;
        v_row.rate := (v_value ->> 'rate')::numeric;
    ELSIF p_action IN ('next', 'jump') THEN
        IF p_action = 'next' AND v_value ->> 'revision' ~ '^\d+$'
           AND (v_value ->> 'revision')::bigint <> v_row.revision THEN
            RETURN jsonb_build_object('activity', public.voice_activity_json(v_row), 'server_now', public.server_now());
        END IF;
        v_index := CASE WHEN p_action = 'jump' AND v_value ->> 'index' ~ '^\d{1,2}$'
                        THEN (v_value ->> 'index')::int ELSE 0 END;
        v_next := v_row.queue -> v_index;
        IF v_next IS NULL THEN
            -- Nothing queued: the activity ends.
            IF v_row.share_id IS NOT NULL THEN
                PERFORM public.voice_activity_drop_share(v_row.share_id);
            END IF;
            DELETE FROM public.voice_activities a WHERE a.channel_id = p_channel;
            RETURN jsonb_build_object('activity', NULL, 'server_now', public.server_now());
        END IF;
        IF v_row.share_id IS NOT NULL THEN
            PERFORM public.voice_activity_drop_share(v_row.share_id);
        END IF;
        v_row.source := v_next ->> 'source';
        v_row.item := v_next -> 'item';
        v_row.queue := (SELECT coalesce(jsonb_agg(e ORDER BY o), '[]'::jsonb)
                          FROM jsonb_array_elements(v_row.queue) WITH ORDINALITY q(e, o)
                         WHERE o - 1 <> v_index);
        v_row.share_id := public.voice_activity_share(v_row.source, v_row.item, p_channel);
        v_row.playing := true;
        v_row.position_ms := 0;
        v_row.position_at := v_now;
    ELSIF p_action = 'enqueue' THEN
        IF jsonb_array_length(v_row.queue) >= 50 THEN
            RAISE EXCEPTION 'The queue holds 50 items' USING ERRCODE = '54000';
        END IF;
        v_row.queue := v_row.queue || jsonb_build_array(jsonb_build_object(
            'source', v_value ->> 'source',
            'item', public.voice_activity_item(v_value ->> 'source', v_value -> 'item', v_profile),
            'added_by', v_profile));
    ELSIF p_action = 'dequeue' THEN
        IF NOT (v_value ->> 'index' ~ '^\d{1,2}$') THEN
            RAISE EXCEPTION 'dequeue needs an index' USING ERRCODE = '22023';
        END IF;
        v_row.queue := (SELECT coalesce(jsonb_agg(e ORDER BY o), '[]'::jsonb)
                          FROM jsonb_array_elements(v_row.queue) WITH ORDINALITY q(e, o)
                         WHERE o - 1 <> (v_value ->> 'index')::int);
    ELSIF p_action = 'controls' THEN
        IF coalesce(v_value ->> 'mode', '') NOT IN ('everyone', 'host') THEN
            RAISE EXCEPTION 'controls is everyone or host' USING ERRCODE = '22023';
        END IF;
        v_row.controls := v_value ->> 'mode';
        v_row.host_id := v_profile;
    ELSE
        RAISE EXCEPTION 'Unknown action %', p_action USING ERRCODE = '22023';
    END IF;

    UPDATE public.voice_activities a
       SET source = v_row.source, item = v_row.item, queue = v_row.queue, playing = v_row.playing,
           position_ms = v_row.position_ms, position_at = v_row.position_at, rate = v_row.rate,
           controls = v_row.controls, host_id = v_row.host_id, share_id = v_row.share_id,
           revision = a.revision + 1, updated_at = v_now
     WHERE a.channel_id = p_channel
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
    IF v_row.controls = 'host' AND v_row.host_id IS DISTINCT FROM v_profile
       AND EXISTS (SELECT 1 FROM public.voice_channel_participants vp
                    WHERE vp.channel_id = p_channel AND vp.user_id = v_row.host_id) THEN
        RAISE EXCEPTION 'Only the host controls this activity' USING ERRCODE = '42501';
    END IF;
    IF v_row.share_id IS NOT NULL THEN
        PERFORM public.voice_activity_drop_share(v_row.share_id);
    END IF;
    DELETE FROM public.voice_activities a WHERE a.channel_id = p_channel;
    RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Broadcast and end of call
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.broadcast_voice_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid := coalesce(NEW.channel_id, OLD.channel_id);
    v_server uuid := coalesce(NEW.server_id, OLD.server_id);
BEGIN
    PERFORM realtime.send(
        jsonb_build_object(
            'event', 'activity',
            'channelId', v_channel,
            'activity', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE public.voice_activity_json(NEW) END,
            'serverNow', public.server_now()),
        'voice-channel-event',
        CASE WHEN public.channel_is_restricted(v_channel) IS DISTINCT FROM false
             THEN 'voice-channel:' || v_channel::text
             ELSE 'voice-channels:' || v_server::text END,
        true);
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS broadcast_voice_activity ON public.voice_activities;
CREATE TRIGGER broadcast_voice_activity
    AFTER INSERT OR UPDATE OR DELETE ON public.voice_activities
    FOR EACH ROW EXECUTE FUNCTION public.broadcast_voice_activity();

CREATE OR REPLACE FUNCTION public.end_voice_activity_when_empty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_share uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.voice_channel_participants vp WHERE vp.channel_id = OLD.channel_id) THEN
        DELETE FROM public.voice_activities a WHERE a.channel_id = OLD.channel_id
        RETURNING a.share_id INTO v_share;
        IF v_share IS NOT NULL THEN
            PERFORM public.voice_activity_drop_share(v_share);
        END IF;
    END IF;
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_end_voice_activity_when_empty ON public.voice_channel_participants;
CREATE TRIGGER z_end_voice_activity_when_empty
    AFTER DELETE ON public.voice_channel_participants
    FOR EACH ROW EXECUTE FUNCTION public.end_voice_activity_when_empty();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.get_voice_activity(uuid)'::regprocedure,
        'public.get_server_voice_activities(uuid)'::regprocedure,
        'public.voice_activity_start(uuid, text, jsonb)'::regprocedure,
        'public.voice_activity_control(uuid, text, jsonb)'::regprocedure,
        'public.voice_activity_stop(uuid)'::regprocedure,
        'public.server_now()'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.voice_activity_item(text, jsonb, uuid)'::regprocedure,
        'public.voice_activity_json(public.voice_activities)'::regprocedure,
        'public.voice_activity_participant(uuid)'::regprocedure,
        'public.voice_activity_drop_share(uuid)'::regprocedure,
        'public.voice_activity_share(text, jsonb, uuid)'::regprocedure,
        'public.broadcast_voice_activity()'::regprocedure,
        'public.end_voice_activity_when_empty()'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
