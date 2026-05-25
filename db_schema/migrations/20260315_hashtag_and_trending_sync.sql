-- =============================================================================
-- Migration: Hashtag MessagePart Extraction + Trending Posts Cron
-- =============================================================================
-- Fixes two schema divergence issues between init-based and dev_backup-based DBs:
--
-- 1. HASHTAGS (spacify / init): Init's trigger only extracts #hashtag from text
--    parts. Federated posts store hashtags as {type:'hashtag', name:'xyz'}
--    MessageParts. This adds extract_hashtags_from_content, upsert_hashtag,
--    process_post_hashtags and delegates the trigger to handle both formats.
--
-- 2. TRENDING (har.mony.lol / dev_backup): trending_posts is populated by
--    update_trending_posts() via pg_cron. If 20260309 wasn't run or pg_cron
--    failed, the table stays empty. This ensures pg_cron is scheduled and runs
--    update_trending_posts once immediately.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. HASHTAG EXTRACTION - Add position_in_content for process_post_hashtags
-- ---------------------------------------------------------------------------
ALTER TABLE public.post_hashtags 
  ADD COLUMN IF NOT EXISTS position_in_content integer DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. extract_hashtags_from_content - Handles MessagePart format + #text
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.extract_hashtags_from_content(p_content jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  hashtags TEXT[] := ARRAY[]::TEXT[];
  item JSONB;
  text_content TEXT;
  hashtag_text TEXT;
  match_record RECORD;
  result TEXT[];
BEGIN
  IF p_content IS NULL OR jsonb_typeof(p_content) != 'array' THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_content)
  LOOP
    IF item->>'type' = 'hashtag' THEN
      hashtag_text := COALESCE(
        item->>'name',
        item->>'hashtag', 
        item->>'normalized'
      );
      IF hashtag_text IS NOT NULL AND hashtag_text != '' THEN
        hashtag_text := regexp_replace(hashtag_text, '^#', '');
        hashtags := array_append(hashtags, lower(hashtag_text));
      END IF;
    ELSIF item->>'type' = 'text' THEN
      text_content := item->>'text';
      IF text_content IS NOT NULL THEN
        FOR match_record IN SELECT (regexp_matches(text_content, '#([a-zA-Z0-9_]+)', 'g'))[1] as tag
        LOOP
          IF match_record.tag IS NOT NULL THEN
            hashtags := array_append(hashtags, lower(match_record.tag));
          END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::TEXT[]) 
  INTO result
  FROM unnest(hashtags) t 
  WHERE t IS NOT NULL;
  
  RETURN COALESCE(result, ARRAY[]::TEXT[]);
END;
$$;

COMMENT ON FUNCTION public.extract_hashtags_from_content(jsonb) IS 
'Extract hashtags from JSONB content array. Handles both hashtag-type MessageParts and #text patterns.';

-- ---------------------------------------------------------------------------
-- 3. upsert_hashtag - Insert or update hashtag, return ID
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_hashtag(p_tag text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_hashtag_id uuid;
  v_normalized_tag text;
BEGIN
  v_normalized_tag := lower(trim(regexp_replace(p_tag, '^#', '')));
  
  SELECT id INTO v_hashtag_id
  FROM public.hashtags
  WHERE normalized_tag = v_normalized_tag;
  
  IF v_hashtag_id IS NULL THEN
    INSERT INTO public.hashtags (tag, normalized_tag, total_uses, daily_uses, first_used_at, last_used_at)
    VALUES (v_normalized_tag, v_normalized_tag, 1, 1, NOW(), NOW())
    ON CONFLICT (normalized_tag) DO UPDATE 
    SET 
      total_uses = hashtags.total_uses + 1,
      daily_uses = COALESCE(hashtags.daily_uses, 0) + 1,
      last_used_at = NOW()
    RETURNING id INTO v_hashtag_id;
  ELSE
    UPDATE public.hashtags
    SET 
      total_uses = total_uses + 1,
      daily_uses = COALESCE(daily_uses, 0) + 1,
      last_used_at = NOW()
    WHERE id = v_hashtag_id;
  END IF;
  
  RETURN v_hashtag_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_hashtag(text) IS 
'Insert or update a hashtag and return its ID. Updates usage counts on conflict.';

-- ---------------------------------------------------------------------------
-- 4. process_post_hashtags - Extract and link hashtags from content
-- ---------------------------------------------------------------------------
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
    v_hashtag_array := public.extract_hashtags_from_content(p_content);
    
    IF v_hashtag_array IS NULL THEN
        v_hashtag_array := ARRAY[]::TEXT[];
    END IF;
    
    IF array_length(v_hashtag_array, 1) IS NULL OR array_length(v_hashtag_array, 1) = 0 THEN
        RETURN 0;
    END IF;
    
    FOREACH v_hashtag_text IN ARRAY v_hashtag_array LOOP
        v_position_counter := v_position_counter + 1;
        v_hashtag_id := public.upsert_hashtag(v_hashtag_text);
        
        INSERT INTO public.post_hashtags (post_id, hashtag_id, position_in_content)
        VALUES (p_post_id, v_hashtag_id, v_position_counter)
        ON CONFLICT (post_id, hashtag_id) DO NOTHING;
        
        v_processed_count := v_processed_count + 1;
    END LOOP;
    
    RETURN v_processed_count;
END;
$$;

COMMENT ON FUNCTION public.process_post_hashtags(uuid, jsonb) IS 
'Process post content to extract and link hashtags. Returns count of hashtags processed.';

-- ---------------------------------------------------------------------------
-- 5. trigger_extract_post_hashtags - Delegate to process_post_hashtags
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_extract_post_hashtags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.content IS NOT NULL AND jsonb_typeof(NEW.content) = 'array' THEN
    PERFORM public.process_post_hashtags(NEW.id, NEW.content);
  END IF;
  
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trigger_extract_post_hashtags() IS 
'Trigger function to automatically extract hashtags from posts on insert. Handles MessagePart format and #text.';

-- ---------------------------------------------------------------------------
-- 6. TRENDING - Ensure update_trending_posts exists, run once, schedule cron
-- ---------------------------------------------------------------------------
-- Run update_trending_posts immediately (populates table for har.mony.lol)
DO $migrate$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_trending_posts') THEN
    PERFORM public.update_trending_posts();
    RAISE NOTICE 'update_trending_posts executed';
  ELSE
    RAISE NOTICE 'update_trending_posts does not exist - ensure 13_functions_rpc_extended or equivalent is loaded';
  END IF;
END;
$migrate$ LANGUAGE plpgsql;

-- Schedule pg_cron jobs (idempotent: unschedule first if exists)
DO $migrate$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('update-trending-posts');
    PERFORM cron.unschedule('update-hashtag-scores');
    PERFORM cron.unschedule('reset-daily-hashtag-counters');
    PERFORM cron.schedule(
      'update-trending-posts',
      '*/15 * * * *',
      'SELECT public.update_trending_posts()'
    );
    PERFORM cron.schedule(
      'update-hashtag-scores',
      '0 * * * *',
      'SELECT public.update_hashtag_trending_scores()'
    );
    PERFORM cron.schedule(
      'reset-daily-hashtag-counters',
      '0 0 * * *',
      'SELECT public.reset_daily_hashtag_counters()'
    );
    RAISE NOTICE 'pg_cron jobs scheduled for trending updates';
  ELSE
    RAISE NOTICE 'pg_cron not available - run update_trending_posts() manually or via external scheduler';
  END IF;
END;
$migrate$ LANGUAGE plpgsql;

NOTIFY pgrst, 'reload schema';

COMMIT;
