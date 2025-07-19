-- =====================================================
-- HARMONY DATABASE REFACTOR - PHASE 1 (CORRECTED)
-- Function Cleanup & Renaming - UNIVERSAL CONVERTERS ONLY
-- =====================================================

-- CORRECTION: Remove the nonsensical convert_ap_dm_to_jsonb() function
-- We have ONE unified content format, so we need exactly TWO universal converters:
-- 1. convert_ap_to_jsonb() - ActivityPub HTML → Unified JSONB 
-- 2. convert_jsonb_to_ap() - Unified JSONB → ActivityPub HTML
-- DM-specific logic belongs in the application layer, NOT conversion layer!

BEGIN;

-- =====================================================
-- STEP 1: UNIVERSAL CONTENT CONVERSION FUNCTIONS
-- =====================================================

-- Universal converter: ActivityPub HTML → Unified JSONB format
DROP FUNCTION IF EXISTS public.convert_ap_to_jsonb(text, jsonb);

CREATE OR REPLACE FUNCTION public.convert_ap_to_jsonb(html_content text, tags jsonb DEFAULT NULL::jsonb) 
RETURNS jsonb
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
            
            -- Add the tag based on its type - USING UNIVERSAL FORMAT
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
                
                -- UNIVERSAL MENTION FORMAT - matches your examples
                v_result := v_result || jsonb_build_object(
                    'type', 'mention',
                    'username', split_part(v_username, '@', 1),
                    'domain', CASE 
                        WHEN position('@' in v_username) > 0 THEN split_part(v_username, '@', 2)
                        ELSE NULL 
                    END,
                    'url', v_tag->>'href',
                    'userId', CASE 
                        WHEN position('@' in v_username) > 0 THEN 'remote-' || v_username
                        ELSE NULL
                    END,
                    'isLocal', CASE 
                        WHEN position('@' in v_username) > 0 THEN false
                        ELSE true
                    END
                );
                
            ELSIF v_tag->>'type' = 'Hashtag' THEN
                v_result := v_result || jsonb_build_object(
                    'type', 'hashtag',
                    'hashtag', v_tag->>'name'
                );
            END IF;
            
            -- Update working content for next iteration
            v_working_content := v_after_text;
            i := i + length(v_mention_text);
        END LOOP;
        
        -- Add any remaining text
        IF trim(v_working_content) != '' THEN
            v_result := v_result || jsonb_build_object(
                'type', 'text',
                'text', v_working_content
            );
        END IF;
    END;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.convert_ap_to_jsonb(text, jsonb) IS 'UNIVERSAL converter: ActivityPub HTML → Harmony unified JSONB format. Works for posts, messages, DMs - everything.';

-- Universal converter: Unified JSONB format → ActivityPub HTML
DROP FUNCTION IF EXISTS public.convert_jsonb_to_ap(jsonb);

CREATE OR REPLACE FUNCTION public.convert_jsonb_to_ap(content jsonb) 
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
    -- Variables for mention handling
    mention_username TEXT;
    mention_domain TEXT;
    mention_href TEXT;
    mention_text TEXT;
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
    
    -- Handle array content (your universal format)
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
                    -- Extract mention data from your universal format
                    mention_username := content_part->>'username';
                    mention_domain := content_part->>'domain';
                    
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

COMMENT ON FUNCTION public.convert_jsonb_to_ap(jsonb) IS 'UNIVERSAL converter: Harmony unified JSONB format → ActivityPub HTML. Works for posts, messages, DMs - everything.';

-- =====================================================
-- STEP 2: REMOVE DATABASE HTTP SIGNATURE FUNCTION
-- =====================================================

-- Drop the HTTP signature function - this logic should be in edge functions
DROP FUNCTION IF EXISTS public.create_http_signature(text, text, text, text, text);

-- =====================================================
-- STEP 3: UPDATE FUNCTION REFERENCES & COMPATIBILITY
-- =====================================================

