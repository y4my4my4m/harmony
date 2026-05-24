-- Migration: Tighten user_servers RLS from "Allow all" to scoped policies
-- The "Allow all" USING(true) WITH CHECK(true) policy allowed any authenticated user
-- to insert/update any row in user_servers. This replaces it with:
-- - INSERT: users can only add themselves (service_role bypasses RLS for federation)
-- - UPDATE: users can update their own row, or server owners can update member rows
-- No recursion risk because these check profiles.id and servers.owner, not user_servers.

BEGIN;

-- Remove the overly permissive "Allow all" policy
DROP POLICY IF EXISTS "Allow all" ON public.user_servers;

-- Users can join servers (insert themselves)
DROP POLICY IF EXISTS "user_servers_insert_self" ON public.user_servers;
CREATE POLICY "user_servers_insert_self" ON public.user_servers
    FOR INSERT TO authenticated
    WITH CHECK (user_id = public.get_current_profile_id());

-- Users can update their own membership, server owners can update any member
DROP POLICY IF EXISTS "user_servers_update_own_or_owner" ON public.user_servers;
CREATE POLICY "user_servers_update_own_or_owner" ON public.user_servers
    FOR UPDATE TO authenticated
    USING (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.servers
            WHERE servers.id = user_servers.server_id
            AND owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    );

-- Note on conversations_insert_authenticated (WITH CHECK (true)):
-- Intentionally permissive - conversation creation is a multi-step operation
-- (create row + add participants). Access control is in application logic.

-- Note on notifications INSERT (WITH CHECK (true)):
-- Intentionally permissive - notifications are created by DB triggers and
-- SECURITY DEFINER functions that need unrestricted INSERT.

NOTIFY pgrst, 'reload schema';

COMMIT;
