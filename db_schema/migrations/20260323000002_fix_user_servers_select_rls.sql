-- Migration: Restrict user_servers SELECT to co-members only
-- The current "Enable read access for all users" policy uses USING(true),
-- allowing any authenticated user to see all server memberships (privacy leak).
-- This replaces it with a scoped policy: users can only see memberships
-- for servers they themselves belong to.
-- Uses a SECURITY DEFINER function to avoid RLS recursion.

BEGIN;

-- Helper: check if the current user is a member of a given server.
-- SECURITY DEFINER so it bypasses RLS on user_servers (avoids infinite recursion).
CREATE OR REPLACE FUNCTION public.current_user_is_member_of_server(p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_servers
        WHERE server_id = p_server_id
          AND user_id = public.get_current_profile_id()
    );
$$;

GRANT EXECUTE ON FUNCTION public.current_user_is_member_of_server(uuid) TO authenticated;

-- Drop the overly permissive SELECT policy
DROP POLICY IF EXISTS "Enable read access for all users" ON public.user_servers;

-- Users can see memberships for servers they are a member of,
-- and admins/mods can see all memberships.
CREATE POLICY "user_servers_select_co_members" ON public.user_servers
    FOR SELECT TO authenticated
    USING (
        user_id = public.get_current_profile_id()
        OR public.current_user_is_member_of_server(server_id)
        OR public.is_current_user_admin()
    );

NOTIFY pgrst, 'reload schema';

COMMIT;
