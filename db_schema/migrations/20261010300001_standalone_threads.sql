-- Standalone threads.
--
-- create_channel_thread starts a thread in a channel without an existing message. Its parent
-- is the channel's 'started a thread' notice (metadata.type 'thread_created'), posted in the
-- same call: threads.parent_message_id stays NOT NULL, and federation keeps a parent to
-- reference. metadata.standalone marks such a notice; post_thread_created_notice finds it
-- and posts no second one.
--
-- Same checks as create_thread: the caller views the channel and holds CREATE_PUBLIC_THREADS
-- or CREATE_PRIVATE_THREADS there. The name is required, 1-100 characters after trimming.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_channel_thread(
    p_channel_id uuid, p_name text, p_auto_archive_duration integer DEFAULT 1440)
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

    IF NOT (public.has_permission(v_caller, v_server_id, 'CREATE_PUBLIC_THREADS', p_channel_id)
            OR public.has_permission(v_caller, v_server_id, 'CREATE_PRIVATE_THREADS', p_channel_id)) THEN
        RAISE EXCEPTION 'Unauthorized: CREATE_PUBLIC_THREADS or CREATE_PRIVATE_THREADS required'
            USING ERRCODE = '42501';
    END IF;

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

REVOKE ALL ON FUNCTION public.create_channel_thread(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_channel_thread(uuid, text, integer) TO authenticated, service_role;

COMMIT;
