-- =============================================
-- Migration: Fix Posts Delete/Update RLS Policy
-- Date: 2024-11-30
-- =============================================
-- 
-- Issue: Users getting "new row violates row-level security policy" 
-- when trying to delete (soft-delete) their own posts.
--
-- The issue is that the UPDATE policy's WITH CHECK clause may be too 
-- restrictive or there's a conflict with other policies.
-- =============================================

BEGIN;

-- =============================================
-- STEP 1: Drop existing UPDATE policy
-- =============================================

DROP POLICY IF EXISTS "Users can update their own posts" ON public.posts;

-- =============================================
-- STEP 2: Create more permissive UPDATE policy
-- The USING clause checks what rows you can access
-- The WITH CHECK clause validates the new values
-- For soft-delete, we want to allow changing is_deleted even if the post was already deleted
-- =============================================

CREATE POLICY "Users can update their own posts" ON public.posts 
FOR UPDATE 
USING (
  author_id = public.get_current_profile_id()
)
WITH CHECK (
  -- The author_id must still match (can't reassign post ownership)
  author_id = public.get_current_profile_id()
  -- Allow any changes to is_deleted, content, etc. as long as it's your post
);

-- =============================================
-- STEP 3: Also ensure there's no policy blocking updates on deleted posts
-- Sometimes we need to update already-deleted posts (e.g., to truly purge them)
-- =============================================

-- Allow users to view their deleted posts (needed for update to work)
DROP POLICY IF EXISTS "Users can view their deleted posts" ON public.posts;
CREATE POLICY "Users can view their deleted posts" ON public.posts 
FOR SELECT 
USING (
  author_id = public.get_current_profile_id()
  AND is_deleted = true
);

-- =============================================
-- STEP 4: Verify the helper function exists and works
-- =============================================

-- Recreate the function to ensure it's up to date
CREATE OR REPLACE FUNCTION public.get_current_profile_id()
RETURNS uuid AS $$
  SELECT id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1
$$ LANGUAGE sql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION public.get_current_profile_id() IS 
  'Returns the profile ID for the currently authenticated user. Uses indexed lookup on auth_user_id. Marked STABLE for query planner optimization.';

COMMIT;

-- =============================================
-- Verification (run manually):
-- =============================================
-- 
-- 1. Check that you can get your profile ID:
--    SELECT public.get_current_profile_id();
--
-- 2. Check that you can see your posts:
--    SELECT id, is_deleted FROM posts WHERE author_id = public.get_current_profile_id() LIMIT 5;
--
-- 3. Try soft-deleting a post:
--    UPDATE posts 
--    SET is_deleted = true, content = '[{"type": "text", "text": "[deleted]"}]'::jsonb
--    WHERE id = 'your-post-id' AND author_id = public.get_current_profile_id();

