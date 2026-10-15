-- Permissions belong to accepted members and need VIEW_CHANNEL in a channel; threads need
-- CREATE_PUBLIC_THREADS.
--
-- get_user_permissions(user, server, channel), as 20261011300001 with two rules of Discord's
-- computation (https://discord.com/developers/docs/topics/permissions):
--   - A profile without an accepted user_servers row holds no permission in the server, the
--     owner excepted. @everyone's mask no longer reaches strangers, banned members and former
--     members through has_permission: update_server, get_server_audit_log, pin_message,
--     get_server_member_timeouts and the channel, override and emoji policies admitted any
--     profile when @everyone held the bit.
--   - With a channel, a resolved mask without VIEW_CHANNEL is zero. pin_message,
--     unpin_message, set_message_embeds_suppressed and moderate_report check no visibility of
--     their own; a PIN_MESSAGES or MANAGE_MESSAGES holder acted on messages of channels hidden
--     from them.
-- The owner and ADMINISTRATOR holders keep every bit in every channel.
--
-- Threads are visible to every viewer of their channel: Harmony has no private thread.
-- create_thread, create_channel_thread and threads_insert_member need CREATE_PUBLIC_THREADS in
-- the channel; CREATE_PRIVATE_THREADS alone grants nothing.
--
-- Timeouts, as Discord's: a timed-out member of a local server adds no reaction, joining an
-- existing one included, and starts no thread. refuse_timed_out_caller raises
-- MEMBER_TIMED_OUT:<epoch of the end>, the error automod_check_message raises for a message.
-- Voice already refuses them (voice_channel_admits, authorizeVoiceChannel) and removes them
-- when the timeout starts (voice_leave_on_timeout).
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- get_user_permissions
-- ---------------------------------------------------------------------------

-- Layers, as 20261011300001:
--   1) base: @everyone's mask OR every role of the member
--   2) @everyone channel override: clear deny, then set allow
--   3) all other role overrides combined: clear deny, then set allow
--   4) member override: clear deny, then set allow
-- then the channel's mask is zero without VIEW_CHANNEL (bit 1).
CREATE OR REPLACE FUNCTION public.get_user_permissions(
    p_user_id uuid,
    p_server_id uuid,
    p_channel_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_names text[] := public.permission_bit_names();
    v_is_owner boolean;
    v_mask bigint := 0;
    v_role record;
    v_override record;
    v_everyone_role_id uuid;
    v_everyone_allow bigint := 0;
    v_everyone_deny  bigint := 0;
    v_role_allow     bigint := 0;
    v_role_deny      bigint := 0;
    v_user_allow     bigint := 0;
    v_user_deny      bigint := 0;
    v_result jsonb := '{}'::jsonb;
    v_i int;
BEGIN
    SELECT (owner = p_user_id) INTO v_is_owner
      FROM public.servers WHERE id = p_server_id;

    IF v_is_owner THEN
        v_mask := -1;
    ELSIF EXISTS (SELECT 1 FROM public.user_servers us
                   WHERE us.user_id = p_user_id
                     AND us.server_id = p_server_id
                     AND us.status = 'accepted') THEN
        SELECT id, COALESCE(permissions, 0) INTO v_everyone_role_id, v_mask
          FROM public.server_roles
         WHERE server_id = p_server_id AND is_default = true
         LIMIT 1;
        v_mask := COALESCE(v_mask, 0);

        FOR v_role IN
            SELECT sr.permissions
              FROM public.user_roles ur
              JOIN public.server_roles sr ON ur.role_id = sr.id
             WHERE ur.user_id = p_user_id AND ur.server_id = p_server_id
        LOOP
            v_mask := v_mask | COALESCE(v_role.permissions, 0);
        END LOOP;

        IF (v_mask & 1) != 0 THEN
            v_mask := -1;
        ELSIF p_channel_id IS NOT NULL THEN
            FOR v_override IN
                SELECT role_id, user_id,
                       COALESCE(allow_permissions, 0) AS allow_p,
                       COALESCE(deny_permissions, 0)  AS deny_p
                  FROM public.channel_permission_overrides
                 WHERE channel_id = p_channel_id
                   AND (
                        role_id = v_everyone_role_id
                     OR role_id IN (
                            SELECT ur.role_id
                              FROM public.user_roles ur
                             WHERE ur.user_id = p_user_id
                               AND ur.server_id = p_server_id
                        )
                     OR user_id = p_user_id
                   )
            LOOP
                IF v_override.user_id = p_user_id THEN
                    v_user_allow := v_user_allow | v_override.allow_p;
                    v_user_deny  := v_user_deny  | v_override.deny_p;
                ELSIF v_override.role_id = v_everyone_role_id THEN
                    v_everyone_allow := v_everyone_allow | v_override.allow_p;
                    v_everyone_deny  := v_everyone_deny  | v_override.deny_p;
                ELSIF v_override.role_id IS NOT NULL THEN
                    v_role_allow := v_role_allow | v_override.allow_p;
                    v_role_deny  := v_role_deny  | v_override.deny_p;
                END IF;
            END LOOP;

            v_mask := (v_mask & ~v_everyone_deny) | v_everyone_allow;
            v_mask := (v_mask & ~v_role_deny) | v_role_allow;
            v_mask := (v_mask & ~v_user_deny) | v_user_allow;

            IF (v_mask & 2) = 0 THEN
                v_mask := 0;
            END IF;
        END IF;
    END IF;

    FOR v_i IN 1..array_length(v_names, 1) LOOP
        v_result := v_result || jsonb_build_object(
            v_names[v_i],
            (v_mask & (1::bigint << (v_i - 1))) != 0
        );
    END LOOP;

    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Timeouts
-- ---------------------------------------------------------------------------

-- The caller's active timeout in a server raises; otherwise true. server_member_timeouts is
-- service_role only, so invoker triggers and policies reach it through this definer.
CREATE OR REPLACE FUNCTION public.refuse_timed_out_caller(p_server_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_until timestamptz;
BEGIN
    SELECT t.until INTO v_until
      FROM public.server_member_timeouts t
     WHERE t.server_id = p_server_id
       AND t.user_id = public.get_current_profile_id()
       AND t.until > now();
    IF v_until IS NOT NULL THEN
        RAISE EXCEPTION 'MEMBER_TIMED_OUT:%', floor(extract(epoch FROM v_until))::bigint
            USING ERRCODE = 'P0001',
                  HINT = format('You are timed out in this server until %s.', v_until);
    END IF;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_timed_out_caller(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refuse_timed_out_caller(uuid) TO authenticated, service_role;

-- As 20261016100005; a timeout refuses ahead of the permission and the join exemption.
CREATE OR REPLACE FUNCTION public.enforce_reaction_add_permission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
    v_server uuid;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    SELECT m.channel_id, c.server_id INTO v_channel, v_server
      FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      JOIN public.servers s ON s.id = c.server_id
     WHERE m.id = NEW.message_id
       AND s.is_local_server IS NOT FALSE;
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM public.refuse_timed_out_caller(v_server);

    IF public.has_permission(public.get_current_profile_id(), v_server, 'ADD_REACTIONS', v_channel)
       OR EXISTS (SELECT 1 FROM public.reactions r
                   WHERE r.message_id = NEW.message_id
                     AND r.emoji_id IS NOT DISTINCT FROM NEW.emoji_id
                     AND r.custom_emoji_content IS NOT DISTINCT FROM NEW.custom_emoji_content) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Missing permission: ADD_REACTIONS' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_reaction_add_permission() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Threads: CREATE_PUBLIC_THREADS, no timeout
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "threads_insert_member" ON public.threads;
CREATE POLICY "threads_insert_member" ON public.threads
    FOR INSERT
    WITH CHECK (
        created_by = (SELECT public.get_current_profile_id())
        AND channel_id IN (SELECT public.current_user_viewable_channel_ids())
        AND public.has_permission((SELECT public.get_current_profile_id()),
                (SELECT c.server_id FROM public.channels c WHERE c.id = threads.channel_id),
                'CREATE_PUBLIC_THREADS', channel_id)
        AND public.refuse_timed_out_caller((SELECT c.server_id FROM public.channels c WHERE c.id = threads.channel_id))
    );

-- As 20261001200002, with CREATE_PUBLIC_THREADS alone and no timeout.
CREATE OR REPLACE FUNCTION public.create_thread(p_message_id uuid, p_name text, p_auto_archive_duration integer DEFAULT 1440)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_thread_id uuid;
    v_channel_id uuid;
    v_server_id uuid;
    v_caller_profile_id uuid;
BEGIN
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();

    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    SELECT m.channel_id, c.server_id INTO v_channel_id, v_server_id
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
     WHERE m.id = p_message_id;

    -- A message in a channel the caller cannot view reads as absent.
    IF v_channel_id IS NULL OR NOT public.can_view_channel(v_caller_profile_id, v_channel_id) THEN
        RAISE EXCEPTION 'Message not found or not in a channel';
    END IF;

    IF NOT public.has_permission(v_caller_profile_id, v_server_id, 'CREATE_PUBLIC_THREADS', v_channel_id) THEN
        RAISE EXCEPTION 'Unauthorized: CREATE_PUBLIC_THREADS required' USING ERRCODE = '42501';
    END IF;
    PERFORM public.refuse_timed_out_caller(v_server_id);

    -- One thread per message. threads.parent_message_id carries no unique index; the lock
    -- serialises concurrent calls for the same message.
    PERFORM pg_advisory_xact_lock(hashtext('create_thread:' || p_message_id::text));
    IF EXISTS (SELECT 1 FROM threads WHERE parent_message_id = p_message_id) THEN
        RAISE EXCEPTION 'Thread already exists for this message';
    END IF;

    INSERT INTO threads (
        channel_id, parent_message_id, name, created_by, auto_archive_duration
    ) VALUES (
        v_channel_id, p_message_id, p_name, v_caller_profile_id, p_auto_archive_duration
    ) RETURNING id INTO v_thread_id;

    INSERT INTO thread_members (thread_id, user_id)
    VALUES (v_thread_id, v_caller_profile_id);

    -- The parent message's author joins with the creator, when it can view the channel.
    INSERT INTO thread_members (thread_id, user_id)
    SELECT v_thread_id, m.user_id
      FROM messages m
     WHERE m.id = p_message_id
       AND m.user_id IS NOT NULL
       AND m.user_id <> v_caller_profile_id
       AND public.can_view_channel(m.user_id, v_channel_id)
    ON CONFLICT (thread_id, user_id) DO NOTHING;

    UPDATE threads
       SET member_count = (SELECT count(*) FROM thread_members WHERE thread_id = v_thread_id)
     WHERE id = v_thread_id;

    RETURN v_thread_id;
END;
$$;

-- As 20261010300001, with CREATE_PUBLIC_THREADS alone and no timeout.
CREATE OR REPLACE FUNCTION public.create_channel_thread(p_channel_id uuid, p_name text, p_auto_archive_duration integer DEFAULT 1440)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_server_id uuid;
    v_name text := btrim(coalesce(p_name, ''));
    v_thread_id uuid := gen_random_uuid();
    v_notice_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT c.server_id INTO v_server_id
      FROM public.channels c
     WHERE c.id = p_channel_id;

    -- A channel the caller cannot view reads as absent.
    IF v_server_id IS NULL OR NOT public.can_view_channel(v_caller, p_channel_id) THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.has_permission(v_caller, v_server_id, 'CREATE_PUBLIC_THREADS', p_channel_id) THEN
        RAISE EXCEPTION 'Unauthorized: CREATE_PUBLIC_THREADS required' USING ERRCODE = '42501';
    END IF;
    PERFORM public.refuse_timed_out_caller(v_server_id);

    IF char_length(v_name) NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'Thread name must be 1 to 100 characters' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
    VALUES (p_channel_id, v_caller,
            '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
            jsonb_build_object('type', 'thread_created', 'thread_id', v_thread_id,
                               'thread_name', v_name, 'standalone', true))
    RETURNING id INTO v_notice_id;

    INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, auto_archive_duration)
    VALUES (v_thread_id, p_channel_id, v_notice_id, v_name, v_caller,
            coalesce(p_auto_archive_duration, 1440));

    INSERT INTO public.thread_members (thread_id, user_id)
    VALUES (v_thread_id, v_caller);

    UPDATE public.threads SET member_count = 1 WHERE id = v_thread_id;

    RETURN v_thread_id;
END;
$$;

COMMIT;
