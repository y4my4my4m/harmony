-- Professional Message Processing: Single trigger approach
-- Handles notifications, federation, and future message processing in one atomic operation

-- 0. Ensure required extensions are available
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 0. Clean up old functions and triggers
DROP TRIGGER IF EXISTS trigger_message_notifications ON messages;
DROP TRIGGER IF EXISTS trigger_federate_dm_messages ON messages;
DROP TRIGGER IF EXISTS handle_new_messages ON messages;
DROP FUNCTION IF EXISTS handle_message_notifications();
DROP FUNCTION IF EXISTS federate_dm_message();
DROP FUNCTION IF EXISTS create_http_signature();
DROP FUNCTION IF EXISTS convert_content_to_activitypub_html();

-- Helper function to convert Harmony content to ActivityPub HTML
CREATE OR REPLACE FUNCTION convert_content_to_activitypub_html(content_data JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = extensions, public, pg_temp
AS $$
DECLARE
    html_content TEXT := '';
    item JSONB;
BEGIN
    -- Handle array content (Harmony's structured format)
    IF jsonb_typeof(content_data) = 'array' THEN
        FOR item IN SELECT * FROM jsonb_array_elements(content_data)
        LOOP
            CASE item->>'type'
                WHEN 'text' THEN
                    html_content := html_content || (item->>'text');
                WHEN 'mention' THEN
                    html_content := html_content || format(
                        '<span class="h-card"><a href="https://%s/@%s" class="u-url mention">@<span>%s</span></a></span>',
                        item->>'domain',
                        item->>'username', 
                        item->>'username'
                    );
                WHEN 'link' THEN
                    html_content := html_content || format(
                        '<a href="%s">%s</a>',
                        item->>'url',
                        COALESCE(item->>'text', item->>'url')
                    );
                ELSE
                    -- Unknown type, treat as text
                    html_content := html_content || COALESCE(item->>'text', item::text);
            END CASE;
        END LOOP;
    ELSE
        -- Handle simple text content
        html_content := content_data::text;
        html_content := trim(both '"' from html_content); -- Remove JSON quotes
    END IF;
    
    RETURN html_content;
END;
$$;

-- Helper function to extract ActivityPub Mention tags from content and recipients
-- For DMs: Always includes all recipients as mentions (required for "direct" visibility)
-- Also includes any explicit @mentions from message content
CREATE OR REPLACE FUNCTION extract_activitypub_mention_tags(
    content_data JSONB,
    recipient_urls TEXT[],
    instance_domain TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = extensions, public, pg_temp
AS $$
DECLARE
    mention_tags JSONB := '[]'::jsonb;
    item JSONB;
    recipient_url TEXT;
    username TEXT;
    domain TEXT;
    mention_name TEXT;
    url_parts TEXT[];
BEGIN
    -- Extract explicit mentions from content (if any)
    IF jsonb_typeof(content_data) = 'array' THEN
        FOR item IN SELECT * FROM jsonb_array_elements(content_data)
        LOOP
            IF item->>'type' = 'mention' THEN
                -- Build proper ActivityPub Mention tag from content mention
                mention_name := '@' || (item->>'username');
                IF item->>'domain' IS NOT NULL AND item->>'domain' != instance_domain THEN
                    mention_name := mention_name || '@' || (item->>'domain');
                END IF;
                
                mention_tags := mention_tags || jsonb_build_array(jsonb_build_object(
                    'type', 'Mention',
                    'href', 'https://' || COALESCE(item->>'domain', instance_domain) || '/@' || (item->>'username'),
                    'name', mention_name
                ));
            END IF;
        END LOOP;
    END IF;
    
    -- For DMs: ALWAYS ensure all recipients are mentioned in tags (required for "direct" visibility)
    -- This happens regardless of whether users explicitly @mention each other in chat
    -- Critical for Mastodon compatibility and proper DM delivery
    FOREACH recipient_url IN ARRAY recipient_urls
    LOOP
        -- Parse recipient URL to extract username and domain
        -- Expected format: https://domain.com/@username or https://domain.com/users/username
        IF recipient_url LIKE 'https://%' THEN
            -- Remove https:// prefix
            recipient_url := substring(recipient_url from 9);
            
            -- Split by / to get domain and path
            url_parts := string_to_array(recipient_url, '/');
            
            IF array_length(url_parts, 1) >= 2 THEN
                domain := url_parts[1];
                
                -- Extract username from path (handles both /@username and /users/username formats)
                IF url_parts[2] LIKE '@%' THEN
                    username := substring(url_parts[2] from 2);  -- Remove @ prefix
                ELSIF array_length(url_parts, 1) >= 3 AND url_parts[2] = 'users' THEN
                    username := url_parts[3];
                ELSE
                    username := url_parts[2];
                END IF;
                
                -- Build mention name
                mention_name := '@' || username;
                IF domain != instance_domain THEN
                    mention_name := mention_name || '@' || domain;
                END IF;
                
                -- Check if this mention is already in tags (avoid duplicates)
                IF NOT EXISTS (
                    SELECT 1 FROM jsonb_array_elements(mention_tags) AS tag
                    WHERE tag->>'href' = 'https://' || domain || '/@' || username
                ) THEN
                    mention_tags := mention_tags || jsonb_build_array(jsonb_build_object(
                        'type', 'Mention',
                        'href', 'https://' || domain || '/@' || username,
                        'name', mention_name
                    ));
                END IF;
            END IF;
        END IF;
    END LOOP;
    
    RETURN mention_tags;
END;
$$;

-- 1. Create comprehensive message processing function
CREATE OR REPLACE FUNCTION handle_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public, pg_temp
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
    
    -- Only federate DM messages
    IF NEW.conversation_id IS NOT NULL AND sender_profile.is_local THEN
        -- Get instance domain from config (cast JSONB to TEXT and remove quotes if present)
        SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
        FROM instance_config 
        WHERE config_key = 'domain' 
        LIMIT 1;
        
        IF v_instance_domain IS NOT NULL THEN
            -- Find remote recipients in the conversation
            FOR v_recipient_profile IN 
                SELECT p.id, p.username, p.domain, p.federated_id, p.is_local
                FROM conversations c
                JOIN profiles p ON (p.id = c.user1 OR p.id = c.user2)
                WHERE c.id = NEW.conversation_id 
                  AND p.id != NEW.user_id
                  AND NOT p.is_local
                  AND p.domain IS NOT NULL
            LOOP
                -- Build URLs
                v_sender_url := 'https://' || v_instance_domain || '/users/' || sender_profile.username;
                v_recipient_url := 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username;
                v_message_url := 'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT;
                v_activity_id := v_sender_url || '#dm-' || NEW.id::TEXT;
                
                -- Generate proper ActivityPub Mention tags for DM recipients
                -- This is required for "direct" visibility in Mastodon
                -- NOTE: For DMs, we ALWAYS include recipients as mentions, regardless of whether
                -- they are explicitly mentioned in the message content (chat-like behavior)
                DECLARE
                    v_mention_tags JSONB;
                    v_recipient_urls TEXT[];
                BEGIN
                    -- Build array of all recipient URLs in the conversation
                    v_recipient_urls := ARRAY[v_recipient_url];
                    
                    -- Extract mention tags including content mentions + all DM recipients
                    -- This will handle both explicit @mentions in content AND ensure all recipients are mentioned
                    v_mention_tags := extract_activitypub_mention_tags(
                        NEW.content,
                        v_recipient_urls,
                        v_instance_domain
                    );
                    
                    -- Create ActivityPub Note object with proper content format and mention tags
                    v_note_object := jsonb_build_object(
                        'id', v_message_url,
                        'type', 'Note',
                        'content', convert_content_to_activitypub_html(NEW.content),
                        'contentMap', jsonb_build_object('en', convert_content_to_activitypub_html(NEW.content)),
                        'attributedTo', v_sender_url,
                        'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                        'to', jsonb_build_array(v_recipient_url),
                        'tag', v_mention_tags,  -- Proper Mention tags for direct visibility
                        'cc', jsonb_build_array(),
                        'sensitive', false
                    );
                END;
                
                -- Create ActivityPub Create activity
                v_activity := jsonb_build_object(
                    '@context', 'https://www.w3.org/ns/activitystreams',
                    'id', v_activity_id,
                    'type', 'Create',
                    'actor', v_sender_url,
                    'object', v_note_object,
                    'to', jsonb_build_array(v_recipient_url),
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                );
                
                -- First, create the ActivityPub activity record
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
                
                -- Prepare inbox URL
                v_inbox_url := 'https://' || v_recipient_profile.domain || '/inbox';
                
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
                    
                    RAISE NOTICE 'Generated HTTP signature using edge function for DM to %@%', 
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
                
                -- Attempt immediate delivery first
                BEGIN
                    -- Log what we're about to attempt
                    RAISE NOTICE 'Attempting DM delivery to: % with signature: %', v_inbox_url, LEFT(v_signature_header, 100);
                    
                    -- Try to deliver immediately using Supabase HTTP extension with proper ActivityPub headers
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
                        
                        RAISE NOTICE '✅ Immediate DM delivery succeeded to: %@% (HTTP %)', 
                            v_recipient_profile.username, v_recipient_profile.domain, v_http_status;
                    ELSE
                        -- Immediate delivery failed, queue for retry
                        UPDATE ap_activities 
                        SET status = 'failed',
                            attempts = 1,
                            last_attempt_at = NOW(),
                            error_message = format('HTTP %s: %s', v_http_status, LEFT(v_http_response, 500))
                        WHERE id = v_activity_uuid;
                        
                        RAISE WARNING '❌ Immediate DM delivery failed to %@% (HTTP %): %', 
                            v_recipient_profile.username, v_recipient_profile.domain, v_http_status, LEFT(v_http_response, 200);
                        RAISE NOTICE 'Queuing DM for retry delivery via federation queue';
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
                        RAISE NOTICE 'Queuing DM for retry delivery via federation queue due to exception';
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

-- 2. Create single trigger (old triggers already dropped above)

CREATE TRIGGER handle_new_messages
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION handle_new_message();

-- 3. Grant permissions
GRANT EXECUTE ON FUNCTION public.create_http_signature(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_http_signature(text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION handle_new_message() TO authenticated;
GRANT EXECUTE ON FUNCTION handle_new_message() TO service_role;
GRANT EXECUTE ON FUNCTION convert_content_to_activitypub_html(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION convert_content_to_activitypub_html(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION extract_activitypub_mention_tags(JSONB, TEXT[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION extract_activitypub_mention_tags(JSONB, TEXT[], TEXT) TO service_role;

-- 4. Documentation
COMMENT ON FUNCTION create_http_signature(text, text, text, text, text) IS 'Generates HTTP signatures for ActivityPub federation using edge function with proper RSA-SHA256 signing';
COMMENT ON FUNCTION handle_new_message() IS 'Comprehensive message processing: notifications (local users only) + federation (remote DMs with proper HTTP signatures via edge function)';
COMMENT ON FUNCTION convert_content_to_activitypub_html(JSONB) IS 'Converts Harmony''s structured content format to ActivityPub-compatible HTML content';
COMMENT ON FUNCTION extract_activitypub_mention_tags(JSONB, TEXT[], TEXT) IS 'Generates proper ActivityPub Mention tags according to ActivityStreams specification: ensures all DM recipients are mentioned for "direct" visibility (chat-like behavior - no need for explicit @mentions), includes proper name property with @mention text';
COMMENT ON TRIGGER handle_new_messages ON messages IS 'Single atomic trigger for all message processing - now with proper RSA signing via edge function';

-- 5. Important Notes
-- =================
-- ActivityStreams Specification Compliance:
-- - Mention tags follow ActivityStreams vocabulary: type="Mention", href=actor_url, name=@mention_text
-- - For direct messages: all actors in 'to' are also mentioned in 'tag' for proper "direct" visibility
-- - Mastodon compatibility: requires Mention tags for notifications and visibility calculation
-- - Name property contains substring that appears in content (@username or @username@domain)
-- 
-- Edge Function Implementation:
-- - HTTP signatures use proper RSA-SHA256 signing via edge function
-- - Edge function handles cryptographic operations securely 
-- - Database function calls edge function at localhost:8000/functions/v1/sign-http-request
-- - Provides proper ActivityPub-compatible signatures
-- 
-- Federation Security:
-- - HTTP signatures include: (request-target), host, date, and digest headers
-- - Private keys are securely accessed and used only in edge function
-- - Proper error handling for edge function failures
-- 
-- Performance Considerations:
-- - Edge function call adds latency but ensures proper signatures
-- - Consider caching or optimizing for high-volume scenarios
-- - Fallback to queue-based delivery for any failures
