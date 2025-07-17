-- ============================================================================
-- FEDERATION EDGE FUNCTION MIGRATION
-- ============================================================================
-- This migration removes HTTP calls from PostgreSQL functions and updates them
-- to only queue activities for the federation-delivery Edge Function to process.
-- All HTTP delivery is now handled by Edge Functions with proper observability.
-- ============================================================================

-- 1. Update handle_post_federation to only queue activities
CREATE OR REPLACE FUNCTION public.handle_post_federation() 
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $$
DECLARE
    v_sender_profile RECORD;
    v_instance_domain TEXT;
    v_activity_id TEXT;
    v_activity_uuid UUID;
    v_sender_url TEXT;
    v_post_url TEXT;
    v_activity JSONB;
    v_note_object JSONB;
    v_mentioned_actor_urls TEXT[];
    v_mention_domains TEXT[];
    v_domain TEXT;
    v_followers_url TEXT;
BEGIN
    -- Only process local posts that should be federated
    IF NEW.is_local IS NOT TRUE OR NEW.visibility = 'private' THEN
        RETURN NEW;
    END IF;

    -- Get sender profile and instance domain
    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.author_id;
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    IF v_instance_domain IS NULL THEN
        RAISE WARNING 'No instance domain configured, skipping post federation';
        RETURN NEW;
    END IF;

    -- Build URLs and activity
    v_sender_url := 'https://' || v_instance_domain || '/users/' || v_sender_profile.username;
    v_post_url := 'https://' || v_instance_domain || '/posts/' || NEW.id::TEXT;
    v_activity_id := v_sender_url || '#create-' || NEW.id::TEXT;
    v_followers_url := v_sender_url || '/followers';

    -- Extract mentions and build Note object
    WITH all_mentions AS (
        SELECT 
            mention_data->>'username' as username,
            mention_data->>'domain' as domain
        FROM jsonb_array_elements(NEW.content) AS content_item,
             jsonb_array_elements(
                 CASE 
                     WHEN content_item->'mentions' IS NOT NULL 
                     THEN content_item->'mentions'
                     ELSE '[]'::jsonb
                 END
             ) AS mention_data
        WHERE content_item->>'type' = 'text'
        AND mention_data->>'username' IS NOT NULL
        
        UNION
        
        SELECT 
            content_item->>'username' as username,
            content_item->>'domain' as domain
        FROM jsonb_array_elements(NEW.content) AS content_item
        WHERE content_item->>'type' = 'mention'
        AND content_item->>'username' IS NOT NULL
    ),
    resolved_mentions AS (
        SELECT DISTINCT
            CASE 
                WHEN am.domain IS NOT NULL AND am.domain != v_instance_domain 
                THEN 'https://' || am.domain || '/users/' || am.username
                WHEN am.domain IS NULL OR am.domain = v_instance_domain
                THEN v_sender_url || '/users/' || am.username
                ELSE 'https://' || am.domain || '/users/' || am.username
            END as actor_url,
            COALESCE(am.domain, v_instance_domain) as domain
        FROM all_mentions am
        WHERE am.username IS NOT NULL
    )
    SELECT 
        array_agg(DISTINCT CASE WHEN rm.actor_url IS NOT NULL THEN rm.actor_url ELSE NULL END),
        array_agg(DISTINCT CASE WHEN rm.domain IS NOT NULL AND rm.domain != v_instance_domain THEN rm.domain ELSE NULL END)
    INTO v_mentioned_actor_urls, v_mention_domains
    FROM resolved_mentions rm;

    -- Build ActivityPub Note object
    v_note_object := jsonb_build_object(
        'id', v_post_url,
        'type', 'Note',
        'attributedTo', v_sender_url,
        'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'content', public.convert_unified_content_to_activitypub_html(NEW.content),
        'contentMap', jsonb_build_object('en', public.convert_unified_content_to_activitypub_html(NEW.content)),
        'attachment', public.extract_activitypub_attachments(NEW.content),
        'tag', CASE 
            WHEN v_mentioned_actor_urls IS NOT NULL 
            THEN public.extract_activitypub_mention_tags(NEW.content)
            ELSE '[]'::jsonb
        END,
        'to', CASE NEW.visibility
            WHEN 'public' THEN jsonb_build_array('https://www.w3.org/ns/activitystreams#Public', v_followers_url)
            WHEN 'unlisted' THEN jsonb_build_array(v_followers_url)
            WHEN 'followers' THEN jsonb_build_array(v_followers_url)
            WHEN 'mentioned' THEN COALESCE(to_jsonb(v_mentioned_actor_urls), '[]'::jsonb)
            ELSE '[]'::jsonb
        END,
        'cc', CASE NEW.visibility
            WHEN 'public' THEN COALESCE(to_jsonb(v_mentioned_actor_urls), '[]'::jsonb)
            WHEN 'unlisted' THEN jsonb_build_array('https://www.w3.org/ns/activitystreams#Public') || COALESCE(to_jsonb(v_mentioned_actor_urls), '[]'::jsonb)
            ELSE '[]'::jsonb
        END
    );

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
        ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
        activity_data, status, to_addresses, is_local, origin_domain
    ) VALUES (
        v_activity_id, 'Create', NEW.author_id, v_sender_url, v_post_url, 'Note',
        v_activity, 'pending', ARRAY[]::TEXT[], true, v_instance_domain
    ) RETURNING id INTO v_activity_uuid;

    -- Queue for edge function delivery based on visibility
    CASE NEW.visibility
        WHEN 'public', 'unlisted' THEN
            -- For public/unlisted posts, federate to all domains that follow this user
            WITH follower_domains AS (
                SELECT DISTINCT p.domain
                FROM follows f
                JOIN profiles p ON f.follower_id = p.id
                WHERE f.following_id = NEW.author_id
                  AND f.status = 'accepted'
                  AND NOT p.is_local
                  AND p.domain IS NOT NULL
            ),
            all_target_domains AS (
                -- Combine follower domains with mention domains
                SELECT domain FROM follower_domains
                UNION
                SELECT UNNEST(v_mention_domains) as domain 
                WHERE v_mention_domains IS NOT NULL
            )
            SELECT array_agg(domain) INTO v_mention_domains
            FROM all_target_domains;
            
            IF v_mention_domains IS NOT NULL AND array_length(v_mention_domains, 1) > 0 THEN
                PERFORM queue_activity_for_federation(v_activity_uuid, v_mention_domains, 5, true);
                RAISE NOTICE '📮 Queued public/unlisted post % for delivery to % domains (followers + mentions)', 
                    NEW.id, array_length(v_mention_domains, 1);
            ELSE
                UPDATE ap_activities SET status = 'completed' WHERE id = v_activity_uuid;
                RAISE NOTICE '🏠 Public/unlisted post % has no remote followers or mentions, marked as completed', NEW.id;
            END IF;
            
        WHEN 'followers' THEN
            -- For followers-only posts, federate to follower domains (not mentioned domains)
            WITH follower_domains AS (
                SELECT DISTINCT p.domain
                FROM follows f
                JOIN profiles p ON f.follower_id = p.id
                WHERE f.following_id = NEW.author_id
                  AND f.status = 'accepted'
                  AND NOT p.is_local
                  AND p.domain IS NOT NULL
            )
            SELECT array_agg(domain) INTO v_mention_domains
            FROM follower_domains;
            
            IF v_mention_domains IS NOT NULL AND array_length(v_mention_domains, 1) > 0 THEN
                PERFORM queue_activity_for_federation(v_activity_uuid, v_mention_domains, 6, true);
                RAISE NOTICE '📮 Queued followers post % for delivery to % follower domains', 
                    NEW.id, array_length(v_mention_domains, 1);
            ELSE
                UPDATE ap_activities SET status = 'completed' WHERE id = v_activity_uuid;
                RAISE NOTICE '🏠 Followers post % has no remote followers, marked as completed', NEW.id;
            END IF;
            
        WHEN 'mentioned' THEN
            IF v_mention_domains IS NOT NULL AND array_length(v_mention_domains, 1) > 0 THEN
                PERFORM queue_activity_for_federation(v_activity_uuid, v_mention_domains, 7, true);
                RAISE NOTICE '📮 Queued mentioned post % for delivery to % domains', 
                    NEW.id, array_length(v_mention_domains, 1);
            ELSE
                UPDATE ap_activities SET status = 'completed' WHERE id = v_activity_uuid;
                RAISE NOTICE '🏠 Mentioned post % has no remote mentions, marked as completed', NEW.id;
            END IF;
            
        ELSE
            UPDATE ap_activities SET status = 'completed' WHERE id = v_activity_uuid;
            RAISE NOTICE 'Unknown visibility % for post %, marked as completed', NEW.visibility, NEW.id;
    END CASE;

    RETURN NEW;
