-- Fix mention format to always include full @username@domain for proper federation
-- Issue: Local mentions were showing as just @username instead of @username@domain
-- This breaks federation because remote instances need the full context

-- Fix the convert_unified_content_to_activitypub_html function to always use full mention format
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
                        -- Always build full mention format for federation compatibility
                        IF mention_domain IS NOT NULL THEN
                            -- Use provided domain
                            mention_href := 'https://' || mention_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || mention_domain;
                        ELSE
                            -- Fallback to current instance domain for local users
                            mention_href := 'https://' || current_instance_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || current_instance_domain;
                        END IF;
                        
                        -- Create the HTML mention link
                        html_content := html_content || format('<a href="%s" class="mention">%s</a>', 
                            mention_href, mention_text);
                    END IF;
                    
                WHEN 'emoji' THEN
                    -- Handle custom emojis - use shortcode format for ActivityPub compatibility
                    -- Remote instances will replace shortcodes with images based on emoji tags
                    part_shortcode := content_part->'emoji'->>'name';
                    
                    IF part_shortcode IS NOT NULL THEN
                        -- Always render as shortcode - emoji metadata goes in ActivityPub tags
                        html_content := html_content || ':' || part_shortcode || ':';
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

-- Fix the extract_activitypub_mention_tags function to always use full mention format
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
                -- Always build full mention format for federation compatibility
                IF mention_domain IS NOT NULL THEN
                    -- Use provided domain
                    mention_href := 'https://' || mention_domain || '/@' || mention_username;
                    mention_name := '@' || mention_username || '@' || mention_domain;
                ELSE
                    -- Fallback to current instance domain for local users
                    mention_href := 'https://' || current_instance_domain || '/@' || mention_username;
                    mention_name := '@' || mention_username || '@' || current_instance_domain;
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

-- Update the existing extract_misskey_emoji_tags function to handle our emoji data structure
CREATE OR REPLACE FUNCTION public.extract_misskey_emoji_tags(content jsonb) 
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    emoji_tags JSONB := '[]'::JSONB;
    part_type TEXT;
    emoji_name TEXT;
    emoji_url TEXT;
    emoji_id TEXT;
    emoji_tag JSONB;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    -- Get current instance domain for emoji ID URLs
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'emoji' THEN
            -- Extract from our actual data structure: {"type": "emoji", "emoji": {"name": "...", "url": "...", "id": "..."}}
            emoji_name := content_part->'emoji'->>'name';
            emoji_url := content_part->'emoji'->>'url';
            emoji_id := content_part->'emoji'->>'id';
            
            IF emoji_name IS NOT NULL AND emoji_url IS NOT NULL THEN
                -- Build ActivityPub Emoji tag
                emoji_tag := jsonb_build_object(
                    'type', 'Emoji',
                    'name', ':' || emoji_name || ':',
                    'icon', jsonb_build_object(
                        'type', 'Image',
                        'url', emoji_url
                    )
                );
                
                -- Add emoji ID if available (for proper ActivityPub identification)
                IF emoji_id IS NOT NULL AND current_instance_domain IS NOT NULL THEN
                    emoji_tag := emoji_tag || jsonb_build_object(
                        'id', 'https://' || current_instance_domain || '/emojis/' || emoji_id
                    );
                END IF;
                
                emoji_tags := emoji_tags || jsonb_build_array(emoji_tag);
            END IF;
        END IF;
    END LOOP;
    
    RETURN emoji_tags;
END;
$$;

COMMENT ON FUNCTION public.convert_unified_content_to_activitypub_html(content jsonb) IS 'Converts MessagePart[] content to ActivityPub HTML format with full @username@domain mentions for proper federation compatibility';

COMMENT ON FUNCTION public.extract_activitypub_mention_tags(content jsonb) IS 'Extracts mention tags from MessagePart[] content as ActivityPub Mention objects with full @username@domain format for proper federation';

COMMENT ON FUNCTION public.extract_misskey_emoji_tags(content jsonb) IS 'Extracts emoji tags from MessagePart[] content in ActivityPub format. Handles emoji data structure: {"type": "emoji", "emoji": {"name": "...", "url": "...", "id": "..."}} and generates proper Emoji tags for federation with Mastodon/Misskey/Pleroma';

-- Test the functions to verify they now always include full domain
DO $$
DECLARE
    test_content_local JSONB;
    test_content_remote JSONB;
    test_html TEXT;
    test_tags JSONB;
