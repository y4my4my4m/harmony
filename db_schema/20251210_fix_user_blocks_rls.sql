-- Migration: Fix user_blocks RLS policy for SELECT
-- Issue: The current RLS policy allows users to see blocks where they are the blocked_user_id
--        This caused blocked users to see themselves in the blockedUsers set
-- Fix: Add proper policy so users can see blocks WHERE THEY ARE THE BLOCKER
-- Date: 2025-12-10

-- ---------------------------------------------------------------------------
-- FIX USER_BLOCKS SELECT RLS POLICY
-- ---------------------------------------------------------------------------

-- Add policy for users to view their own blocks (where they are the blocker)
-- This is the main policy used by loadBlockedUsers to fetch who YOU have blocked
DROP POLICY IF EXISTS "Users can view own blocks" ON public.user_blocks;
CREATE POLICY "Users can view own blocks" ON public.user_blocks
    FOR SELECT USING (blocker_id = public.get_current_profile_id());

COMMENT ON POLICY "Users can view own blocks" ON public.user_blocks IS 
    'Users can view their own blocks (users they have blocked)';

-- The existing "Users can check if blocked" policy is still useful for checking
-- if someone has blocked you (e.g., to show a "you are blocked" message)
-- but the loadBlockedUsers query now explicitly filters by blocker_id anyway

-- ---------------------------------------------------------------------------
-- FIX USER_MUTES RLS POLICIES (if not already correct)
-- ---------------------------------------------------------------------------

-- Ensure user_mutes has RLS enabled
ALTER TABLE public.user_mutes ENABLE ROW LEVEL SECURITY;

-- Users can view their own mutes (where they are the muter)
DROP POLICY IF EXISTS "user_mutes_select_own" ON public.user_mutes;
CREATE POLICY "user_mutes_select_own" ON public.user_mutes
    FOR SELECT USING (muter_id = public.get_current_profile_id());

-- Users can insert their own mutes
DROP POLICY IF EXISTS "user_mutes_insert_own" ON public.user_mutes;
CREATE POLICY "user_mutes_insert_own" ON public.user_mutes
    FOR INSERT WITH CHECK (muter_id = public.get_current_profile_id());

-- Users can update their own mutes
DROP POLICY IF EXISTS "user_mutes_update_own" ON public.user_mutes;
CREATE POLICY "user_mutes_update_own" ON public.user_mutes
    FOR UPDATE USING (muter_id = public.get_current_profile_id());

-- Users can delete their own mutes
DROP POLICY IF EXISTS "user_mutes_delete_own" ON public.user_mutes;
CREATE POLICY "user_mutes_delete_own" ON public.user_mutes
    FOR DELETE USING (muter_id = public.get_current_profile_id());

COMMENT ON POLICY "user_mutes_select_own" ON public.user_mutes IS 
    'Users can view their own mutes (users they have muted)';

-- ---------------------------------------------------------------------------
-- GRANT PERMISSIONS
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_mutes TO authenticated;

