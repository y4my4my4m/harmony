-- "Username has left the server" system message.
--
-- Joining a server posts a system message (handle_member_join_system_message),
-- but leaving only logged a server_membership_events audit row and never posted
-- a chat message - so "has left the server" never appeared. This adds the
-- symmetric leave trigger and suppresses it for kick/ban removals (which post
-- their own "was kicked"/"was banned" message) via a transaction-local flag.
BEGIN;

CREATE OR REPLACE FUNCTION public.handle_member_leave_system_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_channel_id uuid;
    v_is_local boolean;
BEGIN
    -- A kick/ban already inserts "was kicked/banned" - don't also post "has left".
    IF current_setting('harmony.skip_leave_message', true) = '1' THEN
        RETURN OLD;
    END IF;

    -- Only emit for local servers, and skip cascade deletes (server gone).
    SELECT is_local_server INTO v_is_local
    FROM servers
    WHERE id = OLD.server_id;

    IF NOT FOUND OR v_is_local IS NOT TRUE THEN
        RETURN OLD;
    END IF;

    SELECT system_channel_id INTO v_channel_id
    FROM server_settings
    WHERE server_id = OLD.server_id;

    IF v_channel_id IS NULL THEN
        v_channel_id := get_default_channel(OLD.server_id);
    END IF;

    IF v_channel_id IS NULL THEN
        RETURN OLD;
    END IF;

    INSERT INTO messages (channel_id, user_id, content, is_system, metadata)
    VALUES (
        v_channel_id,
        OLD.user_id,
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'has left the server')),
        true,
        jsonb_build_object('type', 'member_leave')
    );

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trigger_member_leave_system_message ON public.user_servers;
CREATE TRIGGER trigger_member_leave_system_message
    AFTER DELETE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_member_leave_system_message();

