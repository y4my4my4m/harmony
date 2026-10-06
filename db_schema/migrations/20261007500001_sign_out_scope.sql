-- Signing out other devices requires the second factor.
--
-- GoTrue's POST /logout accepts any valid access token and checks no assurance level:
-- scope=global or scope=others from the aal1 token of a correct password deletes every
-- session of a 2FA account (v2.182.1 and v2.186.0). The API host's nginx passes
-- scope=local only (dev/nginx-auth-logout.template.conf); the other scopes move here.
--
--   sign_out_my_sessions(p_scope)   'others' deletes the caller's sessions except the one
--                                   the token names; 'global' deletes all of them. Returns
--                                   the number deleted. Refresh tokens and the sessions'
--                                   push targets cascade; enforce_request_assurance refuses
--                                   their access tokens at once (session_revoked).
--   revoke_my_session(p_session_id) as before, plus the assurance check.
--
-- Both raise PT403 insufficient_aal when session_meets_aal() is false, independent of the
-- db-pre-request hook, which the kill switch (ALTER ROLE authenticator RESET
-- pgrst.db_pre_request) turns off.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.sign_out_my_sessions(p_scope text DEFAULT 'others')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_sid text := public.current_jwt_claims() ->> 'session_id';
    v_keep uuid;
    v_count integer;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT public.session_meets_aal() THEN
        RAISE SQLSTATE 'PT403' USING
            MESSAGE = 'insufficient_aal',
            DETAIL = 'This account requires two-factor authentication.',
            HINT = 'Complete the two-factor challenge.';
    END IF;
    IF p_scope IS NULL OR p_scope NOT IN ('others', 'global') THEN
        RAISE EXCEPTION 'invalid_scope' USING ERRCODE = '22023',
            DETAIL = 'p_scope is others or global.';
    END IF;
    -- 'others' with no current session to keep would be 'global'.
    IF p_scope = 'others'
       AND (v_sid IS NULL
            OR v_sid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'session_required' USING ERRCODE = '22023',
            DETAIL = 'The token names no session.';
    END IF;
    IF p_scope = 'others' THEN
        v_keep := v_sid::uuid;
    END IF;

    DELETE FROM auth.sessions s
     WHERE s.user_id = v_uid
       AND s.id IS DISTINCT FROM v_keep;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.sign_out_my_sessions(text) IS
    'Deletes the caller''s other sessions (''others'') or all of them (''global''). aal2 when the account has a verified factor.';

CREATE OR REPLACE FUNCTION public.revoke_my_session(p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_count integer;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT public.session_meets_aal() THEN
        RAISE SQLSTATE 'PT403' USING
            MESSAGE = 'insufficient_aal',
            DETAIL = 'This account requires two-factor authentication.',
            HINT = 'Complete the two-factor challenge.';
    END IF;
    DELETE FROM auth.sessions s WHERE s.id = p_session_id AND s.user_id = v_uid;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count > 0;
END;
$$;

-- Owned by postgres like the rest of 20261005400001; CREATE run as supabase_admin leaves
-- a new function owned by supabase_admin.
DO $$
DECLARE
    fn regprocedure;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        RAISE NOTICE 'postgres role absent, ownership left with %', current_user;
        RETURN;
    END IF;
    FOREACH fn IN ARRAY ARRAY['public.sign_out_my_sessions(text)'::regprocedure,
                              'public.revoke_my_session(uuid)'::regprocedure]
    LOOP
        IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = fn)) <> 'postgres' THEN
            EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', fn);
            RAISE NOTICE '% now owned by postgres', fn;
        END IF;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.sign_out_my_sessions(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_my_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_out_my_sessions(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_my_session(uuid) TO authenticated;

-- The definers delete from auth.sessions as postgres.
DO $$
BEGIN
    IF to_regclass('auth.sessions') IS NOT NULL
       AND NOT has_table_privilege('postgres', 'auth.sessions', 'DELETE') THEN
        RAISE EXCEPTION 'postgres lacks DELETE on auth.sessions';
    END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
