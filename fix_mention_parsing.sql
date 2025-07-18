-- Fix for ActivityPub mention parsing to preserve order in public posts
-- This fixes the parse_activitypub_content_to_jsonb function to maintain
-- the correct order of mentions and text as they appear in the original HTML

-- Drop and recreate the function with proper HTML parsing
DROP FUNCTION IF EXISTS public.parse_activitypub_content_to_jsonb(text, jsonb);

CREATE FUNCTION public.parse_activitypub_content_to_jsonb(html_content text, tags jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    v_result JSONB := '[]'::jsonb;
    v_working_content TEXT;
    v_tag JSONB;
    v_username TEXT;
    v_mention_text TEXT;
    v_pos INTEGER;
    v_before_text TEXT;
    v_after_text TEXT;
    v_url_match TEXT;
BEGIN
    -- If no content, return empty array
    IF html_content IS NULL OR html_content = '' THEN
        RETURN '[]'::jsonb;
    END IF;

    -- Clean HTML thoroughly
    v_working_content := html_content;
    WHILE v_working_content ~ '<[^>]*>' LOOP
        v_working_content := regexp_replace(v_working_content, '<[^>]*>', '', 'g');
    END LOOP;
    v_working_content := regexp_replace(v_working_content, '&[a-zA-Z0-9#]+;', ' ', 'g');
    v_working_content := regexp_replace(v_working_content, '\s+', ' ', 'g');
    v_working_content := trim(v_working_content);

    -- If no tags, just return the cleaned text
    IF tags IS NULL OR jsonb_typeof(tags) != 'array' THEN
        IF v_working_content != '' THEN
            v_result := v_result || jsonb_build_object(
                'type', 'text',
                'text', v_working_content
            );
        END IF;
        RETURN v_result;
    END IF;

    -- Process mentions sequentially, replacing them as we find them
    FOR v_tag IN SELECT * FROM jsonb_array_elements(tags)
    LOOP
        IF v_tag->>'type' = 'Mention' THEN
            v_username := v_tag->>'name';
            IF v_username LIKE '@%' THEN
                v_username := substring(v_username from 2);
            END IF;
            
            -- Try to find the mention text in various forms
            v_mention_text := NULL;
            v_pos := 0;
            
            -- Try @username@domain format first
            IF v_username LIKE '%@%' THEN
                v_mention_text := '@' || v_username;
                v_pos := position(v_mention_text in v_working_content);
            END IF;
            
            -- If not found, try @username format
            IF v_pos = 0 THEN
                v_mention_text := '@' || split_part(v_username, '@', 1);
                v_pos := position(v_mention_text in v_working_content);
            END IF;
            
            -- If still not found, try just username
            IF v_pos = 0 THEN
                v_mention_text := split_part(v_username, '@', 1);
                v_pos := position(v_mention_text in v_working_content);
            END IF;
            
            -- If we found the mention text, process it
            IF v_pos > 0 THEN
                -- Get text before the mention
                v_before_text := substring(v_working_content from 1 for v_pos - 1);
                -- Get text after the mention
                v_after_text := substring(v_working_content from v_pos + length(v_mention_text));
                
                -- Add text before mention if it exists
                IF trim(v_before_text) != '' THEN
                    v_result := v_result || jsonb_build_object(
                        'type', 'text',
                        'text', v_before_text
                    );
                END IF;
                
                -- Add the mention
                v_result := v_result || jsonb_build_object(
                    'type', 'mention',
                    'username', split_part(v_username, '@', 1),
                    'domain', split_part(v_username, '@', 2),
                    'url', v_tag->>'href'
                );
                
                -- Update working content to the text after this mention
                v_working_content := v_after_text;
            END IF;
        END IF;
        
        -- Handle other tag types (emojis, hashtags) similarly
        IF v_tag->>'type' = 'Emoji' THEN
            v_mention_text := ':' || (v_tag->>'name') || ':';
            v_pos := position(v_mention_text in v_working_content);
            
            IF v_pos > 0 THEN
                v_before_text := substring(v_working_content from 1 for v_pos - 1);
                v_after_text := substring(v_working_content from v_pos + length(v_mention_text));
                
                IF trim(v_before_text) != '' THEN
                    v_result := v_result || jsonb_build_object(
                        'type', 'text',
                        'text', v_before_text
                    );
                END IF;
                
                v_result := v_result || jsonb_build_object(
                    'type', 'emoji',
                    'name', v_tag->>'name',
                    'url', COALESCE(v_tag->'icon'->>'url', v_tag->>'icon'),
                    'shortcode', v_mention_text
                );
                
                v_working_content := v_after_text;
            END IF;
        END IF;
        
        IF v_tag->>'type' = 'Hashtag' THEN
            v_mention_text := '#' || (v_tag->>'name');
            v_pos := position(v_mention_text in v_working_content);
            
            IF v_pos > 0 THEN
                v_before_text := substring(v_working_content from 1 for v_pos - 1);
                v_after_text := substring(v_working_content from v_pos + length(v_mention_text));
                
                IF trim(v_before_text) != '' THEN
                    v_result := v_result || jsonb_build_object(
                        'type', 'text',
                        'text', v_before_text
                    );
                END IF;
                
                v_result := v_result || jsonb_build_object(
                    'type', 'hashtag',
                    'tag', v_tag->>'name',
                    'url', v_tag->>'href'
                );
                
                v_working_content := v_after_text;
            END IF;
        END IF;
    END LOOP;

    -- Handle standalone URLs in remaining content
    WHILE v_working_content ~ 'https?://[^\s]+' LOOP
        v_url_match := substring(v_working_content from 'https?://[^\s]+');
        v_pos := position(v_url_match in v_working_content);
        
        IF v_pos > 0 THEN
            v_before_text := substring(v_working_content from 1 for v_pos - 1);
            v_after_text := substring(v_working_content from v_pos + length(v_url_match));
            
            IF trim(v_before_text) != '' THEN
                v_result := v_result || jsonb_build_object(
                    'type', 'text',
                    'text', v_before_text
                );
            END IF;
            
            v_result := v_result || jsonb_build_object(
                'type', 'url',
                'url', v_url_match,
                'preview', true
            );
            
            v_working_content := v_after_text;
        ELSE
            EXIT; -- Safety exit if regex fails
        END IF;
    END LOOP;

    -- Add any remaining text
    IF trim(v_working_content) != '' THEN
        v_result := v_result || jsonb_build_object(
            'type', 'text',
            'text', v_working_content
        );
    END IF;

    RETURN v_result;
END;
$$;

-- Update the function comment
COMMENT ON FUNCTION public.parse_activitypub_content_to_jsonb(html_content text, tags jsonb) IS 'Converts ActivityPub content to Harmony''s JSONB message format, preserving order and supporting mentions, custom emojis (Misskey), hashtags, and standalone URLs. Maps ActivityPub tags to appropriate Harmony content types.';

-- Test the function with a sample (you can remove this after testing)
-- SELECT parse_activitypub_content_to_jsonb(
--     '<span class="h-card"><a href="https://har.mony.lol/users/y4my4m" class="u-url mention">@<span>y4my4m</span></a></span> hey there!',
--     '[{"type": "Mention", "href": "https://har.mony.lol/users/y4my4m", "name": "@y4my4m@har.mony.lol"}]'::jsonb
-- );
-- Expected result: [{"type": "mention", "username": "y4my4m", "domain": "har.mony.lol", "url": "https://har.mony.lol/users/y4my4m"}, {"type": "text", "text": " hey there!"}]
