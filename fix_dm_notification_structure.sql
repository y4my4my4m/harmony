-- Fix DM notification data structure to match NotificationFormatter expectations
-- This updates BOTH handle_message_federation and handle_outgoing_messages functions
-- to create properly structured notification data

-- ===============================
-- 1. Fix handle_message_federation function
-- ===============================
CREATE OR REPLACE FUNCTION public.handle_message_federation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_federation_type TEXT;
    v_is_federated_incoming BOOLEAN;
    v_sender_profile profiles%ROWTYPE;
BEGIN
    -- Determine federation type
    v_federation_type := determine_message_federation_type(NEW.id);
    
    -- Check if this is an incoming federated message
    v_is_federated_incoming := (NEW.metadata->>'federated' = 'true');
    
    -- Get sender profile for notifications
    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;
    
    CASE v_federation_type
        WHEN 'chat_local_only' THEN
            -- Send local notifications for chat messages (ONLY to LOCAL users)
            PERFORM send_notification(
                'chat_message',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    JOIN profiles p ON p.id = cp.user_id  -- ✅ FIXED: Join with profiles
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true  -- ✅ FIXED: ONLY local users!
                ),
                -- ✅ STRUCTURED DATA for chat messages
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', LEFT(NEW.content::text, 100)
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    -- Legacy fields for compatibility
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', LEFT(NEW.content::text, 100)
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
            
        WHEN 'dm_local_only' THEN
            -- Send DM notifications for local-only DMs (ONLY to LOCAL users)
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    JOIN profiles p ON p.id = cp.user_id  -- ✅ FIXED: Join with profiles
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true  -- ✅ FIXED: ONLY local users!
                ),
                -- ✅ STRUCTURED DATA: Match NotificationFormatter expectations
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', CASE 
                            WHEN jsonb_array_length(NEW.content) > 0 
                            THEN LEFT(NEW.content->0->>'text', 100)
                            ELSE 'New message'
                        END
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    -- Legacy fields for compatibility
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', LEFT(NEW.content::text, 100)
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
            
        WHEN 'dm_federated' THEN
            -- Send DM notifications for federated DMs (ONLY to LOCAL users)
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    JOIN profiles p ON p.id = cp.user_id  -- ✅ FIXED: Join with profiles
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true  -- ✅ FIXED: ONLY local users!
                ),
                -- ✅ STRUCTURED DATA: Match NotificationFormatter expectations
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', CASE 
                            WHEN jsonb_array_length(NEW.content) > 0 
                            THEN LEFT(NEW.content->0->>'text', 100)
                            ELSE 'New message'
                        END
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    -- Legacy fields for compatibility
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', LEFT(NEW.content::text, 100),
                    'federated', true
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
    END CASE;
    
    RETURN NEW;
    
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Message federation processing failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$;

-- ===============================
-- 2. Fix handle_outgoing_messages function
-- ===============================

CREATE OR REPLACE FUNCTION public.handle_outgoing_messages()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $$
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
        -- Notify only LOCAL conversation participants with STRUCTURED data
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
            -- ✅ STRUCTURED DATA: Match NotificationFormatter expectations
            jsonb_build_object(
                'sender', jsonb_build_object(
                    'user_id', sender_profile.id,
                    'username', sender_profile.username,
                    'display_name', sender_profile.display_name,
                    'avatar_url', sender_profile.avatar_url
                ),
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', CASE 
                        WHEN jsonb_array_length(NEW.content) > 0 
                        THEN LEFT(NEW.content->0->>'text', 100)
                        ELSE 'New message'
                    END
                ),
                'conversation', jsonb_build_object(
                    'id', NEW.conversation_id
                ),
                -- Additional metadata for compatibility
                'message_id', NEW.id,
                'conversation_id', NEW.conversation_id,
                'sender_id', NEW.user_id,
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
$$;

-- Add comments to document the fixes
COMMENT ON FUNCTION public.handle_message_federation() IS 
'FIXED: Creates structured notification data that matches NotificationFormatter expectations with nested sender, message, and conversation objects for both DM and chat notifications.';

COMMENT ON FUNCTION public.handle_outgoing_messages() IS 
'FIXED: Creates structured notification data that matches NotificationFormatter expectations with nested sender, message, and conversation objects.';

-- ===============================
-- 3. Apply the database fixes
-- ===============================
-- To apply these fixes, run this SQL file against your database:
-- psql -d your_database_name -f fix_dm_notification_structure.sql
--
-- This will update both notification functions to create properly structured
-- notification data that works with the NotificationFormatter system.
