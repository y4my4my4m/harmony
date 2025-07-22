-- Test the content preview extraction logic that runs early in handle_outgoing_messages
-- This is likely where the "Token '@' is invalid" error is happening

-- Test the exact logic from handle_outgoing_messages with your DM content
DO $$
DECLARE
    test_content JSONB := '[{"type": "text", "text": "testest"}]';
    content_preview TEXT;
BEGIN
    RAISE WARNING '🧪 Testing content preview extraction...';
    
    -- This is the exact code from handle_outgoing_messages
    IF jsonb_typeof(test_content) = 'array' THEN
        SELECT LEFT(string_agg(
            CASE 
                WHEN item->>'type' = 'mention' THEN '@' || item->>'username'
                ELSE COALESCE(item->>'text', item::text)
            END, ''
        ), 100) INTO content_preview
        FROM jsonb_array_elements(test_content) AS item;
    ELSE
        content_preview := LEFT(test_content::text, 100);
    END IF;
    
    RAISE WARNING '🧪 Content preview result: %', content_preview;
END;
$$;

-- Also test with a content that has a mention to see if that breaks
DO $$
DECLARE
    test_content_with_mention JSONB := '[{"type": "mention", "username": "testuser"}, {"type": "text", "text": "hello"}]';
    content_preview TEXT;
BEGIN
    RAISE WARNING '🧪 Testing content preview with mention...';
    
    IF jsonb_typeof(test_content_with_mention) = 'array' THEN
        SELECT LEFT(string_agg(
            CASE 
                WHEN item->>'type' = 'mention' THEN '@' || item->>'username'
                ELSE COALESCE(item->>'text', item::text)
            END, ''
        ), 100) INTO content_preview
        FROM jsonb_array_elements(test_content_with_mention) AS item;
    ELSE
        content_preview := LEFT(test_content_with_mention::text, 100);
    END IF;
    
    RAISE WARNING '🧪 Content preview with mention result: %', content_preview;
END;
$$;