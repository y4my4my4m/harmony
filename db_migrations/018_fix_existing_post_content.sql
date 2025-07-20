-- =====================================================
-- Migration 017b: Fix Existing Post Content
-- =====================================================
-- Issue: Existing posts have invalid content that violates new constraint
-- Solution: Convert existing invalid content to proper MessagePart[] format
-- Run this BEFORE migration 018

BEGIN;

-- =====================================================
-- STEP 1: Analyze current content types
-- =====================================================

DO $$
DECLARE
    total_posts INTEGER;
    array_posts INTEGER;
    string_posts INTEGER;
    object_posts INTEGER;
    null_posts INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_posts FROM posts;
    
    SELECT COUNT(*) INTO array_posts 
    FROM posts 
    WHERE jsonb_typeof(content) = 'array';
    
    SELECT COUNT(*) INTO string_posts 
    FROM posts 
    WHERE jsonb_typeof(content) = 'string';
    
    SELECT COUNT(*) INTO object_posts 
    FROM posts 
    WHERE jsonb_typeof(content) = 'object';
    
    SELECT COUNT(*) INTO null_posts 
    FROM posts 
    WHERE content IS NULL OR jsonb_typeof(content) = 'null';
    
    RAISE NOTICE 'Pre-migration content analysis:';
    RAISE NOTICE 'Total posts: %', total_posts;
    RAISE NOTICE 'Array format (correct): %', array_posts;
    RAISE NOTICE 'String format (needs fixing): %', string_posts;
    RAISE NOTICE 'Object format (needs fixing): %', object_posts;
    RAISE NOTICE 'Null content (needs fixing): %', null_posts;
END
$$;

-- =====================================================
-- STEP 2: Fix string content
-- =====================================================

-- Convert string content to proper MessagePart array
UPDATE posts 
SET content = jsonb_build_array(
    jsonb_build_object(
        'type', 'text', 
        'text', content #>> '{}'
    )
)
WHERE jsonb_typeof(content) = 'string' 
AND content IS NOT NULL
AND length(content #>> '{}') > 0;

-- =====================================================
-- STEP 3: Fix object content (single MessagePart)
-- =====================================================

-- Convert object content to array format
UPDATE posts 
SET content = jsonb_build_array(content)
WHERE jsonb_typeof(content) = 'object' 
AND content IS NOT NULL
AND (content ? 'type');

-- =====================================================
-- STEP 4: Fix null or empty content
-- =====================================================

-- Set default content for null/empty posts
UPDATE posts 
SET content = jsonb_build_array(
    jsonb_build_object(
        'type', 'text', 
        'text', '[Content unavailable]'
    )
)
WHERE content IS NULL 
OR jsonb_typeof(content) = 'null'
OR (jsonb_typeof(content) = 'string' AND length(content #>> '{}') = 0);

-- =====================================================
-- STEP 5: Fix any remaining invalid content
-- =====================================================

-- Convert any remaining invalid content to default text
UPDATE posts 
SET content = jsonb_build_array(
    jsonb_build_object(
        'type', 'text', 
        'text', COALESCE(content::text, '[Content unavailable]')
    )
)
WHERE jsonb_typeof(content) != 'array';

-- =====================================================
-- STEP 6: Post-migration analysis
-- =====================================================

DO $$
DECLARE
    total_posts INTEGER;
    array_posts INTEGER;
    fixed_posts INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_posts FROM posts;
    
    SELECT COUNT(*) INTO array_posts 
    FROM posts 
    WHERE jsonb_typeof(content) = 'array';
    
    fixed_posts := total_posts - array_posts;
    
    RAISE NOTICE 'Post-migration content analysis:';
    RAISE NOTICE 'Total posts: %', total_posts;
    RAISE NOTICE 'Array format (correct): %', array_posts;
    RAISE NOTICE 'Fixed posts: %', fixed_posts;
    
    IF array_posts = total_posts THEN
        RAISE NOTICE 'SUCCESS: All posts now have correct JSONB array format';
    ELSE
        RAISE NOTICE 'WARNING: % posts still need fixing', (total_posts - array_posts);
    END IF;
END
$$;

COMMIT;

-- =====================================================
-- VERIFICATION QUERY
-- =====================================================
-- Run this to verify all content is now valid:
-- SELECT 
--   id, 
--   jsonb_typeof(content) as content_type,
--   jsonb_array_length(content) as array_length,
--   content->0->>'type' as first_element_type
-- FROM posts 
-- WHERE jsonb_typeof(content) != 'array' 
-- LIMIT 5;