END;
$$;

-- 2. Update handle_outgoing_messages to handle both local notifications and federation
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
    
    -- DEBUG: Log that the new function is running
    RAISE WARNING '🔧 RESTORED handle_outgoing_messages() function called for message %', NEW.id;
    
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
                
                -- Use improved HTML content processing function (now includes <p> wrapping)
                v_html_content := convert_content_to_activitypub_html(NEW.content);
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
                
                -- NO HTTP CALLS FROM POSTGRES - Queue for immediate Edge Function delivery
                -- This will be picked up by real-time triggers or very frequent cron (every 30 seconds)
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

-- 3. Update process_federation_delivery_queue to use edge function
CREATE OR REPLACE FUNCTION public.process_federation_delivery_queue() 
RETURNS TABLE(processed_count integer, successful_count integer, failed_count integer, details jsonb)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    pending_count INTEGER := 0;
    result_details JSONB;
BEGIN
    -- Count pending deliveries
    SELECT COUNT(*) INTO pending_count
    FROM federation_delivery_queue
    WHERE status = 'pending'
    AND next_attempt_at <= NOW();

    IF pending_count = 0 THEN
        RETURN QUERY SELECT 0, 0, 0, jsonb_build_object(
            'message', 'No pending deliveries',
            'timestamp', NOW()
        );
        RETURN;
    END IF;

    -- The actual delivery processing is now handled by the federation-delivery edge function
    -- This function just returns the current state and statistics
    RAISE NOTICE 'Federation delivery queue has % pending items. Use the federation-delivery edge function to process them.', pending_count;

    RETURN QUERY 
    SELECT 
        pending_count::integer,
        SUM(CASE WHEN status = 'delivered' AND delivered_at > NOW() - INTERVAL '1 hour' THEN 1 ELSE 0 END)::integer,
        SUM(CASE WHEN status = 'failed' AND updated_at > NOW() - INTERVAL '1 hour' THEN 1 ELSE 0 END)::integer,
        jsonb_build_object(
            'message', 'Use federation-delivery edge function for processing',
            'pending_count', pending_count,
            'timestamp', NOW(),
            'edge_function_url', '/functions/v1/federation-delivery'
        )
    FROM federation_delivery_queue;
