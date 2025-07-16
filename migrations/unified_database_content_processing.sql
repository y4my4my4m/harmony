-- Unified Database Content Processing for ActivityPub Federation
-- This creates PL/pgSQL functions that mirror the unified content processing logic
-- from /src/utils/unifiedContentProcessing.ts for use in database triggers

-- =====================================================
-- UNIFIED DATABASE CONTENT PROCESSING FUNCTIONS
-- =====================================================

-- Function to convert MessagePart[] content to ActivityPub HTML
CREATE OR REPLACE FUNCTION convert_unified_content_to_activitypub_html(content JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    html_content TEXT := '';
    part_type TEXT;
    part_text TEXT;
    part_href TEXT;
    part_name TEXT;
    part_url TEXT;
    part_alt TEXT;
    part_shortcode TEXT;
    part_emoji_url TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL THEN
        RETURN '';
    END IF;
    
    -- Handle string content (legacy format)
    IF jsonb_typeof(content) = 'string' THEN
        RETURN content #>> '{}';
    END IF;
    
    -- Handle array content (MessagePart[])
    IF jsonb_typeof(content) = 'array' THEN
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
                    part_href := content_part->>'href';
                    part_name := content_part->>'name';
                    IF part_href IS NOT NULL AND part_name IS NOT NULL THEN
                        html_content := html_content || format('<a href="%s" class="mention">@%s</a>', part_href, part_name);
                    END IF;
                    
                WHEN 'emoji' THEN
                    part_shortcode := content_part->>'shortcode';
                    part_emoji_url := content_part->>'url';
                    IF part_shortcode IS NOT NULL THEN
                        IF part_emoji_url IS NOT NULL THEN
                            -- Custom emoji with image
                            html_content := html_content || format('<img src="%s" alt=":%s:" class="emoji" />', part_emoji_url, part_shortcode);
                        ELSE
                            -- Standard unicode emoji or shortcode
                            html_content := html_content || format(':%s:', part_shortcode);
                        END IF;
                    END IF;
                    
                WHEN 'file' THEN
                    -- Files should not be inline in ActivityPub content
                    -- They become attachments instead
                    -- We skip them here and handle in extract_activitypub_attachments
                    CONTINUE;
                    
                WHEN 'url' THEN
                    part_url := content_part->>'url';
                    part_text := content_part->>'text';
                    IF part_url IS NOT NULL THEN
                        html_content := html_content || format('<a href="%s">%s</a>', part_url, COALESCE(part_text, part_url));
                    END IF;
                    
                ELSE
                    -- Unknown type, try to extract text
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        html_content := html_content || part_text;
                    END IF;
            END CASE;
        END LOOP;
        
        RETURN html_content;
    END IF;
    
    -- Fallback: convert to text
    RETURN content::TEXT;
END;
$$;

-- Function to convert MessagePart[] content to plain text
CREATE OR REPLACE FUNCTION convert_unified_content_to_plain_text(content JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    plain_text TEXT := '';
    part_type TEXT;
    part_text TEXT;
    part_name TEXT;
    part_shortcode TEXT;
    part_url TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL THEN
        RETURN '';
    END IF;
    
    -- Handle string content (legacy format)
    IF jsonb_typeof(content) = 'string' THEN
        RETURN content #>> '{}';
    END IF;
    
    -- Handle array content (MessagePart[])
    IF jsonb_typeof(content) = 'array' THEN
        FOR content_part IN SELECT jsonb_array_elements(content)
        LOOP
            part_type := content_part->>'type';
            
            CASE part_type
                WHEN 'text' THEN
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        plain_text := plain_text || part_text;
                    END IF;
                    
                WHEN 'mention' THEN
                    part_name := content_part->>'name';
                    IF part_name IS NOT NULL THEN
                        plain_text := plain_text || '@' || part_name;
                    END IF;
                    
                WHEN 'emoji' THEN
                    part_shortcode := content_part->>'shortcode';
                    IF part_shortcode IS NOT NULL THEN
                        plain_text := plain_text || ':' || part_shortcode || ':';
                    END IF;
                    
                WHEN 'file' THEN
                    -- Skip files in plain text
                    CONTINUE;
                    
                WHEN 'url' THEN
                    part_url := content_part->>'url';
                    part_text := content_part->>'text';
                    IF part_url IS NOT NULL THEN
                        plain_text := plain_text || COALESCE(part_text, part_url);
                    END IF;
                    
                ELSE
                    -- Unknown type, try to extract text
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        plain_text := plain_text || part_text;
                    END IF;
            END CASE;
        END LOOP;
        
        RETURN plain_text;
    END IF;
    
    -- Fallback: convert to text
    RETURN content::TEXT;
END;
$$;

-- Function to extract ActivityPub attachments from MessagePart[] content
CREATE OR REPLACE FUNCTION extract_activitypub_attachments(content JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    attachments JSONB := '[]'::JSONB;
    part_type TEXT;
    part_url TEXT;
    part_name TEXT;
    part_size INTEGER;
    part_type_attr TEXT;
    attachment JSONB;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'file' THEN
            part_url := content_part->>'url';
            part_name := content_part->>'name';
            part_size := (content_part->>'size')::INTEGER;
            part_type_attr := content_part->>'mimeType';
            
            IF part_url IS NOT NULL THEN
                attachment := jsonb_build_object(
                    'type', 'Document',
                    'url', part_url,
                    'mediaType', COALESCE(part_type_attr, 'application/octet-stream')
                );
                
                IF part_name IS NOT NULL THEN
                    attachment := attachment || jsonb_build_object('name', part_name);
                END IF;
                
                IF part_size IS NOT NULL THEN
                    attachment := attachment || jsonb_build_object('size', part_size);
                END IF;
                
                attachments := attachments || jsonb_build_array(attachment);
            END IF;
        END IF;
    END LOOP;
    
    RETURN attachments;
END;
$$;

-- Function to extract Misskey-compatible emoji tags from MessagePart[] content
CREATE OR REPLACE FUNCTION extract_misskey_emoji_tags(content JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    emoji_tags JSONB := '[]'::JSONB;
    part_type TEXT;
    part_shortcode TEXT;
    part_url TEXT;
    emoji_tag JSONB;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'emoji' THEN
            part_shortcode := content_part->>'shortcode';
            part_url := content_part->>'url';
            
            IF part_shortcode IS NOT NULL AND part_url IS NOT NULL THEN
                emoji_tag := jsonb_build_object(
                    'type', 'Emoji',
                    'name', ':' || part_shortcode || ':',
                    'icon', jsonb_build_object(
                        'type', 'Image',
                        'url', part_url
                    )
                );
                
                emoji_tags := emoji_tags || jsonb_build_array(emoji_tag);
            END IF;
        END IF;
    END LOOP;
    
    RETURN emoji_tags;
END;
$$;

-- Function to extract ActivityPub mention tags from MessagePart[] content
CREATE OR REPLACE FUNCTION extract_activitypub_mention_tags(content JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    mention_tags JSONB := '[]'::JSONB;
    part_type TEXT;
    part_href TEXT;
    part_name TEXT;
    mention_tag JSONB;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'mention' THEN
            part_href := content_part->>'href';
            part_name := content_part->>'name';
            
            IF part_href IS NOT NULL AND part_name IS NOT NULL THEN
                mention_tag := jsonb_build_object(
                    'type', 'Mention',
                    'href', part_href,
                    'name', '@' || part_name
                );
                
                mention_tags := mention_tags || jsonb_build_array(mention_tag);
            END IF;
        END IF;
    END LOOP;
    
    RETURN mention_tags;
END;
$$;

-- Function to combine all tags (mentions + emojis) for ActivityPub
CREATE OR REPLACE FUNCTION extract_all_activitypub_tags(content JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    mention_tags JSONB;
    emoji_tags JSONB;
    all_tags JSONB := '[]'::JSONB;
    tag_item JSONB;
BEGIN
    -- Extract mention tags
    mention_tags := extract_activitypub_mention_tags(content);
    FOR tag_item IN SELECT jsonb_array_elements(mention_tags)
    LOOP
        all_tags := all_tags || jsonb_build_array(tag_item);
    END LOOP;
    
    -- Extract emoji tags
    emoji_tags := extract_misskey_emoji_tags(content);
    FOR tag_item IN SELECT jsonb_array_elements(emoji_tags)
    LOOP
        all_tags := all_tags || jsonb_build_array(tag_item);
    END LOOP;
    
    RETURN all_tags;
END;
$$;

-- =====================================================
-- UPDATED DM FEDERATION FUNCTION
-- =====================================================

-- Replace the legacy create_outgoing_dm_activity function with unified processing
CREATE OR REPLACE FUNCTION create_outgoing_dm_activity_unified(
    p_message_id UUID,
    p_conversation_id UUID,
    p_sender_id UUID,
    p_content JSONB,
    p_recipient_domains TEXT[]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_activity_id UUID;
    v_sender_profile RECORD;
    v_recipient_profile RECORD;
    v_activity_data JSONB;
    v_create_activity JSONB;
    v_note_object JSONB;
    v_domain TEXT := COALESCE(current_setting('app.domain', true), 'har.mony.lol');
    v_message_url TEXT;
    v_actor_url TEXT;
    v_recipient_url TEXT;
    v_domain_to_process TEXT;
    v_inbox_url TEXT;
    
    -- Unified content processing variables
    v_html_content TEXT;
    v_attachments JSONB;
    v_tags JSONB;
    v_to_addresses JSONB := '[]'::JSONB;
    v_cc_addresses JSONB := '[]'::JSONB;
BEGIN
    -- Get sender profile information
    SELECT username, display_name, domain, is_local
    INTO v_sender_profile
    FROM profiles 
    WHERE id = p_sender_id;
    
    IF NOT FOUND OR NOT v_sender_profile.is_local THEN
        RAISE EXCEPTION 'Sender must be a local user';
    END IF;
    
    -- Create URLs
    v_actor_url := 'https://' || v_domain || '/users/' || v_sender_profile.username;
    v_message_url := 'https://' || v_domain || '/messages/' || p_message_id::TEXT;
    
    -- Use unified content processing functions
    v_html_content := convert_unified_content_to_activitypub_html(p_content);
    v_attachments := extract_activitypub_attachments(p_content);
    v_tags := extract_all_activitypub_tags(p_content);
    
    -- Get recipient information for addressing
    FOR v_recipient_profile IN 
        SELECT p.username, p.domain, p.federated_id, p.is_local
        FROM conversations c
        JOIN profiles p ON (p.id = c.user1_id OR p.id = c.user2_id)
        WHERE c.id = p_conversation_id 
        AND p.id != p_sender_id
        AND NOT p.is_local
    LOOP
        v_recipient_url := 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username;
        v_to_addresses := v_to_addresses || to_jsonb(v_recipient_url);
    END LOOP;
    
    -- Create the Note object using unified processing
    v_note_object := jsonb_build_object(
        'id', v_message_url,
        'type', 'Note',
        'published', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'attributedTo', v_actor_url,
        'content', v_html_content,
        'to', v_to_addresses,
        'cc', v_cc_addresses,
        'tag', v_tags,
        'url', v_message_url,
        'inReplyTo', NULL,
        'sensitive', false
    );
    
    -- Add attachments if present
    IF jsonb_array_length(v_attachments) > 0 THEN
        v_note_object := v_note_object || jsonb_build_object('attachment', v_attachments);
    END IF;
    
    -- Create the Create activity
    v_create_activity := jsonb_build_object(
        '@context', 'https://www.w3.org/ns/activitystreams',
        'id', v_message_url || '/activity',
        'type', 'Create',
        'actor', v_actor_url,
        'published', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'to', v_to_addresses,
        'cc', v_cc_addresses,
        'object', v_note_object
    );
    
    -- Store the activity (rest of the function remains the same)
    INSERT INTO ap_activities (
        ap_id,
        ap_type,
        actor_ap_id,
        activity_data,
        object_ap_id,
        object_type,
        origin_domain,
        target_domain,
        is_local,
        status,
        to_addresses,
        cc_addresses
    ) VALUES (
        v_create_activity->>'id',
        'Create',
        v_actor_url,
        v_create_activity,
        v_message_url,
        'Note',
        v_domain,
        NULL,
        true,
        'pending',
        ARRAY(SELECT jsonb_array_elements_text(v_to_addresses)),
        ARRAY(SELECT jsonb_array_elements_text(v_cc_addresses))
    ) RETURNING id INTO v_activity_id;
    
    -- Queue deliveries to each recipient domain
    FOREACH v_domain_to_process IN ARRAY p_recipient_domains
    LOOP
        v_inbox_url := 'https://' || v_domain_to_process || '/inbox';
        
        INSERT INTO federation_delivery_queue (
            activity_id,
            target_domain,
            target_inbox_url,
            status,
            priority
        ) VALUES (
            v_activity_id,
            v_domain_to_process,
            v_inbox_url,
            'pending',
            8 -- High priority for DMs
        );
    END LOOP;
    
    RETURN v_activity_id;
    
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Error creating outgoing DM activity: %', SQLERRM;
        RETURN NULL;
END;
$$;

-- =====================================================
-- GRANTS AND COMMENTS
-- =====================================================

-- Grant permissions
GRANT EXECUTE ON FUNCTION convert_unified_content_to_activitypub_html(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION convert_unified_content_to_plain_text(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION extract_activitypub_attachments(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION extract_misskey_emoji_tags(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION extract_activitypub_mention_tags(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION extract_all_activitypub_tags(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION create_outgoing_dm_activity_unified(UUID, UUID, UUID, JSONB, TEXT[]) TO authenticated, service_role;

-- Documentation
COMMENT ON FUNCTION convert_unified_content_to_activitypub_html(JSONB) IS 'Converts MessagePart[] content to ActivityPub HTML format using unified processing logic';
COMMENT ON FUNCTION convert_unified_content_to_plain_text(JSONB) IS 'Converts MessagePart[] content to plain text format using unified processing logic';
COMMENT ON FUNCTION extract_activitypub_attachments(JSONB) IS 'Extracts file attachments from MessagePart[] content as ActivityPub Document objects';
COMMENT ON FUNCTION extract_misskey_emoji_tags(JSONB) IS 'Extracts custom emoji tags from MessagePart[] content in Misskey-compatible format';
COMMENT ON FUNCTION extract_activitypub_mention_tags(JSONB) IS 'Extracts mention tags from MessagePart[] content as ActivityPub Mention objects';
COMMENT ON FUNCTION extract_all_activitypub_tags(JSONB) IS 'Combines mention and emoji tags for complete ActivityPub tag array';
COMMENT ON FUNCTION create_outgoing_dm_activity_unified(UUID, UUID, UUID, JSONB, TEXT[]) IS 'Creates outgoing DM ActivityPub activities using unified content processing logic';

-- Log completion
DO $$
BEGIN
    RAISE NOTICE '✅ Unified database content processing functions created successfully';
    RAISE NOTICE '📝 These functions mirror the unified content processing logic from TypeScript';
    RAISE NOTICE '🔄 Update your database triggers to use these unified functions for consistency';
    RAISE NOTICE '🎯 Next: Update handle_post_federation() and other triggers to use unified processing';
END;
$$;
