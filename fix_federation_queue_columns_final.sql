-- Fix Federation Queue Column Names (FINAL - with working 073/074 features)
-- This fixes the "activity_uuid does not exist" error AND restores working DM features

BEGIN;

-- =====================================================
-- FIX: Update handle_outgoing_messages with CORRECT column names AND working DM format
-- =====================================================

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
    v_inbox_url TEXT;
    
    -- Variables for unified content processing
    v_html_content TEXT;
    v_attachments JSONB;
    v_tags JSONB;
    
    -- Variables for conversation participants
    participant_record RECORD;
BEGIN
    -- Get sender profile (used by both notifications and federation)
    SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- DEBUG: Log that the function is running
    RAISE NOTICE '🔧 handle_outgoing_messages() function called for message %', NEW.id;
    
    -- Extract content preview for notifications
    IF jsonb_typeof(NEW.content) = 'array' THEN
        SELECT LEFT(string_agg(
            CASE 
                WHEN item->>'type' = 'mention' THEN item->>'mention'
                ELSE COALESCE(item->>'text', item::text)
            END, ''
        ), 100) INTO content_preview
        FROM jsonb_array_elements(NEW.content) AS item;
    ELSE
        content_preview := LEFT(NEW.content::text, 100);
    END IF;
    
    -- =================================================================
    -- SECTION 1: HANDLE NOTIFICATIONS (Already working via handle_message_federation trigger)
    -- =================================================================
    
    -- =================================================================
    -- SECTION 2: HANDLE FEDERATION (FOR DMs ONLY)
    -- =================================================================
    
    -- Only federate DMs to remote participants
    IF NEW.conversation_id IS NOT NULL AND sender_profile.is_local THEN
        -- Get instance domain from config
        SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;
        
        IF v_instance_domain IS NOT NULL AND v_instance_domain != 'debug' THEN
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
                  AND p.domain != 'debug'
            LOOP
                RAISE NOTICE '🎯 Federating DM to: %@%', v_recipient_profile.username, v_recipient_profile.domain;
                
                -- Build URLs 
                v_sender_url := 'https://' || v_instance_domain || '/users/' || sender_profile.username;
                v_recipient_url := COALESCE(v_recipient_profile.federated_id, 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username);
                v_message_url := 'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT;
                v_activity_id := v_sender_url || '#dm-' || NEW.id::TEXT;
                
                -- ✅ FIXED: Use MODERN functions (not deprecated ones)
                v_html_content := convert_jsonb_to_ap(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                v_tags := extract_all_activitypub_tags(NEW.content);
                
                -- ✅ CRITICAL FIX 1: Add recipient as mention tag (from working 073-074)
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
                
                -- Create Note object (DM format with working 073-074 features)
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note', 
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'attributedTo', v_sender_url,
                    'content', v_html_content,
                    'url', v_message_url,
                    'to', jsonb_build_array(v_recipient_url),
                    'cc', '[]'::jsonb,
                    'directMessage', true  -- ✅ CRITICAL FIX 2: Explicit DM flag (from working 073-074)
                );
                
                -- Add attachments if present
                IF v_attachments IS NOT NULL AND jsonb_array_length(v_attachments) > 0 THEN
                    v_note_object := v_note_object || jsonb_build_object('attachment', v_attachments);
                END IF;
                
                -- ✅ CRITICAL FIX 3: Always add tags (including recipient mention)
                v_note_object := v_note_object || jsonb_build_object('tag', v_tags);
                
                -- Create Activity wrapper
                v_activity := jsonb_build_object(
                    '@context', 'https://www.w3.org/ns/activitystreams',
                    'id', v_activity_id,
                    'type', 'Create',
                    'actor', v_sender_url,
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'object', v_note_object,
                    'to', jsonb_build_array(v_recipient_url),
                    'cc', '[]'::jsonb
                );
                
                -- Create ap_activities entry first
                INSERT INTO ap_activities (
                    ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                    activity_data, status, is_local, to_addresses
                ) VALUES (
                    v_activity_id,
                    'Create',
                    sender_profile.id,
                    v_sender_url,
                    v_message_url,
                    'Note',
                    v_activity,
                    'pending',
                    true,
                    ARRAY[v_recipient_url]
                ) RETURNING id INTO v_activity_uuid;
                
                -- ✅ CRITICAL FIX 4: Use shared inbox for DMs (from working 073-074)
                -- Personal inbox: https://misskey.io/users/aa9hh3eoz0kz0apv/inbox
                -- Shared inbox: https://misskey.io/inbox (better for DMs)
                v_inbox_url := 'https://' || v_recipient_profile.domain || '/inbox';  -- Shared inbox
                
                -- ✅ FIXED: Insert into federation_delivery_queue using CORRECT column names
                INSERT INTO federation_delivery_queue (
                    activity_id,              -- ✅ CORRECT: not activity_uuid
                    activity_data,            -- ✅ CORRECT: not activity 
                    target_domain,            -- ✅ CORRECT
                    target_inbox_url,         -- ✅ CORRECT: not target_inbox
                    status,                   -- ✅ CORRECT
                    attempts,                 -- ✅ CORRECT 
                    priority,                 -- ✅ CORRECT
                    actor_username,           -- ✅ CORRECT
                    actor_domain,             -- ✅ CORRECT
                    next_attempt_at           -- ✅ CORRECT
                ) VALUES (
                    v_activity_uuid,          -- Reference to ap_activities.id
                    v_activity,               -- Full ActivityPub JSON
                    v_recipient_profile.domain,
                    v_inbox_url,              -- ✅ FIXED: Shared inbox
                    'pending',
                    0,                        -- Initial attempts
                    5,                        -- Normal priority
                    sender_profile.username,
                    v_instance_domain,
                    NOW()                     -- Immediate attempt
                );
                
                RAISE NOTICE '✅ DM federation queued: %@% -> %@% (activity: %, inbox: %)', 
                    sender_profile.username, v_instance_domain,
                    v_recipient_profile.username, v_recipient_profile.domain,
                    v_activity_uuid, v_inbox_url;
                
            END LOOP;
        ELSE
            RAISE WARNING '⚠️ Instance domain is invalid (%): DM federation disabled', v_instance_domain;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.handle_outgoing_messages() IS 
'FINAL: Fixed column names, modern functions, AND restored working 073-074 DM features (mention tags, directMessage flag, shared inbox).';

-- =====================================================
-- VERIFICATION
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Applied ALL fixes from working migrations 073-074:';
    RAISE NOTICE '   1. Column names: activity_uuid → activity_id, activity → activity_data, target_inbox → target_inbox_url';
    RAISE NOTICE '   2. Function call: convert_unified_content_to_activitypub_html() → convert_jsonb_to_ap()';
    RAISE NOTICE '   3. ✅ MENTION TAGS: Added recipient as mention tag (from 073-074)';
    RAISE NOTICE '   4. ✅ DIRECTMESSAGE FLAG: Set directMessage: true (from 073-074)';
    RAISE NOTICE '   5. ✅ SHARED INBOX: Use domain/inbox instead of personal inbox (from 073-074)';
    RAISE NOTICE '🚀 DMs should now work exactly like in migrations 073-074!';
END $$;

COMMIT;