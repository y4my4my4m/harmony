-- profiles_insert_own checks `auth_user_id = auth.uid()`, which establishes who the caller is
-- and nothing about which columns the row carries. prevent_profile_moderation_self_update
-- guards the same columns but is BEFORE UPDATE, so INSERT reaches the table unfiltered.
--
-- The row is created client-side from a caller-supplied object, and PostgREST accepts any
-- column the role may write, so `is_admin: true` at registration makes the caller an instance
-- admin. Demonstrated as `authenticated` against a database built from this schema:
--
--     INSERT INTO public.profiles (auth_user_id, username, domain, is_local, is_admin)
--     VALUES (auth.uid(), 'attacker', ..., true);
--     -- INSERT 0 1, is_admin = true
--
-- is_current_user_admin() reads the column directly, so the grant is effective immediately.
--
-- Flags are forced to false rather than raising: a federated or administrative insert that
-- legitimately carries an explicit false must not abort. Trigger names sort alphabetically and
-- promote_first_user_to_admin is also BEFORE INSERT, so the a_ prefix keeps this one first and
-- leaves first-user promotion working where that function exists.
--
-- Runs SECURITY INVOKER. The body only rewrites NEW, so it needs no owner rights, and under
-- SECURITY DEFINER current_user resolves to the function owner, which makes the exemption below
-- unconditionally true and the clamp a no-op.
--
-- Exemption is on current_user, not session_user: PostgREST connects as `authenticator` and
-- assumes `authenticated`, `anon` or `service_role` per request, so session_user identifies the
-- pool rather than the caller.

BEGIN;

-- CREATE TRIGGER takes ACCESS EXCLUSIVE on profiles, which every read path joins. Abort rather
-- than queue behind a long transaction; retry is cheap.
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.clamp_profile_moderation_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
        RETURN NEW;
    END IF;

    NEW.is_admin        := false;
    NEW.is_moderator    := false;
    NEW.is_suspended    := false;
    NEW.is_silenced     := false;
    NEW.force_sensitive := false;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_clamp_profile_moderation_on_insert_trigger ON public.profiles;
CREATE TRIGGER a_clamp_profile_moderation_on_insert_trigger
    BEFORE INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.clamp_profile_moderation_on_insert();

COMMIT;

NOTIFY pgrst, 'reload schema';
