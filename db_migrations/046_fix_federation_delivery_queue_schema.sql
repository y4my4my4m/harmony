BEGIN;

-- Fix handle_outgoing_messages function to match actual federation_delivery_queue schema
-- The function was trying to insert columns that don't exist in the table

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
                PERFORM send_notification(
                    'dm',
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
                v_activity_id := v_sender_url || '#dm-' || NEW.id::TEXT;
                
                RAISE WARNING '🎯 Recipient URL: %', v_recipient_url;
                
                -- Use unified content processing for federation
                v_html_content := convert_jsonb_to_ap(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                v_tags := extract_all_activitypub_tags(NEW.content);
                
                -- Create Note object (DM format)
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note', 
                    'published', NEW.created_at::text,
                    'attributedTo', v_sender_url,
                    'content', v_html_content,
                    'url', v_message_url,
                    'to', jsonb_build_array(v_recipient_url),
                    'cc', '[]'::jsonb
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
                    'to', jsonb_build_array(v_recipient_url),
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
                    ARRAY[v_recipient_url]
                );
                
                -- FIXED: Queue for delivery using correct column names
                INSERT INTO federation_delivery_queue (
                    activity_id,           -- ✅ Exists in table
                    activity_data,         -- ✅ Exists in table
                    target_domain,         -- ✅ Exists in table
                    target_inbox_url,      -- ✅ Exists in table
                    status,                -- ✅ Exists in table
                    priority,              -- ✅ Exists in table
                    actor_username,        -- ✅ Exists in table
                    actor_domain           -- ✅ Exists in table
                ) VALUES (
                    v_activity_uuid,       -- Reference to ap_activities.id
                    v_activity,            -- Full ActivityPub JSON
                    v_recipient_profile.domain,
                    COALESCE(v_recipient_profile.inbox_url, 'https://' || v_recipient_profile.domain || '/inbox'),
                    'pending',
                    5,                     -- Normal priority
                    sender_profile.username,
                    v_instance_domain
                );
                
                RAISE WARNING '📮 Queued DM delivery to: %', COALESCE(v_recipient_profile.inbox_url, 'https://' || v_recipient_profile.domain || '/inbox');
                
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$function$;

-- Test the function with a simple verification
DO $$
BEGIN
    -- Just verify the function was created successfully
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_outgoing_messages') THEN
        RAISE NOTICE '✅ handle_outgoing_messages function updated successfully';
    ELSE
        RAISE EXCEPTION '❌ handle_outgoing_messages function update failed';
    END IF;
END $$;

COMMIT;