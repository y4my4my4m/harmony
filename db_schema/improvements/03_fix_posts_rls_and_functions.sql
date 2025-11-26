-- =============================================
-- Migration: Fix Posts RLS Policies and Missing Functions
-- Date: 2024-11-26
-- =============================================
-- 
-- Issues Fixed:
-- 1. Posts RLS policies incorrectly compare auth.uid() with author_id
--    (author_id is a profile UUID, not auth user UUID)
-- 2. Missing get_activitypub_conversation_root function
-- 3. Reply counts including deleted posts
-- =============================================

BEGIN;

-- =============================================
-- STEP 1: Ensure index exists for efficient auth_user_id lookup
-- =============================================

CREATE INDEX IF NOT EXISTS idx_profiles_auth_user_id_unique 
ON public.profiles (auth_user_id) 
WHERE auth_user_id IS NOT NULL;

-- =============================================
-- STEP 2: Create helper function to get current user's profile ID
-- This is cached (STABLE) and uses indexed lookup - very efficient
-- =============================================

CREATE OR REPLACE FUNCTION public.get_current_profile_id()
RETURNS uuid AS $$
  SELECT id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1
$$ LANGUAGE sql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION public.get_current_profile_id() IS 
  'Returns the profile ID for the currently authenticated user. Uses indexed lookup on auth_user_id. Marked STABLE for query planner optimization.';

-- =============================================
-- STEP 3: Fix SELECT policies for posts
-- =============================================

-- Drop existing SELECT policies
DROP POLICY IF EXISTS "Users can view their own posts" ON public.posts;
DROP POLICY IF EXISTS "Users can view public posts" ON public.posts;
DROP POLICY IF EXISTS "Users can view posts from users they follow" ON public.posts;

-- Recreate with proper profile ID check
CREATE POLICY "Users can view their own posts" ON public.posts 
FOR SELECT 
USING (
  author_id = public.get_current_profile_id()
);

CREATE POLICY "Users can view public posts" ON public.posts 
FOR SELECT 
USING (
  visibility IN ('public', 'unlisted') 
  AND (is_deleted = false OR is_deleted IS NULL)
);

CREATE POLICY "Users can view posts from users they follow" ON public.posts 
FOR SELECT 
USING (
  visibility = 'followers'
  AND (is_deleted = false OR is_deleted IS NULL)
  AND EXISTS (
    SELECT 1 FROM public.follows
    WHERE follows.follower_id = public.get_current_profile_id()
    AND follows.following_id = posts.author_id
    AND follows.status = 'accepted'
  )
);

-- =============================================
-- STEP 4: Fix INSERT policy for posts
-- =============================================

DROP POLICY IF EXISTS "Users can create their own posts" ON public.posts;

CREATE POLICY "Users can create their own posts" ON public.posts 
FOR INSERT 
WITH CHECK (author_id = public.get_current_profile_id());

-- =============================================
-- STEP 5: Fix UPDATE policy for posts (soft-delete)
-- =============================================

DROP POLICY IF EXISTS "Users can update their own posts" ON public.posts;

CREATE POLICY "Users can update their own posts" ON public.posts 
FOR UPDATE 
USING (author_id = public.get_current_profile_id())
WITH CHECK (author_id = public.get_current_profile_id());

-- =============================================
-- STEP 6: Fix DELETE policy for posts
-- =============================================

DROP POLICY IF EXISTS "Users can delete their own posts" ON public.posts;

CREATE POLICY "Users can delete their own posts" ON public.posts 
FOR DELETE 
USING (author_id = public.get_current_profile_id());

-- =============================================
-- STEP 7: Fix post_interactions policies
-- =============================================

DROP POLICY IF EXISTS "Users can view post interactions on posts they can see" ON public.post_interactions;
DROP POLICY IF EXISTS "Users can create post interactions on posts they can see" ON public.post_interactions;

