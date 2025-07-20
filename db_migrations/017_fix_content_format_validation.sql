-- =====================================================
-- Migration 017: Fix Content Format Validation
-- =====================================================
-- Issue: Posts failing with "invalid input syntax for type json" error
-- Root cause: Federation trigger interfering with JSONB content insertion
-- Solution: Disable problematic triggers and ensure proper content storage

BEGIN;

-- =====================================================
-- STEP 1: Disable problematic triggers temporarily
-- =====================================================

-- The federation trigger was causing content insertion issues
-- These triggers try to read content immediately after insertion
-- which conflicts with JSONB serialization timing
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;
DROP TRIGGER IF EXISTS trigger_unified_notification_posts ON posts;

-- =====================================================
-- STEP 2: Analyze existing content formats
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
    
    RAISE NOTICE 'Content format analysis:';
    RAISE NOTICE 'Total posts: %', total_posts;
    RAISE NOTICE 'Array format (correct): %', array_posts;
    RAISE NOTICE 'String format (incorrect): %', string_posts;
    RAISE NOTICE 'Object format (incorrect): %', object_posts;
    RAISE NOTICE 'Null content: %', null_posts;
    
    IF string_posts > 0 OR object_posts > 0 THEN
        RAISE NOTICE 'WARNING: Found posts with incorrect content format that need migration';
    ELSE
        RAISE NOTICE 'SUCCESS: All posts have correct JSONB array format';
    END IF;
END
$$;

-- =====================================================
-- STEP 3: Fix invalid content before adding constraint
-- =====================================================

-- First, let's identify and fix any invalid content
DO $$
DECLARE
    invalid_post RECORD;
    fixed_count INTEGER := 0;
BEGIN
    RAISE NOTICE 'Checking for invalid post content...';
    
    -- Find posts with invalid content (using same validation as local environment)
    FOR invalid_post IN 
        SELECT id, content, jsonb_typeof(content) as content_type
        FROM posts 
        WHERE NOT (jsonb_typeof(content) = 'array' AND (jsonb_array_length(content) > 0 OR reblog IS NOT NULL))
        LIMIT 10  -- Limit to avoid too much output
    LOOP
        RAISE NOTICE 'Invalid post ID: %, Content type: %', invalid_post.id, invalid_post.content_type;
        
        -- Try to fix common issues
        IF jsonb_typeof(invalid_post.content) = 'string' THEN
            -- Convert string content to proper MessagePart array
            UPDATE posts 
            SET content = jsonb_build_array(
                jsonb_build_object(
                    'type', 'text',
                    'text', invalid_post.content #>> '{}'
                )
            )
            WHERE id = invalid_post.id;
            fixed_count := fixed_count + 1;
            RAISE NOTICE 'Fixed string content for post %', invalid_post.id;
            
        ELSIF jsonb_typeof(invalid_post.content) = 'object' THEN
            -- If it's an object but not an array, wrap it
            UPDATE posts 
            SET content = jsonb_build_array(invalid_post.content)
            WHERE id = invalid_post.id;
            fixed_count := fixed_count + 1;
            RAISE NOTICE 'Fixed object content for post %', invalid_post.id;
            
        ELSIF invalid_post.content IS NULL OR jsonb_typeof(invalid_post.content) = 'null' THEN
            -- Set empty content to a default text message
            UPDATE posts 
            SET content = jsonb_build_array(
                jsonb_build_object(
                    'type', 'text',
                    'text', ''
                )
            )
            WHERE id = invalid_post.id;
            fixed_count := fixed_count + 1;
            RAISE NOTICE 'Fixed null content for post %', invalid_post.id;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'Fixed % posts with invalid content', fixed_count;
END
$$;

-- =====================================================
-- STEP 4: Update content validation constraint (match local environment)
-- =====================================================

-- Drop existing constraint
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_content_is_array;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_content_not_empty;

-- Add the exact same constraints as in the local environment
ALTER TABLE posts ADD CONSTRAINT posts_content_is_array 
    CHECK (jsonb_typeof(content) = 'array');

ALTER TABLE posts ADD CONSTRAINT posts_content_not_empty 
    CHECK ((jsonb_array_length(content) > 0) OR (reblog IS NOT NULL));

COMMENT ON CONSTRAINT posts_content_not_empty ON posts IS 'Ensures posts have content OR are reblogs. Pure reblogs can have empty content if reblog field is present.';

-- =====================================================
-- STEP 5: Add content validation to messages table (same approach)
-- =====================================================

-- Ensure messages table also has proper content validation
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_is_array;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_not_empty;

ALTER TABLE messages ADD CONSTRAINT messages_content_is_array 
    CHECK (jsonb_typeof(content) = 'array');

ALTER TABLE messages ADD CONSTRAINT messages_content_not_empty 
    CHECK (jsonb_array_length(content) > 0);

-- =====================================================
-- STEP 6: Federation trigger recreation (optional)
-- =====================================================
-- Note: Federation triggers can be re-enabled once content flow is verified
-- This should be done after confirming post creation works properly

-- Commented out for now - enable once content insertion is stable:
-- CREATE TRIGGER trigger_unified_content_federation
--     AFTER INSERT OR UPDATE OR DELETE ON posts
--     FOR EACH ROW
--     EXECUTE FUNCTION handle_unified_content_federation();

COMMIT;

-- =====================================================
-- POST-MIGRATION VERIFICATION
-- =====================================================
-- Run this query to verify the migration worked:
-- SELECT content, jsonb_typeof(content) FROM posts LIMIT 5;