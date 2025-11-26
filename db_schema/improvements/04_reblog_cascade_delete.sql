-- =============================================
-- Migration: Cascade Delete Reblogs When Original Post is Deleted
-- Date: 2024-11-26
-- =============================================
-- 
-- Issue Fixed:
-- When a post is deleted (soft-deleted), all reblogs of that post should also
-- be marked as deleted to maintain data consistency.
-- =============================================

BEGIN;

-- =============================================
-- STEP 1: Create trigger function to cascade delete reblogs
-- =============================================

CREATE OR REPLACE FUNCTION public.cascade_delete_reblogs()
RETURNS TRIGGER AS $$
BEGIN
  -- When a post is soft-deleted, mark all its reblogs as deleted too
  IF NEW.is_deleted = true AND (OLD.is_deleted = false OR OLD.is_deleted IS NULL) THEN
    UPDATE public.posts
    SET 
      is_deleted = true,
      deleted_at = NOW()
    WHERE 
      metadata->>'reblog_of' = OLD.id::text
      AND (is_deleted = false OR is_deleted IS NULL);
    
    -- Also remove the reblog interactions for this post
    UPDATE public.post_interactions
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{cascade_deleted}', 'true'::jsonb)
    WHERE 
      post_id = OLD.id 
      AND interaction_type = 'reblog';
    
    RAISE NOTICE 'Cascade deleted reblogs of post %', OLD.id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.cascade_delete_reblogs() IS 
  'When a post is soft-deleted, automatically soft-delete all reblogs of that post.';

-- =============================================
-- STEP 2: Create trigger for cascade reblog deletion
-- =============================================

DROP TRIGGER IF EXISTS cascade_delete_reblogs_trigger ON public.posts;

CREATE TRIGGER cascade_delete_reblogs_trigger
  AFTER UPDATE OF is_deleted ON public.posts
  FOR EACH ROW
  WHEN (NEW.is_deleted = true AND (OLD.is_deleted = false OR OLD.is_deleted IS NULL))
  EXECUTE FUNCTION public.cascade_delete_reblogs();

-- =============================================
-- STEP 3: Create index for efficient reblog lookups
-- =============================================

CREATE INDEX IF NOT EXISTS idx_posts_reblog_of 
ON public.posts ((metadata->>'reblog_of'))
WHERE metadata->>'reblog_of' IS NOT NULL;

-- =============================================
-- STEP 4: Update reblogs_count trigger to exclude deleted reblogs
-- =============================================

CREATE OR REPLACE FUNCTION public.update_post_reblog_count()
RETURNS TRIGGER AS $$
DECLARE
  original_post_id uuid;
BEGIN
  -- Get the original post ID from the reblog
  IF TG_OP = 'DELETE' THEN
    original_post_id := (OLD.metadata->>'reblog_of')::uuid;
  ELSE
    original_post_id := (NEW.metadata->>'reblog_of')::uuid;
  END IF;
  
  -- If no original post, nothing to update
  IF original_post_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  
  -- Update the original post's reblog count (excluding deleted reblogs)
  UPDATE public.posts 
  SET reblogs_count = (
    SELECT COUNT(*) FROM public.posts 
    WHERE metadata->>'reblog_of' = original_post_id::text
    AND (is_deleted = false OR is_deleted IS NULL)
  )
  WHERE id = original_post_id;
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create triggers for reblog count updates
DROP TRIGGER IF EXISTS update_reblog_count_on_post_insert ON public.posts;
DROP TRIGGER IF EXISTS update_reblog_count_on_post_update ON public.posts;
DROP TRIGGER IF EXISTS update_reblog_count_on_post_delete ON public.posts;

CREATE TRIGGER update_reblog_count_on_post_insert
  AFTER INSERT ON public.posts
  FOR EACH ROW
  WHEN (NEW.metadata->>'reblog_of' IS NOT NULL)
  EXECUTE FUNCTION public.update_post_reblog_count();

CREATE TRIGGER update_reblog_count_on_post_update
  AFTER UPDATE OF is_deleted ON public.posts
  FOR EACH ROW
  WHEN (NEW.metadata->>'reblog_of' IS NOT NULL OR OLD.metadata->>'reblog_of' IS NOT NULL)
  EXECUTE FUNCTION public.update_post_reblog_count();

CREATE TRIGGER update_reblog_count_on_post_delete
  AFTER DELETE ON public.posts
  FOR EACH ROW
  WHEN (OLD.metadata->>'reblog_of' IS NOT NULL)
  EXECUTE FUNCTION public.update_post_reblog_count();

-- =============================================
-- STEP 5: Fix existing reblog counts (one-time cleanup)
-- =============================================

UPDATE public.posts original
SET reblogs_count = (
  SELECT COUNT(*) 
  FROM public.posts reblog
  WHERE reblog.metadata->>'reblog_of' = original.id::text
  AND (reblog.is_deleted = false OR reblog.is_deleted IS NULL)
)
WHERE EXISTS (
  SELECT 1 FROM public.posts reblog 
  WHERE reblog.metadata->>'reblog_of' = original.id::text
);

COMMIT;

-- =============================================
-- Verification queries (run manually to verify)
-- =============================================
-- 
-- Check reblog counts:
-- SELECT id, content, reblogs_count FROM posts WHERE reblogs_count > 0 LIMIT 5;
--
-- Test cascade delete:
-- 1. Create a post
-- 2. Reblog it
-- 3. Delete the original post
-- 4. Verify the reblog is also deleted