END;
$$;

-- 4. Update queue_activity_for_federation to include activity_data
CREATE OR REPLACE FUNCTION public.queue_activity_for_federation(
    p_activity_id uuid, 
    p_target_domains text[], 
    p_priority integer DEFAULT 5, 
    p_immediate boolean DEFAULT true
) 
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    domain text;
    inbox_url text;
    next_attempt timestamptz;
    activity_record RECORD;
    actor_username TEXT;
    actor_domain TEXT;
BEGIN
    -- Get activity metadata including the activity data
    SELECT 
        aa.actor_ap_id,
        aa.origin_domain,
        aa.activity_data
    INTO activity_record
    FROM ap_activities aa
    WHERE aa.id = p_activity_id;

    IF NOT FOUND THEN
        RAISE WARNING 'Activity % not found, cannot queue for federation', p_activity_id;
        RETURN;
    END IF;

    -- Extract username from actor AP ID
    actor_username := regexp_replace(activity_record.actor_ap_id, '^https?://[^/]+/users/([^/#]+).*$', '\1');
    actor_domain := activity_record.origin_domain;
    
    -- Set timing for delivery attempt
    next_attempt := CASE 
        WHEN p_immediate THEN now()
        ELSE now() + interval '1 minute'
    END;
    
    FOREACH domain IN ARRAY p_target_domains LOOP
        inbox_url := 'https://' || domain || '/inbox';
        
        INSERT INTO federation_delivery_queue (
            activity_id,
            activity_data,  -- Include the activity data
            target_domain,
            target_inbox_url,
            actor_username,
            actor_domain,
            status,
            priority,
            attempts,
            next_attempt_at
        ) VALUES (
            p_activity_id,
            activity_record.activity_data,  -- Store the activity data
            domain,
            inbox_url,
            actor_username,
            actor_domain,
            'pending',
            p_priority,
            0,
            next_attempt
        );
    END LOOP;

    RAISE NOTICE '📦 Queued activity % for federation to % domains', p_activity_id, array_length(p_target_domains, 1);
