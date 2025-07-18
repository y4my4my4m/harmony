-- Update DM federation to use unified content processing and drop duplicate function
-- This fixes the mention rendering issue where mentions appear blank in federated DMs

-- Update the handle_outgoing_messages function to use the unified function
CREATE OR REPLACE FUNCTION public.handle_outgoing_messages()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
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
    v_delivery_success BOOLEAN;
    v_http_response TEXT;
    v_http_status INTEGER;
    delivery_result JSONB;
    
    -- Variables for HTTP signatures
    v_signature_header TEXT;
    v_date_header TEXT;
    v_digest_header TEXT;
    v_headers_to_sign TEXT[];
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
    
    -- Handle DM notifications
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
        
        -- Notify LOCAL users only
        IF conversation_info.user1 != NEW.user_id THEN
            SELECT * INTO recipient_profile FROM profiles WHERE id = conversation_info.user1;
            IF recipient_profile.is_local THEN
                PERFORM create_notification_structured(
                    conversation_info.user1, 'dm', notification_data,
                    NULL, NULL, NEW.conversation_id
                );
            END IF;
        END IF;
        
        IF conversation_info.user2 != NEW.user_id THEN
            SELECT * INTO recipient_profile FROM profiles WHERE id = conversation_info.user2;
            IF recipient_profile.is_local THEN
                PERFORM create_notification_structured(
                    conversation_info.user2, 'dm', notification_data,
                    NULL, NULL, NEW.conversation_id
                );
            END IF;
        END IF;
    
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
    
    -- Only federate DM messages from local users
    IF NEW.conversation_id IS NOT NULL AND sender_profile.is_local THEN
        -- Get instance domain from config (cast JSONB to TEXT and remove quotes if present)
        SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
        FROM instance_config 
        WHERE config_key = 'domain' 
        LIMIT 1;
        
        IF v_instance_domain IS NOT NULL THEN
            -- Find remote recipients in the conversation
            FOR v_recipient_profile IN 
                SELECT p.id, p.username, p.domain, p.federated_id, p.is_local, p.inbox_url
                FROM conversations c
                JOIN profiles p ON (p.id = c.user1 OR p.id = c.user2)
                WHERE c.id = NEW.conversation_id 
                  AND p.id != NEW.user_id
                  AND NOT p.is_local
                  AND p.domain IS NOT NULL
            LOOP
                -- Build URLs using federated_id when available, fallback to constructed URL
                v_sender_url := 'https://' || v_instance_domain || '/users/' || sender_profile.username;
                v_recipient_url := COALESCE(v_recipient_profile.federated_id, 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username);
                v_message_url := 'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT;
                v_activity_id := v_sender_url || '#dm-' || NEW.id::TEXT;
                
                RAISE WARNING '🎯 Recipient URL: %', v_recipient_url;
                
                -- Use unified content processing functions (with proper emoji support)
                v_html_content := convert_unified_content_to_activitypub_html(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                v_tags := extract_all_activitypub_tags(NEW.content);
                
                -- For DMs, ensure the recipient is always included as a mention tag
                -- This is REQUIRED for Mastodon to recognize it as a direct message
                IF v_tags IS NULL OR jsonb_array_length(v_tags) = 0 THEN
                    v_tags := jsonb_build_array();
                END IF;
                
                -- Add recipient as mention tag if not already present
                IF NOT EXISTS (
                    SELECT 1 FROM jsonb_array_elements(v_tags) as tag 
                    WHERE tag->>'href' = v_recipient_url
                ) THEN
                    v_tags := v_tags || jsonb_build_array(
                        jsonb_build_object(
                            'type', 'Mention',
                            'href', v_recipient_url,
                            'name', '@' || v_recipient_profile.username || '@' || v_recipient_profile.domain
                        )
                    );
                END IF;
                
                RAISE WARNING '🏷️ Generated tags for DM: %', v_tags;
                RAISE WARNING '📝 Generated HTML content: %', v_html_content;
                RAISE WARNING '✨ Using clean ActivityPub format (no invalid properties on Create activity)';
                
                -- Create ActivityPub Note object with proper field ordering and compatibility fields
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note',
                    'attributedTo', v_sender_url,
                    'to', jsonb_build_array(v_recipient_url),
                    'cc', jsonb_build_array(),
                    'content', v_html_content,
                    'contentMap', jsonb_build_object('en', v_html_content),
                    'tag', COALESCE(v_tags, '[]'::jsonb),
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'sensitive', false
                );
                
                -- Add attachments if present
                IF jsonb_array_length(v_attachments) > 0 THEN
                    v_note_object := v_note_object || jsonb_build_object('attachment', v_attachments);
                END IF;
                
                -- Create ActivityPub Create activity with @context first (clean standard format)
                -- Remove attributedTo, visibility, directMessage, visibleUserIds from Create activity
                v_activity := (
                    '{"@context":"https://www.w3.org/ns/activitystreams",' ||
                    '"id":"' || v_activity_id || '",' ||
                    '"type":"Create",' ||
                    '"actor":"' || v_sender_url || '",' ||
                    '"to":' || jsonb_build_array(v_recipient_url)::text || ',' ||
                    '"cc":[],' ||
                    '"published":"' || to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '",' ||
                    '"object":' || v_note_object::text ||
                    '}'
                )::jsonb;
                
                -- Create the ActivityPub activity record
                INSERT INTO ap_activities (
                    ap_id,
                    ap_type,
                    actor_id,
                    actor_ap_id,
                    object_id,
                    object_type,
                    activity_data,
                    status,
                    to_addresses,
                    is_local,
                    origin_domain
                ) VALUES (
                    v_activity_id,
                    'Create',
                    NEW.user_id,
                    v_sender_url,
                    v_message_url,
                    'Note',
                    v_activity,
                    'pending',
                    ARRAY[v_recipient_url],
                    true,
                    v_instance_domain
                ) RETURNING id INTO v_activity_uuid;
                
                -- Prepare inbox URL - for DMs, MUST use user-specific inbox, not domain inbox
                IF v_recipient_profile.inbox_url IS NOT NULL THEN
                    v_inbox_url := v_recipient_profile.inbox_url;
                    RAISE WARNING '📮 Using stored inbox URL: %', v_inbox_url;
                ELSE
                    v_inbox_url := 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username || '/inbox';
                    RAISE WARNING '📮 Constructed inbox URL: %', v_inbox_url;
                END IF;
                
                -- Generate HTTP signature using edge function
                BEGIN
                    SELECT 
                        signature_header,
                        date_header,
                        digest_header,
                        headers_to_sign
                    INTO 
                        v_signature_header,
                        v_date_header,
                        v_digest_header,
                        v_headers_to_sign
                    FROM create_http_signature(
                        v_inbox_url,
                        v_activity::text,
                        sender_profile.username,
                        v_instance_domain,
                        'POST'
                    );
                    
                    RAISE NOTICE 'Generated HTTP signature for DM to %@%', 
                        v_recipient_profile.username, v_recipient_profile.domain;
                        
                EXCEPTION 
                    WHEN OTHERS THEN
                        RAISE WARNING 'Failed to generate signature for DM to %@%: %', 
                            v_recipient_profile.username, v_recipient_profile.domain, SQLERRM;
                        -- Update activity as failed and continue
                        UPDATE ap_activities 
                        SET status = 'failed',
                            error_message = 'Signature generation failed: ' || SQLERRM
                        WHERE id = v_activity_uuid;
                        CONTINUE;
                END;
                
                -- Queue for immediate Edge Function delivery
                PERFORM queue_activity_for_federation(v_activity_uuid, ARRAY[v_recipient_profile.domain], 8, true);
                
                RAISE NOTICE '📮 Queued DM for immediate Edge Function delivery: %@%', 
                    v_recipient_profile.username, v_recipient_profile.domain;
            END LOOP;
        ELSE
            RAISE WARNING 'No instance domain configured, skipping federation';
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Update function comment
COMMENT ON FUNCTION public.handle_outgoing_messages() IS 'UPDATED: Fixed to use convert_unified_content_to_activitypub_html for proper mention rendering in federated DMs. No longer makes direct HTTP calls from PostgreSQL.';

-- Drop the old incomplete function (only if it exists)
DROP FUNCTION IF EXISTS public.convert_content_to_activitypub_html(jsonb);

-- Add comment explaining the unified approach
COMMENT ON FUNCTION public.convert_unified_content_to_activitypub_html(jsonb) IS 'UNIFIED: The single function for converting MessagePart[] content to ActivityPub HTML. Handles mentions, emojis, URLs, and files properly for federation. Used by both posts and DMs.';
