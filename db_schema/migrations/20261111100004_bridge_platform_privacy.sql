-- Preserve existing opt-outs on both platforms; bridge_opt_out remains the Discord preference.
BEGIN;
ALTER TABLE public.user_servers ADD COLUMN matrix_bridge_opt_out boolean NOT NULL DEFAULT false;
UPDATE public.user_servers SET matrix_bridge_opt_out = bridge_opt_out;

CREATE FUNCTION public.guard_matrix_bridge_preference()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF current_user IN ('authenticated', 'anon') AND
       ((TG_OP = 'INSERT' AND NEW.matrix_bridge_opt_out) OR
        (TG_OP = 'UPDATE' AND NEW.matrix_bridge_opt_out IS DISTINCT FROM OLD.matrix_bridge_opt_out)) THEN
        RAISE EXCEPTION 'Use the bridge privacy RPC' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER a_matrix_bridge_preference_guard BEFORE INSERT OR UPDATE ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.guard_matrix_bridge_preference();
REVOKE ALL ON FUNCTION public.guard_matrix_bridge_preference() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_server_bridge_privacy(p_server_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_value jsonb;
BEGIN
    SELECT jsonb_build_object('discord', us.bridge_opt_out, 'matrix', us.matrix_bridge_opt_out) INTO v_value
      FROM public.user_servers us WHERE us.server_id = p_server_id
       AND us.user_id = public.get_current_profile_id() AND us.status = 'accepted';
    IF NOT FOUND THEN RAISE EXCEPTION 'Accepted membership required' USING ERRCODE = '42501'; END IF;
    RETURN v_value;
END;
$$;

CREATE FUNCTION public.set_server_bridge_platform_opt_out(p_server_id uuid, p_platform text, p_opt_out boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_platform IS NULL OR p_platform NOT IN ('matrix', 'discord') OR p_opt_out IS NULL THEN
        RAISE EXCEPTION 'Valid platform and boolean required' USING ERRCODE = '22023';
    END IF;
    UPDATE public.user_servers
       SET bridge_opt_out = CASE WHEN p_platform = 'discord' THEN p_opt_out ELSE bridge_opt_out END,
           matrix_bridge_opt_out = CASE WHEN p_platform = 'matrix' THEN p_opt_out ELSE matrix_bridge_opt_out END
     WHERE server_id = p_server_id AND user_id = public.get_current_profile_id() AND status = 'accepted';
    IF NOT FOUND THEN RAISE EXCEPTION 'Accepted membership required' USING ERRCODE = '42501'; END IF;
    RETURN p_opt_out;
END;
$$;

-- Old clients still control both platforms and conservatively show any opt-out as enabled.
CREATE OR REPLACE FUNCTION public.get_server_bridge_opt_out(p_server_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT (v->>'discord')::boolean OR (v->>'matrix')::boolean
      FROM public.get_server_bridge_privacy(p_server_id) v;
$$;
CREATE OR REPLACE FUNCTION public.set_server_bridge_opt_out(p_server_id uuid, p_opt_out boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM public.set_server_bridge_platform_opt_out(p_server_id, 'discord', p_opt_out);
    PERFORM public.set_server_bridge_platform_opt_out(p_server_id, 'matrix', p_opt_out);
    RETURN p_opt_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_bridge_member_messages(p_bot_id uuid, p_channel_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT public.bridge_channel_platform(p_bot_id, p_channel_id) IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.user_servers us JOIN public.channels c ON c.server_id = us.server_id
                    WHERE c.id = p_channel_id AND us.user_id = p_user_id AND us.status = 'accepted'
                      AND NOT CASE public.bridge_channel_platform(p_bot_id, p_channel_id)
                        WHEN 'matrix' THEN us.matrix_bridge_opt_out ELSE us.bridge_opt_out END);
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_channel_members(p_bot_id uuid, p_channel_id uuid)
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
       WHERE c.id = p_channel_id AND us.status = 'accepted'
         AND public.can_bridge_member_messages(p_bot_id, c.id, p.id)
         AND p.is_local IS TRUE AND p.deleted_at IS NULL
         AND public.can_view_channel(p.id, c.id)
       ORDER BY p.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_server_bridge_privacy(uuid), public.set_server_bridge_platform_opt_out(uuid,text,boolean)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_server_bridge_privacy(uuid), public.set_server_bridge_platform_opt_out(uuid,text,boolean)
    TO authenticated;
COMMIT;
