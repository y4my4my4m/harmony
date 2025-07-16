-- ============================================================================
-- HARMONY MESSAGE FUNCTION REFACTORING MIGRATION
-- ============================================================================
-- This migration consolidates and renames message processing functions for clarity:
-- - handle_new_message() → handle_outgoing_messages() (outgoing messages & federation)
-- - process_activitypub_direct_message() → handle_incoming_messages() (incoming ActivityPub)
-- - Removes redundant create_outgoing_dm_activity* functions
-- ============================================================================

-- Step 1: Drop the old trigger first
DROP TRIGGER IF EXISTS handle_new_messages ON public.messages;

-- Step 2: Drop old functions that are no longer needed
DROP FUNCTION IF EXISTS public.create_outgoing_dm_activity(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.create_outgoing_dm_activity(uuid, uuid, uuid, jsonb, text[]);
DROP FUNCTION IF EXISTS public.create_outgoing_dm_activity_unified(uuid, uuid, uuid, jsonb, text[]);

-- Step 3: Drop the old handle_new_message function (if it exists with old name)
DROP FUNCTION IF EXISTS public.handle_new_message();

-- Step 4: Create the new handle_outgoing_messages function with corrected ActivityPub logic
CREATE OR REPLACE FUNCTION public.handle_outgoing_messages() RETURNS trigger
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
                
                -- Use unified content processing functions
                v_html_content := convert_unified_content_to_activitypub_html(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                v_tags := extract_all_activitypub_tags(NEW.content);
                
                -- Create ActivityPub Note object with proper field ordering and no CC for DMs
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note',
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'attributedTo', v_sender_url,
                    'content', v_html_content,
                    'contentMap', jsonb_build_object('en', v_html_content),
                    'to', jsonb_build_array(v_recipient_url),
                    'tag', v_tags,
                    'inReplyTo', NULL,
                    'sensitive', false
                );
                
                -- Add attachments if present
                IF jsonb_array_length(v_attachments) > 0 THEN
                    v_note_object := v_note_object || jsonb_build_object('attachment', v_attachments);
                END IF;
                
                -- Create ActivityPub Create activity with @context first
                v_activity := jsonb_build_object(
                    '@context', 'https://www.w3.org/ns/activitystreams',
                    'id', v_activity_id,
                    'type', 'Create',
                    'actor', v_sender_url,
                    'to', jsonb_build_array(v_recipient_url),
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'object', v_note_object
                );
                
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
                
                -- Prepare inbox URL - try user-specific inbox first, fall back to domain inbox
                v_inbox_url := COALESCE(v_recipient_profile.inbox_url, 'https://' || v_recipient_profile.domain || '/inbox');
                
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
                
                -- Attempt immediate delivery
                BEGIN
                    -- Log delivery attempt
                    RAISE NOTICE 'Attempting DM delivery to: %', v_inbox_url;
                    
                    -- Try to deliver immediately using Supabase HTTP extension
                    SELECT status, content INTO v_http_status, v_http_response
                    FROM http((
                        'POST',
                        v_inbox_url,
                        ARRAY[
                            ('Content-Type', 'application/activity+json'),
                            ('User-Agent', 'Harmony/1.0.0'),
                            ('Host', v_recipient_profile.domain),
                            ('Date', v_date_header),
                            ('Digest', v_digest_header),
                            ('Signature', v_signature_header)
                        ]::http_header[],
                        'application/activity+json',
                        v_activity::text
                    )::http_request);
                    
                    -- Check delivery success
                    v_delivery_success := (v_http_status >= 200 AND v_http_status < 300);
                    
                    RAISE NOTICE 'HTTP Response: Status=%, Body=%', v_http_status, LEFT(v_http_response, 200);
                    
                    IF v_delivery_success THEN
                        -- Immediate delivery succeeded
                        UPDATE ap_activities 
                        SET status = 'completed',
                            last_attempt_at = NOW()
                        WHERE id = v_activity_uuid;
                        
                        RAISE NOTICE '✅ DM delivery succeeded to: %@% (HTTP %)', 
                            v_recipient_profile.username, v_recipient_profile.domain, v_http_status;
                    ELSE
                        -- Immediate delivery failed, queue for retry
                        UPDATE ap_activities 
                        SET status = 'failed',
                            attempts = 1,
                            last_attempt_at = NOW(),
                            error_message = format('HTTP %s: %s', v_http_status, LEFT(v_http_response, 500))
                        WHERE id = v_activity_uuid;
                        
                        RAISE WARNING '❌ DM delivery failed to %@% (HTTP %): %', 
                            v_recipient_profile.username, v_recipient_profile.domain, v_http_status, LEFT(v_http_response, 200);
                        RAISE NOTICE 'Queuing DM for retry delivery';
                        PERFORM queue_activity_for_federation(v_activity_uuid, ARRAY[v_recipient_profile.domain], 8, true);
                    END IF;
                    
                EXCEPTION 
                    WHEN OTHERS THEN
                        -- HTTP extension not available or network error, queue for delivery
                        UPDATE ap_activities 
                        SET status = 'failed',
                            error_message = 'HTTP delivery failed: ' || SQLERRM
                        WHERE id = v_activity_uuid;
                        
                        RAISE WARNING '💥 HTTP delivery exception for DM to %@% - SQLSTATE: %, Error: %', 
                            v_recipient_profile.username, v_recipient_profile.domain, SQLSTATE, SQLERRM;
                        RAISE NOTICE 'Queuing DM for retry delivery due to exception';
                        PERFORM queue_activity_for_federation(v_activity_uuid, ARRAY[v_recipient_profile.domain], 8, true);
                END;
            END LOOP;
        ELSE
            RAISE WARNING 'No instance domain configured, skipping federation';
        END IF;
    END IF;
    
    -- =================================================================
    -- SECTION 3: FUTURE EXTENSIBILITY
    -- =================================================================
    -- Add additional message processing here:
    -- - Message indexing for search
    -- - Content moderation
    -- - Analytics/metrics
    -- - Read receipt handling
    -- - Message archiving
    
    RETURN NEW;
END;
$$;

-- Step 5: Rename process_activitypub_direct_message to handle_incoming_messages
-- Drop the old function and create the new one with the exact same functionality

DROP FUNCTION IF EXISTS public.process_activitypub_direct_message(uuid, jsonb, record, text);

CREATE FUNCTION public.handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) 
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
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
    v_recipient TEXT;
    v_user_match TEXT;
    v_profile_match TEXT;