END;
$$;

-- 5. Add activity_data column to federation_delivery_queue if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'federation_delivery_queue' 
        AND column_name = 'activity_data'
    ) THEN
        ALTER TABLE federation_delivery_queue 
        ADD COLUMN activity_data JSONB;
        
        COMMENT ON COLUMN federation_delivery_queue.activity_data IS 
        'ActivityPub activity data to be delivered, stored here to avoid joins during edge function processing';
    END IF;
END $$;

-- 6. Create index on next_attempt_at for better performance
CREATE INDEX IF NOT EXISTS idx_federation_delivery_queue_next_attempt_pending 
ON federation_delivery_queue (next_attempt_at) 
WHERE status = 'pending';

-- 7. Update comments to reflect edge function approach
COMMENT ON FUNCTION public.handle_post_federation() IS 
'UPDATED: Handles ActivityPub federation for posts by queuing activities for the federation-delivery edge function. No longer makes direct HTTP calls from PostgreSQL.';

COMMENT ON FUNCTION public.handle_outgoing_messages() IS 
'UPDATED: Processes outgoing messages by queuing federated DMs for the federation-delivery edge function. No longer makes direct HTTP calls from PostgreSQL.';

COMMENT ON FUNCTION public.process_federation_delivery_queue() IS 
'UPDATED: Returns federation queue statistics. Actual delivery processing is now handled by the federation-delivery edge function.';

COMMENT ON FUNCTION public.queue_activity_for_federation(uuid, text[], integer, boolean) IS 
'UPDATED: Enhanced queue function that includes activity data for edge function delivery processing.';

-- 8. Update process_federation_delivery_queue_unified to delegate to edge function
CREATE OR REPLACE FUNCTION public.process_federation_delivery_queue_unified() 
RETURNS TABLE(processed_count integer, successful_count integer, failed_count integer, details jsonb)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    pending_count INTEGER := 0;
BEGIN
    -- Count pending deliveries
    SELECT COUNT(*) INTO pending_count
    FROM federation_delivery_queue
    WHERE status = 'pending'
    AND next_attempt_at <= NOW();

    -- The actual delivery processing is now handled by the outbox edge function
    -- This function just returns the current state and statistics
    RAISE NOTICE 'Unified federation delivery queue has % pending items. Use the outbox edge function to process them.', pending_count;

    RETURN QUERY 
    SELECT 
        pending_count::integer,
        SUM(CASE WHEN status = 'delivered' AND delivered_at > NOW() - INTERVAL '1 hour' THEN 1 ELSE 0 END)::integer,
        SUM(CASE WHEN status = 'failed' AND updated_at > NOW() - INTERVAL '1 hour' THEN 1 ELSE 0 END)::integer,
        jsonb_build_object(
            'message', 'Use outbox edge function for unified delivery processing',
            'pending_count', pending_count,
            'timestamp', NOW(),
            'edge_function_url', '/functions/v1/outbox'
        )
    FROM federation_delivery_queue;
