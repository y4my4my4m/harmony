-- =============================================================================
-- Migration: Align dev RLS policies with localhost
-- =============================================================================
-- Many dev policies use auth.uid() where they should use get_current_profile_id()
-- since user_servers.user_id, user_roles.user_id etc. reference profiles.id,
-- NOT auth.users.id.
--
-- This script drops broken policies and recreates them correctly.
-- Safe to run on both dev and localhost (idempotent).
-- =============================================================================
-- IMPORTANT: After running this, execute:
--   NOTIFY pgrst, 'reload schema';
-- to force PostgREST to pick up the changes.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. server_roles: Simple open SELECT, permission-based write
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.server_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view server roles" ON public.server_roles;
DROP POLICY IF EXISTS "server_roles_select_member" ON public.server_roles;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.server_roles;
DROP POLICY IF EXISTS "Authenticated users can manage roles" ON public.server_roles;
DROP POLICY IF EXISTS "Users with MANAGE_ROLES can create roles" ON public.server_roles;
DROP POLICY IF EXISTS "Users with MANAGE_ROLES can update roles" ON public.server_roles;
DROP POLICY IF EXISTS "Users with MANAGE_ROLES can delete roles" ON public.server_roles;

CREATE POLICY "server_roles_select" ON public.server_roles
    FOR SELECT USING (true);

CREATE POLICY "server_roles_insert" ON public.server_roles
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = server_id AND owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    );

CREATE POLICY "server_roles_update" ON public.server_roles
    FOR UPDATE USING (
        NOT is_default
        AND (
            EXISTS (
                SELECT 1 FROM public.servers
                WHERE id = server_id AND owner = public.get_current_profile_id()
            )
            OR public.is_current_user_admin()
        )
    );

CREATE POLICY "server_roles_delete" ON public.server_roles
    FOR DELETE USING (
        NOT is_default
        AND (
            EXISTS (
                SELECT 1 FROM public.servers
                WHERE id = server_id AND owner = public.get_current_profile_id()
            )
            OR public.is_current_user_admin()
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. user_roles: Open SELECT, permission-based write
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view role assignments" ON public.user_roles;
DROP POLICY IF EXISTS "user_roles_select_all" ON public.user_roles;
DROP POLICY IF EXISTS "Users with MANAGE_ROLES can assign roles" ON public.user_roles;
DROP POLICY IF EXISTS "Users with MANAGE_ROLES can remove roles" ON public.user_roles;

CREATE POLICY "user_roles_select" ON public.user_roles
    FOR SELECT USING (true);

CREATE POLICY "user_roles_insert" ON public.user_roles
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = server_id AND owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    );

CREATE POLICY "user_roles_delete" ON public.user_roles
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = server_id AND owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Force PostgREST schema reload
-- ─────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$ BEGIN
    RAISE NOTICE 'RLS policies aligned: server_roles, user_roles. PostgREST schema reloaded.';
END $$;
