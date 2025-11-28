-- =====================================================
-- Migration 21: Fix NULL Mention Username in HTML Generation
-- =====================================================
--
-- PROBLEM: In the content-to-HTML conversion used by federation triggers,
-- when a mention part has a NULL username, the entire string concatenation
-- returns NULL. The string_agg function then silently skips this NULL value,
-- causing mentions with missing username fields to be dropped from the 
-- generated HTML content sent to remote instances.
--
-- AFFECTED FUNCTIONS:
-- - handle_post_federation (from migration 17, updated in 18)
-- - Any function using the same content-to-HTML pattern
--
-- FIX: Use COALESCE to provide fallback values for potentially NULL fields
-- in all content parts (mentions, emojis, hashtags).
--
-- =====================================================

-- =====================================================
-- FIX 1: Create a reusable function for content-to-HTML conversion
-- This centralizes the logic and ensures consistent handling
-- =====================================================

CREATE OR REPLACE FUNCTION public.convert_content_to_html(
    p_content jsonb,
    p_instance_domain text
) RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_html text;
BEGIN
    SELECT string_agg(
        CASE 
            WHEN part->>'type' = 'text' THEN 
                COALESCE(part->>'text', '')
            WHEN part->>'type' = 'mention' THEN 
                -- FIX: Use COALESCE for username to prevent NULL concatenation
                CASE 
                    WHEN part->>'username' IS NOT NULL THEN
                        '<span class="h-card"><a href="https://' || 
                        COALESCE(part->>'domain', p_instance_domain) || 
                        '/users/' || (part->>'username') || 
                        '" class="u-url mention">@<span>' || (part->>'username') || '</span></a></span>'
                    ELSE 
                        -- Fallback: render as plain text if username is missing
                        COALESCE('@' || (part->>'display_name'), '@unknown')
                END
            WHEN part->>'type' = 'emoji' THEN 
                -- FIX: Use COALESCE for emoji name
                ':' || COALESCE(part->>'name', 'emoji') || ':'
            WHEN part->>'type' = 'hashtag' THEN 
                -- FIX: Use COALESCE for hashtag
                '#' || COALESCE(part->>'tag', COALESCE(part->>'name', 'tag'))
            WHEN part->>'type' = 'link' THEN
                -- Handle link parts
                '<a href="' || COALESCE(part->>'url', '#') || '">' || 
                COALESCE(part->>'text', part->>'url', 'link') || '</a>'
            WHEN part->>'type' = 'file' THEN
                -- Skip file parts in HTML (handled separately as attachments)
                ''
            ELSE 
                -- Unknown type: try to extract any text content
                COALESCE(part->>'text', '')
        END, ''  -- Use empty string as separator (parts handle their own spacing)
    ) INTO v_html
    FROM jsonb_array_elements(p_content) AS part;
    
    RETURN COALESCE(v_html, '');
END;
$$;

COMMENT ON FUNCTION public.convert_content_to_html(jsonb, text) IS 
    'Converts post content JSONB array to HTML string for ActivityPub federation. Properly handles NULL values in mentions, emojis, and hashtags to prevent data loss.';


-- =====================================================
-- NOTE: handle_post_federation already calls build_post_create_activity,
-- so updating build_post_create_activity automatically fixes the trigger.
-- =====================================================


-- =====================================================
-- FIX 2: Update build_post_create_activity to use NULL-safe HTML conversion
-- =====================================================

CREATE OR REPLACE FUNCTION public.build_post_create_activity(
    p_post_id uuid,
    p_author_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_post RECORD;
    v_author RECORD;
    v_instance_domain text;
    v_activity_id text;
    v_post_url text;
    v_author_url text;
    v_followers_url text;
    v_note_object jsonb;
    v_activity jsonb;
    v_content_html text;
    v_to_addresses jsonb;
    v_cc_addresses jsonb;
BEGIN
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    IF v_instance_domain IS NULL THEN
        v_instance_domain := 'har.mony.lol'; -- Fallback
    END IF;
    
    -- Get post data
    SELECT * INTO v_post FROM posts WHERE id = p_post_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Get author data
    SELECT * INTO v_author FROM profiles WHERE id = p_author_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Build URLs
    v_author_url := 'https://' || v_instance_domain || '/users/' || v_author.id;
    v_post_url := 'https://' || v_instance_domain || '/posts/' || v_post.id;
    v_activity_id := v_post_url || '#activity';
    v_followers_url := v_author_url || '/followers';
    
    -- FIX: Convert content to HTML using NULL-safe function
    v_content_html := '<p>' || convert_content_to_html(v_post.content, v_instance_domain) || '</p>';
    
    -- Determine addressing based on visibility
    IF v_post.visibility = 'public' THEN
        v_to_addresses := jsonb_build_array('https://www.w3.org/ns/activitystreams#Public');
        v_cc_addresses := jsonb_build_array(v_followers_url);
    ELSIF v_post.visibility = 'unlisted' THEN
        v_to_addresses := jsonb_build_array(v_followers_url);
        v_cc_addresses := jsonb_build_array('https://www.w3.org/ns/activitystreams#Public');
    ELSIF v_post.visibility = 'followers' THEN
        v_to_addresses := jsonb_build_array(v_followers_url);
        v_cc_addresses := '[]'::jsonb;
    ELSE
        -- Direct/private - would need specific recipients
        v_to_addresses := '[]'::jsonb;
        v_cc_addresses := '[]'::jsonb;
    END IF;
    
    -- Build Note object
    v_note_object := jsonb_build_object(
        'id', v_post_url,
        'type', 'Note',
        'published', to_char(v_post.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'attributedTo', v_author_url,
        'content', v_content_html,
        'url', v_post_url,
        'to', v_to_addresses,
        'cc', v_cc_addresses,
        'sensitive', COALESCE(v_post.is_sensitive, false),
        'attachment', COALESCE(v_post.media_attachments, '[]'::jsonb)
    );
    
    -- Add inReplyTo if this is a reply
    IF v_post.in_reply_to IS NOT NULL THEN
        v_note_object := v_note_object || jsonb_build_object(
            'inReplyTo', 'https://' || v_instance_domain || '/posts/' || v_post.in_reply_to
        );
    END IF;
    
    -- Add content warning if present
    IF v_post.content_warning IS NOT NULL AND v_post.content_warning != '' THEN
        v_note_object := v_note_object || jsonb_build_object(
            'summary', v_post.content_warning
        );
    END IF;
    
    -- Build Create activity
    v_activity := jsonb_build_object(
        '@context', 'https://www.w3.org/ns/activitystreams',
        'id', v_activity_id,
        'type', 'Create',
        'actor', v_author_url,
        'published', to_char(v_post.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'to', v_to_addresses,
        'cc', v_cc_addresses,
        'object', v_note_object
    );
    
    RETURN v_activity;
END;
$$;

COMMENT ON FUNCTION public.build_post_create_activity(uuid, uuid) IS 
    'Builds an ActivityPub Create activity for a post. Uses convert_content_to_html for NULL-safe HTML generation of mentions, emojis, and hashtags.';


-- =====================================================
-- VERIFICATION
-- =====================================================

DO $$
BEGIN
    RAISE LOG 'Migration 21_fix_null_mention_html.sql applied successfully';
    RAISE LOG 'Created: convert_content_to_html() - centralized NULL-safe HTML generation';
    RAISE LOG 'Updated: build_post_create_activity() - now uses convert_content_to_html()';
    RAISE LOG 'Updated: handle_post_federation() - already uses build_post_create_activity()';
    RAISE LOG 'Fixed: NULL username/emoji/hashtag values no longer cause data loss';
END $$;