BEGIN
    RAISE NOTICE '📩 Processing ActivityPub direct message from %@%', 
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
        RAISE WARNING 'Direct message has no local recipients - skipping';
        RETURN;
    END IF;

    RAISE NOTICE '📧 DM mentions % local users: %', array_length(v_all_recipients, 1), v_all_recipients;
    
    -- Convert ActivityPub HTML content to our JSONB format
    v_content := parse_activitypub_content_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- Process each mentioned local user
    FOREACH v_username IN ARRAY v_all_recipients LOOP
        -- Get the local user
        SELECT * INTO v_local_user
        FROM profiles 
        WHERE username = v_username 
          AND domain = instance_domain 
          AND is_local = true;

        IF NOT FOUND THEN
            RAISE WARNING 'Local user not found: %@%', v_username, instance_domain;
            CONTINUE;
        END IF;

        RAISE NOTICE '📨 Processing DM for local user: %', v_username;

        -- Find or create conversation between remote sender and local recipient
        SELECT id INTO v_conversation_id
        FROM conversations 
        WHERE (user1 = actor_profile.id AND user2 = v_local_user.id)
           OR (user1 = v_local_user.id AND user2 = actor_profile.id);

        IF NOT FOUND THEN
            -- Create new conversation
            INSERT INTO conversations (user1, user2, created_at)
            VALUES (actor_profile.id, v_local_user.id, NOW())
            RETURNING id INTO v_conversation_id;
            
            RAISE NOTICE '🆕 Created new conversation: %', v_conversation_id;
        ELSE
            RAISE NOTICE '📝 Found existing conversation: %', v_conversation_id;
        END IF;

        -- Insert the DM message
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
                'activity_id', activity_id
            )
        ) RETURNING id INTO v_message_id;

        RAISE NOTICE '✅ Saved federated DM %: %@% -> %', 
            v_message_id, actor_profile.username, actor_profile.domain, v_username;

        -- Note: DM notifications will be handled by existing message triggers
        -- No need to manually create notifications here
    END LOOP;
    
    RAISE NOTICE '🎯 Completed DM processing for activity %', activity_id;
