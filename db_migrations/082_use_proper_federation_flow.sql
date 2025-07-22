-- Migration 082: Use Proper Federation Flow (ap_activities -> federation_delivery_queue)
-- ISSUE: Foreign key constraint requires activity_id to exist in ap_activities table first
-- SOLUTION: Insert into ap_activities first, then use that UUID for federation_delivery_queue

BEGIN;

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
    v_activity_id_text TEXT;  -- ActivityPub ID as text
    v_activity_uuid UUID;     -- UUID for database
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
    RAISE WARNING '🔧 handle_outgoing_messages() function called for message %', NEW.id;
    
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
    -- SECTION 1: HANDLE NOTIFICATIONS (Local users only)
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
        
        -- UPDATED: Notify all conversation participants except sender (using participant system)
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
                PERFORM create_notification_structured(
                    participant_record.user_id, 'dm', notification_data,
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
                    PERFORM create_notification_structured(
                        reply_author_id, 'reply',
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
                    PERFORM create_notification_structured(
                        mentioned_user_id, 'mention', notification_data,
                        channel_info.server_id, NEW.channel_id, NULL
                    );
                END IF;
            END IF;
        END LOOP;
    END IF;
    
    -- =================================================================
    -- SECTION 2: HANDLE FEDERATION (DMs to remote users only)
    -- =================================================================
    
    -- Only federate DM messages from local users (UPDATED FOR PARTICIPANT SYSTEM)
    IF NEW.conversation_id IS NOT NULL AND sender_profile.is_local THEN
        -- Get instance domain from config (cast JSONB to TEXT and remove quotes if present)
        SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
        FROM instance_config 
        WHERE config_key = 'domain' 
        LIMIT 1;
        
        IF v_instance_domain IS NOT NULL THEN
            -- UPDATED: Find remote recipients using conversation_participants table
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
                v_activity_id_text := v_sender_url || '#dm-' || NEW.id::TEXT;
                
                RAISE WARNING '🎯 Recipient URL: %', v_recipient_url;
                
                -- Use unified content processing for federation
                v_html_content := convert_jsonb_to_ap(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                v_tags := extract_all_activitypub_tags(NEW.content);
                
                -- Create Note object (DM format) - MATCH WORKING EXAMPLE EXACTLY
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note', 
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'attributedTo', v_sender_url,
                    'content', v_html_content,
                    'url', v_message_url,
                    'to', jsonb_build_array(v_recipient_url),
                    'cc', jsonb_build_array(),  -- Empty array, not '[]'::jsonb
                    'tag', jsonb_build_array(
                        jsonb_build_object(
                            'type', 'Mention',
                            'href', v_recipient_url,
                            'name', '@' || v_recipient_profile.username || '@' || v_recipient_profile.domain
                        )
                    )
                );
                
                -- Add attachments if present
                IF v_attachments IS NOT NULL AND jsonb_array_length(v_attachments) > 0 THEN
                    v_note_object := v_note_object || jsonb_build_object('attachment', v_attachments);
                END IF;
                
                -- Create Activity wrapper - MATCH WORKING EXAMPLE EXACTLY
                v_activity := jsonb_build_object(
                    'id', v_activity_id_text,
                    'type', 'Create',
                    'actor', v_sender_url,
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'object', v_note_object,
                    'to', jsonb_build_array(v_recipient_url),
                    'cc', jsonb_build_array(),  -- Empty array, not '[]'::jsonb
                    '@context', 'https://www.w3.org/ns/activitystreams'
                );
                
                -- Queue for delivery to recipient's inbox
                v_inbox_url := COALESCE(v_recipient_profile.inbox_url, 'https://' || v_recipient_profile.domain || '/inbox');
                
                RAISE WARNING '📮 Queuing DM delivery to: %', v_inbox_url;
                
                -- ✅ PROPER FLOW: Insert into ap_activities FIRST, then federation_delivery_queue
                INSERT INTO ap_activities (
                    ap_id,                 -- ActivityPub ID (text)
                    ap_type,               -- Activity type
                    actor_id,              -- Local actor ID  
                    actor_ap_id,           -- Actor ActivityPub ID
                    object_id,             -- Message ID (what this activity is about)
                    object_type,           -- Object type (Note)
                    activity_data,         -- Full ActivityPub JSON
                    is_local,              -- This is a local activity
                    origin_domain          -- Our domain
                ) VALUES (
                    v_activity_id_text,    -- ActivityPub ID
                    'Create',              -- Activity type
                    sender_profile.id,     -- Local actor ID
                    v_sender_url,          -- Actor ActivityPub ID
                    NEW.id,                -- Message ID
                    'Note',                -- Object type
                    v_activity,            -- Full JSON
                    true,                  -- Is local
                    v_instance_domain      -- Our domain
                ) RETURNING id INTO v_activity_uuid;
                
                -- Now insert into federation_delivery_queue with the ap_activities UUID
                INSERT INTO federation_delivery_queue (
                    activity_id,           -- UUID from ap_activities
                    target_domain,         -- TEXT
                    target_inbox_url,      -- TEXT
                    actor_username,        -- TEXT
                    actor_domain,          -- TEXT
                    activity_data          -- JSONB
                ) VALUES (
                    v_activity_uuid,       -- UUID from ap_activities
                    v_recipient_profile.domain,
                    v_inbox_url,
                    sender_profile.username,
                    v_instance_domain,
                    v_activity              -- Full ActivityPub JSON
                );
                
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$function$;

COMMIT;