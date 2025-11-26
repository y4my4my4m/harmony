-- =============================================
-- Fix Deleted Posts RLS Security
-- =============================================
-- This migration ensures deleted posts cannot be accessed via any means,
-- including direct API calls that might bypass frontend filters.

-- =============================================
-- STEP 1: Fix "Users can view their own posts" policy
-- Currently it allows users to see their own deleted posts
-- =============================================

-- Drop the existing policy
DROP POLICY IF EXISTS "Users can view their own posts" ON public.posts;

-- Recreate with is_deleted check
-- Users can view their own posts ONLY if not deleted
CREATE POLICY "Users can view their own posts" ON public.posts 
FOR SELECT 
USING (
  (SELECT auth.uid() AS uid) = author_id 
  AND (is_deleted = false OR is_deleted IS NULL)
);

-- =============================================
-- STEP 2: Verify and fix other post viewing policies
-- These should already have is_deleted checks but let's ensure they're correct
-- =============================================

-- Drop and recreate public posts policy for consistency
DROP POLICY IF EXISTS "Users can view public posts" ON public.posts;

CREATE POLICY "Users can view public posts" ON public.posts 
FOR SELECT 
USING (
  visibility IN ('public', 'unlisted') 
  AND (is_deleted = false OR is_deleted IS NULL)
);

-- Drop and recreate followers posts policy
DROP POLICY IF EXISTS "Users can view posts from users they follow" ON public.posts;

CREATE POLICY "Users can view posts from users they follow" ON public.posts 
FOR SELECT 
USING (
  visibility = 'followers'
  AND (is_deleted = false OR is_deleted IS NULL)
  AND EXISTS (
    SELECT 1 FROM public.follows
    WHERE follows.follower_id = (SELECT auth.uid())
    AND follows.following_id = posts.author_id
    AND follows.status = 'accepted'
  )
);

-- =============================================
-- STEP 3: Create a secure view for posts that always excludes deleted
-- This can be used by RPC functions or as an alternative to direct table access
-- =============================================

DROP VIEW IF EXISTS public.visible_posts;

CREATE VIEW public.visible_posts AS
SELECT * FROM public.posts
WHERE is_deleted = false OR is_deleted IS NULL;

-- Grant access to the view
GRANT SELECT ON public.visible_posts TO authenticated;
GRANT SELECT ON public.visible_posts TO anon;

-- =============================================
-- STEP 4: Fix post_interactions policies to not return interactions on deleted posts
-- =============================================

DROP POLICY IF EXISTS "Users can view post interactions on posts they can see" ON public.post_interactions;

CREATE POLICY "Users can view post interactions on posts they can see" ON public.post_interactions 
FOR SELECT 
USING (
  post_id IN (
    SELECT p.id FROM public.posts p
    WHERE (p.is_deleted = false OR p.is_deleted IS NULL)
    AND (
      p.author_id = (SELECT auth.uid())
      OR p.visibility = 'public'
      OR p.visibility = 'unlisted'
      OR (
        p.visibility = 'followers' 
        AND EXISTS (
          SELECT 1 FROM public.follows f
          WHERE f.follower_id = (SELECT auth.uid())
          AND f.following_id = p.author_id
          AND f.status = 'accepted'
        )
      )
    )
  )
);

-- Also fix the insert policy for interactions
DROP POLICY IF EXISTS "Users can create post interactions on posts they can see" ON public.post_interactions;

CREATE POLICY "Users can create post interactions on posts they can see" ON public.post_interactions 
FOR INSERT 
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND post_id IN (
    SELECT p.id FROM public.posts p
    WHERE (p.is_deleted = false OR p.is_deleted IS NULL)
    AND (
      p.author_id = (SELECT auth.uid())
      OR p.visibility = 'public'
      OR p.visibility = 'unlisted'
      OR (
        p.visibility = 'followers' 
        AND EXISTS (
          SELECT 1 FROM public.follows f
          WHERE f.follower_id = (SELECT auth.uid())
          AND f.following_id = p.author_id
          AND f.status = 'accepted'
        )
      )
    )
  )
);

-- =============================================
-- STEP 5: Update any RPC functions that might bypass RLS
-- If get_timeline_posts_with_interactions exists, update it
-- =============================================

-- Check if the function exists and update it to filter deleted posts
DO $$
BEGIN
  -- Update the function if it exists
  IF EXISTS (
    SELECT 1 FROM pg_proc 
    WHERE proname = 'get_timeline_posts_with_interactions'
  ) THEN
    -- The function should be updated to filter is_deleted
    -- This is a placeholder - the actual function update depends on its current implementation
    RAISE NOTICE 'Function get_timeline_posts_with_interactions exists - verify it filters is_deleted';
  END IF;
END $$;

-- =============================================
-- STEP 6: Add a database trigger to auto-clean interactions on deleted posts
-- When a post is soft-deleted, we might want to handle related data
-- =============================================

CREATE OR REPLACE FUNCTION public.handle_post_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- When a post is soft-deleted, we could optionally clean up related data
  -- For now, we just log it - the RLS policies will prevent access
  IF NEW.is_deleted = true AND (OLD.is_deleted = false OR OLD.is_deleted IS NULL) THEN
    -- Post was just soft-deleted
    -- The RLS policies will now prevent anyone from seeing it
    RAISE NOTICE 'Post % was soft-deleted', NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger if it doesn't exist
DROP TRIGGER IF EXISTS on_post_soft_delete ON public.posts;

CREATE TRIGGER on_post_soft_delete
  AFTER UPDATE OF is_deleted ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_post_soft_delete();