-- Mark kick/ban removals so the leave trigger stays quiet for them.
CREATE OR REPLACE FUNCTION public.kick_server_member(
    p_server_id uuid,
    p_user_id uuid,
    p_reason text DEFAULT NULL,
    p_delete_message_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_caller_id uuid;
    v_is_owner boolean;
    v_has_permission boolean;
    v_caller_position integer;
    v_target_position integer;
    v_target_is_owner boolean;
    v_deleted_count integer := 0;
    v_system_channel_id uuid;
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF v_caller_id = p_user_id THEN
        RAISE EXCEPTION 'Cannot kick yourself';
    END IF;

    SELECT (owner = p_user_id) INTO v_target_is_owner
    FROM public.servers WHERE id = p_server_id;
    IF v_target_is_owner THEN
        RAISE EXCEPTION 'Cannot kick the server owner';
    END IF;

    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;

    IF NOT v_is_owner THEN
        SELECT COALESCE((public.get_user_permissions(v_caller_id, p_server_id)->>'KICK_MEMBERS')::boolean, false)
        INTO v_has_permission;
        IF NOT v_has_permission THEN
            RAISE EXCEPTION 'Missing KICK_MEMBERS permission';
        END IF;
    END IF;

    IF NOT v_is_owner THEN
        v_caller_position := public.get_user_highest_role_position(v_caller_id, p_server_id);
        v_target_position := public.get_user_highest_role_position(p_user_id, p_server_id);
        IF v_caller_position <= v_target_position THEN
            RAISE EXCEPTION 'Cannot kick a member with an equal or higher role';
        END IF;
    END IF;

    IF p_delete_message_seconds > 0 THEN
        UPDATE public.messages
        SET is_deleted = true, content = '[{"type":"text","content":"[message deleted]"}]'::jsonb
        WHERE user_id = p_user_id
          AND channel_id IN (SELECT id FROM public.channels WHERE server_id = p_server_id)
          AND created_at > now() - (p_delete_message_seconds || ' seconds')::interval
          AND is_deleted = false;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    -- Suppress the "has left the server" trigger - we post "was kicked" below.
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    DELETE FROM public.user_servers
    WHERE user_id = p_user_id AND server_id = p_server_id;

    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_user_id, 'kick', jsonb_build_object(
        'kicked_by', v_caller_id,
        'reason', COALESCE(p_reason, ''),
        'messages_deleted', v_deleted_count
    ));

    SELECT system_channel_id INTO v_system_channel_id
    FROM public.server_settings WHERE server_id = p_server_id;
    IF v_system_channel_id IS NULL THEN
        v_system_channel_id := public.get_default_channel(p_server_id);
    END IF;
    IF v_system_channel_id IS NOT NULL THEN
        INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
        VALUES (
            v_system_channel_id,
            p_user_id,
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'was kicked from the server')),
            true,
            jsonb_build_object('type', 'member_kick', 'kicked_by', v_caller_id, 'reason', COALESCE(p_reason, ''))
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'messages_deleted', v_deleted_count
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.ban_server_member(
    p_server_id uuid,
    p_user_id uuid,
    p_reason text DEFAULT NULL,
    p_delete_message_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_caller_id uuid;
    v_is_owner boolean;
    v_has_permission boolean;
    v_caller_position integer;
    v_target_position integer;
    v_target_is_owner boolean;
    v_deleted_count integer := 0;
    v_already_banned boolean;
    v_system_channel_id uuid;
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF v_caller_id = p_user_id THEN
        RAISE EXCEPTION 'Cannot ban yourself';
    END IF;

    SELECT (owner = p_user_id) INTO v_target_is_owner
    FROM public.servers WHERE id = p_server_id;
    IF v_target_is_owner THEN
        RAISE EXCEPTION 'Cannot ban the server owner';
    END IF;

    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;

    IF NOT v_is_owner THEN
        SELECT COALESCE((public.get_user_permissions(v_caller_id, p_server_id)->>'BAN_MEMBERS')::boolean, false)
        INTO v_has_permission;
        IF NOT v_has_permission THEN
            RAISE EXCEPTION 'Missing BAN_MEMBERS permission';
        END IF;
    END IF;

    IF NOT v_is_owner THEN
        v_caller_position := public.get_user_highest_role_position(v_caller_id, p_server_id);
        v_target_position := public.get_user_highest_role_position(p_user_id, p_server_id);
        IF v_caller_position <= v_target_position THEN
            RAISE EXCEPTION 'Cannot ban a member with an equal or higher role';
        END IF;
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM public.server_bans
        WHERE server_id = p_server_id AND user_id = p_user_id
    ) INTO v_already_banned;

    IF v_already_banned THEN
        RETURN jsonb_build_object('success', true, 'already_banned', true, 'messages_deleted', 0);
    END IF;

    IF p_delete_message_seconds > 0 THEN
        UPDATE public.messages
        SET is_deleted = true, content = '[{"type":"text","content":"[message deleted]"}]'::jsonb
        WHERE user_id = p_user_id
          AND channel_id IN (SELECT id FROM public.channels WHERE server_id = p_server_id)
          AND created_at > now() - (p_delete_message_seconds || ' seconds')::interval
          AND is_deleted = false;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    INSERT INTO public.server_bans (server_id, user_id, banned_by, reason, delete_message_seconds)
    VALUES (p_server_id, p_user_id, v_caller_id, p_reason, p_delete_message_seconds);

    -- Suppress the "has left the server" trigger - we post "was banned" below.
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    DELETE FROM public.user_servers
    WHERE user_id = p_user_id AND server_id = p_server_id;

    DELETE FROM public.user_roles
    WHERE user_id = p_user_id AND server_id = p_server_id;

    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_user_id, 'ban', jsonb_build_object(
        'banned_by', v_caller_id,
        'reason', COALESCE(p_reason, ''),
        'messages_deleted', v_deleted_count
    ));

    SELECT system_channel_id INTO v_system_channel_id
    FROM public.server_settings WHERE server_id = p_server_id;
    IF v_system_channel_id IS NULL THEN
        v_system_channel_id := public.get_default_channel(p_server_id);
    END IF;
    IF v_system_channel_id IS NOT NULL THEN
        INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
        VALUES (
            v_system_channel_id,
            p_user_id,
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'was banned from the server')),
            true,
            jsonb_build_object('type', 'member_ban', 'banned_by', v_caller_id, 'reason', COALESCE(p_reason, ''))
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'messages_deleted', v_deleted_count
    );
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