END;
$$;

-- Step 5.5: Update the call to the renamed function in process_create_activity
-- The process_create_activity function calls process_activitypub_direct_message and needs to be updated
CREATE OR REPLACE FUNCTION public.process_create_activity(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) 
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_object JSONB;
    v_object_type TEXT;
    v_is_dm BOOLEAN;
BEGIN
    v_object := activity_data->'object';
    v_object_type := v_object->>'type';

    IF v_object_type != 'Note' THEN
        RAISE WARNING 'Create activity object is not a Note: %', v_object_type;
        RETURN;
    END IF;

    -- Check if this is a direct message
    v_is_dm := is_activitypub_direct_message(v_object, instance_domain);

    IF v_is_dm THEN
        RAISE NOTICE '📩 Processing as direct message';
        PERFORM handle_incoming_messages(activity_id, activity_data, actor_profile, instance_domain);
    ELSE
        RAISE NOTICE '📢 Processing as public post';
        PERFORM process_activitypub_public_post(activity_id, activity_data, actor_profile, instance_domain);
    END IF;
END;
$$;

-- Step 6: Create the new trigger with updated name
CREATE TRIGGER handle_outgoing_messages 
    AFTER INSERT ON public.messages 
    FOR EACH ROW 
    EXECUTE FUNCTION public.handle_outgoing_messages();

-- Step 7: Add comments to document the new functions
COMMENT ON FUNCTION public.handle_outgoing_messages() IS 
'Processes outgoing messages: creates notifications for local users and federates DMs to remote users via ActivityPub with proper HTTP signatures. Replaces the old handle_new_message function.';

COMMENT ON FUNCTION public.handle_incoming_messages(uuid, jsonb, record, text) IS 
'Processes incoming ActivityPub direct messages from federated instances. Handles both mention-based and direct addressing patterns. Renamed from process_activitypub_direct_message for clarity.';

COMMENT ON TRIGGER handle_outgoing_messages ON public.messages IS 
'Triggers on message insert to handle notifications and federation delivery. Renamed from handle_new_messages for clarity.';

-- Step 8: Log migration completion
DO $log$
BEGIN
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'HARMONY MESSAGE FUNCTION REFACTORING MIGRATION COMPLETED';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'Changes made:';
    RAISE NOTICE '✅ Dropped redundant create_outgoing_dm_activity* functions';
    RAISE NOTICE '✅ Renamed handle_new_message() → handle_outgoing_messages()';
    RAISE NOTICE '✅ Renamed process_activitypub_direct_message() → handle_incoming_messages()';
    RAISE NOTICE '✅ Updated process_create_activity() to call handle_incoming_messages()';
    RAISE NOTICE '✅ Updated trigger: handle_new_messages → handle_outgoing_messages'; 
    RAISE NOTICE '✅ Applied ActivityPub fixes: @context ordering, mention href format, no CC for DMs';
    RAISE NOTICE '✅ Added unified content processing integration';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'Function consolidation complete - fewer, clearer functions for message processing';
    RAISE NOTICE '============================================================================';
END;
$log$;