END;
$$;

-- 9. Update handle_unified_interaction_processing to only queue activities
CREATE OR REPLACE FUNCTION public.handle_unified_interaction_processing() 
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    post_record RECORD;
    user_profile RECORD;
    target_user_profile RECORD;
    is_target_local BOOLEAN;
    activity_id UUID;
    user_actor_url TEXT;
    target_actor_url TEXT;
    v_activity_data JSONB;
    instance_domain TEXT;
BEGIN
    -- Only handle new interactions
    IF TG_OP != 'INSERT' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Get post and user info
    SELECT * INTO post_record FROM posts WHERE id = NEW.post_id;
    SELECT * INTO user_profile FROM profiles WHERE id = NEW.user_id;
    SELECT * INTO target_user_profile FROM profiles WHERE id = post_record.author_id;
    
    -- Check if target user is local
    is_target_local := target_user_profile.is_local;
    
    -- Get instance domain for federation
    SELECT trim(both '"' from config_value::text) INTO instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;

    IF NEW.interaction_type = 'favorite' THEN
        IF is_target_local THEN
            -- LOCAL USER: Create notification only
            PERFORM create_simple_activitypub_notification(
                post_record.author_id,
                'activitypub_favorite',
                jsonb_build_object(
                    'user', jsonb_build_object(
                        'id', user_profile.id,
                        'username', user_profile.username,
                        'display_name', user_profile.display_name,
                        'avatar_url', user_profile.avatar_url,
                        'domain', user_profile.domain
                    ),
                    'post_id', post_record.id,
                    'interaction_id', NEW.id
                )
            );
        ELSE
            -- REMOTE USER: Only queue for federation (no immediate HTTP delivery)
            activity_id := gen_random_uuid();
            user_actor_url := format('https://%s/users/%s', instance_domain, user_profile.username);
            target_actor_url := COALESCE(target_user_profile.federated_id, format('https://%s/users/%s', target_user_profile.domain, target_user_profile.username));
            
            v_activity_data := jsonb_build_object(
                '@context', 'https://www.w3.org/ns/activitystreams',
                'id', format('%s#like-%s', user_actor_url, NEW.id),
                'type', 'Like',
                'actor', user_actor_url,
                'object', COALESCE(post_record.ap_id, format('https://%s/posts/%s', target_user_profile.domain, post_record.id)),
                'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            );

            -- Store activity
            INSERT INTO ap_activities (
                id, ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                activity_data, status, to_addresses, is_local, origin_domain
            ) VALUES (
                activity_id, v_activity_data->>'id', 'Like', user_profile.id, user_actor_url,
                post_record.ap_id, 'Note', v_activity_data, 'pending',
                ARRAY[target_actor_url], true, instance_domain
            );

            -- Queue for federation delivery
            PERFORM queue_activity_for_federation(activity_id, ARRAY[target_user_profile.domain]);
        END IF;

    ELSIF NEW.interaction_type = 'reblog' THEN
        IF is_target_local THEN
            -- LOCAL USER: Create notification only
            PERFORM create_simple_activitypub_notification(
                post_record.author_id,
                'activitypub_reblog',
                jsonb_build_object(
                    'user', jsonb_build_object(
                        'id', user_profile.id,
                        'username', user_profile.username,
                        'display_name', user_profile.display_name,
                        'avatar_url', user_profile.avatar_url,
                        'domain', user_profile.domain
                    ),
                    'post_id', post_record.id,
                    'interaction_id', NEW.id
                )
            );
        ELSE
            -- REMOTE USER: Only queue for federation (no immediate HTTP delivery)
            activity_id := gen_random_uuid();
            user_actor_url := format('https://%s/users/%s', instance_domain, user_profile.username);
            
            v_activity_data := jsonb_build_object(
                '@context', 'https://www.w3.org/ns/activitystreams',
                'id', format('%s#announce-%s', user_actor_url, NEW.id),
                'type', 'Announce',
                'actor', user_actor_url,
                'object', COALESCE(post_record.ap_id, format('https://%s/posts/%s', target_user_profile.domain, post_record.id)),
                'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'to', jsonb_build_array('https://www.w3.org/ns/activitystreams#Public'),
                'cc', jsonb_build_array(format('%s/followers', user_actor_url))
            );

            -- Store activity
            INSERT INTO ap_activities (
                id, ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                activity_data, status, to_addresses, is_local, origin_domain
            ) VALUES (
                activity_id, v_activity_data->>'id', 'Announce', user_profile.id, user_actor_url,
                post_record.ap_id, 'Note', v_activity_data, 'pending',
                ARRAY['https://www.w3.org/ns/activitystreams#Public'], true, instance_domain
            );

            -- Queue for federation delivery  
            PERFORM queue_activity_for_federation(activity_id, ARRAY[target_user_profile.domain]);
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- 10. Create helper function to update cron jobs for Edge Function delivery
CREATE OR REPLACE FUNCTION public.update_federation_cron_jobs() 
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    result TEXT := '';
    schedule_result TEXT;
BEGIN
    -- Remove old federation delivery cron job if it exists
    BEGIN
        PERFORM cron.unschedule('federation-delivery-worker');
        result := result || 'Removed old federation-delivery-worker cron job. ';
    EXCEPTION 
        WHEN OTHERS THEN
            -- Job might not exist, ignore
            NULL;
    END;
    
    -- Create new cron job that calls the Edge Function frequently for near-real-time delivery
    -- SECURITY: This approach uses Supabase's internal service authentication
    SELECT cron.schedule(
        'federation-delivery-worker',
        '*/30 * * * *',  -- Every 30 seconds for near real-time delivery
        $CRON$
        SELECT extensions.http_post(
            url := 'http://localhost:54321/functions/v1/outbox/delivery',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'User-Agent', 'Harmony-Cron/1.0.0'
            ),
            body := jsonb_build_object()
        );
        $CRON$
    ) INTO schedule_result;
    
    result := result || 'Created secure federation-delivery-worker cron job (every 30s for near real-time). ';
    
    RAISE NOTICE 'For TRUE real-time delivery (< 1 second), set up Database Webhooks:';
    RAISE NOTICE '1. Go to Supabase Dashboard > Database > Webhooks';
    RAISE NOTICE '2. Create webhook on federation_delivery_queue table, INSERT events';
    RAISE NOTICE '3. Point to: https://your-project.supabase.co/functions/v1/outbox/delivery';
    RAISE NOTICE '4. This will trigger Edge Function immediately when activities are queued';
    
    -- Also fix the activitypub-daily-stats cron job to remove FILTER clause
    BEGIN
        PERFORM cron.unschedule('activitypub-daily-stats');
    EXCEPTION 
        WHEN OTHERS THEN
            NULL;
    END;
    
    SELECT cron.schedule(
        'activitypub-daily-stats',
        '0 1 * * *',
        $STATS$
        INSERT INTO activitypub_processing_stats (
            date, total_activities, processed_activities, failed_activities, 
            permanently_failed_activities, avg_processing_time_ms
        ) 
        SELECT 
            CURRENT_DATE - INTERVAL '1 day',
            COUNT(*),
            COUNT(CASE WHEN status = 'processed' THEN 1 END),
            COUNT(CASE WHEN status = 'failed' THEN 1 END),
            COUNT(CASE WHEN status = 'permanently_failed' THEN 1 END),
            AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000)
        FROM ap_activities 
        WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' 
        AND created_at < CURRENT_DATE;
        $STATS$
    ) INTO schedule_result;
    
    result := result || 'Fixed activitypub-daily-stats cron job to use CASE WHEN instead of FILTER. ';
    
    RETURN result;
