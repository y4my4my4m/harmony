-- Minimal Matrix room/mode control plane. Existing registrations and omitted modes stay relay.
BEGIN;

ALTER TABLE public.bridge_channels
    ADD COLUMN room_id text CHECK (char_length(room_id) BETWEEN 2 AND 255 AND room_id ~ '^![^[:space:]/]+$'),
    ADD COLUMN sender_mode text NOT NULL DEFAULT 'relay' CHECK (sender_mode IN ('ghost', 'relay')),
    ADD COLUMN sender_mode_set_by_manager boolean NOT NULL DEFAULT false;
CREATE INDEX bridge_channels_channel_idx ON public.bridge_channels(channel_id);

-- Reconfiguration must retain room identity and admin mode choices on channels kept paired.
CREATE OR REPLACE FUNCTION public.configure_matrix_bridge(p_bot_id uuid, p_server_id uuid, p_channel_ids uuid[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_install public.bot_server_permissions; v_bot public.bots;
BEGIN
    IF NOT public.can_manage_discord_bridge(p_server_id) THEN
        RAISE EXCEPTION 'MANAGE_SERVER required' USING ERRCODE = '42501';
    END IF;
    IF p_channel_ids IS NULL OR array_position(p_channel_ids, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'Channel IDs must be a nonnull array without null entries' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_bot FROM public.bots WHERE id = p_bot_id FOR UPDATE;
    IF NOT FOUND OR v_bot.is_active IS NOT TRUE THEN RAISE EXCEPTION 'Active bot required' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.discord_bridges WHERE bot_id = p_bot_id)
       OR (v_bot.bot_type = 'bridge' AND v_bot.bridge_platform IS NULL) THEN
        RAISE EXCEPTION 'Discord bridge cannot be converted to Matrix' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_install FROM public.bot_server_permissions
     WHERE bot_id = p_bot_id AND server_id = p_server_id AND is_active FOR UPDATE;
    IF NOT FOUND OR v_install.read_messages IS NOT TRUE OR v_install.send_messages IS NOT TRUE
       OR v_install.allowed_channel_ids IS NULL THEN
        RAISE EXCEPTION 'Active scoped read/send install required' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_channel_ids) input(channel_id)
                WHERE NOT COALESCE(input.channel_id = ANY(v_install.allowed_channel_ids), false)
                   OR NOT EXISTS (SELECT 1 FROM public.channels c WHERE c.id = input.channel_id AND c.server_id = p_server_id AND c.type = 0)) THEN
        RAISE EXCEPTION 'Channels must belong to the server and install allowlist' USING ERRCODE = '22023';
    END IF;
    UPDATE public.bots SET bot_type = 'bridge', bridge_platform = 'matrix' WHERE id = p_bot_id;
    DELETE FROM public.bridge_channels bc USING public.channels c
     WHERE bc.bot_id = p_bot_id AND c.id = bc.channel_id AND c.server_id = p_server_id
       AND NOT (bc.channel_id = ANY(p_channel_ids));
    INSERT INTO public.bridge_channels(bot_id, channel_id, platform)
      SELECT p_bot_id, id, 'matrix' FROM unnest(p_channel_ids) id ON CONFLICT DO NOTHING;
    RETURN true;
END;
$$;

CREATE FUNCTION public.matrix_bridge_bind_room(
    p_bot_id uuid, p_channel_id uuid, p_room_id text, p_initial_sender_mode text DEFAULT 'relay')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_binding public.bridge_channels;
BEGIN
    SELECT * INTO v_binding FROM public.bridge_channels
     WHERE bot_id = p_bot_id AND channel_id = p_channel_id FOR UPDATE;
    IF NOT FOUND OR public.bridge_channel_platform(p_bot_id, p_channel_id) IS DISTINCT FROM 'matrix' THEN
        RAISE EXCEPTION 'Registered active Matrix pair required' USING ERRCODE = '42501';
    END IF;
    -- Room IDs are opaque: room version 12+ does not require a homeserver suffix.
    IF p_room_id IS NULL OR char_length(p_room_id) NOT BETWEEN 2 AND 255 OR p_room_id !~ '^![^[:space:]/]+$'
       OR p_initial_sender_mode IS NULL OR p_initial_sender_mode NOT IN ('ghost', 'relay') THEN
        RAISE EXCEPTION 'Invalid Matrix room ID or sender mode' USING ERRCODE = '22023';
    END IF;
    IF v_binding.room_id IS NOT NULL AND v_binding.room_id <> p_room_id THEN
        RAISE EXCEPTION 'Unpair the channel before assigning another Matrix room' USING ERRCODE = '22023';
    END IF;
    IF v_binding.room_id IS NULL THEN
        UPDATE public.bridge_channels
           SET room_id = p_room_id,
               sender_mode = CASE WHEN sender_mode_set_by_manager THEN sender_mode ELSE p_initial_sender_mode END
         WHERE bot_id = p_bot_id AND channel_id = p_channel_id RETURNING * INTO v_binding;
    END IF;
    RETURN jsonb_build_object('room_id', v_binding.room_id, 'sender_mode', v_binding.sender_mode);
