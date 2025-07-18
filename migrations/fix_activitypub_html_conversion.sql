-- Fix ActivityPub HTML conversion functions to properly handle mention format
-- Issue: The convert_unified_content_to_activitypub_html function is not properly 
-- converting mentions to HTML, causing mentions to disappear in federated posts

-- Fix the convert_unified_content_to_activitypub_html function
CREATE OR REPLACE FUNCTION public.convert_unified_content_to_activitypub_html(content jsonb) 
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    html_content TEXT := '';
    part_type TEXT;
    part_text TEXT;
    part_url TEXT;
    part_shortcode TEXT;
    part_emoji_url TEXT;
    -- Variables for mention handling
    mention_username TEXT;
    mention_domain TEXT;
    mention_display_name TEXT;
    mention_href TEXT;
    mention_text TEXT;
    mention_is_local BOOLEAN;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL THEN
        RETURN '';
    END IF;
    
    -- Handle string content (legacy format)
    IF jsonb_typeof(content) = 'string' THEN
        RETURN content #>> '{}';
    END IF;
    
    -- Get current instance domain for local mention detection
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    -- Handle array content (MessagePart[])
    IF jsonb_typeof(content) = 'array' THEN
        FOR content_part IN SELECT jsonb_array_elements(content)
        LOOP
            part_type := content_part->>'type';
            
            CASE part_type
                WHEN 'text' THEN
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        -- Escape HTML entities in text content for safety
                        part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || part_text;
                    END IF;
                    
                WHEN 'mention' THEN
                    -- Extract mention data from the unified format (username, domain, etc.)
                    mention_username := content_part->>'username';
                    mention_domain := content_part->>'domain';
                    mention_display_name := content_part->>'displayName';
                    mention_is_local := COALESCE((content_part->>'isLocal')::boolean, false);
                    
                    IF mention_username IS NOT NULL THEN
                        IF mention_domain IS NOT NULL AND mention_domain != current_instance_domain THEN
                            -- Remote mention: build full @username@domain format
                            mention_href := 'https://' || mention_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || mention_domain;
                        ELSE
                            -- Local mention: just @username
                            mention_href := 'https://' || current_instance_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username;
                        END IF;
                        
                        -- Create the HTML mention link
                        html_content := html_content || format('<a href="%s" class="mention">%s</a>', 
                            mention_href, mention_text);
                    END IF;
                    
                WHEN 'emoji' THEN
                    -- Handle custom emojis
                    part_shortcode := content_part->>'shortcode';
                    part_emoji_url := content_part->'emoji'->>'url';
                    
                    IF part_shortcode IS NOT NULL THEN
                        IF part_emoji_url IS NOT NULL THEN
                            -- Custom emoji with URL - convert to shortcode for federation
                            html_content := html_content || ':' || part_shortcode || ':';
                        ELSE
                            -- Fallback to shortcode
                            html_content := html_content || ':' || part_shortcode || ':';
                        END IF;
                    END IF;
                    
                WHEN 'file' THEN
                    -- Files should not be inline in ActivityPub content (handled as attachments)
                    CONTINUE;
                    
                WHEN 'url' THEN
                    -- Handle URLs
                    part_url := content_part->>'url';
                    IF part_url IS NOT NULL THEN
                        -- Escape URL for safety and create link
                        part_url := replace(replace(replace(part_url, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || format('<a href="%s" rel="noopener noreferrer" target="_blank">%s</a>', 
                            part_url, part_url);
                    END IF;
                    
                ELSE
                    -- Unknown type, try to extract text and escape it
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || part_text;
                    END IF;
            END CASE;
        END LOOP;
        
        RETURN html_content;
    END IF;
    
    -- Fallback: convert to text and escape
    part_text := content::TEXT;
    part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    RETURN part_text;
END;
$$;

COMMENT ON FUNCTION public.convert_unified_content_to_activitypub_html(content jsonb) IS 'Converts MessagePart[] content to ActivityPub HTML format with proper mention handling. Supports username/domain/displayName format and escapes HTML entities for security.';

-- Also fix the extract_activitypub_mention_tags function to match the content format
CREATE OR REPLACE FUNCTION public.extract_activitypub_mention_tags(content jsonb) 
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    mention_tags JSONB := '[]'::JSONB;
    part_type TEXT;
    mention_username TEXT;
    mention_domain TEXT;
    mention_href TEXT;
    mention_name TEXT;
    mention_tag JSONB;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'mention' THEN
            mention_username := content_part->>'username';
            mention_domain := content_part->>'domain';
            
            IF mention_username IS NOT NULL THEN
                IF mention_domain IS NOT NULL AND mention_domain != current_instance_domain THEN
                    -- Remote mention
                    mention_href := 'https://' || mention_domain || '/@' || mention_username;
                    mention_name := '@' || mention_username || '@' || mention_domain;
                ELSE
                    -- Local mention
                    mention_href := 'https://' || current_instance_domain || '/@' || mention_username;
                    mention_name := '@' || mention_username;
                END IF;
                
                -- Build the ActivityPub Mention tag
                mention_tag := jsonb_build_object(
                    'type', 'Mention',
                    'href', mention_href,
                    'name', mention_name
                );
                
                -- Add to tags array
                mention_tags := mention_tags || jsonb_build_array(mention_tag);
            END IF;
        END IF;
    END LOOP;
    
    RETURN mention_tags;
END;
$$;

COMMENT ON FUNCTION public.extract_activitypub_mention_tags(content jsonb) IS 'Extracts mention tags from MessagePart[] content as ActivityPub Mention objects with proper username/domain handling';

-- Test the functions with sample data to verify they work correctly
DO $$
DECLARE
    test_content JSONB;
    test_html TEXT;
    test_tags JSONB;
BEGIN
    -- Test content matching the user's format
    test_content := '[
        {"text": "what about singular ", "type": "text"}, 
        {"type": "mention", "domain": "misskey.io", "userId": "e33e2b83-922a-40cc-9629-b83ca1922011", "isLocal": false, "username": "tester004", "displayName": "Tester004"}, 
        {"text": " hmmm", "type": "text"}
    ]'::JSONB;
    
    -- Test HTML conversion
    test_html := convert_unified_content_to_activitypub_html(test_content);
    RAISE NOTICE 'Test HTML output: %', test_html;
    
    -- Test mention tags extraction
    test_tags := extract_activitypub_mention_tags(test_content);
    RAISE NOTICE 'Test mention tags: %', test_tags;
    
    -- Verify the HTML contains the mention link
    IF test_html LIKE '%<a href="https://misskey.io/@tester004" class="mention">@tester004@misskey.io</a>%' THEN
        RAISE NOTICE '✅ Mention HTML conversion is working correctly!';
    ELSE
        RAISE WARNING '❌ Mention HTML conversion failed. Expected mention link not found.';
    END IF;
    
    -- Verify the tags contain the proper mention
    IF test_tags::text LIKE '%"href":"https://misskey.io/@tester004"%' THEN
        RAISE NOTICE '✅ Mention tag extraction is working correctly!';
    ELSE
        RAISE WARNING '❌ Mention tag extraction failed. Expected mention tag not found.';
    END IF;
END;
$$;
