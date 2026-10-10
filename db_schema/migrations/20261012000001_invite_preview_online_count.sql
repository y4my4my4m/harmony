-- Online count on the server card of a valid invite.
--
-- get_invite_preview(code) gains online_count: accepted members whose published presence
-- (user_presence.published_status, 20261006800001) is not offline. Invisible members publish
-- 0 and count as offline; remote members have no local presence row and do too. Only a count
-- leaves the function, never who is online. Invalid invites still answer status alone.
--
-- Converges by state: CREATE OR REPLACE of the 20261005650001 body with the count added;
-- grants restated as that migration left them (anon and authenticated call it).

BEGIN;

-- status: valid, not_found, exhausted, revoked, expired. Server fields only when valid.
CREATE OR REPLACE FUNCTION public.get_invite_preview(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_row record;
    v_count bigint;
    v_online bigint;
BEGIN
    SELECT i.code, i.server_id, i.used, i.expires_at, i.max_uses, COALESCE(i.uses, 0) AS uses,
           s.name, s.description, s.icon, s.banner, s.rules, s.is_local_server
      INTO v_row
      FROM public.invites i
      JOIN public.servers s ON s.id = i.server_id
     WHERE i.code = p_code;

    IF NOT FOUND OR v_row.is_local_server IS NOT TRUE THEN
        RETURN jsonb_build_object('status', 'not_found');
    END IF;
    IF COALESCE(v_row.max_uses, 0) > 0 AND v_row.uses >= v_row.max_uses THEN
        RETURN jsonb_build_object('status', 'exhausted');
    END IF;
    IF v_row.used IS TRUE THEN
        RETURN jsonb_build_object('status', 'revoked');
    END IF;
    IF v_row.expires_at IS NOT NULL AND v_row.expires_at <= now() THEN
        RETURN jsonb_build_object('status', 'expired');
    END IF;

    SELECT count(*), count(*) FILTER (WHERE up.published_status <> 0)
      INTO v_count, v_online
      FROM public.user_servers us
      LEFT JOIN public.user_presence up ON up.profile_id = us.user_id
     WHERE us.server_id = v_row.server_id AND us.status = 'accepted';

    RETURN jsonb_build_object(
        'status', 'valid',
        'code', v_row.code,
        'server_id', v_row.server_id,
        'name', v_row.name,
        'description', v_row.description,
        'icon', v_row.icon,
        'banner', v_row.banner,
        'rules', COALESCE(v_row.rules, '[]'::jsonb),
        'member_count', v_count,
        'online_count', v_online,
        'expires_at', v_row.expires_at,
        'is_member', v_me IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.user_servers us
             WHERE us.server_id = v_row.server_id AND us.user_id = v_me AND us.status = 'accepted'));
END;
$$;

DO $$
DECLARE
    grantee text;
BEGIN
    REVOKE ALL ON FUNCTION public.get_invite_preview(text) FROM PUBLIC, anon, authenticated;
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.get_invite_preview(text) TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_invite_preview(text) TO anon, authenticated;

COMMIT;