CREATE POLICY "Users can view post interactions on posts they can see" ON public.post_interactions 
FOR SELECT 
USING (
  post_id IN (
    SELECT p.id FROM public.posts p
    WHERE (p.is_deleted = false OR p.is_deleted IS NULL)
    AND (
      p.author_id = public.get_current_profile_id()
      OR p.visibility IN ('public', 'unlisted')
      OR (
        p.visibility = 'followers' 
        AND EXISTS (
          SELECT 1 FROM public.follows f
          WHERE f.follower_id = public.get_current_profile_id()
          AND f.following_id = p.author_id
          AND f.status = 'accepted'
        )
      )
    )
  )
);

CREATE POLICY "Users can create post interactions on posts they can see" ON public.post_interactions 
FOR INSERT 
WITH CHECK (
  user_id = public.get_current_profile_id()
  AND post_id IN (
    SELECT p.id FROM public.posts p
    WHERE (p.is_deleted = false OR p.is_deleted IS NULL)
    AND (
      p.author_id = public.get_current_profile_id()
      OR p.visibility IN ('public', 'unlisted')
      OR (
        p.visibility = 'followers' 
        AND EXISTS (
          SELECT 1 FROM public.follows f
          WHERE f.follower_id = public.get_current_profile_id()
          AND f.following_id = p.author_id
          AND f.status = 'accepted'
        )
      )
    )
  )
);

-- =============================================
-- STEP 7: Create missing get_activitypub_conversation_root function
-- =============================================

CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_root(post_id uuid)
RETURNS TABLE(root_id uuid) AS $$
DECLARE
  current_id uuid := post_id;
  parent_id uuid;
  max_depth int := 100; -- Prevent infinite loops
  depth int := 0;
BEGIN
  LOOP
    -- Get the parent post ID
    SELECT in_reply_to INTO parent_id
    FROM public.posts
    WHERE id = current_id;
    
    -- If no parent, we've found the root
    IF parent_id IS NULL THEN
      RETURN QUERY SELECT current_id;
      RETURN;
    END IF;
    
    -- Move to parent
    current_id := parent_id;
    depth := depth + 1;
    
    -- Safety check
    IF depth >= max_depth THEN
      RETURN QUERY SELECT current_id;
      RETURN;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION public.get_activitypub_conversation_root(uuid) IS 
  'Finds the root post of a conversation thread by following in_reply_to chain. Returns table with root_id column.';

-- =============================================
-- STEP 8: Fix reply count trigger to exclude deleted posts
-- =============================================

CREATE OR REPLACE FUNCTION public.update_post_reply_count()
RETURNS TRIGGER AS $$
DECLARE
  parent_post_id uuid;
BEGIN
  -- Determine the parent post ID based on operation type
  IF TG_OP = 'DELETE' THEN
    parent_post_id := OLD.in_reply_to;
  ELSE
    parent_post_id := NEW.in_reply_to;
  END IF;
  
  -- If there's no parent, nothing to update
  IF parent_post_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  
  -- Update the parent post's reply count (excluding deleted replies)
  UPDATE public.posts 
  SET replies_count = (
    SELECT COUNT(*) FROM public.posts 
    WHERE in_reply_to = parent_post_id 
    AND (is_deleted = false OR is_deleted IS NULL)
  )
  WHERE id = parent_post_id;
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create triggers for reply count updates
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

-- =============================================
-- STEP 9: Fix existing reply counts (one-time cleanup)
-- =============================================

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

-- =============================================
-- STEP 10: Create index for better query performance
-- =============================================

CREATE INDEX IF NOT EXISTS idx_posts_not_deleted 
ON public.posts (created_at DESC) 
WHERE is_deleted = false OR is_deleted IS NULL;

CREATE INDEX IF NOT EXISTS idx_posts_visible_public
ON public.posts (created_at DESC)
WHERE (is_deleted = false OR is_deleted IS NULL) 
  AND visibility IN ('public', 'unlisted');

COMMIT;

-- =============================================
-- Verification queries (run manually to verify)
-- =============================================
-- 
-- Check that get_current_profile_id works:
-- SELECT public.get_current_profile_id();
--
-- Check that you can see your own posts:
-- SELECT id, content FROM posts WHERE author_id = public.get_current_profile_id() LIMIT 5;
--
-- Test soft-delete:
-- UPDATE posts SET is_deleted = true, deleted_at = NOW() 
-- WHERE id = 'your-post-id' AND author_id = public.get_current_profile_id();

