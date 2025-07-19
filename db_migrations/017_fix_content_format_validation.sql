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
-- STEP 3: Enhanced content validation function
-- =====================================================

CREATE OR REPLACE FUNCTION validate_message_parts_content(content_value JSONB)
RETURNS BOOLEAN AS $$
BEGIN
    -- Must be an array
    IF jsonb_typeof(content_value) != 'array' THEN
        RETURN FALSE;
    END IF;
    
    -- Must not be empty
    IF jsonb_array_length(content_value) = 0 THEN
        RETURN FALSE;
    END IF;
    
    -- Each element must have a 'type' field
    FOR i IN 0..jsonb_array_length(content_value) - 1 LOOP
        IF NOT (content_value->i ? 'type') THEN
            RETURN FALSE;
        END IF;
        
        -- Validate based on type
        CASE content_value->i->>'type'
            WHEN 'text' THEN
                IF NOT (content_value->i ? 'text') THEN
                    RETURN FALSE;
                END IF;
            WHEN 'mention' THEN
                IF NOT (content_value->i ? 'userId' AND content_value->i ? 'username') THEN
                    RETURN FALSE;
                END IF;
            WHEN 'emoji' THEN
                IF NOT (content_value->i ? 'emojiId' OR content_value->i ? 'shortcode') THEN
                    RETURN FALSE;
                END IF;
            WHEN 'hashtag' THEN
                IF NOT (content_value->i ? 'tag') THEN
                    RETURN FALSE;
                END IF;
            ELSE
                -- Unknown type, allow but log
                RAISE NOTICE 'Unknown MessagePart type: %', content_value->i->>'type';
        END CASE;
    END LOOP;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- STEP 4: Update content validation constraint
-- =====================================================

-- Drop existing constraint
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_content_is_array;

-- Add enhanced constraint using validation function
ALTER TABLE posts ADD CONSTRAINT posts_content_valid_message_parts
    CHECK (validate_message_parts_content(content));

-- =====================================================
-- STEP 5: Add content validation to messages table
-- =====================================================

-- Ensure messages table also has proper content validation
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_is_array;
ALTER TABLE messages ADD CONSTRAINT messages_content_valid_message_parts
    CHECK (validate_message_parts_content(content));

-- =====================================================
-- STEP 6: Create helper function for content debugging
-- =====================================================

CREATE OR REPLACE FUNCTION debug_content_format(content_value JSONB)
RETURNS TEXT AS $$
BEGIN
    RETURN format(
        'Type: %s, Length: %s, Valid: %s, Sample: %s',
        jsonb_typeof(content_value),
        CASE WHEN jsonb_typeof(content_value) = 'array' 
             THEN jsonb_array_length(content_value)::text 
             ELSE 'N/A' 
        END,
        validate_message_parts_content(content_value),
        left(content_value::text, 100)
    );
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- STEP 7: Federation trigger recreation (optional)
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
-- SELECT debug_content_format(content) FROM posts LIMIT 5;