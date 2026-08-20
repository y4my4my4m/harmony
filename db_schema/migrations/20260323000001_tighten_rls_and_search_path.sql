-- Migration: Tighten permissive RLS policies + add search_path to SECURITY DEFINER functions
--
-- Issues fixed:
-- 1. federation_health_manage: was USING(auth.uid() IS NOT NULL) - any auth user could write.
--    Now restricted to admin-only + service_role.
-- 2. federated_instances_manage: same problem, now admin-only + service_role.
-- 3. ap_activities "System" policy: was USING(true) with no role restriction - any user passed.
--    Now restricted to service_role only.
-- 4. SECURITY DEFINER functions missing SET search_path = public (hardening).
--
-- user_servers "Allow all" was already tightened in 20260313_tighten_user_servers_rls.sql.

BEGIN;

-- =========================================================================
-- 1. federation_health: tighten manage policy to admin + add service_role
-- =========================================================================
DROP POLICY IF EXISTS "federation_health_manage" ON public.federation_health;
CREATE POLICY "federation_health_manage" ON public.federation_health
    FOR ALL USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "federation_health_service_role" ON public.federation_health;
CREATE POLICY "federation_health_service_role" ON public.federation_health
    TO service_role USING (true);

-- =========================================================================
-- 2. federated_instances: tighten manage policy to admin + add service_role
-- =========================================================================
DROP POLICY IF EXISTS "federated_instances_manage" ON public.federated_instances;
CREATE POLICY "federated_instances_manage" ON public.federated_instances
    FOR ALL USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "federated_instances_service_role" ON public.federated_instances;
CREATE POLICY "federated_instances_service_role" ON public.federated_instances
    TO service_role USING (true);

-- =========================================================================
-- 3. ap_activities: restrict "System" policy to service_role
-- =========================================================================
DROP POLICY IF EXISTS "System can manage ActivityPub activities" ON public.ap_activities;
CREATE POLICY "System can manage ActivityPub activities" ON public.ap_activities
    TO service_role USING (true);

-- =========================================================================
-- 4. Add SET search_path = public to critical SECURITY DEFINER helpers
--    (used by RLS policies - most security-sensitive)
-- =========================================================================

CREATE OR REPLACE FUNCTION public.get_current_profile_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_current_user_profile_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    profile_uuid uuid;
BEGIN
    SELECT id INTO profile_uuid
    FROM profiles
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    RETURN profile_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

CREATE OR REPLACE FUNCTION public.is_current_user_moderator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT is_moderator FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

CREATE OR REPLACE FUNCTION public.is_current_user_admin_or_mod()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT (is_admin OR is_moderator) FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

CREATE OR REPLACE FUNCTION public.is_author_suspended(p_author_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT is_suspended FROM public.profiles WHERE id = p_author_id),
        false
    );
$$;

CREATE OR REPLACE FUNCTION public.is_blocked_by(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_blocks
        WHERE blocker_id = target_user_id
        AND blocked_user_id = public.get_current_profile_id()
    );
$$;

CREATE OR REPLACE FUNCTION public.has_blocked(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_blocks
        WHERE blocker_id = public.get_current_profile_id()
        AND blocked_user_id = target_user_id
    );
$$;

CREATE OR REPLACE FUNCTION public.is_muted_by(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_mutes
        WHERE muter_id = target_user_id
        AND muted_user_id = public.get_current_profile_id()
    );
$$;

CREATE OR REPLACE FUNCTION public.has_muted(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_mutes
        WHERE muter_id = public.get_current_profile_id()
        AND muted_user_id = target_user_id
    );
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
