-- Professional Post Federation: Single trigger approach
-- Handles ActivityPub federation for public posts with mentions
-- Follows the same pattern as professional_message_processing.sql

-- Create comprehensive post federation function
CREATE OR REPLACE FUNCTION handle_post_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    -- Variables for federation
    v_sender_profile RECORD;
    v_instance_domain TEXT;
    v_activity_id TEXT;
    v_activity_uuid UUID;
    v_sender_url TEXT;
    v_post_url TEXT;
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
    
    -- Variables for mentions
    v_mentioned_users RECORD;
    v_mention_domains TEXT[];
    v_domain TEXT;
    v_inbox_url TEXT;
BEGIN
    -- Only process local posts that should be federated
    IF NOT NEW.is_local OR NEW.visibility NOT IN ('public', 'unlisted') OR NOT NEW.is_federated THEN
        RETURN NEW;
    END IF;
    
    -- Get sender profile
    SELECT * INTO v_sender_profile 
    FROM profiles 
    WHERE id = NEW.author_id;
    
    IF NOT FOUND OR NOT v_sender_profile.is_local THEN
        RETURN NEW;
    END IF;
    
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config 
    WHERE config_key = 'domain' 
    LIMIT 1;
    
    IF v_instance_domain IS NULL THEN
        RAISE WARNING 'No instance domain configured, skipping post federation';
        RETURN NEW;
    END IF;
    
    -- Build URLs
    v_sender_url := 'https://' || v_instance_domain || '/users/' || v_sender_profile.username;
    v_post_url := 'https://' || v_instance_domain || '/posts/' || NEW.id::TEXT;
    v_activity_id := v_sender_url || '#create-' || NEW.id::TEXT;
    
    -- Create ActivityPub Note object with proper content format
    v_note_object := jsonb_build_object(
        'id', v_post_url,
        'type', 'Note',
        'content', convert_content_to_activitypub_html(NEW.content),
        'contentMap', jsonb_build_object('en', convert_content_to_activitypub_html(NEW.content)),
        'attributedTo', v_sender_url,
        'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'to', CASE 
            WHEN NEW.visibility = 'public' THEN jsonb_build_array('https://www.w3.org/ns/activitystreams#Public')
            ELSE jsonb_build_array()
        END,
        'cc', jsonb_build_array(),
        'url', v_post_url,
        'mediaType', 'text/html',
        'sensitive', COALESCE(NEW.is_sensitive, false)
    );
    
    -- Add content warning if present
    IF NEW.content_warning IS NOT NULL AND NEW.content_warning != '' THEN
        v_note_object := v_note_object || jsonb_build_object('summary', NEW.content_warning);
    END IF;
    
    -- Add reply context if this is a reply
    IF NEW.in_reply_to IS NOT NULL THEN
        -- Get the original post's AP ID
        SELECT ap_id INTO v_post_url FROM posts WHERE id = NEW.in_reply_to::UUID;
        IF FOUND AND v_post_url IS NOT NULL THEN
            v_note_object := v_note_object || jsonb_build_object('inReplyTo', v_post_url);
        END IF;
    END IF;
    
    -- Create ActivityPub Create activity
    v_activity := jsonb_build_object(
        '@context', 'https://www.w3.org/ns/activitystreams',
        'id', v_activity_id,
        'type', 'Create',
        'actor', v_sender_url,
        'object', v_note_object,
        'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'to', v_note_object->'to',
        'cc', v_note_object->'cc'
    );
    
    -- Store the ActivityPub activity record
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
        NEW.author_id,
        v_sender_url,
        v_post_url,
        'Note',
        v_activity,
        'pending',
        ARRAY[]::TEXT[], -- Will be populated based on mentions
        true,
        v_instance_domain
    ) RETURNING id INTO v_activity_uuid;
    
    -- Find mentioned remote users and their domains
    WITH mentioned_users AS (
        -- Handle both mention object types and mentions metadata
        SELECT DISTINCT 
            p.domain,
            p.username,
            p.federated_id
        FROM (
            -- Extract mentions from mentions metadata within text objects
            SELECT 
                mention_data->>'username' as username,
                mention_data->>'domain' as domain
            FROM jsonb_array_elements(NEW.content) AS content_item,
                 jsonb_array_elements(content_item->'mentions') AS mention_data
            WHERE content_item->>'type' = 'text'
              AND content_item->'mentions' IS NOT NULL
              AND mention_data->>'domain' IS NOT NULL
              AND mention_data->>'domain' != v_instance_domain
            
            UNION
            
            -- Extract mentions from separate mention objects
            SELECT 
                content_item->>'username' as username,
                content_item->>'domain' as domain
            FROM jsonb_array_elements(NEW.content) AS content_item
            WHERE content_item->>'type' = 'mention'
              AND content_item->>'domain' IS NOT NULL
              AND content_item->>'domain' != v_instance_domain
        ) AS all_mentions
        JOIN profiles p ON p.username = all_mentions.username 
                        AND p.domain = all_mentions.domain
                        AND NOT p.is_local
        WHERE p.domain IS NOT NULL
    )
    SELECT array_agg(DISTINCT domain) INTO v_mention_domains
    FROM mentioned_users;
    
    -- If we have remote mentions, attempt immediate delivery
    IF v_mention_domains IS NOT NULL AND array_length(v_mention_domains, 1) > 0 THEN
        RAISE NOTICE 'Post % has mentions to remote domains: %', NEW.id, v_mention_domains;
        
        -- Update activity with target addresses
        UPDATE ap_activities 
        SET to_addresses = v_mention_domains
        WHERE id = v_activity_uuid;
        
        -- Attempt immediate delivery to each domain
        FOREACH v_domain IN ARRAY v_mention_domains
        LOOP
            -- Use shared inbox pattern for efficiency
            v_inbox_url := 'https://' || v_domain || '/inbox';
            
            BEGIN
                -- Generate HTTP signature
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
                    v_sender_profile.username,
                    v_instance_domain,
                    'POST'
                );
                
                -- Attempt immediate delivery
                RAISE NOTICE 'Attempting post delivery to: % with signature: %', v_inbox_url, LEFT(v_signature_header, 100);
                
                -- Use Supabase's http_post function with proper signature
                SELECT status, content INTO v_http_status, v_http_response
                FROM http_post(
                    v_inbox_url,
                    v_activity::text,
                    'application/activity+json',
                    jsonb_build_object(
                        'User-Agent', 'Harmony/1.0.0',
                        'Host', v_domain,
                        'Date', v_date_header,
                        'Digest', v_digest_header,
                        'Signature', v_signature_header
                    )
                );
                
                -- Check delivery success
                v_delivery_success := (v_http_status >= 200 AND v_http_status < 300);
                
                IF v_delivery_success THEN
                    RAISE NOTICE '✅ Immediate post delivery succeeded to: % (HTTP %)', v_domain, v_http_status;
                ELSE
                    RAISE WARNING 'Immediate delivery failed to % (HTTP %), will queue for retry. Response: %', 
                        v_domain, v_http_status, LEFT(v_http_response, 200);
                END IF;
                
            EXCEPTION 
                WHEN OTHERS THEN
                    RAISE NOTICE 'HTTP delivery failed to % (%), will queue for retry. Error: %', 
                        v_domain, SQLSTATE, SQLERRM;
                    v_delivery_success := false;
            END;
        END LOOP;
        
        -- Update activity status based on delivery results
        IF v_delivery_success THEN
            UPDATE ap_activities 
            SET status = 'completed',
                last_attempt_at = NOW()
            WHERE id = v_activity_uuid;
        ELSE
            -- Queue for retry if immediate delivery failed
            UPDATE ap_activities 
            SET status = 'failed',
                attempts = 1,
                last_attempt_at = NOW(),
                error_message = 'Immediate delivery failed, queued for retry'
            WHERE id = v_activity_uuid;
            
            -- Queue for federation delivery worker
            PERFORM queue_activity_for_federation(v_activity_uuid, v_mention_domains, 5, false);
        END IF;
    ELSE
        -- No remote mentions, just mark as completed
        UPDATE ap_activities 
        SET status = 'completed'
        WHERE id = v_activity_uuid;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Drop any existing post federation triggers
DROP TRIGGER IF EXISTS handle_post_federation_trigger ON posts;

-- Create the trigger
CREATE TRIGGER handle_post_federation_trigger
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_post_federation();

-- Grant permissions
GRANT EXECUTE ON FUNCTION handle_post_federation() TO authenticated;
GRANT EXECUTE ON FUNCTION handle_post_federation() TO service_role;

-- Documentation
COMMENT ON FUNCTION handle_post_federation() IS 'Handles ActivityPub federation for public posts with mentions - follows same pattern as DM federation with immediate delivery + queue fallback';
COMMENT ON TRIGGER handle_post_federation_trigger ON posts IS 'Automatically federates public posts with mentions using immediate delivery + queue fallback pattern';
