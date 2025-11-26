-- =============================================
-- Migration: Auto-extract hashtags when posts are created
-- Date: 2024-11-26
-- =============================================
-- 
-- Issue Fixed:
-- Hashtags are not being extracted from posts automatically.
-- The process_post_hashtags function exists but is not being called.
-- Also: upsert_hashtag function was missing.
-- Also: extract_hashtags_from_content didn't handle 'hashtag' type parts.
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
  -- Normalize the tag (lowercase, trim, remove leading #)
  v_normalized_tag := lower(trim(regexp_replace(p_tag, '^#', '')));
  
  -- Try to find existing hashtag
  SELECT id INTO v_hashtag_id
  FROM public.hashtags
  WHERE normalized_tag = v_normalized_tag;
  
  -- If not found, insert new hashtag
  IF v_hashtag_id IS NULL THEN
    INSERT INTO public.hashtags (tag, normalized_tag, total_uses, first_used_at, last_used_at)
    VALUES (v_normalized_tag, v_normalized_tag, 1, NOW(), NOW())
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
-- STEP 0.5: Fix extract_hashtags_from_content to handle 'hashtag' type parts
-- =============================================

CREATE OR REPLACE FUNCTION public.extract_hashtags_from_content(p_content jsonb) 
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  hashtags TEXT[] := ARRAY[]::TEXT[];
  item JSONB;
  text_content TEXT;
  hashtag_text TEXT;
  match_record RECORD;
  result TEXT[];
BEGIN
  -- Return empty array if content is null or not an array
  IF p_content IS NULL OR jsonb_typeof(p_content) != 'array' THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  -- Extract from JSONB array format
  FOR item IN SELECT * FROM jsonb_array_elements(p_content)
  LOOP
    -- Handle dedicated hashtag type parts
    -- Check multiple possible field names: 'name', 'hashtag', 'normalized'
    IF item->>'type' = 'hashtag' THEN
      -- Try 'name' field first (this is the actual format used)
      hashtag_text := COALESCE(
        item->>'name',
        item->>'hashtag', 
        item->>'normalized'
      );
      IF hashtag_text IS NOT NULL AND hashtag_text != '' THEN
        -- Remove leading # if present
        hashtag_text := regexp_replace(hashtag_text, '^#', '');
        hashtags := array_append(hashtags, lower(hashtag_text));
      END IF;
    -- Also check for #hashtag patterns in text content
    ELSIF item->>'type' = 'text' THEN
      text_content := item->>'text';
      IF text_content IS NOT NULL THEN
        -- Use a loop to get all regex matches
        FOR match_record IN SELECT (regexp_matches(text_content, '#([a-zA-Z0-9_]+)', 'g'))[1] as tag
        LOOP
          IF match_record.tag IS NOT NULL THEN
            hashtags := array_append(hashtags, lower(match_record.tag));
          END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  -- Return unique hashtags (never NULL)
  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::TEXT[]) 
  INTO result
  FROM unnest(hashtags) t 
  WHERE t IS NOT NULL;
  
  RETURN COALESCE(result, ARRAY[]::TEXT[]);
END;
$$;

COMMENT ON FUNCTION public.extract_hashtags_from_content(jsonb) IS 
  'Extract hashtags from JSONB content array. Handles both hashtag-type parts and #text patterns. Never returns NULL.';

-- =============================================
-- STEP 0.6: Recreate process_post_hashtags with NULL handling
-- =============================================

CREATE OR REPLACE FUNCTION public.process_post_hashtags(p_post_id uuid, p_content jsonb) 
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_hashtag_array TEXT[];
    v_hashtag_text TEXT;
    v_hashtag_id UUID;
    v_position_counter INTEGER := 0;
    v_processed_count INTEGER := 0;
BEGIN
    -- Extract hashtags from content (returns empty array, never NULL)
    v_hashtag_array := public.extract_hashtags_from_content(p_content);
    
    -- Handle NULL case defensively
    IF v_hashtag_array IS NULL THEN
        v_hashtag_array := ARRAY[]::TEXT[];
    END IF;
    
    -- Return early if no hashtags
    IF array_length(v_hashtag_array, 1) IS NULL OR array_length(v_hashtag_array, 1) = 0 THEN
        RETURN 0;
    END IF;
    
    -- Process each hashtag
    FOREACH v_hashtag_text IN ARRAY v_hashtag_array LOOP
        v_position_counter := v_position_counter + 1;
        
        -- Upsert hashtag and get ID
        v_hashtag_id := public.upsert_hashtag(v_hashtag_text);
        
        -- Link post to hashtag
        INSERT INTO public.post_hashtags (post_id, hashtag_id, position_in_content)
        VALUES (p_post_id, v_hashtag_id, v_position_counter)
        ON CONFLICT (post_id, hashtag_id) DO NOTHING;
        
        v_processed_count := v_processed_count + 1;
    END LOOP;
    
    RETURN v_processed_count;
END;
$$;

COMMENT ON FUNCTION public.process_post_hashtags(uuid, jsonb) IS 
  'Process a post content to extract and link hashtags. Returns count of hashtags processed.';

-- =============================================
-- STEP 1: Create trigger function to extract hashtags on post insert
-- =============================================

CREATE OR REPLACE FUNCTION public.trigger_extract_post_hashtags()
RETURNS TRIGGER AS $$
BEGIN
  -- Only process if content is not null and is an array
  IF NEW.content IS NOT NULL AND jsonb_typeof(NEW.content) = 'array' THEN
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
-- STEP 3: Clear old data and reprocess all posts with hashtags
-- =============================================

-- Clear existing post_hashtags to reprocess with fixed function
DELETE FROM public.post_hashtags;

DO $$
DECLARE
  v_post RECORD;
  v_count INTEGER := 0;
  v_hashtag_count INTEGER := 0;
  v_total_hashtags INTEGER := 0;
BEGIN
  -- Process all posts that contain hashtag-type parts
  FOR v_post IN 
    SELECT p.id, p.content 
    FROM public.posts p
    WHERE p.content IS NOT NULL
    AND (p.is_deleted = false OR p.is_deleted IS NULL)
    AND jsonb_typeof(p.content) = 'array'
    -- Check if content contains hashtag parts or text with # 
    AND (
      p.content::text LIKE '%"type":"hashtag"%' 
      OR p.content::text LIKE '%#%'
    )
  LOOP
    BEGIN
      v_hashtag_count := public.process_post_hashtags(v_post.id, v_post.content);
      IF v_hashtag_count > 0 THEN
        v_count := v_count + 1;
        v_total_hashtags := v_total_hashtags + v_hashtag_count;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Error processing post %: %', v_post.id, SQLERRM;
    END;
  END LOOP;
  
  RAISE NOTICE 'Processed % hashtags from % posts', v_total_hashtags, v_count;
END $$;

-- =============================================
-- STEP 4: Verify and display hashtag counts
-- =============================================

DO $$
DECLARE
  v_hashtag_count INTEGER;
  v_post_hashtag_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_hashtag_count FROM public.hashtags;
  SELECT COUNT(*) INTO v_post_hashtag_count FROM public.post_hashtags;
  
  RAISE NOTICE 'Total hashtags: %, Total post-hashtag links: %', v_hashtag_count, v_post_hashtag_count;
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

