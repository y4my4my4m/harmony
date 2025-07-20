-- Migration 035: Fix mention href format from /@username to /users/username
-- This fixes federation compatibility with ActivityPub servers like Misskey, Mastodon etc

BEGIN;

-- Fix extract_activitypub_mention_tags function to use /users/ format
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
                -- ✅ FIX: Use /users/ format instead of /@
                IF mention_domain IS NOT NULL THEN
                    -- Use provided domain with proper /users/ format
                    mention_href := 'https://' || mention_domain || '/users/' || mention_username;
                    mention_name := '@' || mention_username || '@' || mention_domain;
                ELSE
                    -- Fallback to current instance domain with proper /users/ format
                    mention_href := 'https://' || current_instance_domain || '/users/' || mention_username;
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

-- Fix extract_activitypub_mention_tags overload function
CREATE OR REPLACE FUNCTION public.extract_activitypub_mention_tags(content_data jsonb, recipient_urls text[], instance_domain text)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $$
DECLARE
    mention_tags JSONB := '[]'::JSONB;
    recipient_url TEXT;
    url_parts TEXT[];
    domain TEXT;
    username TEXT;
    mention_name TEXT;
BEGIN
    -- Handle null or empty inputs
    IF content_data IS NULL OR recipient_urls IS NULL OR array_length(recipient_urls, 1) = 0 THEN
        RETURN mention_tags;
    END IF;
    
    -- Process each recipient URL to create mention tags
    -- This ensures every DM recipient is mentioned in ActivityPub
    -- This is critical for proper DM delivery regardless of whether users explicitly @mention each other in chat
    -- Critical for Mastodon compatibility and proper DM delivery
    FOREACH recipient_url IN ARRAY recipient_urls
    LOOP
        -- Parse recipient URL to extract username and domain
        -- Expected format: https://domain.com/@username or https://domain.com/users/username
        IF recipient_url LIKE 'https://%' THEN
            -- Remove https:// prefix
            recipient_url := substring(recipient_url from 9);
            
            -- Split by / to get domain and path
            url_parts := string_to_array(recipient_url, '/');
            
            IF array_length(url_parts, 1) >= 2 THEN
                domain := url_parts[1];
                
                -- Extract username from path (handles both /@username and /users/username formats)
                IF url_parts[2] LIKE '@%' THEN
                    username := substring(url_parts[2] from 2);  -- Remove @ prefix
                ELSIF array_length(url_parts, 1) >= 3 AND url_parts[2] = 'users' THEN
                    username := url_parts[3];
                ELSE
                    username := url_parts[2];
                END IF;
                
                -- Build mention name
                mention_name := '@' || username;
                IF domain != instance_domain THEN
                    mention_name := mention_name || '@' || domain;
                END IF;
                
                -- ✅ FIX: Use /users/ format instead of /@
                -- Check if this mention is already in tags (avoid duplicates)
                IF NOT EXISTS (
                    SELECT 1 FROM jsonb_array_elements(mention_tags) AS tag
                    WHERE tag->>'href' = 'https://' || domain || '/users/' || username
                ) THEN
                    mention_tags := mention_tags || jsonb_build_array(jsonb_build_object(
                        'type', 'Mention',
                        'href', 'https://' || domain || '/users/' || username,
                        'name', mention_name
                    ));
                END IF;
            END IF;
        END IF;
    END LOOP;
    
    RETURN mention_tags;
END;
$$;

-- Fix convert_unified_content_to_activitypub_html function
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
    mention_username TEXT;
    mention_domain TEXT;
    mention_href TEXT;
    mention_text TEXT;
    current_instance_domain TEXT;
    hashtag_name TEXT;
    file_url TEXT;
    mention_display_name TEXT;
    mention_is_local BOOLEAN;
BEGIN
    -- Handle null or empty content
    IF content IS NULL THEN
        RETURN '';
    END IF;
    
    -- Handle string content (convert to simple text)
    IF jsonb_typeof(content) = 'string' THEN
        RETURN content #>> '{}';
    END IF;
    
    -- Handle array content (MessagePart[])
    IF jsonb_typeof(content) != 'array' THEN
        RETURN '';
    END IF;
    
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        CASE part_type
            WHEN 'text' THEN
                part_text := content_part->>'text';
                IF part_text IS NOT NULL THEN
                    html_content := html_content || part_text;
                END IF;
                
            WHEN 'mention' THEN
                -- Extract mention data from the unified format (username, domain, etc.)
                mention_username := content_part->>'username';
                mention_domain := content_part->>'domain';
                mention_display_name := content_part->>'displayName';
                mention_is_local := COALESCE((content_part->>'isLocal')::boolean, false);
                
                IF mention_username IS NOT NULL THEN
                    -- ✅ FIX: Use /users/ format instead of /@
                    -- Always build full mention format for federation compatibility
                    IF mention_domain IS NOT NULL THEN
                        -- Use provided domain with proper /users/ format
                        mention_href := 'https://' || mention_domain || '/users/' || mention_username;
                        mention_text := '@' || mention_username || '@' || mention_domain;
                    ELSE
                        -- Fallback to current instance domain with proper /users/ format
                        mention_href := 'https://' || current_instance_domain || '/users/' || mention_username;
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
                
            WHEN 'hashtag' THEN
                hashtag_name := content_part->>'name';
                IF hashtag_name IS NOT NULL THEN
                    html_content := html_content || format('<a href="https://%s/tags/%s" class="mention hashtag" rel="tag">#<span>%s</span></a>', 
                        current_instance_domain, hashtag_name, hashtag_name);
                END IF;
                
            WHEN 'url' THEN
                part_url := content_part->>'url';
                IF part_url IS NOT NULL THEN
                    html_content := html_content || format('<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>', 
                        part_url, part_url);
                END IF;
                
            WHEN 'file' THEN
                -- Files are handled as ActivityPub attachments, not inline content
                -- Just add a placeholder or nothing for the content
                file_url := content_part->>'url';
                IF file_url IS NOT NULL THEN
                    html_content := html_content || format('<p><a href="%s">[Attachment]</a></p>', file_url);
                END IF;
                
            ELSE
                -- Unknown part type, skip
                NULL;
        END CASE;
    END LOOP;
    
    RETURN html_content;
END;
$$;

COMMIT;