-- Fix post content format and add constraints to prevent future issues
-- This prevents the root cause of JSON parse errors

-- STEP 1: Clean up existing data first
UPDATE posts 
SET content = CASE 
  WHEN jsonb_typeof(content) = 'string' THEN 
    jsonb_build_array(jsonb_build_object('type', 'text', 'text', content #>> '{}'))
  WHEN jsonb_typeof(content) = 'null' THEN 
    jsonb_build_array(jsonb_build_object('type', 'text', 'text', ''))
  WHEN jsonb_typeof(content) != 'array' THEN 
    jsonb_build_array(jsonb_build_object('type', 'text', 'text', content::text))
  ELSE content
END
WHERE jsonb_typeof(content) != 'array' OR jsonb_array_length(content) = 0;

-- STEP 2: Now add constraints to prevent future issues
ALTER TABLE posts ADD CONSTRAINT posts_content_is_array 
CHECK (jsonb_typeof(content) = 'array');

ALTER TABLE posts ADD CONSTRAINT posts_content_not_empty 
CHECK (jsonb_array_length(content) > 0);

-- Verify the fix worked
DO $$
DECLARE
  invalid_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO invalid_count 
  FROM posts 
  WHERE jsonb_typeof(content) != 'array' OR jsonb_array_length(content) = 0;
  
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'Still have % posts with invalid content format', invalid_count;
  ELSE
    RAISE NOTICE 'All posts now have valid JSONB array content format ✅';
  END IF;
END $$; 