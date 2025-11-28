-- =============================================
-- RLS POLICIES: SUSPENDED USER FILTERING
-- Date: 2025-11-28
-- =============================================
-- 
-- Updates RLS policies to filter out:
-- 1. Posts from suspended users (for all viewers)
-- 2. Ensures is_deleted check is consistently applied
-- 
-- This is defense-in-depth - even if RPC/frontend code has bugs,
-- the database will never return posts from suspended users.
-- =============================================

BEGIN;

-- =============================================
-- HELPER FUNCTION: Check if author is suspended
-- =============================================

CREATE OR REPLACE FUNCTION public.is_author_suspended(p_author_id UUID)
RETURNS BOOLEAN AS $$
  SELECT COALESCE(is_suspended, false) 
  FROM public.profiles 
  WHERE id = p_author_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION public.is_author_suspended IS 
  'Returns true if the post author is suspended. Used by RLS policies.';

-- =============================================
-- POSTS TABLE: Update SELECT policies
-- =============================================

-- Policy 1: Users viewing their own posts
-- Even own posts shouldn't be visible if user is suspended (prevents API access)
DROP POLICY IF EXISTS "Users can view their own posts" ON public.posts;

CREATE POLICY "Users can view their own posts" ON public.posts 
FOR SELECT 
USING (
  author_id = public.get_current_profile_id()
  AND (is_deleted = false OR is_deleted IS NULL)
  AND NOT public.is_author_suspended(author_id)
);

COMMENT ON POLICY "Users can view their own posts" ON public.posts IS 
  'Users can view their own posts only if not deleted and not suspended';

-- Policy 2: Anyone viewing public/unlisted posts
DROP POLICY IF EXISTS "Users can view public posts" ON public.posts;

CREATE POLICY "Users can view public posts" ON public.posts 
FOR SELECT 
USING (
  visibility IN ('public', 'unlisted') 
  AND (is_deleted = false OR is_deleted IS NULL)
  AND NOT public.is_author_suspended(author_id)
);

COMMENT ON POLICY "Users can view public posts" ON public.posts IS 
  'Anyone can view public/unlisted posts that are not deleted and author is not suspended';

-- Policy 3: Users viewing posts from accounts they follow
DROP POLICY IF EXISTS "Users can view posts from users they follow" ON public.posts;

CREATE POLICY "Users can view posts from users they follow" ON public.posts 
FOR SELECT 
USING (
  visibility = 'followers'
  AND (is_deleted = false OR is_deleted IS NULL)
  AND NOT public.is_author_suspended(author_id)
  AND EXISTS (
    SELECT 1 FROM public.follows
    WHERE follows.follower_id = public.get_current_profile_id()
    AND follows.following_id = posts.author_id
    AND follows.status = 'accepted'
  )
);

COMMENT ON POLICY "Users can view posts from users they follow" ON public.posts IS 
  'Users can view follower-only posts from followed accounts, if not deleted and author not suspended';

-- =============================================
-- POST_INTERACTIONS TABLE: Update policies
-- =============================================

DROP POLICY IF EXISTS "Users can view post interactions on posts they can see" ON public.post_interactions;

CREATE POLICY "Users can view post interactions on posts they can see" ON public.post_interactions 
FOR SELECT 
USING (
  post_id IN (
    SELECT p.id FROM public.posts p
    WHERE (p.is_deleted = false OR p.is_deleted IS NULL)
    AND NOT public.is_author_suspended(p.author_id)
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

DROP POLICY IF EXISTS "Users can create post interactions on posts they can see" ON public.post_interactions;

CREATE POLICY "Users can create post interactions on posts they can see" ON public.post_interactions 
FOR INSERT 
WITH CHECK (
  user_id = public.get_current_profile_id()
  AND post_id IN (
    SELECT p.id FROM public.posts p
    WHERE (p.is_deleted = false OR p.is_deleted IS NULL)
    AND NOT public.is_author_suspended(p.author_id)
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
-- PROFILES TABLE: Prevent viewing suspended profiles
-- =============================================

-- Check if profiles has RLS enabled
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables 
    WHERE tablename = 'profiles' 
    AND rowsecurity = true
  ) THEN
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Drop existing profile viewing policies if they exist
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
DROP POLICY IF EXISTS "Anyone can view profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can view non-suspended profiles" ON public.profiles;

-- Create policy that hides suspended profiles from public view
-- Exception: users can always see their own profile
CREATE POLICY "Users can view non-suspended profiles" ON public.profiles
FOR SELECT
USING (
  -- Users can always see their own profile
  id = public.get_current_profile_id()
  -- Or profile is not suspended
  OR (is_suspended = false OR is_suspended IS NULL)
);

COMMENT ON POLICY "Users can view non-suspended profiles" ON public.profiles IS 
  'Users can view their own profile or any non-suspended profile';

-- Ensure users can still update their own profile
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

CREATE POLICY "Users can update own profile" ON public.profiles
FOR UPDATE
USING (id = public.get_current_profile_id())
WITH CHECK (id = public.get_current_profile_id());

-- =============================================
-- TIMELINE_ENTRIES TABLE: Filter suspended users
-- =============================================

DROP POLICY IF EXISTS "Users can view their timeline entries" ON public.timeline_entries;

CREATE POLICY "Users can view their timeline entries" ON public.timeline_entries
FOR SELECT
USING (
  user_id = public.get_current_profile_id()
  AND post_id IN (
    SELECT p.id FROM public.posts p
    WHERE (p.is_deleted = false OR p.is_deleted IS NULL)
    AND NOT public.is_author_suspended(p.author_id)
  )
);

COMMIT;

-- =============================================
-- VERIFICATION QUERIES (run manually to verify)
-- =============================================
-- 
-- Test that suspended user posts are hidden:
-- 
-- 1. Suspend a test user:
--    UPDATE profiles SET is_suspended = true WHERE username = 'testuser';
--
-- 2. Try to fetch their posts (should return 0):
--    SELECT * FROM posts WHERE author_id = (SELECT id FROM profiles WHERE username = 'testuser');
--
-- 3. Unsuspend:
--    UPDATE profiles SET is_suspended = false WHERE username = 'testuser';
-- =============================================

