-- Migration 073: Properly Fix DM Issues (Using Actual Table Schema)
-- FIXES:
-- 1. Use correct federation_delivery_queue column names (not assumed ones)
-- 2. Fix "debug" URLs in federation delivery
-- 3. Fix notification function calls

BEGIN;

-- =================================================================
-- FIX 1: Update handle_outgoing_messages with CORRECT table schema
-- =================================================================

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
    -- SECTION 2: HANDLE FEDERATION (DMs to remote users only) - FIXED
    -- =================================================================
    
    -- Only federate DM messages from local users
    IF NEW.conversation_id IS NOT NULL AND sender_profile.is_local THEN
        -- Get instance domain from config
        SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
        FROM instance_config 
        WHERE config_key = 'domain' 
        LIMIT 1;
        
        -- CRITICAL: Validate we have a real domain, not debug values
        IF v_instance_domain IS NOT NULL AND v_instance_domain != 'debug' AND v_instance_domain != '' THEN
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
                  AND p.domain != ''
            LOOP
                -- Build URLs using federated_id when available, fallback to constructed URL
                v_sender_url := 'https://' || v_instance_domain || '/users/' || sender_profile.username;
                v_recipient_url := COALESCE(v_recipient_profile.federated_id, 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username);
                v_message_url := 'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT;
                v_activity_id := v_sender_url || '#dm-' || NEW.id::TEXT;
                
                -- CRITICAL: Validate recipient domain before proceeding
                IF v_recipient_profile.domain != 'debug' AND v_recipient_profile.domain != '' THEN
                    RAISE WARNING '🎯 Federating DM to: %@%', v_recipient_profile.username, v_recipient_profile.domain;
                    
                    -- Use unified content processing for federation
                    v_html_content := convert_jsonb_to_ap(NEW.content);
                    v_attachments := extract_activitypub_attachments(NEW.content);
                    
                    -- Extract ActivityPub tags AND ensure recipient is always mentioned
                    v_tags := extract_all_activitypub_tags(NEW.content);
                    
                    -- Add recipient as mention tag if not already present
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
                    
                    -- Build proper inbox URL - FIXED: No more debug values
                    v_inbox_url := COALESCE(v_recipient_profile.inbox_url, 'https://' || v_recipient_profile.domain || '/inbox');
                    
                    RAISE WARNING '📮 Queuing DM delivery to: %', v_inbox_url;
                    
                    -- FIXED: Insert into federation_delivery_queue using ACTUAL column names
                    INSERT INTO federation_delivery_queue (
                        -- Using actual table columns, NOT assumed ones
                        activity_id,              -- uuid (can be NULL per schema)
                        activity_data,            -- jsonb - the actual activity to deliver
                        target_domain,            -- text NOT NULL
                        target_inbox_url,         -- text NOT NULL
                        status,                   -- text DEFAULT 'pending'
                        attempts,                 -- integer DEFAULT 0
                        priority,                 -- integer DEFAULT 5
                        actor_username,           -- text
                        actor_domain,             -- text
                        next_attempt_at           -- timestamp DEFAULT now()
                    ) VALUES (
                        NULL,                     -- activity_id can be NULL (we're not creating ap_activities entry)
                        v_activity,               -- Full ActivityPub JSON
                        v_recipient_profile.domain,  -- Actual domain, not 'debug'
                        v_inbox_url,              -- Proper inbox URL
                        'pending',                -- Status
                        0,                        -- Initial attempts
                        5,                        -- Normal priority (1-10 scale, 5 is default)
                        sender_profile.username,  -- Actor username  
                        v_instance_domain,        -- Actor domain
                        NOW()                     -- Immediate attempt
                    );
                    
                    RAISE NOTICE '✅ DM federation queued: %@% -> %@%', 
                        sender_profile.username, v_instance_domain,
                        v_recipient_profile.username, v_recipient_profile.domain;
                ELSE
                    RAISE WARNING '⚠️  Skipping DM federation to debug/empty domain: %', v_recipient_profile.domain;
                END IF;
                
            END LOOP;
        ELSE
            RAISE WARNING '⚠️  Instance domain is debug/empty (%): DM federation disabled', v_instance_domain;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.handle_outgoing_messages() IS 
'FIXED: Uses correct federation_delivery_queue schema and prevents debug URL insertion. Fixed notification function calls.';

-- =================================================================
-- VERIFICATION: Check current table structure matches our usage
-- =================================================================

DO $$
DECLARE
    missing_columns text[] := '{}';
    column_exists boolean;
BEGIN
    -- Check each column we're using exists
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'federation_delivery_queue' 
        AND column_name = 'activity_data'
    ) INTO column_exists;
    IF NOT column_exists THEN
        missing_columns := array_append(missing_columns, 'activity_data');
    END IF;
    
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'federation_delivery_queue' 
        AND column_name = 'target_domain'
    ) INTO column_exists;
    IF NOT column_exists THEN
        missing_columns := array_append(missing_columns, 'target_domain');
    END IF;
    
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'federation_delivery_queue' 
        AND column_name = 'target_inbox_url'
    ) INTO column_exists;
    IF NOT column_exists THEN
        missing_columns := array_append(missing_columns, 'target_inbox_url');
    END IF;
    
    IF array_length(missing_columns, 1) > 0 THEN
        RAISE EXCEPTION 'Missing required columns in federation_delivery_queue: %', array_to_string(missing_columns, ', ');
    ELSE
        RAISE NOTICE '✅ All required federation_delivery_queue columns exist';
    END IF;
END $$;

COMMIT;