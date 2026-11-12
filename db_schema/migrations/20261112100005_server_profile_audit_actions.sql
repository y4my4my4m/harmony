-- Server profile audit actions follow the dotted naming of every other server audit action.
--
-- moderate_server_profile wrote member_nickname_changed and member_server_profile_reset, which the
-- client audit renderer (KNOWN_ACTIONS) and the "Members" kind filter (prefix match on `member.`)
-- did not recognise: the rows showed the raw key and never named the target member. They become
-- member.nickname_update and member.profile_reset, and rows already written are renamed.
--
-- Converges by state: CREATE OR REPLACE, COMMENT and an UPDATE that matches nothing once renamed.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.moderate_server_profile(
    p_server_id uuid,
    p_user_id uuid,
    p_nickname text DEFAULT NULL,
    p_set_nickname boolean DEFAULT false,
    p_reset_profile boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_owner uuid;
    v_local boolean;
    v_old public.user_servers%ROWTYPE;
    v_new public.user_servers%ROWTYPE;
    v_name text;
    v_changes jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;

    IF NOT p_set_nickname AND NOT p_reset_profile THEN
        RAISE EXCEPTION 'nothing to change: set p_set_nickname or p_reset_profile' USING ERRCODE = '22023';
    END IF;

    SELECT s.owner, s.is_local_server IS NOT FALSE INTO v_owner, v_local FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no such server' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_local THEN
        RAISE EXCEPTION 'Server profiles are kept by the instance that hosts the server' USING ERRCODE = '42501';
    END IF;

    IF v_me IS DISTINCT FROM v_owner THEN
        IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                        WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted')
           OR NOT public.has_permission(v_me, p_server_id, 'MANAGE_NICKNAMES') THEN
            RAISE EXCEPTION 'Missing MANAGE_NICKNAMES permission' USING ERRCODE = '42501';
        END IF;
        IF p_user_id IS NOT DISTINCT FROM v_owner THEN
            RAISE EXCEPTION 'Only the server owner changes the owner''s server profile' USING ERRCODE = '42501';
        END IF;
        IF public.get_user_highest_role_position(v_me, p_server_id)
           <= public.get_user_highest_role_position(p_user_id, p_server_id) THEN
            RAISE EXCEPTION 'Cannot change the server profile of a member with an equal or higher role'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT * INTO v_old FROM public.user_servers us
     WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted'
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'not an accepted member of this server' USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.user_servers us
       SET nickname   = CASE WHEN p_set_nickname THEN p_nickname ELSE us.nickname END,
           avatar_url = CASE WHEN p_reset_profile THEN NULL ELSE us.avatar_url END,
           banner_url = CASE WHEN p_reset_profile THEN NULL ELSE us.banner_url END,
           bio        = CASE WHEN p_reset_profile THEN NULL ELSE us.bio END,
           pronouns   = CASE WHEN p_reset_profile THEN NULL ELSE us.pronouns END
     WHERE us.server_id = p_server_id AND us.user_id = p_user_id
    RETURNING us.* INTO v_new;

    SELECT p.username INTO v_name FROM public.profiles p WHERE p.id = p_user_id;

    IF p_set_nickname AND v_new.nickname IS DISTINCT FROM v_old.nickname THEN
        v_changes := jsonb_build_object('nickname', jsonb_build_object('old', v_old.nickname, 'new', v_new.nickname));
        PERFORM public.server_audit_write(p_server_id, 'member.nickname_update', 'user', p_user_id::text, v_name, v_changes);
    END IF;
    IF p_reset_profile AND (v_old.avatar_url IS NOT NULL OR v_old.banner_url IS NOT NULL
                            OR v_old.bio IS NOT NULL OR v_old.pronouns IS NOT NULL) THEN
        PERFORM public.server_audit_write(p_server_id, 'member.profile_reset', 'user', p_user_id::text, v_name);
    END IF;

    RETURN jsonb_build_object('nickname', v_new.nickname, 'avatar_url', v_new.avatar_url,
                              'banner_url', v_new.banner_url, 'bio', v_new.bio, 'pronouns', v_new.pronouns);
END;
$$;

COMMENT ON FUNCTION public.moderate_server_profile(uuid, uuid, text, boolean, boolean) IS
    'Change (p_set_nickname) or reset (p_reset_profile) a member''s server profile; needs MANAGE_NICKNAMES and a role above the member''s. Audited as member.nickname_update / member.profile_reset; a reset of an already-empty profile writes no audit row.';

UPDATE public.server_audit_log SET action = 'member.nickname_update' WHERE action = 'member_nickname_changed';
UPDATE public.server_audit_log SET action = 'member.profile_reset' WHERE action = 'member_server_profile_reset';

NOTIFY pgrst, 'reload schema';

COMMIT;
