-- Fix DM Mention Tags and DirectMessage Flag
-- This adds the 2 critical missing pieces from working migrations 073-074

BEGIN;

-- =====================================================
-- FIX: Add mention tags and directMessage flag to handle_outgoing_messages
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
    conversation_type TEXT;
    
    -- Variables for federation
    v_federation_type TEXT;
    v_instance_domain TEXT;
    v_sender_url TEXT;
    v_recipient_url TEXT;
    v_message_url TEXT;
    v_activity_id TEXT;
    v_html_content TEXT;
    v_attachments JSONB;
    v_tags JSONB;
    v_note_object JSONB;
    v_activity JSONB;
    v_activity_uuid UUID;
    v_recipient_profile RECORD;
    target_domains TEXT[];
BEGIN
    -- Get sender profile
    SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- Determine federation type
    v_federation_type := determine_message_federation_type(NEW.id);
    
    -- Send notifications for federated messages ONLY to LOCAL users
    IF v_federation_type = 'dm_federated' THEN
        -- Notify only LOCAL conversation participants
        PERFORM send_notification(
            'dm',
            ARRAY(
                SELECT DISTINCT cp.user_id 
                FROM conversation_participants cp
                JOIN profiles p ON p.id = cp.user_id
                WHERE cp.conversation_id = NEW.conversation_id 
                  AND cp.user_id != NEW.user_id
                  AND cp.left_at IS NULL
                  AND p.is_local = true  -- ✅ ONLY LOCAL USERS
            ),
            jsonb_build_object(
                'message_id', NEW.id,
                'conversation_id', NEW.conversation_id,
                'sender_id', NEW.user_id,
                'content_preview', CASE 
                    WHEN jsonb_array_length(NEW.content) > 0 
                    THEN NEW.content->0->>'text'
                    ELSE 'New message'
                END,
                'federated', true
            ),
            NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
        );
    END IF;
    
    -- Handle federation for outgoing messages
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
                
                -- Use modern content processing functions
                v_html_content := convert_jsonb_to_ap(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                v_tags := extract_all_activitypub_tags(NEW.content);
                
                -- ✅ CRITICAL FIX 1: Add recipient as mention tag (from working 073-074)
                v_tags := v_tags || jsonb_build_array(
                    jsonb_build_object(
                        'type', 'Mention',
                        'href', v_recipient_url,
                        'name', '@' || v_recipient_profile.username || '@' || v_recipient_profile.domain
                    )
                );
                
                -- Create Note object (DM format)
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note',
                    'attributedTo', v_sender_url,
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'content', v_html_content,
                    'contentMap', jsonb_build_object('en', v_html_content),
                    'attachment', COALESCE(v_attachments, '[]'::jsonb),
                    'tag', v_tags,
                    'to', jsonb_build_array(v_recipient_url),  -- Direct addressing
                    'cc', '[]'::jsonb,                         -- Empty CC for DMs
                    'directMessage', true                      -- ✅ CRITICAL FIX 2: Explicit DM flag
                );
                
                -- Create ActivityPub Create activity
                v_activity := jsonb_build_object(
                    '@context', 'https://www.w3.org/ns/activitystreams',
                    'id', v_activity_id,
                    'type', 'Create',
                    'actor', v_sender_url,
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'object', v_note_object,
                    'to', jsonb_build_array(v_recipient_url),  -- Direct addressing
                    'cc', '[]'::jsonb                          -- Empty CC for DMs
                );
                
                -- Store the ActivityPub activity record
                INSERT INTO ap_activities (
                    ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                    activity_data, status, to_addresses, is_local, origin_domain
                ) VALUES (
                    v_activity_id, 'Create', sender_profile.id, v_sender_url, v_message_url, 'Note',
                    v_activity, 'pending', ARRAY[v_recipient_url], true, v_instance_domain
                ) RETURNING id INTO v_activity_uuid;
                
                -- Build array of target domains for queue_activity_for_federation
                target_domains := ARRAY[v_recipient_profile.domain];
                
                -- Queue for federation delivery
                PERFORM queue_activity_for_federation(
                    v_activity_uuid,  -- The UUID from ap_activities 
                    target_domains,   -- Array of domains to deliver to
                    8,                -- High priority for DMs (1-10 scale, 8 is high)
                    true              -- Immediate delivery
                );
                
                RAISE NOTICE '📮 Queued DM for federation to: %@% (activity: %)', 
                    v_recipient_profile.username, v_recipient_profile.domain, v_activity_uuid;
                    
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Error in handle_outgoing_messages for message %: % %', NEW.id, SQLSTATE, SQLERRM;
        RETURN NEW;
END;
$function$;

COMMIT;