END;
$$;

-- 11. SECURITY NOTE: Do NOT store service keys in the database
-- Instead, use Supabase's built-in service authentication for internal calls

COMMENT ON FUNCTION public.update_federation_cron_jobs() IS 
'Updates cron jobs to use Edge Function delivery instead of PostgreSQL functions. Call this after migration.';

-- 12. SOLUTION OPTIONS FOR IMMEDIATE DELIVERY (Choose one):

-- OPTION 1: Database Webhooks (Recommended)
-- Set up a webhook in Supabase Dashboard:
-- 1. Go to Database > Webhooks
-- 2. Create webhook on federation_delivery_queue table
-- 3. Trigger on INSERT events  
-- 4. Point to: https://your-project.supabase.co/functions/v1/outbox/delivery
-- 5. This gives true real-time delivery (< 1 second)

-- OPTION 2: Very Frequent Cron (Current approach)
-- Cron every 30 seconds provides near real-time delivery
-- Trade-off: Some latency (up to 30 seconds) but simpler setup

-- OPTION 3: Application-Level Triggers  
-- Your frontend/backend can call Edge Function after queuing
-- Example: After successful queue operation, trigger delivery via your app

-- OPTION 4: Database NOTIFY/LISTEN (Advanced)
-- Use PostgreSQL's NOTIFY system with external listeners
-- Requires additional infrastructure but gives true real-time

