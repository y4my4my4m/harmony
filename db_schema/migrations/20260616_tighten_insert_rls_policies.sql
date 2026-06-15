-- =============================================================================
-- Tighten always-true INSERT RLS policies (security advisor: rls_policy_always_true)
-- =============================================================================
-- Three INSERT policies used WITH CHECK (true), letting any authenticated user
-- insert arbitrary rows. Each is replaced with the real ownership constraint.
-- Verified against the app + schema so legitimate flows are unaffected:
--
--  1. servers / "Enable insert for authenticated users only"
--     Servers are created by a direct client insert (useServerChannel.ts) with
--     owner = the caller's profile. servers.owner is a FK to profiles(id). We
--     mirror the EXISTING update policy's ownership check, so a user may only
--     create a server they own (blocks creating servers owned by someone else).
--
--  2. conversations / "conversations_insert_authenticated"
--     Conversations are created ONLY via SECURITY DEFINER RPCs
--     (create_or_get_direct_conversation, create_group_conversation) which bypass
--     RLS. No direct client insert exists. Tightening to created_by = self does
--     not affect the RPC path and blocks forged direct inserts.
--
--  3. server_membership_events / "System can insert membership events"
--     Every writer is SECURITY DEFINER (route_server_membership,
--     route_server_leave triggers; kick/ban/unban RPCs) and bypasses RLS. The
--     frontend only SELECTs this table. The authenticated INSERT policy is unused
--     and only allows forging join/leave/ban events, so it is dropped.
--
-- Idempotent (DROP POLICY IF EXISTS + CREATE). auth.uid() is pre-wrapped as
-- (select ...) to stay consistent with the auth_rls_initplan optimization.
-- =============================================================================

BEGIN;

-- 1. servers --------------------------------------------------------------
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.servers;
CREATE POLICY "Enable insert for authenticated users only" ON public.servers
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = servers.owner
              AND profiles.auth_user_id = (select auth.uid())
        )
    );

-- 2. conversations --------------------------------------------------------
DROP POLICY IF EXISTS "conversations_insert_authenticated" ON public.conversations;
CREATE POLICY "conversations_insert_authenticated" ON public.conversations
    FOR INSERT
    WITH CHECK (created_by = (select public.get_current_profile_id()));

-- 3. server_membership_events (system-only; SECURITY DEFINER writers) -----
DROP POLICY IF EXISTS "System can insert membership events" ON public.server_membership_events;

COMMIT;
