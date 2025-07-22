BEGIN;

-- Migration 048: Fix Modern DM Federation Architecture
-- FIXES:
-- 1. handle_incoming_messages() uses legacy user1/user2 (now conversation_participants)
-- 2. Group chat support for multiple mentions in private mentions
-- 3. Modern function usage (send_notification vs create_notification_structured)
-- 4. Proper ActivityPub private mention format

-- =================================================================
-- 1. FIX INCOMING MESSAGES - Modern Conversation Participants System
-- =================================================================

CREATE OR REPLACE FUNCTION handle_incoming_messages(
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
    existing_conversation RECORD;
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
    
    -- Convert ActivityPub HTML content to our JSONB format
    v_content := convert_ap_to_jsonb(
        v_object->>'content', 
        v_object->'tag',
        instance_domain
    );
    
    -- Get all local user IDs that are mentioned
    SELECT ARRAY_AGG(p.id) INTO v_local_user_ids
    FROM profiles p
    WHERE p.username = ANY(v_all_recipients)
      AND p.domain = instance_domain 
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
        -- Count must match exactly
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
        -- MODERN: Create new multi-participant conversation
        INSERT INTO conversations (
            name,
            type,
            created_by,
            created_at
        ) VALUES (
            CASE 
                WHEN array_length(v_all_participants, 1) = 2 THEN NULL  -- Direct chat, no name
                ELSE 'Private Mention Group'  -- Group chat gets a name
            END,
            CASE 
                WHEN array_length(v_all_participants, 1) = 2 THEN 'direct'
                ELSE 'group'
            END,
            actor_profile.id,
            NOW()
        )
        RETURNING id INTO v_conversation_id;
        
        -- MODERN: Add all participants
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

-- =================================================================
-- 2. FIX OUTGOING MESSAGES - Use Modern send_notification Function
-- =================================================================

CREATE OR REPLACE FUNCTION handle_outgoing_messages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $function$
DECLARE
    -- Variables for notifications
    mentioned_usernames TEXT[];
    mentioned_user_id UUID;
    username_item TEXT;
    sender_profile profiles%ROWTYPE;
    channel_info channels%ROWTYPE;
    server_info servers%ROWTYPE;
    conversation_info conversations%ROWTYPE;
    reply_author_id UUID;
    content_preview TEXT;
    notification_data JSONB;
    recipient_profile profiles%ROWTYPE;
    
    -- Variables for federation
    v_recipient_profile RECORD;
    v_instance_domain TEXT;
    v_activity_id TEXT;
    v_activity_uuid UUID;
    v_sender_url TEXT;
    v_recipient_url TEXT;
    v_message_url TEXT;
    v_activity JSONB;
    v_note_object JSONB;
    
    -- Variables for unified content processing
    v_html_content TEXT;
    v_attachments JSONB;
    v_tags JSONB;
    
    -- Variables for conversation participants
    participant_record RECORD;
    v_all_remote_participants UUID[];
    v_to_addresses JSONB;
BEGIN
    -- Get sender profile (used by both notifications and federation)
    SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- DEBUG: Log that the function is running
    RAISE WARNING '🔧 handle_outgoing_messages() function called for message %', NEW.id;
    
    -- Extract content preview for notifications
    IF jsonb_typeof(NEW.content) = 'array' THEN
        SELECT LEFT(string_agg(
            CASE 
                WHEN item->>'type' = 'mention' THEN '@' || item->>'username'
                ELSE COALESCE(item->>'text', item::text)
            END, ''
        ), 100) INTO content_preview
        FROM jsonb_array_elements(NEW.content) AS item;
    ELSE
        content_preview := LEFT(NEW.content::text, 100);
    END IF;
    
    -- =================================================================
    -- SECTION 1: HANDLE NOTIFICATIONS (Local users only) 
    -- =================================================================
    
    -- Handle DM notifications (MODERN PARTICIPANT SYSTEM)
    IF NEW.conversation_id IS NOT NULL THEN
        SELECT * INTO conversation_info FROM conversations WHERE id = NEW.conversation_id;
        
        -- Build structured data for DM notification
        notification_data := jsonb_build_object(
            'sender', jsonb_build_object(
                'user_id', sender_profile.id,
                'username', sender_profile.username,
                'avatar_url', sender_profile.avatar_url
            ),
            'conversation', jsonb_build_object(
                'id', NEW.conversation_id,
                'type', conversation_info.type,
                'name', conversation_info.name
            ),
            'message', jsonb_build_object(
                'id', NEW.id,
                'content_preview', content_preview,
                'created_at', NEW.created_at
            )
        );
        
        -- MODERN: Notify all conversation participants except sender
        FOR participant_record IN 
            SELECT cp.user_id, p.is_local
            FROM conversation_participants cp
            JOIN profiles p ON p.id = cp.user_id
            WHERE cp.conversation_id = NEW.conversation_id 
              AND cp.user_id != NEW.user_id
              AND cp.left_at IS NULL
        LOOP
            -- Only notify LOCAL users using MODERN function
            IF participant_record.is_local THEN
                PERFORM send_notification(
                    CASE 
                        WHEN conversation_info.type = 'group' THEN 'group_message'
                        ELSE 'dm'
                    END,
                    ARRAY[participant_record.user_id],
                    notification_data,
                    NULL, NULL, NEW.conversation_id
                );
            END IF;
        END LOOP;
    
    -- Handle server channel notifications
    ELSIF NEW.channel_id IS NOT NULL THEN
        SELECT * INTO channel_info FROM channels WHERE id = NEW.channel_id;
        SELECT * INTO server_info FROM servers WHERE id = channel_info.server_id;
        
        notification_data := jsonb_build_object(
            'sender', jsonb_build_object(
                'user_id', sender_profile.id,
                'username', sender_profile.username,
                'avatar_url', sender_profile.avatar_url
            ),
            'location', jsonb_build_object(
                'server_id', channel_info.server_id,
                'server_name', server_info.name,
                'channel_id', NEW.channel_id,
                'channel_name', channel_info.name
            ),
            'message', jsonb_build_object(
                'id', NEW.id,
                'content_preview', content_preview,
                'created_at', NEW.created_at
            )
        );
        
        -- Handle reply notifications (LOCAL users only)
        IF NEW.reply_to IS NOT NULL THEN
            SELECT user_id INTO reply_author_id FROM messages WHERE id = NEW.reply_to;
            IF reply_author_id IS NOT NULL AND reply_author_id != NEW.user_id THEN
                SELECT * INTO recipient_profile FROM profiles WHERE id = reply_author_id;
                IF recipient_profile.is_local THEN
                    PERFORM send_notification(
                        'reply',
                        ARRAY[reply_author_id],
                        notification_data || jsonb_build_object(
                            'original_message', jsonb_build_object('id', NEW.reply_to)
                        ),
                        channel_info.server_id, NEW.channel_id, NULL
                    );
                END IF;
            END IF;
        END IF;
        
        -- Handle mention notifications (LOCAL users only)
        mentioned_usernames := extract_mentions(NEW.content);
        FOREACH username_item IN ARRAY mentioned_usernames
        LOOP
            mentioned_user_id := get_user_id_from_username(username_item);
            IF mentioned_user_id IS NOT NULL AND mentioned_user_id != NEW.user_id THEN
                SELECT * INTO recipient_profile FROM profiles WHERE id = mentioned_user_id;
                IF recipient_profile.is_local THEN
                    PERFORM send_notification(
                        'mention',
                        ARRAY[mentioned_user_id],
                        notification_data,
                        channel_info.server_id, NEW.channel_id, NULL
                    );
                END IF;
            END IF;
        END LOOP;
    END IF;
    
    -- =================================================================
    -- SECTION 2: HANDLE FEDERATION (Private Mentions to remote users)
    -- =================================================================
    
    -- Only federate DM messages from local users (MODERN PARTICIPANT SYSTEM)
    IF NEW.conversation_id IS NOT NULL AND sender_profile.is_local THEN
        -- Get instance domain from config
        SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
        FROM instance_config 
        WHERE config_key = 'domain' 
        LIMIT 1;
        
        IF v_instance_domain IS NOT NULL THEN
            -- MODERN: Get all remote participants
            SELECT ARRAY_AGG(p.id) INTO v_all_remote_participants
            FROM conversation_participants cp
            JOIN profiles p ON p.id = cp.user_id
            WHERE cp.conversation_id = NEW.conversation_id 
              AND cp.user_id != NEW.user_id
              AND cp.left_at IS NULL
              AND NOT p.is_local
              AND p.domain IS NOT NULL;

            -- Only federate if there are remote participants
            IF v_all_remote_participants IS NOT NULL AND array_length(v_all_remote_participants, 1) > 0 THEN
                -- Build URLs
                v_sender_url := 'https://' || v_instance_domain || '/users/' || sender_profile.username;
                v_message_url := 'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT;
                v_activity_id := v_sender_url || '#create-private-mention-' || NEW.id::TEXT;
                
                -- Build "to" addresses for all remote participants
                SELECT jsonb_agg(
                    COALESCE(p.federated_id, 'https://' || p.domain || '/users/' || p.username)
                ) INTO v_to_addresses
                FROM profiles p
                WHERE p.id = ANY(v_all_remote_participants);
                
                RAISE WARNING '🎯 Private mention recipients: %', v_to_addresses;
                
                -- Use unified content processing for federation
                v_html_content := convert_jsonb_to_ap(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                v_tags := extract_all_activitypub_tags(NEW.content);
                
                -- Create Note object (Private Mention format)
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note', 
                    'published', NEW.created_at::text,
                    'attributedTo', v_sender_url,
                    'content', v_html_content,
                    'url', v_message_url,
                    'to', v_to_addresses,  -- Only the mentioned users
                    'cc', '[]'::jsonb      -- Private mentions have empty cc
                );
                
                -- Add attachments and tags if present
                IF v_attachments IS NOT NULL AND jsonb_array_length(v_attachments) > 0 THEN
                    v_note_object := v_note_object || jsonb_build_object('attachment', v_attachments);
                END IF;
                
                IF v_tags IS NOT NULL AND jsonb_array_length(v_tags) > 0 THEN
                    v_note_object := v_note_object || jsonb_build_object('tag', v_tags);
                END IF;
                
                -- Create Activity wrapper
                v_activity := jsonb_build_object(
                    'id', v_activity_id,
                    'type', 'Create',
                    'actor', v_sender_url,
                    'published', NEW.created_at::text,
                    'object', v_note_object,
                    'to', v_to_addresses,  -- Private mention audience
                    'cc', '[]'::jsonb
                );
                
                -- Generate activity UUID for ap_activities table
                v_activity_uuid := gen_random_uuid();
                
                -- First, insert into ap_activities table
                INSERT INTO ap_activities (
                    id,
                    ap_id,
                    ap_type,
                    actor_id,
                    actor_ap_id,
                    object_id,
                    object_type,
                    activity_data,
                    status,
                    is_local,
                    to_addresses
                ) VALUES (
                    v_activity_uuid,
                    v_activity_id,
                    'Create',
                    sender_profile.id,
                    v_sender_url,
                    v_message_url,
                    'Note',
                    v_activity,
                    'pending',
                    true,
                    (SELECT ARRAY_AGG(addr::text) FROM jsonb_array_elements_text(v_to_addresses) AS addr)
                );
                
                -- MODERN: Queue for delivery to all remote participants
                FOR v_recipient_profile IN 
                    SELECT p.id, p.username, p.domain, p.federated_id, p.inbox_url
                    FROM profiles p
                    WHERE p.id = ANY(v_all_remote_participants)
                LOOP
                    INSERT INTO federation_delivery_queue (
                        activity_id,           
                        activity_data,         
                        target_domain,         
                        target_inbox_url,      
                        status,                
                        priority,              
                        actor_username,        
                        actor_domain           
                    ) VALUES (
                        v_activity_uuid,       
                        v_activity,            
                        v_recipient_profile.domain,
                        COALESCE(v_recipient_profile.inbox_url, 'https://' || v_recipient_profile.domain || '/inbox'),
                        'pending',
                        8,  -- High priority for private mentions
                        sender_profile.username,
                        v_instance_domain
                    );
                    
                    RAISE WARNING '📮 Queued private mention delivery to: %@%', 
                        v_recipient_profile.username, v_recipient_profile.domain;
                END LOOP;
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$function$;

-- =================================================================
-- 3. CREATE MODERN CONVERSATION HELPERS
-- =================================================================

-- Modern conversation finder/creator for multi-participant conversations
CREATE OR REPLACE FUNCTION create_or_get_multi_conversation(
    participant_ids UUID[],
    conversation_type TEXT DEFAULT 'direct',
    conversation_name TEXT DEFAULT NULL,
    created_by_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $function$
DECLARE
    v_conversation_id UUID;
    participant_id UUID;
BEGIN
    -- Validate inputs
    IF participant_ids IS NULL OR array_length(participant_ids, 1) < 2 THEN
        RAISE EXCEPTION 'At least 2 participants required for conversation';
    END IF;
    
    -- Try to find existing conversation with exact same participants
    SELECT DISTINCT c.id INTO v_conversation_id
    FROM conversations c
    WHERE (
        -- Count must match exactly
        (SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.left_at IS NULL) = array_length(participant_ids, 1)
        AND
        -- All participants must be present
        NOT EXISTS (
            SELECT 1 FROM unnest(participant_ids) AS required_participant(participant_id)
            WHERE NOT EXISTS (
                SELECT 1 FROM conversation_participants cp 
                WHERE cp.conversation_id = c.id 
                  AND cp.user_id = required_participant.participant_id 
                  AND cp.left_at IS NULL
            )
        )
    )
    LIMIT 1;

    -- Create new conversation if not found
    IF v_conversation_id IS NULL THEN
        INSERT INTO conversations (
            name,
            type,
            created_by,
            created_at
        ) VALUES (
            CASE 
                WHEN array_length(participant_ids, 1) = 2 AND conversation_name IS NULL THEN NULL
                ELSE COALESCE(conversation_name, 'Group Chat')
            END,
            CASE 
                WHEN array_length(participant_ids, 1) = 2 THEN 'direct'
                ELSE COALESCE(conversation_type, 'group')
            END,
            COALESCE(created_by_id, participant_ids[1]),
            NOW()
        )
        RETURNING id INTO v_conversation_id;
        
        -- Add all participants
        INSERT INTO conversation_participants (conversation_id, user_id, joined_at, role)
        SELECT v_conversation_id, participant_id, NOW(), 'member'
        FROM unnest(participant_ids) AS participants(participant_id);
        
        RAISE NOTICE '🆕 Created new % conversation % with % participants', 
            CASE WHEN array_length(participant_ids, 1) = 2 THEN 'direct' ELSE 'group' END,
            v_conversation_id, 
            array_length(participant_ids, 1);
    END IF;

    RETURN v_conversation_id;
END;
$function$;

-- =================================================================
-- 4. VERIFICATION AND TESTING
-- =================================================================

-- Test the debug function again to confirm user lookup works
SELECT * FROM debug_local_user_lookup();

-- Verify the modern functions were created
DO $$
BEGIN
    -- Verify modern functions exist
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_incoming_messages') THEN
        RAISE NOTICE '✅ handle_incoming_messages function updated with modern conversation_participants system';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_outgoing_messages') THEN
        RAISE NOTICE '✅ handle_outgoing_messages function updated with modern send_notification calls';
    END IF;
    
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_or_get_multi_conversation') THEN
        RAISE NOTICE '✅ create_or_get_multi_conversation helper function created for group chats';
    END IF;
END $$;

COMMIT;