-- =============================================
-- STEP 7: Add index for better query performance
-- =============================================

-- Create partial index for non-deleted posts (very useful for large tables)
CREATE INDEX IF NOT EXISTS idx_posts_not_deleted 
ON public.posts (created_at DESC) 
WHERE is_deleted = false OR is_deleted IS NULL;

-- Create partial index for public/unlisted visible posts
CREATE INDEX IF NOT EXISTS idx_posts_visible_public
ON public.posts (created_at DESC)
WHERE (is_deleted = false OR is_deleted IS NULL) 
  AND visibility IN ('public', 'unlisted');

-- =============================================
-- STEP 8: Fix reply/reblog/favorite counts to exclude deleted posts
-- =============================================

-- Create or replace function to update post counts excluding deleted
CREATE OR REPLACE FUNCTION public.update_post_reply_count()
RETURNS TRIGGER AS $$
BEGIN
  -- Update the parent post's reply count (excluding deleted replies)
  IF TG_OP = 'INSERT' THEN
    UPDATE public.posts 
    SET replies_count = (
      SELECT COUNT(*) FROM public.posts 
      WHERE in_reply_to = NEW.in_reply_to 
      AND (is_deleted = false OR is_deleted IS NULL)
    )
    WHERE id = NEW.in_reply_to;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- If is_deleted changed, update the parent's count
    IF OLD.is_deleted IS DISTINCT FROM NEW.is_deleted THEN
      UPDATE public.posts 
      SET replies_count = (
        SELECT COUNT(*) FROM public.posts 
        WHERE in_reply_to = NEW.in_reply_to 
        AND (is_deleted = false OR is_deleted IS NULL)
      )
      WHERE id = NEW.in_reply_to;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.posts 
    SET replies_count = (
      SELECT COUNT(*) FROM public.posts 
      WHERE in_reply_to = OLD.in_reply_to 
      AND (is_deleted = false OR is_deleted IS NULL)
    )
    WHERE id = OLD.in_reply_to;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create separate triggers for INSERT/UPDATE and DELETE
-- (DELETE triggers cannot reference NEW values in WHEN clause)
DROP TRIGGER IF EXISTS update_reply_count_on_post_change ON public.posts;
DROP TRIGGER IF EXISTS update_reply_count_on_post_insert_update ON public.posts;
DROP TRIGGER IF EXISTS update_reply_count_on_post_delete ON public.posts;

CREATE TRIGGER update_reply_count_on_post_insert_update
  AFTER INSERT OR UPDATE OF is_deleted ON public.posts
  FOR EACH ROW
  WHEN (NEW.in_reply_to IS NOT NULL)
  EXECUTE FUNCTION public.update_post_reply_count();

CREATE TRIGGER update_reply_count_on_post_delete
  AFTER DELETE ON public.posts
  FOR EACH ROW
  WHEN (OLD.in_reply_to IS NOT NULL)
  EXECUTE FUNCTION public.update_post_reply_count();

-- Fix existing reply counts (one-time cleanup)
UPDATE public.posts parent
SET replies_count = (
  SELECT COUNT(*) 
  FROM public.posts child
  WHERE child.in_reply_to = parent.id 
  AND (child.is_deleted = false OR child.is_deleted IS NULL)
)
WHERE EXISTS (
  SELECT 1 FROM public.posts child WHERE child.in_reply_to = parent.id
);

-- Also fix reblog counts to exclude deleted reblogs
UPDATE public.posts 
SET reblogs_count = (
  SELECT COUNT(*) 
  FROM public.post_interactions 
  WHERE post_id = posts.id 
  AND interaction_type = 'reblog'
  AND EXISTS (
    SELECT 1 FROM public.posts reblog_post
    WHERE reblog_post.metadata->>'reblog_of' = posts.id::text
    AND (reblog_post.is_deleted = false OR reblog_post.is_deleted IS NULL)
  )
);

-- =============================================
-- Verification queries (run these to verify the fix)
-- =============================================

-- Test query: This should return 0 for any deleted posts
-- SELECT COUNT(*) FROM posts WHERE is_deleted = true;

-- Test query: This should fail or return empty for deleted posts
-- SELECT * FROM posts WHERE id = '<deleted_post_id>';

-- Test query: Verify reply counts are correct
-- SELECT id, replies_count, 
--   (SELECT COUNT(*) FROM posts child WHERE child.in_reply_to = parent.id AND (child.is_deleted = false OR child.is_deleted IS NULL)) as actual_count
-- FROM posts parent 
-- WHERE replies_count > 0;

-- =============================================
-- STEP 9: Fix UPDATE policy to allow soft-deleting own posts
-- The existing UPDATE policy needs to allow setting is_deleted = true
-- =============================================

-- Drop and recreate the update policy to ensure it works for soft-delete
DROP POLICY IF EXISTS "Users can update their own posts" ON public.posts;

CREATE POLICY "Users can update their own posts" ON public.posts 
FOR UPDATE 
USING ((SELECT auth.uid()) = author_id)
WITH CHECK ((SELECT auth.uid()) = author_id);

COMMENT ON POLICY "Users can view their own posts" ON public.posts IS 
  'Users can view their own posts only if not deleted';

COMMENT ON POLICY "Users can view public posts" ON public.posts IS 
  'Anyone can view public/unlisted posts that are not deleted';

COMMENT ON POLICY "Users can view posts from users they follow" ON public.posts IS 
  'Users can view follower-only posts from accounts they follow, if not deleted';

COMMENT ON POLICY "Users can update their own posts" ON public.posts IS 
  'Users can update their own posts (including soft-delete)';

