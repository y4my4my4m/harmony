-- Fix DM Private Mention Handling
-- ISSUE: DMs need recipient mentions in ActivityPub tags, not in content
-- SOLUTION: Modify handle_outgoing_messages to ensure recipient mentions are added to tags only

CREATE OR REPLACE FUNCTION handle_outgoing_messages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $function$
DECLARE
    -- Variables for notifications (existing)
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
    
    -- Variables for federation (updated)
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
    v_all_remote_participants UUID[];
    v_to_addresses JSONB;
    v_recipient_urls TEXT[];
    
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
                    participant_record.user_id, 
                    'dm', 
                    notification_data
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
                        reply_author_id, 
                        'reply',
                        notification_data || jsonb_build_object(
                            'original_message', jsonb_build_object('id', NEW.reply_to)
                        )
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
                        mentioned_user_id, 
                        'mention', 
                        notification_data
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
            -- UPDATED: Find all remote participants for private mention
            SELECT ARRAY_AGG(p.id) INTO v_all_remote_participants
            FROM conversation_participants cp
            JOIN profiles p ON p.id = cp.user_id
            WHERE cp.conversation_id = NEW.conversation_id 
              AND cp.user_id != NEW.user_id
              AND cp.left_at IS NULL
              AND NOT p.is_local
              AND p.domain IS NOT NULL;
              
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
                
                -- Build recipient URLs array for mention tags
                SELECT ARRAY_AGG(
                    COALESCE(p.federated_id, 'https://' || p.domain || '/users/' || p.username)
                ) INTO v_recipient_urls
                FROM profiles p
                WHERE p.id = ANY(v_all_remote_participants);
                
                RAISE WARNING '🎯 Private mention recipients: %', v_to_addresses;
                
                -- CRITICAL FIX: Process content WITHOUT modifying the original content
                -- The content stays as MessagePart[] - we only convert for ActivityPub HTML
                v_html_content := convert_jsonb_to_ap(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                
                -- CRITICAL FIX: Generate tags with recipient mentions for private mention
                -- This ensures remote recipients are mentioned in ActivityPub tags
                v_tags := extract_activitypub_mention_tags(
                    NEW.content,  -- Original content (no changes)
                    v_recipient_urls,  -- All remote recipients
                    v_instance_domain
                );
                
                -- Create Note object (Private Mention format)
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note', 
                    'published', NEW.created_at::text,
                    'attributedTo', v_sender_url,
                    'content', v_html_content,  -- HTML for ActivityPub (with @mentions if any exist in content)
                    'url', v_message_url,
                    'to', v_to_addresses,  -- Only the mentioned users
                    'cc', '[]'::jsonb      -- Private mentions have empty cc
                );
                
                -- Add attachments and tags if present
                IF v_attachments IS NOT NULL AND jsonb_array_length(v_attachments) > 0 THEN
                    v_note_object := v_note_object || jsonb_build_object('attachment', v_attachments);
                END IF;
                
                -- CRITICAL: Always add recipient mention tags for DM/private mention
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
                    'to', v_to_addresses,  -- Same as Note's "to"
                    'cc', '[]'::jsonb      -- Private mentions have empty cc
                );
                
                -- Generate UUID for activity
                v_activity_uuid := gen_random_uuid();
                
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