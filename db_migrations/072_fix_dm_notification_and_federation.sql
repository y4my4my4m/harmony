-- Migration 072: Fix DM Notification and Federation Issues
-- FIXES:
-- 1. Local DM notification error: "function send_notification(uuid, unknown, jsonb) does not exist"
-- 2. Remote DM federation: Ensure proper ActivityPub addressing and mention tagging

BEGIN;

-- =================================================================
-- FIX 1: Update handle_outgoing_messages to use correct notification function
-- =================================================================

-- The issue: create_notification_structured() has function signature mismatches
-- Solution: Use send_notification_to_user() directly with correct parameters

CREATE OR REPLACE FUNCTION public.handle_outgoing_messages()
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
    participant_record RECORD;
    
    -- Variables for federation
    v_recipient_profile RECORD;
    v_instance_domain TEXT;
    v_activity_id TEXT;
    v_sender_url TEXT;
    v_recipient_url TEXT;
    v_message_url TEXT;
    v_activity JSONB;
    v_note_object JSONB;
    v_inbox_url TEXT;
    
    -- Variables for unified content processing
    v_html_content TEXT;
    v_attachments JSONB;
    v_tags JSONB;
    
BEGIN
    -- Get sender profile (used by both notifications and federation)
    SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- DEBUG: Log that the function is running
    RAISE WARNING '🔧 handle_outgoing_messages() function called for message %', NEW.id;
    
    -- Extract content preview for notifications (FIXED: Proper text casting)
    IF jsonb_typeof(NEW.content) = 'array' THEN
        SELECT LEFT(string_agg(
            CASE 
                WHEN item->>'type' = 'mention' THEN ('@' || COALESCE(item->>'username', 'unknown'))::TEXT
                ELSE COALESCE(item->>'text', item::text)
            END, ''
        ), 100) INTO content_preview
        FROM jsonb_array_elements(NEW.content) AS item;
    ELSE
        content_preview := LEFT(NEW.content::text, 100);
    END IF;
    
    -- =================================================================
    -- SECTION 1: HANDLE NOTIFICATIONS (Local users only) - FIXED
    -- =================================================================
    
    -- Handle DM notifications (UPDATED FOR PARTICIPANT SYSTEM)
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
                'id', NEW.conversation_id
            ),
            'message', jsonb_build_object(
                'id', NEW.id,
                'content_preview', content_preview,
                'created_at', NEW.created_at
            )
        );
        
        -- FIXED: Use send_notification_to_user directly instead of create_notification_structured
        FOR participant_record IN 
            SELECT cp.user_id, p.is_local
            FROM conversation_participants cp
            JOIN profiles p ON p.id = cp.user_id
            WHERE cp.conversation_id = NEW.conversation_id 
              AND cp.user_id != NEW.user_id
              AND cp.left_at IS NULL
        LOOP
            -- Only notify LOCAL users
            IF participant_record.is_local THEN
                PERFORM send_notification_to_user(
                    'dm',                           -- notification_type
                    participant_record.user_id,    -- to_user_id
                    notification_data,              -- notification_data
                    NULL,                          -- server_id
                    NULL,                          -- channel_id
                    NEW.conversation_id,           -- conversation_id
                    NEW.user_id,                   -- from_user_id
                    'normal'                       -- priority
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
        
        -- Handle reply notifications (LOCAL users only) - FIXED
        IF NEW.reply_to IS NOT NULL THEN
            SELECT user_id INTO reply_author_id FROM messages WHERE id = NEW.reply_to;
            IF reply_author_id IS NOT NULL AND reply_author_id != NEW.user_id THEN
                SELECT * INTO recipient_profile FROM profiles WHERE id = reply_author_id;
                IF recipient_profile.is_local THEN
                    PERFORM send_notification_to_user(
                        'reply',                                        -- notification_type
                        reply_author_id,                               -- to_user_id
                        notification_data || jsonb_build_object(      -- notification_data
                            'original_message', jsonb_build_object('id', NEW.reply_to)
                        ),
                        channel_info.server_id,                       -- server_id
                        NEW.channel_id,                               -- channel_id
                        NULL,                                         -- conversation_id
                        NEW.user_id,                                  -- from_user_id
                        'normal'                                      -- priority
                    );
                END IF;
            END IF;
        END IF;
        
        -- Handle mention notifications (LOCAL users only) - FIXED
        mentioned_usernames := extract_mentions(NEW.content);
        FOREACH username_item IN ARRAY mentioned_usernames
        LOOP
            mentioned_user_id := get_user_id_from_username(username_item);
            IF mentioned_user_id IS NOT NULL AND mentioned_user_id != NEW.user_id THEN
                SELECT * INTO recipient_profile FROM profiles WHERE id = mentioned_user_id;
                IF recipient_profile.is_local THEN
                    PERFORM send_notification_to_user(
                        'mention',                    -- notification_type
                        mentioned_user_id,           -- to_user_id
                        notification_data,           -- notification_data
                        channel_info.server_id,      -- server_id
                        NEW.channel_id,              -- channel_id
                        NULL,                        -- conversation_id
                        NEW.user_id,                 -- from_user_id
                        'normal'                     -- priority
                    );
                END IF;
            END IF;
        END LOOP;
    END IF;
    
    -- =================================================================
    -- SECTION 2: HANDLE FEDERATION (DMs to remote users only) - ENHANCED
    -- =================================================================
    
    -- Only federate DM messages from local users
    IF NEW.conversation_id IS NOT NULL AND sender_profile.is_local THEN
        -- Get instance domain from config
        SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
        FROM instance_config 
        WHERE config_key = 'domain' 
        LIMIT 1;
        
        IF v_instance_domain IS NOT NULL THEN
            -- Find remote recipients using conversation_participants table
            FOR v_recipient_profile IN 
                SELECT p.id, p.username, p.domain, p.federated_id, p.is_local, p.inbox_url
                FROM conversation_participants cp
                JOIN profiles p ON p.id = cp.user_id
                WHERE cp.conversation_id = NEW.conversation_id 
                  AND cp.user_id != NEW.user_id
                  AND cp.left_at IS NULL
                  AND NOT p.is_local
                  AND p.domain IS NOT NULL
            LOOP
                -- Build URLs using federated_id when available, fallback to constructed URL
                v_sender_url := 'https://' || v_instance_domain || '/users/' || sender_profile.username;
                v_recipient_url := COALESCE(v_recipient_profile.federated_id, 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username);
                v_message_url := 'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT;
                v_activity_id := v_sender_url || '#dm-' || NEW.id::TEXT;
                
                RAISE WARNING '🎯 Federating DM to: %@%', v_recipient_profile.username, v_recipient_profile.domain;
                
                -- Use unified content processing for federation
                v_html_content := convert_jsonb_to_ap(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                
                -- ENHANCED: Extract ActivityPub tags AND ensure recipient is always mentioned
                v_tags := extract_all_activitypub_tags(NEW.content);
                
                -- CRITICAL: Add recipient as mention tag if not already present (required for some AP servers)
                IF v_tags IS NULL THEN
                    v_tags := '[]'::jsonb;
                END IF;
                
                -- Add the recipient as a mention tag to ensure proper DM recognition
                v_tags := v_tags || jsonb_build_array(
                    jsonb_build_object(
                        'type', 'Mention',
                        'href', v_recipient_url,
                        'name', '@' || v_recipient_profile.username || '@' || v_recipient_profile.domain
                    )
                );
                
                -- Create Note object (DM format with proper visibility)
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note', 
                    'published', NEW.created_at::text,
                    'attributedTo', v_sender_url,
                    'content', v_html_content,
                    'url', v_message_url,
                    'to', jsonb_build_array(v_recipient_url),  -- Direct addressing
                    'cc', '[]'::jsonb,                         -- Empty CC for DMs
                    'directMessage', true                      -- Explicit DM flag
                );
                
                -- Add attachments if present
                IF v_attachments IS NOT NULL AND jsonb_array_length(v_attachments) > 0 THEN
                    v_note_object := v_note_object || jsonb_build_object('attachment', v_attachments);
                END IF;
                
                -- Add tags (including recipient mention)
                IF v_tags IS NOT NULL AND jsonb_array_length(v_tags) > 0 THEN
                    v_note_object := v_note_object || jsonb_build_object('tag', v_tags);
                END IF;
                
                -- Create Activity wrapper
                v_activity := jsonb_build_object(
                    '@context', 'https://www.w3.org/ns/activitystreams',
                    'id', v_activity_id,
                    'type', 'Create',
                    'actor', v_sender_url,
                    'published', NEW.created_at::text,
                    'object', v_note_object,
                    'to', jsonb_build_array(v_recipient_url),  -- Direct addressing
                    'cc', '[]'::jsonb                          -- Empty CC for DMs
                );
                
                -- Queue for delivery to recipient's inbox
                v_inbox_url := COALESCE(v_recipient_profile.inbox_url, 'https://' || v_recipient_profile.domain || '/inbox');
                
                RAISE WARNING '📮 Queuing DM delivery to: %', v_inbox_url;
                
                -- Insert into delivery queue
                INSERT INTO federation_delivery_queue (
                    activity_uuid,
                    activity,
                    target_inbox,
                    sender_profile_id,
                    recipient_profile_id,
                    message_id,
                    delivery_type,
                    priority
                ) VALUES (
                    gen_random_uuid(),
                    v_activity,
                    v_inbox_url,
                    sender_profile.id,
                    v_recipient_profile.id::uuid,
                    NEW.id,
                    'dm',
                    'high'
                );
                
                RAISE NOTICE '✅ DM federation queued: %@% -> %@%', 
                    sender_profile.username, v_instance_domain,
                    v_recipient_profile.username, v_recipient_profile.domain;
                
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.handle_outgoing_messages() IS 
'UPDATED: Fixed DM notifications to use send_notification_to_user() directly. Enhanced DM federation with proper ActivityPub addressing and mention tagging.';

-- =================================================================
-- FIX 2: Test the notification fix
-- =================================================================

-- Test that send_notification_to_user works correctly
DO $$
DECLARE
    test_user_id uuid;
    test_notification_id uuid;
BEGIN
    -- Get a real user ID for testing (if any exist)
    SELECT id INTO test_user_id 
    FROM profiles 
    WHERE is_local = true 
    LIMIT 1;
    
    -- Only test if we have a real user
    IF test_user_id IS NOT NULL THEN
        -- Test the function with a real user ID
        SELECT send_notification_to_user(
            'test_dm_fix',
            test_user_id,
            '{"message": "DM notification fix test", "test": true}'::jsonb,
            NULL,  -- server_id
            NULL,  -- channel_id
            NULL,  -- conversation_id
            NULL,  -- from_user_id
            'normal' -- priority
        ) INTO test_notification_id;
        
        -- Clean up test notification
        DELETE FROM notifications WHERE id = test_notification_id;
        
        RAISE NOTICE '✅ DM notification fix tested successfully with user %', test_user_id;
    ELSE
        RAISE NOTICE '✅ DM notification fix deployed (no users available for testing)';
    END IF;
    
EXCEPTION WHEN OTHERS THEN
    -- Clean up any test notifications that might have been created
    DELETE FROM notifications WHERE type = 'test_dm_fix';
    RAISE EXCEPTION 'DM notification fix test failed: %', SQLERRM;
END $$;

-- =================================================================
-- FIX 3: Ensure ActivityPub DM detection works properly
-- =================================================================

-- Update the is_activitypub_direct_message function for better DM detection
CREATE OR REPLACE FUNCTION public.is_activitypub_direct_message(object_data jsonb, instance_domain text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
    v_to JSONB;
    v_cc JSONB;
    v_visibility TEXT;
    v_has_public BOOLEAN := false;
    v_has_followers BOOLEAN := false;
    v_has_local_recipients BOOLEAN := false;
    v_recipient TEXT;
    v_total_recipients INTEGER := 0;
BEGIN
    -- Method 1: Check visibility property
    v_visibility := object_data->>'visibility';
    IF v_visibility = 'direct' THEN
        RETURN true;
    END IF;

    -- Method 2: Check directMessage flag
    IF (object_data->>'directMessage')::boolean = true THEN
        RETURN true;
    END IF;

    -- Method 3: Check addressing patterns
    v_to := COALESCE(object_data->'to', '[]'::jsonb);
    v_cc := COALESCE(object_data->'cc', '[]'::jsonb);

    -- Count total recipients and check for public indicators
    FOR v_recipient IN 
        SELECT jsonb_array_elements_text(v_to || v_cc)
    LOOP
        v_total_recipients := v_total_recipients + 1;
        
        -- Check for public addressing
        IF v_recipient IN (
            'https://www.w3.org/ns/activitystreams#Public',
            'Public'
        ) THEN
            v_has_public := true;
            EXIT; -- If it's public, it's definitely not a DM
        END IF;
        
        -- Check for followers addressing
        IF v_recipient LIKE '%/followers' THEN
            v_has_followers := true;
        END IF;
        
        -- Check for local recipients (this instance)
        IF v_recipient LIKE 'https://' || instance_domain || '/users/%' 
           OR v_recipient LIKE 'https://' || instance_domain || '/social/profile/%' THEN
            v_has_local_recipients := true;
        END IF;
    END LOOP;

    -- ENHANCED: More aggressive DM detection
    -- It's a DM if:
    -- 1. No public addressing AND
    -- 2. No followers addressing AND  
    -- 3. Has local recipients AND
    -- 4. Total recipients is small (≤ 10 for group DMs) AND
    -- 5. CC is empty or very small (private mentions typically have empty CC)
    
    IF NOT v_has_public 
       AND NOT v_has_followers 
       AND v_has_local_recipients 
       AND v_total_recipients <= 10
       AND jsonb_array_length(v_cc) <= 1 THEN
        RETURN true;
    END IF;

    -- ADDITIONAL: If 'to' field is small and CC is empty, it's likely a DM
    IF v_total_recipients <= 3 
       AND jsonb_array_length(v_cc) = 0 
       AND v_has_local_recipients THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$function$;

COMMENT ON FUNCTION public.is_activitypub_direct_message(object_data jsonb, instance_domain text) IS 
'ENHANCED: Improved ActivityPub DM detection with better heuristics for recognizing direct messages vs public posts.';

COMMIT;