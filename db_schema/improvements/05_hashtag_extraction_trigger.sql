-- =============================================
-- Migration: Auto-extract hashtags when posts are created
-- Date: 2024-11-26
-- =============================================
-- 
-- Issue Fixed:
-- Hashtags are not being extracted from posts automatically.
-- The process_post_hashtags function exists but is not being called.
-- Also: upsert_hashtag function was missing.
-- =============================================

BEGIN;

-- =============================================
-- STEP 0: Create missing upsert_hashtag function
-- =============================================

CREATE OR REPLACE FUNCTION public.upsert_hashtag(p_tag text)
RETURNS uuid AS $$
DECLARE
  v_hashtag_id uuid;
  v_normalized_tag text;
BEGIN
  -- Normalize the tag (lowercase, trim)
  v_normalized_tag := lower(trim(p_tag));
  
  -- Try to find existing hashtag
  SELECT id INTO v_hashtag_id
  FROM public.hashtags
  WHERE normalized_tag = v_normalized_tag;
  
  -- If not found, insert new hashtag
  IF v_hashtag_id IS NULL THEN
    INSERT INTO public.hashtags (tag, normalized_tag, total_uses, first_used_at, last_used_at)
    VALUES (p_tag, v_normalized_tag, 1, NOW(), NOW())
    ON CONFLICT (normalized_tag) DO UPDATE 
    SET 
      total_uses = hashtags.total_uses + 1,
      last_used_at = NOW()
    RETURNING id INTO v_hashtag_id;
  ELSE
    -- Update usage stats
    UPDATE public.hashtags
    SET 
      total_uses = total_uses + 1,
      last_used_at = NOW()
    WHERE id = v_hashtag_id;
  END IF;
  
  RETURN v_hashtag_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.upsert_hashtag(text) IS 
  'Insert or update a hashtag and return its ID. Updates usage counts on conflict.';

-- =============================================
-- STEP 1: Create trigger function to extract hashtags on post insert
-- =============================================

CREATE OR REPLACE FUNCTION public.trigger_extract_post_hashtags()
RETURNS TRIGGER AS $$
BEGIN
  -- Only process if content is not null
  IF NEW.content IS NOT NULL THEN
    PERFORM public.process_post_hashtags(NEW.id, NEW.content);
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.trigger_extract_post_hashtags() IS 
  'Trigger function to automatically extract hashtags from posts on insert.';

-- =============================================
-- STEP 2: Create trigger on posts table
-- =============================================

DROP TRIGGER IF EXISTS extract_hashtags_on_post_insert ON public.posts;

CREATE TRIGGER extract_hashtags_on_post_insert
  AFTER INSERT ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_extract_post_hashtags();

-- =============================================
-- STEP 3: Backfill existing posts (process any posts without hashtags)
-- =============================================

DO $$
DECLARE
  v_post RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_post IN 
    SELECT p.id, p.content 
    FROM public.posts p
    WHERE p.content IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.post_hashtags ph WHERE ph.post_id = p.id
    )
    AND jsonb_typeof(p.content) = 'array'
    LIMIT 1000 -- Process in batches
  LOOP
    PERFORM public.process_post_hashtags(v_post.id, v_post.content);
    v_count := v_count + 1;
  END LOOP;
  
  RAISE NOTICE 'Processed hashtags for % posts', v_count;
END $$;

COMMIT;

-- =============================================
-- Verification queries
-- =============================================
-- 
-- Check hashtag extraction works:
-- SELECT h.tag, COUNT(*) as uses
-- FROM post_hashtags ph
-- JOIN hashtags h ON ph.hashtag_id = h.id
-- GROUP BY h.tag
-- ORDER BY uses DESC
-- LIMIT 10;
--
-- Check trending hashtags function:
-- SELECT * FROM get_trending_hashtags(7, 10);

