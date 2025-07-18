-- Fix incoming ActivityPub emoji parsing to use correct data structure
-- This fixes the parse_activitypub_content_to_jsonb function to generate
-- emoji MessageParts with the proper structure that Harmony expects

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
    v_emoji_name TEXT;
    v_emoji_url TEXT;
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

    -- Process all tags in a single pass to maintain proper order
    -- We need to find all tag positions first, then process them in order
    DECLARE
        tag_positions JSONB := '[]'::jsonb;
        v_tag_data JSONB;
        i INTEGER;
    BEGIN
        -- Find positions of all tags in content
        FOR v_tag IN SELECT * FROM jsonb_array_elements(tags)
        LOOP
            v_mention_text := NULL;
            v_pos := 0;
            
            IF v_tag->>'type' = 'Emoji' THEN
                -- Extract emoji name (remove colons if present)
                v_emoji_name := v_tag->>'name';
                IF v_emoji_name LIKE ':%' AND v_emoji_name LIKE '%:' THEN
                    v_emoji_name := substring(v_emoji_name from 2 for length(v_emoji_name) - 2);
                END IF;
                
                v_mention_text := ':' || v_emoji_name || ':';
                v_pos := position(v_mention_text in v_working_content);
                
            ELSIF v_tag->>'type' = 'Mention' THEN
                v_username := v_tag->>'name';
                IF v_username LIKE '@%' THEN
                    v_username := substring(v_username from 2);
                END IF;
                
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
                
            ELSIF v_tag->>'type' = 'Hashtag' THEN
                v_mention_text := '#' || (v_tag->>'name');
                v_pos := position(v_mention_text in v_working_content);
            END IF;
            
            -- Store tag position and data if found
            IF v_pos > 0 THEN
                tag_positions := tag_positions || jsonb_build_object(
                    'position', v_pos,
                    'length', length(v_mention_text),
                    'tag', v_tag,
                    'text', v_mention_text
                );
            END IF;
        END LOOP;
        
        -- Sort tags by position
        SELECT jsonb_agg(value ORDER BY (value->>'position')::integer)
        INTO tag_positions
        FROM jsonb_array_elements(tag_positions);
        
        -- Process tags in order
        i := 0;
        FOR v_tag_data IN SELECT * FROM jsonb_array_elements(COALESCE(tag_positions, '[]'::jsonb))
        LOOP
            v_pos := (v_tag_data->>'position')::integer - i;
            v_mention_text := v_tag_data->>'text';
            v_tag := v_tag_data->'tag';
            
            -- Adjust position for previous removals
            v_before_text := substring(v_working_content from 1 for v_pos - 1);
            v_after_text := substring(v_working_content from v_pos + length(v_mention_text));
            
            -- Add text before this tag
            IF trim(v_before_text) != '' THEN
                v_result := v_result || jsonb_build_object(
                    'type', 'text',
                    'text', v_before_text
                );
            END IF;
            
            -- Add the tag based on its type
            IF v_tag->>'type' = 'Emoji' THEN
                v_emoji_name := v_tag->>'name';
                IF v_emoji_name LIKE ':%' AND v_emoji_name LIKE '%:' THEN
                    v_emoji_name := substring(v_emoji_name from 2 for length(v_emoji_name) - 2);
                END IF;
                v_emoji_url := COALESCE(v_tag->'icon'->>'url', v_tag->>'icon');
                
                v_result := v_result || jsonb_build_object(
                    'type', 'emoji',
                    'emoji', jsonb_build_object(
                        'name', v_emoji_name,
                        'url', v_emoji_url,
                        'id', COALESCE(v_tag->>'id', 'remote-' || v_emoji_name),
                        'server_id', 'remote'
                    )
                );
                
            ELSIF v_tag->>'type' = 'Mention' THEN
                v_username := v_tag->>'name';
                IF v_username LIKE '@%' THEN
                    v_username := substring(v_username from 2);
                END IF;
                
                v_result := v_result || jsonb_build_object(
                    'type', 'mention',
                    'username', split_part(v_username, '@', 1),
                    'domain', split_part(v_username, '@', 2),
                    'url', v_tag->>'href',
                    'isLocal', false,
                    'userId', 'remote-' || v_username
                );
                
            ELSIF v_tag->>'type' = 'Hashtag' THEN
                v_result := v_result || jsonb_build_object(
                    'type', 'hashtag',
                    'tag', v_tag->>'name',
                    'url', v_tag->>'href'
                );
            END IF;
            
            -- Update working content and position offset
            v_working_content := v_after_text;
            i := i + v_pos + length(v_mention_text) - 1;
        END LOOP;
    END;

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

COMMENT ON FUNCTION public.parse_activitypub_content_to_jsonb(html_content text, tags jsonb) IS 'Converts ActivityPub content to Harmony''s JSONB message format, preserving order and supporting mentions, custom emojis (Misskey), hashtags, and standalone URLs. Maps ActivityPub emoji tags to Harmony''s expected structure: {"type": "emoji", "emoji": {"name": "...", "url": "...", "id": "..."}}';

-- Test the function with a sample ActivityPub message containing emoji tags
SELECT 'Test 1: Simple emoji' as test_name, parse_activitypub_content_to_jsonb(
    'Hello :blobcat: from remote instance!', 
    '[{"type": "Emoji", "name": ":blobcat:", "icon": {"type": "Image", "url": "https://misskey.example/emoji/blobcat.png"}}]'::jsonb
) AS parsed_content

UNION ALL

SELECT 'Test 2: Multiple emojis' as test_name, parse_activitypub_content_to_jsonb(
    'Look at this :happy: and this :sad: emoji!',
    '[
        {"type": "Emoji", "name": ":happy:", "icon": {"type": "Image", "url": "https://example.com/happy.png"}},
        {"type": "Emoji", "name": ":sad:", "icon": {"type": "Image", "url": "https://example.com/sad.png"}}
    ]'::jsonb
) AS parsed_content

UNION ALL

SELECT 'Test 3: Emoji with mention' as test_name, parse_activitypub_content_to_jsonb(
    'Hey @alice check out this :cool: emoji!',
    '[
        {"type": "Mention", "name": "@alice@example.com", "href": "https://example.com/@alice"},
        {"type": "Emoji", "name": ":cool:", "icon": {"type": "Image", "url": "https://example.com/cool.webp"}}
    ]'::jsonb
) AS parsed_content;
