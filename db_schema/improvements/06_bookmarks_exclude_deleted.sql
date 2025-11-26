-- =============================================
-- Migration: Bookmarks should exclude deleted posts
-- Date: 2024-11-26
-- =============================================
-- 
-- Issue Fixed:
-- Bookmarks were showing deleted posts because the join
-- didn't filter out is_deleted = true posts.
-- =============================================

BEGIN;

-- =============================================
-- STEP 1: Create index for faster bookmark queries
-- =============================================

-- Index for bookmark interactions lookup
CREATE INDEX IF NOT EXISTS idx_post_interactions_bookmarks 
ON public.post_interactions (user_id, interaction_type, created_at DESC)
WHERE interaction_type = 'bookmark';

-- =============================================
-- STEP 2: Create a view for user bookmarks that excludes deleted posts
-- =============================================

DROP VIEW IF EXISTS public.user_bookmarks;

CREATE VIEW public.user_bookmarks AS
SELECT 
  pi.id as bookmark_id,
  pi.user_id,
  pi.post_id,
  pi.created_at as bookmarked_at,
  p.*
FROM public.post_interactions pi
JOIN public.posts p ON pi.post_id = p.id
WHERE pi.interaction_type = 'bookmark'
  AND (p.is_deleted = false OR p.is_deleted IS NULL);

-- Grant access
GRANT SELECT ON public.user_bookmarks TO authenticated;

COMMENT ON VIEW public.user_bookmarks IS 
  'User bookmarks view that automatically excludes deleted posts';

-- =============================================
-- STEP 3: Create RPC function to get bookmarks efficiently
-- =============================================

CREATE OR REPLACE FUNCTION public.get_user_bookmarks(
  p_user_id uuid,
  p_limit integer DEFAULT 20,
  p_cursor timestamp with time zone DEFAULT NULL
)
RETURNS TABLE (
  bookmark_id uuid,
  bookmarked_at timestamp with time zone,
  post_id uuid,
  content jsonb,
  author_id uuid,
  created_at timestamp with time zone,
  visibility text,
  favorites_count integer,
  reblogs_count integer,
  replies_count integer,
  author_username text,
  author_display_name text,
  author_avatar_url text,
  author_domain text,
  author_is_local boolean
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    pi.id as bookmark_id,
    pi.created_at as bookmarked_at,
    p.id as post_id,
    p.content,
    p.author_id,
    p.created_at,
    p.visibility,
    COALESCE(p.favorites_count, 0)::integer,
    COALESCE(p.reblogs_count, 0)::integer,
    COALESCE(p.replies_count, 0)::integer,
    pr.username as author_username,
    pr.display_name as author_display_name,
    pr.avatar_url as author_avatar_url,
    pr.domain as author_domain,
    pr.is_local as author_is_local
  FROM public.post_interactions pi
  JOIN public.posts p ON pi.post_id = p.id
  JOIN public.profiles pr ON p.author_id = pr.id
  WHERE pi.user_id = p_user_id
    AND pi.interaction_type = 'bookmark'
    AND (p.is_deleted = false OR p.is_deleted IS NULL)
    AND (p_cursor IS NULL OR pi.created_at < p_cursor)
  ORDER BY pi.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION public.get_user_bookmarks(uuid, integer, timestamp with time zone) IS 
  'Get user bookmarks efficiently, excluding deleted posts';

COMMIT;

-- =============================================
-- Verification queries
-- =============================================
-- 
-- Check bookmarks exclude deleted:
-- SELECT * FROM user_bookmarks WHERE user_id = 'your-user-id' LIMIT 10;
--
-- Test RPC function:
-- SELECT * FROM get_user_bookmarks('your-user-id', 10, NULL);

