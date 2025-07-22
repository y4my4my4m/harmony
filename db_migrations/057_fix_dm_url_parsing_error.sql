-- Fix DM URL Parsing Error in extract_activitypub_mention_tags
-- ISSUE: URL parsing is failing when processing recipient URLs containing "@" characters
-- SOLUTION: Add proper error handling and validation in URL parsing

CREATE OR REPLACE FUNCTION extract_activitypub_mention_tags(content_data jsonb, recipient_urls text[], instance_domain text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $function$
DECLARE
    mention_tags JSONB := '[]'::jsonb;
    item JSONB;
    recipient_url TEXT;
    username TEXT;
    domain TEXT;
    mention_name TEXT;
    url_parts TEXT[];
    original_url TEXT;
BEGIN
    -- Extract explicit mentions from content (if any)
    IF jsonb_typeof(content_data) = 'array' THEN
        FOR item IN SELECT * FROM jsonb_array_elements(content_data)
        LOOP
            IF item->>'type' = 'mention' THEN
                -- Build proper ActivityPub Mention tag from content mention
                mention_name := '@' || (item->>'username');
                IF item->>'domain' IS NOT NULL AND item->>'domain' != instance_domain THEN
                    mention_name := mention_name || '@' || (item->>'domain');
                END IF;
                
                mention_tags := mention_tags || jsonb_build_array(jsonb_build_object(
                    'type', 'Mention',
                    'href', 'https://' || COALESCE(item->>'domain', instance_domain) || '/users/' || (item->>'username'),
                    'name', mention_name
                ));
            END IF;
        END LOOP;
    END IF;
    
    -- For DMs: ALWAYS ensure all recipients are mentioned in tags (required for "direct" visibility)
    -- This happens regardless of whether users explicitly @mention each other in chat
    -- Critical for Mastodon compatibility and proper DM delivery
    FOREACH recipient_url IN ARRAY recipient_urls
    LOOP
        -- Store original URL for debugging
        original_url := recipient_url;
        
        -- CRITICAL FIX: Add validation and error handling for URL parsing
        BEGIN
            -- Parse recipient URL to extract username and domain
            -- Expected format: https://domain.com/@username or https://domain.com/users/username
            IF recipient_url LIKE 'https://%' THEN
                -- Remove https:// prefix
                recipient_url := substring(recipient_url from 9);
                
                -- CRITICAL FIX: Validate the URL structure before parsing
                IF recipient_url IS NULL OR recipient_url = '' THEN
                    RAISE WARNING 'Empty URL after removing https:// prefix from: %', original_url;
                    CONTINUE;
                END IF;
                
                -- Split by / to get domain and path
                url_parts := string_to_array(recipient_url, '/');
                
                -- CRITICAL FIX: Validate array bounds before accessing elements
                IF url_parts IS NULL OR array_length(url_parts, 1) < 2 THEN
                    RAISE WARNING 'Invalid URL structure, insufficient parts in: %', original_url;
                    CONTINUE;
                END IF;
                
                domain := url_parts[1];
                
                -- CRITICAL FIX: Validate domain is not empty
                IF domain IS NULL OR domain = '' THEN
                    RAISE WARNING 'Empty domain extracted from URL: %', original_url;
                    CONTINUE;
                END IF;
                
                -- Extract username from path (handles both /@username and /users/username formats)
                IF url_parts[2] LIKE '@%' THEN
                    username := substring(url_parts[2] from 2);  -- Remove @ prefix
                ELSIF array_length(url_parts, 1) >= 3 AND url_parts[2] = 'users' THEN
                    username := url_parts[3];
                ELSE
                    username := url_parts[2];
                END IF;
                
                -- CRITICAL FIX: Validate username is not empty
                IF username IS NULL OR username = '' THEN
                    RAISE WARNING 'Empty username extracted from URL: %', original_url;
                    CONTINUE;
                END IF;
                
                -- Build mention name
                mention_name := '@' || username;
                IF domain != instance_domain THEN
                    mention_name := mention_name || '@' || domain;
                END IF;
                
                -- Check if this mention is already in tags (avoid duplicates)
                IF NOT EXISTS (
                    SELECT 1 FROM jsonb_array_elements(mention_tags) AS tag
                    WHERE tag->>'href' = 'https://' || domain || '/users/' || username
                ) THEN
                    -- CRITICAL FIX: Use /users/ format consistently (not /@)
                    mention_tags := mention_tags || jsonb_build_array(jsonb_build_object(
                        'type', 'Mention',
                        'href', 'https://' || domain || '/users/' || username,
                        'name', mention_name
                    ));
                    
                    RAISE NOTICE 'Added recipient mention tag: %@% -> %', username, domain, mention_name;
                END IF;
            ELSE
                RAISE WARNING 'Invalid recipient URL format (missing https://): %', original_url;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE WARNING 'Error parsing recipient URL %: % %', original_url, SQLSTATE, SQLERRM;
                -- Continue processing other recipients
                CONTINUE;
        END;
    END LOOP;
    
    RETURN mention_tags;
END;
$function$;