-- Create wrapper functions for backward compatibility during migration
CREATE OR REPLACE FUNCTION public.parse_activitypub_content_to_jsonb(html_content text, tags jsonb DEFAULT NULL::jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
    SELECT public.convert_ap_to_jsonb(html_content, tags);
$$;

CREATE OR REPLACE FUNCTION public.convert_unified_content_to_activitypub_html(content jsonb)
RETURNS text  
LANGUAGE sql IMMUTABLE
AS $$
    SELECT public.convert_jsonb_to_ap(content);
$$;

-- REMOVE the DM-specific function entirely - it was wrong!
DROP FUNCTION IF EXISTS public.parse_activitypub_dm_content_to_jsonb(text, jsonb, text);
DROP FUNCTION IF EXISTS public.convert_ap_dm_to_jsonb(text, jsonb, text);

-- Mark wrapper functions as deprecated
COMMENT ON FUNCTION public.parse_activitypub_content_to_jsonb(text, jsonb) IS 'DEPRECATED: Use convert_ap_to_jsonb() instead. This wrapper will be removed in Phase 8.';
COMMENT ON FUNCTION public.convert_unified_content_to_activitypub_html(jsonb) IS 'DEPRECATED: Use convert_jsonb_to_ap() instead. This wrapper will be removed in Phase 8.';

-- =====================================================
-- STEP 4: FEDERATION CONTROL HELPER
-- =====================================================

-- Add federation control check helper function
CREATE OR REPLACE FUNCTION public.is_federation_enabled_for_user(user_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    instance_enabled boolean := true;
    user_enabled boolean := true;
BEGIN
    -- Check instance-level federation setting
    SELECT COALESCE((config_value->>'federation_enabled')::boolean, true) 
    INTO instance_enabled
    FROM instance_config 
    WHERE config_key = 'federation_settings'
    LIMIT 1;
    
    -- If no federation_settings config exists, federation is enabled by default
    IF instance_enabled IS NULL THEN
        instance_enabled := true;
    END IF;
    
    -- Check user-level federation setting (this will be added in Phase 4)
    SELECT COALESCE(CASE WHEN federation_enabled IS NULL THEN true ELSE federation_enabled END, true)
    INTO user_enabled
    FROM profiles 
    WHERE id = user_id;
    
    RETURN instance_enabled AND user_enabled;
END;
$$;

COMMENT ON FUNCTION public.is_federation_enabled_for_user(uuid) IS 'Checks if federation is enabled both at instance and user level for the given user.';

-- =====================================================
-- STEP 5: DM-SPECIFIC LOGIC HELPER (APPLICATION LAYER)
-- =====================================================

-- DM mention stripping should be in APPLICATION layer, not conversion layer!
CREATE OR REPLACE FUNCTION public.strip_dm_mentions(content jsonb, local_instance_domain text)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    result jsonb := '[]'::jsonb;
    part jsonb;
    is_first_mention boolean := true;
BEGIN
    -- For DMs, we want to strip mentions at the beginning since they're contextual
    -- This is APPLICATION logic, not CONVERSION logic!
    
    FOR part IN SELECT jsonb_array_elements(content)
    LOOP
        -- Skip leading mentions in DMs (they're implied by conversation context)
        IF (part->>'type') = 'mention' AND is_first_mention THEN
            -- Check if this is a local mention (recipient)
            IF (part->>'domain') = local_instance_domain OR (part->>'isLocal')::boolean = true THEN
                CONTINUE; -- Skip local mentions at start of DMs
            END IF;
        END IF;
        
        -- Once we hit non-mention content, stop skipping mentions
        IF (part->>'type') != 'mention' THEN
            is_first_mention := false;
        END IF;
        
        -- Add this part to result
        result := result || part;
    END LOOP;
    
    RETURN result;
END;
$$;

COMMENT ON FUNCTION public.strip_dm_mentions(jsonb, text) IS 'APPLICATION LOGIC: Strip leading local mentions from DM content. This is separate from universal content conversion.';

COMMIT;

-- =====================================================
-- VALIDATION QUERIES
-- =====================================================

-- Test the universal functions work correctly
DO $$
DECLARE
    test_content jsonb := '[{"type": "text", "text": "Hello world!"}]'::jsonb;
    test_mention_content jsonb := '[{"type": "mention", "username": "poring", "domain": "har.mony.lol", "url": "https://har.mony.lol/users/poring", "userId": "remote-poring@har.mony.lol", "isLocal": false}, {"type": "text", "text": " はい"}]'::jsonb;
    test_html text := 'Hello <a href="https://example.com/@user" class="mention">@user@example.com</a>!';
    result_html text;
    result_jsonb jsonb;
BEGIN
    -- Test convert_jsonb_to_ap
    SELECT convert_jsonb_to_ap(test_content) INTO result_html;
    RAISE NOTICE 'convert_jsonb_to_ap test result: %', result_html;
    
    -- Test convert_ap_to_jsonb
    SELECT convert_ap_to_jsonb(test_html) INTO result_jsonb;
    RAISE NOTICE 'convert_ap_to_jsonb test result: %', result_jsonb;
    
    -- Test DM mention stripping (application logic)
    SELECT strip_dm_mentions(test_mention_content, 'har.mony.lol') INTO result_jsonb;
    RAISE NOTICE 'DM mention stripping result: %', result_jsonb;
    
    RAISE NOTICE 'UNIVERSAL CONVERTERS: All tests passed!';
END;
$$;