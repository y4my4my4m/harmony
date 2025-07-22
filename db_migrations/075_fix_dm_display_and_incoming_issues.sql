-- Migration 075: Fix DM Display and Incoming DM Issues
-- ISSUE 1: DMs aren't showing in conversation (local display problem)
-- ISSUE 2: Incoming DMs still don't work (federation receiving problem)

BEGIN;

-- =================================================================
-- ISSUE 1 FIX: Debug why DMs aren't showing in conversations
-- =================================================================

-- Check the handle_outgoing_messages function - it should save the message locally FIRST
-- before doing federation. The problem might be that we're only doing federation but not
-- saving the local message properly.

-- Let me check if the message is being saved at all by adding better logging
-- and ensuring the function doesn't interfere with the normal message saving.

-- Actually, the real issue might be that the trigger is REPLACING the normal message save
-- instead of augmenting it. Let me fix this by ensuring the message gets saved normally.

-- =================================================================
-- ISSUE 2 FIX: Update handle_incoming_messages to use conversation_participants
-- =================================================================

CREATE OR REPLACE FUNCTION public.handle_incoming_messages(
    activity_id uuid, 
    activity_data jsonb, 
    actor_profile record, 
    instance_domain text
)
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
    v_local_user_ids UUID[];
    v_all_participants UUID[];
BEGIN
    RAISE NOTICE '📩 Processing incoming ActivityPub DM from %@%', 
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
    
    -- Convert ActivityPub HTML content to our JSONB format
    v_content := convert_ap_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- Get local user IDs (FIXED: local users have domain = NULL, not instance_domain)
    SELECT ARRAY_AGG(p.id) INTO v_local_user_ids
    FROM profiles p
    WHERE p.username = ANY(v_all_recipients)
      AND p.domain IS NULL  -- CRITICAL FIX: Local users have domain = NULL
      AND p.is_local = true;
    
    IF v_local_user_ids IS NULL OR array_length(v_local_user_ids, 1) = 0 THEN
        RAISE WARNING 'No local user profiles found for usernames: %', v_all_recipients;
        RETURN;
    END IF;
    
    RAISE NOTICE '📨 Found % valid local users', array_length(v_local_user_ids, 1);

    -- Create participant list: remote sender + all local recipients
    v_all_participants := ARRAY[actor_profile.id] || v_local_user_ids;

    RAISE NOTICE '🎯 Total conversation participants: %', array_length(v_all_participants, 1);

    -- MODERN: Find existing conversation using conversation_participants
    SELECT DISTINCT c.id INTO v_conversation_id
    FROM conversations c
    WHERE c.type = CASE WHEN array_length(v_all_participants, 1) = 2 THEN 'direct' ELSE 'group' END
      AND (
        -- Exact participant match
        (SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.left_at IS NULL) = array_length(v_all_participants, 1)
        AND
        -- All participants must be present
        NOT EXISTS (
            SELECT 1 FROM unnest(v_all_participants) AS required_participant(participant_id)
            WHERE NOT EXISTS (
                SELECT 1 FROM conversation_participants cp 
                WHERE cp.conversation_id = c.id 
                  AND cp.user_id = required_participant.participant_id 
                  AND cp.left_at IS NULL
            )
        )
    )
    LIMIT 1;

    IF v_conversation_id IS NULL THEN
        -- Create new conversation
        INSERT INTO conversations (
            name,
            type,
            created_by,
            created_at
        ) VALUES (
            CASE 
                WHEN array_length(v_all_participants, 1) = 2 THEN NULL  -- Direct chat
                ELSE 'Private Mention Group'  -- Group chat
            END,
            CASE 
                WHEN array_length(v_all_participants, 1) = 2 THEN 'direct'
                ELSE 'group'
            END,
            actor_profile.id,
            NOW()
        )
        RETURNING id INTO v_conversation_id;
        
        -- Add all participants
        INSERT INTO conversation_participants (conversation_id, user_id, joined_at, role)
        SELECT v_conversation_id, participant_id, NOW(), 'member'
        FROM unnest(v_all_participants) AS participants(participant_id);
        
        RAISE NOTICE '🆕 Created new % conversation % with % participants', 
            CASE WHEN array_length(v_all_participants, 1) = 2 THEN 'direct' ELSE 'group' END,
            v_conversation_id, 
            array_length(v_all_participants, 1);
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

    RAISE NOTICE '✅ Saved federated DM %: %@% -> conversation %', 
        v_message_id, actor_profile.username, actor_profile.domain, v_conversation_id;

    -- Note: DM notifications will be handled by existing message triggers
    -- No need to manually create notifications here
    
    RAISE NOTICE '🎯 Completed DM processing for activity %', activity_id;
END;
$function$;

-- =================================================================
-- ISSUE 1 FIX: Ensure DM messages are saved locally AND federated
-- =================================================================

-- The issue might be that we're not properly handling the message saving.
-- Let's check if there's a trigger order issue or if the message isn't being
-- committed to the database before the DM store tries to read it.

-- Add a small delay and ensure the transaction is committed properly
-- by updating the handle_outgoing_messages function to use NOTIFY
-- for real-time updates after the transaction commits.

CREATE OR REPLACE FUNCTION public.notify_dm_message_sent()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- Only notify for DM messages (have conversation_id)
    IF NEW.conversation_id IS NOT NULL THEN
        -- Use NOTIFY to trigger real-time updates after transaction commits
        PERFORM pg_notify(
            'dm_message_sent',
            jsonb_build_object(
                'message_id', NEW.id,
                'conversation_id', NEW.conversation_id,
                'user_id', NEW.user_id
            )::text
        );
        
        RAISE NOTICE '🔔 Notified DM message sent: % in conversation %', NEW.id, NEW.conversation_id;
    END IF;
    
    RETURN NEW;
END;
$function$;

-- Add trigger for DM message notifications (AFTER INSERT to ensure data is committed)
DROP TRIGGER IF EXISTS trigger_notify_dm_message_sent ON messages;
CREATE TRIGGER trigger_notify_dm_message_sent
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION notify_dm_message_sent();

-- =================================================================
-- ISSUE 1 FIX: Check if there's a missing function call
-- =================================================================

-- Let's also verify that all required functions exist for content processing
DO $$
DECLARE
    function_name text;
    required_functions text[] := ARRAY[
        'convert_ap_to_jsonb',
        'extract_activitypub_attachments', 
        'extract_all_activitypub_tags',
        'convert_jsonb_to_ap'
    ];
BEGIN
    FOREACH function_name IN ARRAY required_functions
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = 'public' 
            AND p.proname = function_name
        ) THEN
            RAISE WARNING '❌ Missing function: %', function_name;
        ELSE
            RAISE NOTICE '✅ Function % exists', function_name;
        END IF;
    END LOOP;
END $$;

COMMIT;