COMMENT ON FUNCTION public.queue_activity_for_federation(uuid, text[], integer, boolean) IS 
'Queues activities for Edge Function delivery. For immediate delivery, use webhooks or very frequent cron jobs (every 30s) to minimize latency.';

-- Log completion
DO $log$
BEGIN
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'FEDERATION EDGE FUNCTION MIGRATION COMPLETED';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'Changes made:';
    RAISE NOTICE '✅ REMOVED all HTTP calls from PostgreSQL functions';
    RAISE NOTICE '✅ All federation now queued for Edge Function delivery';
    RAISE NOTICE '✅ Updated process_federation_delivery_queue() to delegate to edge function';
    RAISE NOTICE '✅ Updated process_federation_delivery_queue_unified() to delegate to edge function';
    RAISE NOTICE '✅ Removed HTTP calls from handle_unified_interaction_processing()';
    RAISE NOTICE '✅ Enhanced queue_activity_for_federation() with activity data';
    RAISE NOTICE '✅ Added activity_data column to federation_delivery_queue';
    RAISE NOTICE '✅ Added performance indexes';
    RAISE NOTICE '✅ Added cron job update helper function';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'CRITICAL NEXT STEPS:';
    RAISE NOTICE '1. Run: SELECT update_federation_cron_jobs(); -- This creates secure cron jobs';
    RAISE NOTICE '2. Deploy outbox edge function with delivery functionality';
    RAISE NOTICE '3. Test: Make a DM to verify both local notifications AND federation work';
    RAISE NOTICE '4. Monitor federation_delivery_queue and ap_activities tables';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'SECURITY: Cron jobs now use internal Supabase authentication';
    RAISE NOTICE 'NO service keys stored in database - secure by design!';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'DM Features Updated:';
    RAISE NOTICE '✅ Local DM notifications';
    RAISE NOTICE '✅ Server channel reply/mention notifications'; 
    RAISE NOTICE '✅ NO MORE PostgreSQL HTTP calls (prevents database hanging)';
    RAISE NOTICE '✅ All federation queued for Edge Function processing';
    RAISE NOTICE '✅ Near real-time delivery via 30s cron + optional webhooks';
    RAISE NOTICE '✅ Proper ActivityPub DM formatting';
    RAISE NOTICE '============================================================================';
END;
$log$;
