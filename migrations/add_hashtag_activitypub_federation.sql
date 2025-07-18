-- Migration: Add hashtag support to ActivityPub federation
-- This adds hashtag extraction and proper ActivityPub tag generation for outgoing messages

-- Create function to extract hashtag tags for ActivityPub
CREATE OR REPLACE FUNCTION public.extract_activitypub_hashtag_tags(content jsonb) 
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    hashtag_tags JSONB := '[]'::JSONB;
    part_type TEXT;
    hashtag_name TEXT;
    hashtag_href TEXT;
    hashtag_tag JSONB;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    -- Get current instance domain for hashtag URLs
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'hashtag' THEN
            hashtag_name := content_part->>'name';
            
            IF hashtag_name IS NOT NULL THEN
                -- Build hashtag URL - ActivityPub standard format
                hashtag_href := 'https://' || current_instance_domain || '/tags/' || hashtag_name;
                
                -- Ensure hashtag name starts with # for ActivityPub format
                IF NOT starts_with(hashtag_name, '#') THEN
                    hashtag_name := '#' || hashtag_name;
                END IF;
                
                -- Build the ActivityPub Hashtag tag
                hashtag_tag := jsonb_build_object(
                    'type', 'Hashtag',
                    'href', hashtag_href,
                    'name', hashtag_name
                );
                
                -- Add to tags array
                hashtag_tags := hashtag_tags || jsonb_build_array(hashtag_tag);
            END IF;
        END IF;
    END LOOP;
    
    RETURN hashtag_tags;
END;
$$;

COMMENT ON FUNCTION public.extract_activitypub_hashtag_tags(content jsonb) IS 'Extracts hashtag tags from MessagePart[] content as ActivityPub Hashtag objects for proper federation. Handles hashtag data structure: {"type": "hashtag", "name": "cats"} and generates proper ActivityPub format: {"type": "Hashtag", "name": "#cats", "href": "https://domain.com/tags/cats"}';

-- Update the unified extract_all_activitypub_tags function to include hashtags
CREATE OR REPLACE FUNCTION public.extract_all_activitypub_tags(content jsonb) 
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    mention_tags JSONB;
    emoji_tags JSONB;
    hashtag_tags JSONB;
    all_tags JSONB := '[]'::JSONB;
    tag_item JSONB;
BEGIN
    -- Extract mention tags (using updated function with full domain format)
    mention_tags := extract_activitypub_mention_tags(content);
    FOR tag_item IN SELECT jsonb_array_elements(mention_tags)
    LOOP
        all_tags := all_tags || jsonb_build_array(tag_item);
    END LOOP;
    
    -- Extract emoji tags (using updated function with correct data structure)
    emoji_tags := extract_misskey_emoji_tags(content);
    FOR tag_item IN SELECT jsonb_array_elements(emoji_tags)
    LOOP
        all_tags := all_tags || jsonb_build_array(tag_item);
    END LOOP;
    
    -- Extract hashtag tags (using new function for ActivityPub format)
    hashtag_tags := extract_activitypub_hashtag_tags(content);
    FOR tag_item IN SELECT jsonb_array_elements(hashtag_tags)
    LOOP
        all_tags := all_tags || jsonb_build_array(tag_item);
    END LOOP;
    
    RETURN all_tags;
END;
$$;

COMMENT ON FUNCTION public.extract_all_activitypub_tags(content jsonb) IS 'Combines mention, emoji, and hashtag tags for complete ActivityPub tag array. Uses updated functions that handle full @username@domain mentions, correct emoji data structure, and proper hashtag federation format.';

-- Test the hashtag extraction function
DO $$
DECLARE
    test_content JSONB;
    result_tags JSONB;
BEGIN
    -- Test with mixed content including hashtags
    test_content := jsonb_build_array(
        jsonb_build_object('type', 'text', 'text', 'Hello world! '),
        jsonb_build_object('type', 'hashtag', 'name', 'cats'),
        jsonb_build_object('type', 'text', 'text', ' and '),
        jsonb_build_object('type', 'hashtag', 'name', 'dogs'),
        jsonb_build_object('type', 'mention', 'username', 'user1', 'domain', 'example.com')
    );
    
    -- Test hashtag extraction specifically
    SELECT extract_activitypub_hashtag_tags(test_content) INTO result_tags;
    RAISE NOTICE 'Hashtag tags only: %', result_tags;
    
    -- Test combined tag extraction
    SELECT extract_all_activitypub_tags(test_content) INTO result_tags;
    RAISE NOTICE 'All ActivityPub tags (mentions + emojis + hashtags): %', result_tags;
END;
$$;