BEGIN
    -- Test local mention
    test_content_local := '[
        {"text": "hey ", "type": "text"}, 
        {"type": "mention", "domain": "har.mony.lol", "userId": "local-user-123", "isLocal": true, "username": "localuser", "displayName": "Local User"}, 
        {"text": " how are you?", "type": "text"}
    ]'::JSONB;
    
    -- Test remote mention
    test_content_remote := '[
        {"text": "what about singular ", "type": "text"}, 
        {"type": "mention", "domain": "misskey.io", "userId": "e33e2b83-922a-40cc-9629-b83ca1922011", "isLocal": false, "username": "tester004", "displayName": "Tester004"}, 
        {"text": " hmmm", "type": "text"}
    ]'::JSONB;
    
    -- Test local mention HTML
    test_html := convert_unified_content_to_activitypub_html(test_content_local);
    RAISE NOTICE 'Local mention HTML: %', test_html;
    
    -- Test remote mention HTML
    test_html := convert_unified_content_to_activitypub_html(test_content_remote);
    RAISE NOTICE 'Remote mention HTML: %', test_html;
    
    -- Test local mention tags
    test_tags := extract_activitypub_mention_tags(test_content_local);
    RAISE NOTICE 'Local mention tags: %', test_tags;
    
    -- Test remote mention tags
    test_tags := extract_activitypub_mention_tags(test_content_remote);
    RAISE NOTICE 'Remote mention tags: %', test_tags;
    
    -- Verify both contain full domain format
    test_html := convert_unified_content_to_activitypub_html(test_content_local);
    IF test_html LIKE '%@localuser@har.mony.lol%' THEN
        RAISE NOTICE '✅ Local mention now includes full domain format!';
    ELSE
        RAISE WARNING '❌ Local mention still missing full domain format.';
    END IF;
    
    test_html := convert_unified_content_to_activitypub_html(test_content_remote);
    IF test_html LIKE '%@tester004@misskey.io%' THEN
        RAISE NOTICE '✅ Remote mention includes full domain format!';
    ELSE
        RAISE WARNING '❌ Remote mention missing full domain format.';
    END IF;

    -- Test custom emoji handling
    DECLARE
        test_emoji_content JSONB;
        test_emoji_html TEXT;
        test_emoji_tags JSONB;
    BEGIN
        test_emoji_content := '[
            {"text": "Hello ", "type": "text"},
            {"type": "emoji", "emoji": {"id": "2148bd2f-4ff3-48bb-a706-fb8cdcc16ab3", "name": "big_smile", "url": "https://example.com/emojis/big_smile.webp"}},
            {"text": " world!", "type": "text"}
        ]'::JSONB;
        
        test_emoji_html := convert_unified_content_to_activitypub_html(test_emoji_content);
        RAISE NOTICE 'Emoji HTML: %', test_emoji_html;
        
        test_emoji_tags := extract_misskey_emoji_tags(test_emoji_content);
        RAISE NOTICE 'Emoji tags: %', test_emoji_tags;
        
        -- Verify emoji is rendered as shortcode in content
        IF test_emoji_html LIKE '%:big_smile:%' THEN
            RAISE NOTICE '✅ Custom emoji rendered as shortcode for ActivityPub compatibility!';
        ELSE
            RAISE WARNING '❌ Custom emoji not rendered as shortcode.';
        END IF;
        
        -- Verify emoji tag is properly extracted
        IF test_emoji_tags::text LIKE '%"type":"Emoji"%' AND 
           test_emoji_tags::text LIKE '%":big_smile:"%' AND
           test_emoji_tags::text LIKE '%"url":"https://example.com/emojis/big_smile.webp"%' THEN
            RAISE NOTICE '✅ Custom emoji tag properly extracted for ActivityPub!';
        ELSE
            RAISE WARNING '❌ Custom emoji tag not properly extracted.';
        END IF;
        
    -- Test the unified function (existing extract_all_activitypub_tags)
    DECLARE
        test_mixed_content JSONB;
        test_all_tags JSONB;
    BEGIN
        test_mixed_content := '[
            {"text": "Hello ", "type": "text"},
            {"type": "mention", "domain": "example.com", "username": "alice", "displayName": "Alice"},
            {"text": " check out this ", "type": "text"},
            {"type": "emoji", "emoji": {"name": "cool", "url": "https://example.com/emojis/cool.webp"}},
            {"text": " emoji!", "type": "text"}
        ]'::JSONB;
        
        test_all_tags := extract_all_activitypub_tags(test_mixed_content);
        RAISE NOTICE 'Unified tags (mentions + emojis): %', test_all_tags;
        
        -- Verify both mentions and emojis are included
        IF test_all_tags::text LIKE '%"type":"Mention"%' AND 
           test_all_tags::text LIKE '%"type":"Emoji"%' THEN
            RAISE NOTICE '✅ Unified tag extraction includes both mentions and emojis!';
        ELSE
            RAISE WARNING '❌ Unified tag extraction missing mentions or emojis.';
        END IF;
    END;
END;
$$;
