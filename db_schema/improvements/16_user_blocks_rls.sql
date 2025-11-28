-- =============================================
-- USER_BLOCKS RLS POLICIES
-- Date: 2025-11-28
-- =============================================
-- 
-- Fix RLS policies for user_blocks table to allow:
-- 1. Users to see their own blocks (where they are blocker)
-- 2. Users to see if they are blocked (where they are blocked_user_id)
-- 3. Users to create/delete their own blocks
-- =============================================

BEGIN;

-- Enable RLS if not already enabled
ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to recreate them properly
DROP POLICY IF EXISTS "Check if blocked by user" ON public.user_blocks;
DROP POLICY IF EXISTS "Users can see their own blocks" ON public.user_blocks;
DROP POLICY IF EXISTS "Users can check if blocked" ON public.user_blocks;
DROP POLICY IF EXISTS "Users can create blocks" ON public.user_blocks;
DROP POLICY IF EXISTS "Users can delete own blocks" ON public.user_blocks;

-- Policy 1: Users can see blocks they created (for managing their block list)
CREATE POLICY "Users can see their own blocks" ON public.user_blocks
FOR SELECT
USING (blocker_id = public.get_current_profile_id());

-- Policy 2: Users can check if they are blocked by someone
CREATE POLICY "Users can check if blocked" ON public.user_blocks
FOR SELECT
USING (blocked_user_id = public.get_current_profile_id());

-- Policy 3: Users can create blocks (block someone)
CREATE POLICY "Users can create blocks" ON public.user_blocks
FOR INSERT
WITH CHECK (blocker_id = public.get_current_profile_id());

-- Policy 4: Users can delete their own blocks (unblock someone)
CREATE POLICY "Users can delete own blocks" ON public.user_blocks
FOR DELETE
USING (blocker_id = public.get_current_profile_id());

-- Add comments for documentation
COMMENT ON POLICY "Users can see their own blocks" ON public.user_blocks IS 
  'Users can view blocks they have created to manage their block list';

COMMENT ON POLICY "Users can check if blocked" ON public.user_blocks IS 
  'Users can check if they have been blocked by someone';

COMMENT ON POLICY "Users can create blocks" ON public.user_blocks IS 
  'Users can block other users';

COMMENT ON POLICY "Users can delete own blocks" ON public.user_blocks IS 
  'Users can unblock users they have blocked';

-- Grant table permissions
GRANT SELECT, INSERT, DELETE ON public.user_blocks TO authenticated;

COMMIT;

