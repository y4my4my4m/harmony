
--
-- Name: parse_activitypub_dm_content_to_jsonb(text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.parse_activitypub_dm_content_to_jsonb(html_content text, tags jsonb DEFAULT NULL::jsonb, instance_domain text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    v_result JSONB := '[]'::jsonb;
    v_text_content TEXT;
    v_tag JSONB;
    v_mention_pattern TEXT;
    v_cleaned_text TEXT;
    v_local_mentions TEXT[] := '{}';
BEGIN
    -- If no content, return empty array
    IF html_content IS NULL OR html_content = '' THEN
        RETURN '[]'::jsonb;
    END IF;

    -- Clean HTML and extract plain text
    v_text_content := regexp_replace(html_content, '<[^>]*>', '', 'g');
    v_text_content := regexp_replace(v_text_content, '&[a-zA-Z0-9#]+;', ' ', 'g');
    v_text_content := trim(v_text_content);

    -- For direct messages, remove mention text at the beginning
    v_cleaned_text := v_text_content;
    
    -- Process mention tags to extract mention patterns to remove
    IF tags IS NOT NULL AND jsonb_typeof(tags) = 'array' AND instance_domain IS NOT NULL THEN
        -- First, collect all local mention patterns
        FOR v_tag IN SELECT * FROM jsonb_array_elements(tags)
        LOOP
            IF v_tag->>'type' = 'Mention' THEN
                -- Check if this mention is for our domain (local user)
                IF v_tag->>'href' LIKE 'https://' || instance_domain || '/%' THEN
                    -- Extract the mention pattern from the tag name
                    v_mention_pattern := v_tag->>'name';
                    IF v_mention_pattern IS NOT NULL THEN
                        v_local_mentions := v_local_mentions || v_mention_pattern;
                    END IF;
                END IF;
            END IF;
        END LOOP;
        
        -- Remove all local mentions from the beginning of the text
        FOREACH v_mention_pattern IN ARRAY v_local_mentions
        LOOP
            -- Remove the mention from the beginning of the text (case insensitive)
            -- Handle patterns like "@username@domain.com" or "@username"
            WHILE v_cleaned_text ILIKE v_mention_pattern || '%' LOOP
                v_cleaned_text := substring(v_cleaned_text from length(v_mention_pattern) + 1);
                -- Remove leading whitespace after removing mention
                v_cleaned_text := ltrim(v_cleaned_text);
            END LOOP;
        END LOOP;
    END IF;

    -- Only add text content if there's something left after stripping mentions
    IF v_cleaned_text != '' THEN
        v_result := v_result || jsonb_build_object(
            'type', 'text',
            'text', v_cleaned_text
        );
    END IF;

    -- For direct messages, we don't include mention objects in the content
    -- The mentions are handled through the conversation context

    RETURN v_result;
END;
$$;


--
-- Name: FUNCTION parse_activitypub_dm_content_to_jsonb(text, jsonb, text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.parse_activitypub_dm_content_to_jsonb(text, jsonb, text) IS 'Converts ActivityPub HTML content to Harmony''s JSONB message format specifically for direct messages. Strips mention text from the beginning and excludes mention objects, since DMs are contextual conversations.';




--
-- Name: handle_incoming_messages(uuid, jsonb, record, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_object JSONB;
    v_content JSONB;
    v_mentioned_users TEXT[];
    v_username TEXT;
    v_local_user RECORD;
    v_conversation_id UUID;
    v_message_id UUID;
    v_directly_addressed TEXT[];
    v_all_recipients TEXT[];
    v_recipient TEXT;
    v_user_match TEXT;
    v_profile_match TEXT;
BEGIN
    RAISE NOTICE '📩 Processing ActivityPub direct message from %@%', 
        actor_profile.username, actor_profile.domain;
    
    v_object := activity_data->'object';
    
    -- Extract mentioned local users from tags
    SELECT ARRAY_AGG(DISTINCT username) INTO v_mentioned_users
    FROM (
        SELECT CASE 
            WHEN tag->>'href' LIKE 'https://' || instance_domain || '/users/%' THEN
                substring(tag->>'href' from 'https://' || instance_domain || '/users/([^/]+)')
            WHEN tag->>'href' LIKE 'https://' || instance_domain || '/social/profile/%' THEN
                substring(tag->>'href' from 'https://' || instance_domain || '/social/profile/([^/]+)')
            ELSE NULL
        END as username
        FROM jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) AS tag
        WHERE tag->>'type' = 'Mention'
    ) t 
    WHERE username IS NOT NULL;

    -- Also check direct addressing in 'to' and 'cc' fields
    SELECT ARRAY_AGG(DISTINCT username) INTO v_directly_addressed
    FROM (
        SELECT CASE 
            WHEN recipient LIKE 'https://' || instance_domain || '/users/%' THEN
                substring(recipient from 'https://' || instance_domain || '/users/([^/]+)')
            WHEN recipient LIKE 'https://' || instance_domain || '/social/profile/%' THEN
                substring(recipient from 'https://' || instance_domain || '/social/profile/([^/]+)')
            ELSE NULL
        END as username
        FROM (
            SELECT jsonb_array_elements_text(COALESCE(v_object->'to', '[]'::jsonb)) as recipient
            UNION ALL
            SELECT jsonb_array_elements_text(COALESCE(v_object->'cc', '[]'::jsonb)) as recipient
        ) recipients
    ) t 
    WHERE username IS NOT NULL;

    -- Combine all recipients
    v_all_recipients := COALESCE(v_mentioned_users, ARRAY[]::TEXT[]) || COALESCE(v_directly_addressed, ARRAY[]::TEXT[]);
    
    -- Remove duplicates
    SELECT ARRAY_AGG(DISTINCT username) INTO v_all_recipients
    FROM unnest(v_all_recipients) AS username;
    
    IF v_all_recipients IS NULL OR array_length(v_all_recipients, 1) = 0 THEN
        RAISE WARNING 'Direct message has no local recipients - skipping';
        RETURN;
    END IF;

    RAISE NOTICE '📧 DM mentions % local users: %', array_length(v_all_recipients, 1), v_all_recipients;
    
    -- Convert ActivityPub HTML content to our JSONB format (specialized for DMs)
    v_content := parse_activitypub_dm_content_to_jsonb(
        v_object->>'content', 
        v_object->'tag',
        instance_domain
    );
    
    -- Process each mentioned local user
    FOREACH v_username IN ARRAY v_all_recipients LOOP
        -- Get the local user
        SELECT * INTO v_local_user
        FROM profiles 
        WHERE username = v_username 
          AND domain = instance_domain 
          AND is_local = true;

        IF NOT FOUND THEN
            RAISE WARNING 'Local user not found: %@%', v_username, instance_domain;
            CONTINUE;
        END IF;

        RAISE NOTICE '📨 Processing DM for local user: %', v_username;

        -- Find or create conversation between remote sender and local recipient
        SELECT id INTO v_conversation_id
        FROM conversations 
        WHERE (user1 = actor_profile.id AND user2 = v_local_user.id)
           OR (user1 = v_local_user.id AND user2 = actor_profile.id);

        IF NOT FOUND THEN
            -- Create new conversation
            INSERT INTO conversations (user1, user2, created_at)
            VALUES (actor_profile.id, v_local_user.id, NOW())
            RETURNING id INTO v_conversation_id;
            
            RAISE NOTICE '🆕 Created new conversation: %', v_conversation_id;
        ELSE
            RAISE NOTICE '📝 Found existing conversation: %', v_conversation_id;
        END IF;

        -- Insert the DM message
        INSERT INTO messages (
            conversation_id,
            user_id,
            content,
            created_at,
            is_system,
            metadata
        ) VALUES (
            v_conversation_id,
            actor_profile.id,
            v_content,
            COALESCE((v_object->>'published')::timestamptz, NOW()),
            false,
            jsonb_build_object(
                'federated', true,
                'ap_id', v_object->>'id',
                'ap_type', 'Note',
                'from_domain', actor_profile.domain,
                'original_url', COALESCE(v_object->>'url', v_object->>'id'),
                'actor_ap_id', actor_profile.federated_id,
                'activity_id', activity_id
            )
        ) RETURNING id INTO v_message_id;

        RAISE NOTICE '✅ Saved federated DM %: %@% -> %', 
            v_message_id, actor_profile.username, actor_profile.domain, v_username;

        -- Note: DM notifications will be handled by existing message triggers
        -- No need to manually create notifications here
    END LOOP;
    
    RAISE NOTICE '🎯 Completed DM processing for activity %', activity_id;
END;
$$;