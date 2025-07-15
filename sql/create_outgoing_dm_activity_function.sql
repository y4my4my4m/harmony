-- Function to create and queue outgoing direct message activities for ActivityPub federation
-- This function creates the ActivityPub Create activity and queues it for delivery

CREATE OR REPLACE FUNCTION create_outgoing_dm_activity(
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
    
    -- Convert content to HTML for ActivityPub
    -- Simple conversion: assume content is array of text/mention parts
    DECLARE
        v_html_content TEXT := '';
        v_content_part JSONB;
        v_tags JSONB := '[]'::JSONB;
    BEGIN
        FOR v_content_part IN SELECT jsonb_array_elements(p_content)
        LOOP
            IF v_content_part->>'type' = 'text' THEN
                v_html_content := v_html_content || (v_content_part->>'text');
            ELSIF v_content_part->>'type' = 'mention' THEN
                -- Add mention tag and HTML
                v_tags := v_tags || jsonb_build_object(
                    'type', 'Mention',
                    'href', v_content_part->>'href',
                    'name', v_content_part->>'name'
                );
                v_html_content := v_html_content || '<a href="' || (v_content_part->>'href') || '">@' || (v_content_part->>'name') || '</a>';
            END IF;
        END LOOP;
    END;
    
    -- Get recipient information for addressing
    DECLARE
        v_to_addresses JSONB := '[]'::JSONB;
        v_cc_addresses JSONB := '[]'::JSONB;
    BEGIN
        -- Find all federated recipients in this conversation
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
    END;
    
    -- Create the Note object
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
    
    -- Store the activity
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
        NULL, -- Will be set per delivery
        true,
        'pending',
        ARRAY(SELECT jsonb_array_elements_text(v_to_addresses)),
        ARRAY(SELECT jsonb_array_elements_text(v_cc_addresses))
    ) RETURNING id INTO v_activity_id;
    
    -- Queue deliveries to each recipient domain
    FOREACH v_domain_to_process IN ARRAY p_recipient_domains
    LOOP
        -- Get inbox URL for the domain (simplified - in practice you'd need to resolve this)
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

-- Grant permissions
GRANT EXECUTE ON FUNCTION create_outgoing_dm_activity(UUID, UUID, UUID, JSONB, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION create_outgoing_dm_activity(UUID, UUID, UUID, JSONB, TEXT[]) TO service_role;
