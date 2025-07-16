-- Update Database Triggers to Use Unified Content Processing
-- This script updates existing database trigger functions to use the unified content processing functions

-- =====================================================
-- UPDATE POST FEDERATION TRIGGER FUNCTION
-- =====================================================

-- Update the handle_post_federation function to use unified content processing
CREATE OR REPLACE FUNCTION handle_post_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public, pg_temp
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
    
    -- Variables for unified content processing
    v_html_content TEXT;
    v_attachments JSONB;
    v_tags JSONB;
    v_mention_tags JSONB;
    v_emoji_tags JSONB;
    
    -- Variables for addressing
    v_to_addresses JSONB;
    v_cc_addresses JSONB;
    v_followers_url TEXT;
    v_mention_domains TEXT[];
    v_mentioned_actor_urls TEXT[];
    
    -- Variables for delivery
    v_domain TEXT;
    v_inbox_url TEXT;
    v_signature_header TEXT;
    v_date_header TEXT;
    v_digest_header TEXT;
    v_headers_to_sign TEXT[];
BEGIN
    -- Only process local posts that should be federated
    IF NOT NEW.is_local OR NEW.visibility NOT IN ('public', 'unlisted', 'followers', 'mentioned') OR NOT NEW.is_federated THEN
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
    v_followers_url := v_sender_url || '/followers';
    
    -- =====================================================
    -- USE UNIFIED CONTENT PROCESSING FUNCTIONS
    -- =====================================================
    
    -- Convert content using unified processing
    v_html_content := convert_unified_content_to_activitypub_html(NEW.content);
    v_attachments := extract_activitypub_attachments(NEW.content);
    v_mention_tags := extract_activitypub_mention_tags(NEW.content);
    v_emoji_tags := extract_misskey_emoji_tags(NEW.content);
    
    -- Combine all tags
    v_tags := '[]'::JSONB;
    IF jsonb_array_length(v_mention_tags) > 0 THEN
        v_tags := v_tags || v_mention_tags;
    END IF;
    IF jsonb_array_length(v_emoji_tags) > 0 THEN
        v_tags := v_tags || v_emoji_tags;
    END IF;
    
    -- Extract mention domains for federation targeting
    SELECT ARRAY(
        SELECT DISTINCT 
            CASE 
                WHEN tag_item->>'href' LIKE 'https://%' THEN
                    split_part(split_part(tag_item->>'href', '://', 2), '/', 1)
                ELSE NULL
            END
        FROM jsonb_array_elements(v_mention_tags) AS tag_item
        WHERE tag_item->>'href' IS NOT NULL AND tag_item->>'href' != ''
        AND split_part(split_part(tag_item->>'href', '://', 2), '/', 1) != v_instance_domain
    ) INTO v_mention_domains;
    
    -- Extract mentioned actor URLs
    SELECT ARRAY(
        SELECT tag_item->>'href'
        FROM jsonb_array_elements(v_mention_tags) AS tag_item
        WHERE tag_item->>'href' IS NOT NULL
    ) INTO v_mentioned_actor_urls;
    
    -- Build ActivityPub addressing based on visibility
    CASE NEW.visibility
        WHEN 'public' THEN
            v_to_addresses := jsonb_build_array('https://www.w3.org/ns/activitystreams#Public');
            v_cc_addresses := jsonb_build_array(v_followers_url);
            IF v_mentioned_actor_urls IS NOT NULL AND array_length(v_mentioned_actor_urls, 1) > 0 THEN
                v_cc_addresses := v_cc_addresses || to_jsonb(v_mentioned_actor_urls);
            END IF;
            
        WHEN 'unlisted' THEN
            v_to_addresses := jsonb_build_array(v_followers_url);
            v_cc_addresses := jsonb_build_array('https://www.w3.org/ns/activitystreams#Public');
            IF v_mentioned_actor_urls IS NOT NULL AND array_length(v_mentioned_actor_urls, 1) > 0 THEN
                v_cc_addresses := v_cc_addresses || to_jsonb(v_mentioned_actor_urls);
            END IF;
            
        WHEN 'followers' THEN
            v_to_addresses := jsonb_build_array(v_followers_url);
            v_cc_addresses := '[]'::JSONB;
            IF v_mentioned_actor_urls IS NOT NULL AND array_length(v_mentioned_actor_urls, 1) > 0 THEN
                v_to_addresses := v_to_addresses || to_jsonb(v_mentioned_actor_urls);
            END IF;
            
        WHEN 'mentioned' THEN
            IF v_mentioned_actor_urls IS NOT NULL AND array_length(v_mentioned_actor_urls, 1) > 0 THEN
                v_to_addresses := to_jsonb(v_mentioned_actor_urls);
            ELSE
                v_to_addresses := '[]'::JSONB;
            END IF;
            v_cc_addresses := '[]'::JSONB;
            
        ELSE
            -- Unknown visibility, don't federate
            RAISE NOTICE 'Unknown visibility % for post %, skipping federation', NEW.visibility, NEW.id;
            RETURN NEW;
    END CASE;
    
    -- Create ActivityPub Note object using unified processing results
    v_note_object := jsonb_build_object(
        'id', v_post_url,
        'type', COALESCE(NEW.ap_type, 'Note'),
        'content', v_html_content,
        'contentMap', jsonb_build_object('en', v_html_content),
        'attributedTo', v_sender_url,
        'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'to', v_to_addresses,
        'cc', v_cc_addresses,
        'tag', v_tags,
        'url', v_post_url,
        'mediaType', 'text/html',
        'sensitive', COALESCE(NEW.is_sensitive, false)
    );
    
    -- Add attachments if present
    IF jsonb_array_length(v_attachments) > 0 THEN
        v_note_object := v_note_object || jsonb_build_object('attachment', v_attachments);
    END IF;
    
    -- Add content warning if present
    IF NEW.content_warning IS NOT NULL AND NEW.content_warning != '' THEN
        v_note_object := v_note_object || jsonb_build_object('summary', NEW.content_warning);
    END IF;
    
    -- Add reply context if this is a reply
    IF NEW.in_reply_to IS NOT NULL THEN
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
        origin_domain,
        is_local,
        to_addresses,
        cc_addresses
    ) VALUES (
        v_activity_id,
        'Create',
        NEW.author_id,
        v_sender_url,
        NEW.id,
        'Note',
        v_activity,
        'pending',
        v_instance_domain,
        true,
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_to_addresses)), ARRAY[]::TEXT[]),
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_cc_addresses)), ARRAY[]::TEXT[])
    ) RETURNING id INTO v_activity_uuid;
    
    -- Attempt immediate delivery if we have target domains
    IF v_mention_domains IS NOT NULL AND array_length(v_mention_domains, 1) > 0 THEN
        
        -- Attempt immediate delivery to each domain
        FOREACH v_domain IN ARRAY v_mention_domains
        LOOP
            -- Use shared inbox pattern for efficiency
            v_inbox_url := 'https://' || v_domain || '/inbox';
            
            BEGIN
                -- Generate HTTP signature using edge function
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
                SELECT status, content INTO v_http_status, v_http_response
                FROM http((
                    'POST',
                    v_inbox_url,
                    ARRAY[
                        ('Content-Type', 'application/activity+json'),
                        ('User-Agent', 'Harmony/1.0.0'),
                        ('Host', v_domain),
                        ('Date', v_date_header),
                        ('Digest', v_digest_header),
                        ('Signature', v_signature_header)
                    ]::http_header[],
                    'application/activity+json',
                    v_activity::text
                )::http_request);
                
                -- Check delivery success
                v_delivery_success := (v_http_status >= 200 AND v_http_status < 300);
                
                IF v_delivery_success THEN
                    RAISE NOTICE '✅ Immediate post delivery succeeded to: % (HTTP %)', v_domain, v_http_status;
                ELSE
                    RAISE WARNING '❌ Immediate post delivery failed to % (HTTP %): %', 
                        v_domain, v_http_status, LEFT(v_http_response, 200);
                    RAISE NOTICE 'Will queue post for retry delivery via federation queue';
                END IF;
                
            EXCEPTION 
                WHEN OTHERS THEN
                    RAISE WARNING '💥 HTTP delivery exception for post to % - SQLSTATE: %, Error: %', 
                        v_domain, SQLSTATE, SQLERRM;
                    RAISE NOTICE 'Will queue post for retry delivery via federation queue due to exception';
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

