BEGIN;

-- ============================================================================
-- Add missing INSERT/UPDATE/DELETE RLS policies for threads and thread_members
-- ============================================================================

-- THREADS: INSERT - server members can create threads
DROP POLICY IF EXISTS "threads_insert_member" ON public.threads;
CREATE POLICY "threads_insert_member" ON public.threads
    FOR INSERT WITH CHECK (
        created_by = public.get_current_profile_id()
        AND EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.user_servers us ON us.server_id = c.server_id
            WHERE c.id = threads.channel_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    );

-- THREADS: UPDATE - thread creator or server owner
DROP POLICY IF EXISTS "threads_update_authorized" ON public.threads;
CREATE POLICY "threads_update_authorized" ON public.threads
    FOR UPDATE USING (
        created_by = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            WHERE c.id = threads.channel_id
            AND s.owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    );

-- THREADS: DELETE - thread creator or server owner
DROP POLICY IF EXISTS "threads_delete_authorized" ON public.threads;
CREATE POLICY "threads_delete_authorized" ON public.threads
    FOR DELETE USING (
        created_by = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            WHERE c.id = threads.channel_id
            AND s.owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    );

-- THREADS: Service role full access (federation backend)
DROP POLICY IF EXISTS "threads_service_role" ON public.threads;
CREATE POLICY "threads_service_role" ON public.threads
    FOR ALL TO service_role USING (true);

-- THREAD MEMBERS: INSERT - users can join threads
DROP POLICY IF EXISTS "thread_members_insert_self" ON public.thread_members;
CREATE POLICY "thread_members_insert_self" ON public.thread_members
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

-- THREAD MEMBERS: UPDATE - users can update own membership (mute, etc.)
DROP POLICY IF EXISTS "thread_members_update_self" ON public.thread_members;
CREATE POLICY "thread_members_update_self" ON public.thread_members
    FOR UPDATE USING (user_id = public.get_current_profile_id());

-- THREAD MEMBERS: DELETE - users can leave threads
DROP POLICY IF EXISTS "thread_members_delete_self" ON public.thread_members;
CREATE POLICY "thread_members_delete_self" ON public.thread_members
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- THREAD MEMBERS: Service role full access (triggers/federation)
DROP POLICY IF EXISTS "thread_members_service_role" ON public.thread_members;
CREATE POLICY "thread_members_service_role" ON public.thread_members
    FOR ALL TO service_role USING (true);

COMMIT;
