-- Fix Missing DM Content Function Call
-- ISSUE: handle_incoming_messages() calls removed function parse_activitypub_dm_content_to_jsonb()
-- SOLUTION: Replace with convert_ap_to_jsonb() which is the correct universal function

CREATE OR REPLACE FUNCTION handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
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
    v_local_user_ids UUID[];
    v_all_participants UUID[];
BEGIN
    RAISE NOTICE '📩 Processing ActivityPub private mention from %@%', 
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
        RAISE WARNING 'Private mention has no local recipients - skipping';
        RETURN;
    END IF;

    RAISE NOTICE '📧 Private mention targets % local users: %', array_length(v_all_recipients, 1), v_all_recipients;
    
    -- CRITICAL FIX: Use convert_ap_to_jsonb instead of missing parse_activitypub_dm_content_to_jsonb
    v_content := convert_ap_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- Get all local user IDs that are mentioned
    SELECT ARRAY_AGG(p.id) INTO v_local_user_ids
    FROM profiles p
    WHERE p.username = ANY(v_all_recipients)
      AND p.domain IS NULL  -- Local users have domain = NULL
      AND p.is_local = true;

    IF v_local_user_ids IS NULL OR array_length(v_local_user_ids, 1) = 0 THEN
        RAISE WARNING 'No valid local users found from mentions: %', v_all_recipients;
        RETURN;
    END IF;

    RAISE NOTICE '📨 Found % valid local users', array_length(v_local_user_ids, 1);

    -- Create participant list: remote sender + all local recipients
    v_all_participants := ARRAY[actor_profile.id] || v_local_user_ids;

    RAISE NOTICE '🎯 Total conversation participants: %', array_length(v_all_participants, 1);

    -- MODERN: Find existing conversation with EXACT same participants using conversation_participants
    SELECT DISTINCT c.id INTO v_conversation_id
    FROM conversations c
    WHERE (
        -- For direct conversations (1:1)
        (c.type = 'direct' AND EXISTS (
            SELECT 1 FROM conversation_participants cp1
            WHERE cp1.conversation_id = c.id 
              AND cp1.user_id = actor_profile.id 
              AND cp1.left_at IS NULL
        ) AND EXISTS (
            SELECT 1 FROM conversation_participants cp2
            WHERE cp2.conversation_id = c.id 
              AND cp2.user_id = ANY(v_local_user_ids)
              AND cp2.left_at IS NULL
        ) AND (
            SELECT COUNT(*) FROM conversation_participants cp3
            WHERE cp3.conversation_id = c.id 
              AND cp3.left_at IS NULL
        ) = 2)
        
        OR
        
        -- For group conversations (multi-participant)
        (c.type = 'group' AND (
            SELECT ARRAY_AGG(cp.user_id ORDER BY cp.user_id) 
            FROM conversation_participants cp
            WHERE cp.conversation_id = c.id 
              AND cp.left_at IS NULL
        ) = (
            SELECT ARRAY_AGG(unnest ORDER BY unnest) 
            FROM unnest(v_all_participants)
        ))
    )
    LIMIT 1;

    IF v_conversation_id IS NULL THEN
        -- MODERN: Create new conversation with proper type
        INSERT INTO conversations (
            type, 
            created_by, 
            is_active,
            created_at,
            updated_at
        ) VALUES (
            CASE 
                WHEN array_length(v_all_participants, 1) = 2 THEN 'direct'
                ELSE 'group'
            END,
            actor_profile.id,
            TRUE,
            NOW(),
            NOW()
        ) RETURNING id INTO v_conversation_id;
        
        -- Add all participants
        INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
        SELECT v_conversation_id, unnest, 'member', NOW()
        FROM unnest(v_all_participants);
        
        RAISE NOTICE '🆕 Created new % conversation: %', 
            CASE WHEN array_length(v_all_participants, 1) = 2 THEN 'direct' ELSE 'group' END,
            v_conversation_id;
    ELSE
        RAISE NOTICE '📝 Found existing conversation: %', v_conversation_id;
    END IF;

    -- Insert the private mention message
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
            'activity_id', activity_id,
            'private_mention', true,
            'mentioned_users', v_all_recipients
        )
    ) RETURNING id INTO v_message_id;

    RAISE NOTICE '✅ Saved federated private mention %: %@% -> % local users', 
        v_message_id, actor_profile.username, actor_profile.domain, array_length(v_local_user_ids, 1);

    -- Note: Notifications will be handled by existing message triggers automatically
    
    RAISE NOTICE '🎯 Completed private mention processing for activity %', activity_id;
END;
$function$;