-- =====================================================
-- REPLACE LEGACY DM FUNCTION WITH UNIFIED VERSION
-- =====================================================

-- Drop the old function and replace with the unified version
DROP FUNCTION IF EXISTS create_outgoing_dm_activity(UUID, UUID, UUID, JSONB, TEXT[]);

-- Create alias for backward compatibility
CREATE OR REPLACE FUNCTION create_outgoing_dm_activity(
    p_message_id UUID,
    p_conversation_id UUID,
    p_sender_id UUID,
    p_content JSONB,
    p_recipient_domains TEXT[]
)
RETURNS UUID
LANGUAGE SQL
AS $$
    SELECT create_outgoing_dm_activity_unified(p_message_id, p_conversation_id, p_sender_id, p_content, p_recipient_domains);
$$;

-- =====================================================
-- UPDATE OTHER FEDERATION FUNCTIONS TO USE UNIFIED PROCESSING
-- =====================================================

-- Update any other functions that process content for federation
-- This is a template - adjust based on your specific functions

CREATE OR REPLACE FUNCTION process_federation_delivery_queue_unified()
RETURNS TABLE(processed_count INTEGER, successful_count INTEGER, failed_count INTEGER, details JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    delivery_record RECORD;
    delivery_count INTEGER := 0;
    success_count INTEGER := 0;
    fail_count INTEGER := 0;
    result_details JSONB := '[]'::JSONB;
    delivery_result JSONB;
    instance_url TEXT := COALESCE(current_setting('app.instance_url', true), 'har.mony.lol');
BEGIN
    -- Log start of processing
    RAISE NOTICE 'Starting unified federation delivery queue processing...';
    
    -- Process pending deliveries with exponential backoff
    FOR delivery_record IN 
        SELECT * FROM federation_delivery_queue
        WHERE status = 'pending'
        AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        LIMIT 50  -- Process in batches to avoid long-running transactions
    LOOP
        delivery_count := delivery_count + 1;
        
        BEGIN
            -- The activity_data should already be properly formatted by unified processing
            -- No need to reprocess content here
            
            -- Attempt HTTP delivery
            delivery_result := net.http_post(
                delivery_record.target_inbox,
                delivery_record.activity_data::TEXT,
                headers => FORMAT(
                    '{"Content-Type": "application/activity+json", "User-Agent": "Harmony/%s", "Host": "%s", "Date": "%s"}',
                    '1.0.0',
                    instance_url,
                    TO_CHAR(NOW() AT TIME ZONE 'UTC', 'Dy, DD Mon YYYY HH24:MI:SS "GMT"')
                )::JSONB
            );
            
            -- Check if delivery was successful (2xx status codes)
            IF (delivery_result->>'status_code')::INTEGER BETWEEN 200 AND 299 THEN
                -- Mark as delivered
                UPDATE federation_delivery_queue 
                SET 
                    status = 'delivered',
                    delivered_at = NOW(),
                    delivery_duration_ms = EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000,
                    last_response = delivery_result
                WHERE id = delivery_record.id;
                
                success_count := success_count + 1;
                
                -- Log successful delivery
                RAISE NOTICE 'Successfully delivered activity % to %', 
                    delivery_record.activity_id, delivery_record.target_inbox;
                    
            ELSE
                -- Handle failed delivery with exponential backoff
                DECLARE
                    new_attempt_count INTEGER := delivery_record.attempt_count + 1;
                    backoff_minutes INTEGER;
                    max_attempts INTEGER := 5;
                BEGIN
                    -- Calculate exponential backoff: 2^attempt_count minutes
                    backoff_minutes := POWER(2, new_attempt_count);
                    
                    IF new_attempt_count >= max_attempts THEN
                        -- Mark as permanently failed
                        UPDATE federation_delivery_queue 
                        SET 
                            status = 'failed',
                            attempt_count = new_attempt_count,
                            last_error = FORMAT('Max attempts reached. Last response: %s', delivery_result),
                            last_response = delivery_result
                        WHERE id = delivery_record.id;
                        
                        fail_count := fail_count + 1;
                        
                        RAISE NOTICE 'Permanently failed delivery of activity % to % after % attempts', 
                            delivery_record.activity_id, delivery_record.target_inbox, max_attempts;
                    ELSE
                        -- Schedule retry with exponential backoff
                        UPDATE federation_delivery_queue 
                        SET 
                            attempt_count = new_attempt_count,
                            next_attempt_at = NOW() + (backoff_minutes || ' minutes')::INTERVAL,
                            last_error = FORMAT('Attempt %s failed. Response: %s', new_attempt_count, delivery_result),
                            last_response = delivery_result
                        WHERE id = delivery_record.id;
                        
                        RAISE NOTICE 'Scheduled retry for activity % to % in % minutes (attempt %)', 
                            delivery_record.activity_id, delivery_record.target_inbox, backoff_minutes, new_attempt_count;
                    END IF;
                END;
            END IF;
            
        EXCEPTION
            WHEN OTHERS THEN
                -- Handle exceptions during delivery
                UPDATE federation_delivery_queue 
                SET 
                    attempt_count = delivery_record.attempt_count + 1,
                    last_error = FORMAT('Exception during delivery: %s', SQLERRM),
                    next_attempt_at = NOW() + INTERVAL '5 minutes'
                WHERE id = delivery_record.id;
                
                RAISE WARNING 'Exception during delivery to %: %', 
                    delivery_record.target_inbox, SQLERRM;
        END;
    END LOOP;
    
    -- Return processing summary
    RETURN QUERY SELECT 
        delivery_count, 
        success_count, 
        fail_count, 
        jsonb_build_object(
            'processed', delivery_count,
            'successful', success_count,
            'failed', fail_count,
            'timestamp', NOW()
        );
        
    RAISE NOTICE 'Completed unified federation delivery processing: % processed, % successful, % failed', 
        delivery_count, success_count, fail_count;
END;
$$;

-- =====================================================
-- GRANTS AND FINAL SETUP
-- =====================================================

-- Grant permissions to updated functions
GRANT EXECUTE ON FUNCTION handle_post_federation() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION create_outgoing_dm_activity(UUID, UUID, UUID, JSONB, TEXT[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_federation_delivery_queue_unified() TO authenticated, service_role;

-- Update function comments
COMMENT ON FUNCTION handle_post_federation() IS 'Updated post federation trigger function using unified content processing for consistency with frontend processing';
COMMENT ON FUNCTION create_outgoing_dm_activity(UUID, UUID, UUID, JSONB, TEXT[]) IS 'Updated DM federation function using unified content processing (backward compatibility alias)';
COMMENT ON FUNCTION process_federation_delivery_queue_unified() IS 'Updated federation delivery queue processor using unified content processing';

-- Log completion
DO $$
BEGIN
    RAISE NOTICE '🎉 DATABASE TRIGGER UNIFICATION COMPLETED!';
    RAISE NOTICE '✅ Updated handle_post_federation() to use unified content processing';
    RAISE NOTICE '✅ Updated create_outgoing_dm_activity() to use unified content processing';
    RAISE NOTICE '✅ Updated federation delivery queue processor';
    RAISE NOTICE '🔧 All database federation functions now use consistent content processing';
    RAISE NOTICE '📝 Content processing logic is now unified between frontend and database triggers';
    RAISE NOTICE '🎯 Files are properly handled as ActivityPub attachments';
    RAISE NOTICE '😀 Emojis are properly formatted as Misskey-compatible tags';
    RAISE NOTICE '💬 Mentions are properly formatted as ActivityPub Mention objects';
    RAISE NOTICE '🌐 Federation output is now standards-compliant and consistent';
END;
$$;
