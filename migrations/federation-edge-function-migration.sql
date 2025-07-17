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
        array_agg(DISTINCT rm.actor_url) FILTER (WHERE rm.actor_url IS NOT NULL),
        array_agg(DISTINCT rm.domain) FILTER (WHERE rm.domain IS NOT NULL AND rm.domain != v_instance_domain)
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
            IF v_mention_domains IS NOT NULL AND array_length(v_mention_domains, 1) > 0 THEN
                PERFORM queue_activity_for_federation(v_activity_uuid, v_mention_domains, 5, true);
                RAISE NOTICE '📮 Queued public/unlisted post % for delivery to % domains', 
                    NEW.id, array_length(v_mention_domains, 1);
            ELSE
                UPDATE ap_activities SET status = 'completed' WHERE id = v_activity_uuid;
                RAISE NOTICE '🏠 Public/unlisted post % has no remote mentions, marked as completed', NEW.id;
            END IF;
            
        WHEN 'followers' THEN
            IF v_mention_domains IS NOT NULL AND array_length(v_mention_domains, 1) > 0 THEN
                PERFORM queue_activity_for_federation(v_activity_uuid, v_mention_domains, 6, true);
                RAISE NOTICE '📮 Queued followers post % for delivery to % domains', 
                    NEW.id, array_length(v_mention_domains, 1);
            ELSE
                UPDATE ap_activities SET status = 'completed' WHERE id = v_activity_uuid;
                RAISE NOTICE '🏠 Followers post % has no remote mentions, marked as completed', NEW.id;
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

-- 2. Update handle_outgoing_messages to only queue activities  
CREATE OR REPLACE FUNCTION public.handle_outgoing_messages() 
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    sender_profile RECORD;
    v_instance_domain TEXT;
    v_recipient_profile RECORD;
    v_activity_uuid UUID;
    v_activity_id TEXT;
    v_activity JSONB;
    v_sender_url TEXT;
    v_message_url TEXT;
    v_conversation_url TEXT;
    v_tags JSONB;
    remote_domains TEXT[] := ARRAY[]::TEXT[];
BEGIN
    -- Only handle new messages
    IF TG_OP != 'INSERT' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Get sender profile
    SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- Only process messages from local users
    IF NOT sender_profile.is_local THEN
        RETURN NEW;
    END IF;

    -- Only federate DM messages from local users
    IF NEW.conversation_id IS NOT NULL THEN
        SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;
        
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
                -- Build URLs
                v_sender_url := 'https://' || v_instance_domain || '/users/' || sender_profile.username;
                v_message_url := 'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT;
                v_conversation_url := 'https://' || v_instance_domain || '/conversations/' || NEW.conversation_id::TEXT;
                v_activity_id := v_sender_url || '#create-' || NEW.id::TEXT;

                -- Generate ActivityPub mention tags for the recipient
                v_tags := public.generate_activitypub_mention_tags(
                    NEW.content, 
                    ARRAY[v_recipient_profile.federated_id], 
                    v_instance_domain
                );

                -- Create ActivityPub Create activity for DM
                v_activity := jsonb_build_object(
                    '@context', 'https://www.w3.org/ns/activitystreams',
                    'id', v_activity_id,
                    'type', 'Create',
                    'actor', v_sender_url,
                    'object', jsonb_build_object(
                        'id', v_message_url,
                        'type', 'Note',
                        'attributedTo', v_sender_url,
                        'content', public.convert_unified_content_to_activitypub_html(NEW.content),
                        'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                        'to', jsonb_build_array(v_recipient_profile.federated_id),
                        'tag', v_tags,
                        'conversation', v_conversation_url,
                        'directMessage', true
                    ),
                    'to', jsonb_build_array(v_recipient_profile.federated_id),
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                );

                -- Store the ActivityPub activity
                INSERT INTO ap_activities (
                    ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                    activity_data, status, to_addresses, is_local, origin_domain
                ) VALUES (
                    v_activity_id, 'Create', NEW.user_id, v_sender_url, v_message_url, 'Note',
                    v_activity, 'pending', ARRAY[v_recipient_profile.federated_id], true, v_instance_domain
                ) RETURNING id INTO v_activity_uuid;

                -- Add to remote domains for queuing
                remote_domains := array_append(remote_domains, v_recipient_profile.domain);

                RAISE NOTICE '📩 Prepared DM federation: %@% -> %@%', 
                    sender_profile.username, v_instance_domain,
                    v_recipient_profile.username, v_recipient_profile.domain;
            END LOOP;

            -- Queue all remote domains for delivery
            IF array_length(remote_domains, 1) > 0 THEN
                PERFORM queue_activity_for_federation(v_activity_uuid, remote_domains, 8, true);
                RAISE NOTICE '📮 Queued DM for delivery to % domains', array_length(remote_domains, 1);
            END IF;
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

-- Log completion
DO $log$
BEGIN
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'FEDERATION EDGE FUNCTION MIGRATION COMPLETED';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'Changes made:';
    RAISE NOTICE '✅ Removed HTTP calls from handle_post_federation()';
    RAISE NOTICE '✅ Removed HTTP calls from handle_outgoing_messages()';
    RAISE NOTICE '✅ Updated process_federation_delivery_queue() to delegate to edge function';
    RAISE NOTICE '✅ Updated process_federation_delivery_queue_unified() to delegate to edge function';
    RAISE NOTICE '✅ Removed HTTP calls from handle_unified_interaction_processing()';
    RAISE NOTICE '✅ Enhanced queue_activity_for_federation() with activity data';
    RAISE NOTICE '✅ Added activity_data column to federation_delivery_queue';
    RAISE NOTICE '✅ Added performance indexes';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'Next steps:';
    RAISE NOTICE '1. Deploy outbox edge function with delivery functionality';
    RAISE NOTICE '2. Set up cron job to call POST /functions/v1/outbox every 1-2 minutes';
    RAISE NOTICE '3. Monitor federation metrics in federation_delivery_stats table';
    RAISE NOTICE '4. Remove old federation-delivery function if it exists';
    RAISE NOTICE '============================================================================';
END;
$log$;
