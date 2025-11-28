-- =====================================================
-- FIX: Duplicate Reply Count Triggers
-- =====================================================
-- 
-- PROBLEM: There are THREE triggers all updating replies_count on the same event,
-- causing the count to be incremented multiple times per reply:
--   1. update_post_reply_counter_trigger -> update_post_counters()
--   2. update_reply_count_on_post_insert_update -> update_post_reply_count()
--   3. update_reply_counts_trigger -> update_reply_counts()
--
-- SOLUTION: Keep only ONE accurate trigger (update_post_reply_count) that:
--   - Counts actual replies (excluding deleted)
--   - Handles INSERT, DELETE, and soft-delete (is_deleted update)
--
-- =====================================================

-- Step 1: Drop the duplicate/problematic triggers
-- =====================================================

-- Drop the old increment/decrement trigger (can cause negative counts, doesn't handle soft deletes)
DROP TRIGGER IF EXISTS update_post_reply_counter_trigger ON public.posts;
DROP TRIGGER IF EXISTS update_reply_counts_trigger ON public.posts;

-- Step 2: Ensure the accurate function exists
-- =====================================================
-- This function does a proper COUNT(*) of non-deleted replies

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

COMMENT ON FUNCTION public.update_post_reply_count() IS 'Accurately updates reply count by counting non-deleted replies. Handles INSERT, DELETE, and soft-delete scenarios.';

-- Step 3: Ensure triggers exist for all cases
-- =====================================================

-- Drop existing triggers to recreate them cleanly
DROP TRIGGER IF EXISTS update_reply_count_on_post_insert_update ON public.posts;
DROP TRIGGER IF EXISTS update_reply_count_on_post_delete ON public.posts;

-- Trigger for INSERT and soft-delete (is_deleted update)
CREATE TRIGGER update_reply_count_on_post_insert_update
    AFTER INSERT OR UPDATE OF is_deleted ON public.posts
    FOR EACH ROW
    WHEN (NEW.in_reply_to IS NOT NULL)
    EXECUTE FUNCTION public.update_post_reply_count();

-- Trigger for hard DELETE
CREATE TRIGGER update_reply_count_on_post_delete
    AFTER DELETE ON public.posts
    FOR EACH ROW
    WHEN (OLD.in_reply_to IS NOT NULL)
    EXECUTE FUNCTION public.update_post_reply_count();

-- Step 4: Drop the old redundant functions (if they exist and are no longer needed)
-- =====================================================

-- Keep update_post_counters() as it may be used for other things, but ensure it doesn't duplicate reply counting
-- Check if update_post_counters is still used for other purposes before dropping

-- Drop the simple increment/decrement function that can cause count drift
DROP FUNCTION IF EXISTS public.update_reply_counts() CASCADE;

-- Step 5: Fix any existing incorrect counts
-- =====================================================

-- Recalculate all reply counts to fix any existing discrepancies
-- Using IS DISTINCT FROM to properly handle NULL values
-- (NULL != 0 evaluates to NULL, but NULL IS DISTINCT FROM 0 evaluates to TRUE)
UPDATE public.posts p
SET replies_count = (
  SELECT COUNT(*) 
  FROM public.posts r 
  WHERE r.in_reply_to = p.id 
  AND (r.is_deleted = false OR r.is_deleted IS NULL)
)
WHERE p.replies_count IS DISTINCT FROM (
  SELECT COUNT(*) 
  FROM public.posts r 
  WHERE r.in_reply_to = p.id 
  AND (r.is_deleted = false OR r.is_deleted IS NULL)
);

-- Report how many posts were fixed
DO $$
DECLARE
  fixed_count INTEGER;
BEGIN
  GET DIAGNOSTICS fixed_count = ROW_COUNT;
  RAISE NOTICE 'Fixed % posts with incorrect reply counts', fixed_count;
END $$;

