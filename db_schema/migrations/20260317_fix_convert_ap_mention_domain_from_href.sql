BEGIN;

-- Fix convert_ap_to_jsonb: extract mention domain from href when tag name has no @domain.
-- Previously, mentions like { name: "@bob", href: "https://instance-a.com/users/bob" }
-- produced domain=NULL, isLocal=true. Now we parse the hostname from href and compare
-- against this instance's domain to set isLocal correctly.

CREATE OR REPLACE FUNCTION public.convert_ap_to_jsonb(html_content text, tags jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
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
    v_instance_domain TEXT;
BEGIN
    -- If no content, return empty array
    IF html_content IS NULL OR html_content = '' THEN
        RETURN '[]'::jsonb;
    END IF;

    -- Get instance domain for isLocal determination
    v_instance_domain := public.get_instance_domain();

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

                DECLARE
                    v_mention_domain TEXT;
                    v_href_domain TEXT;
                    v_mention_is_local BOOLEAN;
                BEGIN
                    IF position('@' in v_username) > 0 THEN
                        v_mention_domain := split_part(v_username, '@', 2);
                    ELSIF v_tag->>'href' IS NOT NULL AND v_tag->>'href' ~ '^https?://' THEN
                        v_href_domain := regexp_replace(v_tag->>'href', '^https?://([^/]+).*$', '\1');
                        IF v_href_domain IS NOT NULL AND v_href_domain != '' THEN
                            v_mention_domain := v_href_domain;
                        END IF;
                    END IF;

                    v_mention_is_local := (v_mention_domain IS NULL) 
                        OR (v_mention_domain = v_instance_domain);

                    v_result := v_result || jsonb_build_object(
                        'type', 'mention',
                        'username', split_part(v_username, '@', 1),
                        'domain', v_mention_domain,
                        'url', v_tag->>'href',
                        'userId', CASE 
                            WHEN NOT v_mention_is_local THEN 'remote-' || split_part(v_username, '@', 1) || '@' || v_mention_domain
                            ELSE NULL
                        END,
                        'isLocal', v_mention_is_local
                    );
                END;
                
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

COMMENT ON FUNCTION public.convert_ap_to_jsonb(html_content text, tags jsonb)
    IS 'UNIVERSAL converter: ActivityPub HTML → Harmony unified JSONB format. Works for posts, messages, DMs - everything.';

NOTIFY pgrst, 'reload schema';

COMMIT;