END;
$$;

CREATE FUNCTION public.matrix_bridge_room(p_bot_id uuid, p_channel_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_binding public.bridge_channels;
BEGIN
    IF public.bridge_channel_platform(p_bot_id, p_channel_id) IS DISTINCT FROM 'matrix' THEN
        RAISE EXCEPTION 'Registered active Matrix pair required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_binding FROM public.bridge_channels WHERE bot_id = p_bot_id AND channel_id = p_channel_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Registered active Matrix pair required' USING ERRCODE = '42501'; END IF;
    RETURN jsonb_build_object('room_id', v_binding.room_id, 'sender_mode', v_binding.sender_mode);
END;
$$;

CREATE FUNCTION public.get_server_matrix_bridges(p_server_id uuid)
RETURNS TABLE(bot_id uuid, channel_id uuid, channel_name text, room_id text, sender_mode text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NOT public.can_manage_discord_bridge(p_server_id) THEN
        RAISE EXCEPTION 'MANAGE_SERVER required' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
      SELECT bc.bot_id, bc.channel_id, c.name, bc.room_id, bc.sender_mode
        FROM public.bridge_channels bc JOIN public.channels c ON c.id = bc.channel_id
        JOIN public.bots b ON b.id = bc.bot_id
       WHERE c.server_id = p_server_id AND bc.platform = 'matrix' AND b.bridge_platform = 'matrix'
       ORDER BY c.name, bc.channel_id, bc.bot_id;
END;
$$;

-- Admin choices target one explicit active pair, even before its worker binds a room.
-- The marker distinguishes an explicit relay choice from the legacy relay default.
CREATE FUNCTION public.set_matrix_bridge_sender_mode(p_bot_id uuid, p_channel_id uuid, p_sender_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_server uuid; v_bot uuid; v_result jsonb;
BEGIN
    SELECT server_id INTO v_server FROM public.channels WHERE id = p_channel_id;
    IF NOT FOUND OR NOT public.can_manage_discord_bridge(v_server) THEN
        RAISE EXCEPTION 'MANAGE_SERVER required' USING ERRCODE = '42501';
    END IF;
    IF p_sender_mode IS NULL OR p_sender_mode NOT IN ('ghost', 'relay') THEN
        RAISE EXCEPTION 'Invalid Matrix sender mode' USING ERRCODE = '22023';
    END IF;
    SELECT bc.bot_id INTO v_bot FROM public.bridge_channels bc
     WHERE bc.bot_id = p_bot_id AND bc.channel_id = p_channel_id AND bc.platform = 'matrix'
       AND public.bridge_channel_platform(bc.bot_id, bc.channel_id) = 'matrix'
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No active registered Matrix pair' USING ERRCODE = 'P0002'; END IF;
    UPDATE public.bridge_channels SET sender_mode = p_sender_mode, sender_mode_set_by_manager = true
     WHERE bot_id = v_bot AND channel_id = p_channel_id;
    SELECT jsonb_build_object('bot_id', bc.bot_id, 'channel_id', bc.channel_id,
               'channel_name', c.name, 'room_id', bc.room_id, 'sender_mode', bc.sender_mode)
      INTO v_result FROM public.bridge_channels bc JOIN public.channels c ON c.id = bc.channel_id
      JOIN public.bots b ON b.id = bc.bot_id
     WHERE bc.channel_id = p_channel_id AND bc.bot_id = v_bot;
    RETURN v_result;
END;
$$;

CREATE FUNCTION public.matrix_bridge_channel_members(p_bot_id uuid, p_channel_id uuid)
RETURNS TABLE(id uuid, username text, display_name text, avatar_url text, nickname text, domain text, is_local boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF public.bridge_channel_platform(p_bot_id, p_channel_id) IS DISTINCT FROM 'matrix' THEN
        RAISE EXCEPTION 'Registered active Matrix pair required' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
      SELECT p.id, p.username, COALESCE(NULLIF(us.nickname, ''), p.display_name, p.username), p.avatar_url, us.nickname, p.domain, p.is_local
        FROM public.channels c JOIN public.user_servers us ON us.server_id = c.server_id
        JOIN public.profiles p ON p.id = us.user_id
       WHERE c.id = p_channel_id AND us.status = 'accepted' AND NOT us.bridge_opt_out
         AND p.is_local IS TRUE AND p.deleted_at IS NULL
         AND public.can_view_channel(p.id, c.id)
       ORDER BY p.id;
END;
$$;

DO $$
DECLARE fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.matrix_bridge_bind_room(uuid,uuid,text,text)', 'public.matrix_bridge_room(uuid,uuid)',
        'public.matrix_bridge_channel_members(uuid,uuid)']::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
    FOREACH fn IN ARRAY ARRAY[
        'public.get_server_matrix_bridges(uuid)', 'public.set_matrix_bridge_sender_mode(uuid,uuid,text)']::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;
END;
$$;

COMMIT;
