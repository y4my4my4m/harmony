-- =====================================================
-- Migration 017: Fix Content Format Validation
-- =====================================================
-- Issue: Posts failing with "invalid input syntax for type json" error
-- Root cause: HTML content being inserted instead of JSONB array
-- Solution: Ensure content format validation and investigate conversion issues

BEGIN;

-- =====================================================
-- STEP 1: Analyze existing content formats
-- =====================================================

-- Check what types of content we currently have
DO $$
DECLARE
    total_posts INTEGER;
    array_posts INTEGER;
    string_posts INTEGER;
    object_posts INTEGER;
    null_posts INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_posts FROM posts;
    SELECT COUNT(*) INTO array_posts FROM posts WHERE jsonb_typeof(content) = 'array';
    SELECT COUNT(*) INTO string_posts FROM posts WHERE jsonb_typeof(content) = 'string'; 
    SELECT COUNT(*) INTO object_posts FROM posts WHERE jsonb_typeof(content) = 'object';
    SELECT COUNT(*) INTO null_posts FROM posts WHERE content IS NULL;
    
    RAISE NOTICE 'Content Format Analysis:';
    RAISE NOTICE 'Total posts: %', total_posts;
    RAISE NOTICE 'Array format (correct): %', array_posts;
    RAISE NOTICE 'String format (legacy): %', string_posts;
    RAISE NOTICE 'Object format (invalid): %', object_posts;
    RAISE NOTICE 'Null content: %', null_posts;
END;
$$;

-- =====================================================
-- STEP 2: Create helper function to validate content format
-- =====================================================

CREATE OR REPLACE FUNCTION validate_post_content_format(content_input JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    -- Content must be a JSONB array
    IF jsonb_typeof(content_input) != 'array' THEN
        RETURN FALSE;
    END IF;
    
    -- Array must not be empty
    IF jsonb_array_length(content_input) = 0 THEN
        RETURN FALSE;
    END IF;
    
    -- Each element must be an object with a 'type' field
    -- This validates the MessagePart[] format
    FOR i IN 0..jsonb_array_length(content_input) - 1 LOOP
        IF jsonb_typeof(content_input -> i) != 'object' THEN
            RETURN FALSE;
        END IF;
        
        IF NOT (content_input -> i ? 'type') THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    
    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION validate_post_content_format(JSONB) IS 'Validates that post content follows the MessagePart[] array format required by the application';

-- =====================================================
-- STEP 3: Add trigger to validate content format on insert/update
-- =====================================================

CREATE OR REPLACE FUNCTION trigger_validate_post_content()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Skip validation for reblog posts (they have reblog content instead)
    IF NEW.reblog IS NOT NULL THEN
        RETURN NEW;
    END IF;
    
    -- Validate content format
    IF NOT validate_post_content_format(NEW.content) THEN
        RAISE EXCEPTION 'Invalid post content format. Content must be a non-empty JSONB array of MessagePart objects. Received: %', jsonb_typeof(NEW.content);
    END IF;
    
    RETURN NEW;
END;
$$;

-- Create trigger (only if it doesn't exist)
DROP TRIGGER IF EXISTS trigger_validate_post_content_format ON posts;
CREATE TRIGGER trigger_validate_post_content_format
    BEFORE INSERT OR UPDATE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION trigger_validate_post_content();

COMMENT ON TRIGGER trigger_validate_post_content_format ON posts IS 'Validates post content format to ensure MessagePart[] array structure';

-- =====================================================
-- STEP 4: Add debugging for content insertion issues
-- =====================================================

CREATE OR REPLACE FUNCTION debug_post_content_insertion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Log content format details for debugging
    RAISE NOTICE 'POST CONTENT DEBUG: type=%, length=%, first_element=%', 
        jsonb_typeof(NEW.content),
        CASE WHEN jsonb_typeof(NEW.content) = 'array' THEN jsonb_array_length(NEW.content) ELSE NULL END,
        CASE WHEN jsonb_typeof(NEW.content) = 'array' AND jsonb_array_length(NEW.content) > 0 THEN NEW.content -> 0 ELSE NULL END;
    
    RETURN NEW;
END;
$$;

-- Temporarily add debug trigger (can be removed after issue is resolved)
DROP TRIGGER IF EXISTS trigger_debug_post_content ON posts;
CREATE TRIGGER trigger_debug_post_content
    BEFORE INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION debug_post_content_insertion();

COMMENT ON TRIGGER trigger_debug_post_content ON posts IS 'Temporary debugging trigger for post content format issues';

-- =====================================================
-- STEP 5: Clean up any existing invalid content
-- =====================================================

-- Convert string content to MessagePart array format
UPDATE posts 
SET content = jsonb_build_array(
    jsonb_build_object('type', 'text', 'text', content #>> '{}')
)
WHERE jsonb_typeof(content) = 'string' 
AND content IS NOT NULL;

-- Log the cleanup
DO $$
DECLARE
    updated_count INTEGER;
BEGIN
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE 'Converted % string content posts to MessagePart array format', updated_count;
END;
$$;

COMMIT;