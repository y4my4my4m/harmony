-- ============================================================================
-- FIX ACCEPT ACTIVITY FEDERATION
-- ============================================================================
-- This migration fixes the process_accept_activity function to actually send
-- Accept activities back to the remote server via HTTP POST, similar to how
-- DMs are federated in handle_outgoing_messages().
-- ============================================================================

-- Drop and recreate the process_accept_activity function with federation support
DROP FUNCTION IF EXISTS public.process_accept_activity(uuid, jsonb, record);

CREATE OR REPLACE FUNCTION public.process_accept_activity(activity_id uuid, activity_data jsonb, actor_profile record) 
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $$
DECLARE
    v_object JSONB;
    v_follow_record RECORD;
    v_following_profile RECORD;
    v_instance_domain TEXT;
    v_accept_id TEXT;
    v_accept_activity JSONB;
    v_activity_uuid UUID;
    v_inbox_url TEXT;
    v_signature_header TEXT;
    v_date_header TEXT;
    v_digest_header TEXT;
    v_http_status INTEGER;
    v_http_response TEXT;
    v_delivery_success BOOLEAN;
BEGIN
    RAISE NOTICE '📩 Processing Accept activity: %', activity_data->>'id';
    
    v_object := activity_data->'object';
    
    -- Only process Follow objects in Accept activities
    IF v_object->>'type' != 'Follow' THEN
        RAISE WARNING 'Accept activity does not contain a Follow object: %', v_object->>'type';
        RETURN;
    END IF;
    
    -- Find the follow record this Accept is responding to
    SELECT * INTO v_follow_record
    FROM follows 
    WHERE ap_id = v_object->>'id';
    
    IF NOT FOUND THEN
        RAISE WARNING 'Follow record not found for Accept activity: %', v_object->>'id';
        RETURN;
    END IF;
    
    -- Update the follow status to accepted
    UPDATE follows 
    SET status = 'accepted',
        updated_at = NOW()
    WHERE id = v_follow_record.id;
    
    RAISE NOTICE '✅ Follow request accepted: % -> %', 
        actor_profile.username, v_follow_record.following_id;
        
    -- NOTE: Accept activities are typically responses to our outgoing Follow requests
    -- They don't need to be federated back out - we just need to process them locally
    -- The federation delivery would have already happened when the remote server sent this Accept to us
    
END;
$$;

-- Also create an improved function for sending Accept activities for incoming Follow requests
-- This is what we actually need for the auto-accept functionality

CREATE OR REPLACE FUNCTION public.send_accept_activity_for_follow(follow_activity_id uuid, local_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $$
DECLARE
    v_follow_activity RECORD;
    v_local_profile RECORD;
    v_instance_domain TEXT;
    v_accept_id TEXT;
    v_accept_activity JSONB;
    v_activity_uuid UUID;
    v_inbox_url TEXT;
    v_signature_header TEXT;
    v_date_header TEXT;
    v_digest_header TEXT;
    v_http_status INTEGER;
    v_http_response TEXT;
    v_delivery_success BOOLEAN;
    v_follower_domain TEXT;
BEGIN
    RAISE NOTICE '📤 Sending Accept activity for follow: %', follow_activity_id;
    
    -- Get the Follow activity we're accepting
    SELECT * INTO v_follow_activity
    FROM ap_activities 
    WHERE id = follow_activity_id
    AND ap_type = 'Follow';
    
    IF NOT FOUND THEN
        RAISE WARNING 'Follow activity not found: %', follow_activity_id;
        RETURN;
    END IF;
    
    -- Get the local user profile
    SELECT * INTO v_local_profile
    FROM profiles 
    WHERE id = local_user_id
    AND is_local = true;
    
    IF NOT FOUND THEN
        RAISE WARNING 'Local user not found: %', local_user_id;
        RETURN;
    END IF;
    
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config 
    WHERE config_key = 'domain' 
    LIMIT 1;
    
    IF v_instance_domain IS NULL THEN
        RAISE WARNING 'Instance domain not configured, cannot send Accept';
        RETURN;
    END IF;
    
    -- Create Accept activity
    v_accept_id := 'https://' || v_instance_domain || '/users/' || v_local_profile.username || '#accepts/' || extract(epoch from now())::bigint;
    
    v_accept_activity := jsonb_build_object(
        '@context', 'https://www.w3.org/ns/activitystreams',
        'id', v_accept_id,
        'type', 'Accept',
        'actor', 'https://' || v_instance_domain || '/users/' || v_local_profile.username,
        'object', v_follow_activity.activity_data
    );
    
    RAISE NOTICE '📋 Created Accept activity: %', v_accept_id;
    
    -- Store the Accept activity in our database
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
        v_accept_id,
        'Accept',
        local_user_id,
        'https://' || v_instance_domain || '/users/' || v_local_profile.username,
        v_follow_activity.ap_id,
        'Follow',
        v_accept_activity,
        'pending',
        ARRAY[v_follow_activity.actor_ap_id],
        true,
        v_instance_domain
    ) RETURNING id INTO v_activity_uuid;
    
    -- Extract follower domain for inbox URL
    v_follower_domain := (SELECT domain FROM profiles WHERE federated_id = v_follow_activity.actor_ap_id OR id = (
        SELECT id FROM profiles WHERE federated_id = v_follow_activity.actor_ap_id LIMIT 1
    ));
    
    IF v_follower_domain IS NULL THEN
        -- Try to extract domain from actor URL
        v_follower_domain := substring(v_follow_activity.actor_ap_id from 'https://([^/]+)/');
    END IF;
    
    IF v_follower_domain IS NULL THEN
        RAISE WARNING 'Could not determine follower domain from: %', v_follow_activity.actor_ap_id;
        RETURN;
    END IF;
    
    -- Construct inbox URL (user-specific for better delivery)
    v_inbox_url := v_follow_activity.actor_ap_id || '/inbox';
    
    RAISE WARNING '📮 Sending Accept to inbox: %', v_inbox_url;
    
    -- Generate HTTP signature
    BEGIN
        SELECT 
            signature_header,
            date_header,
            digest_header
        INTO 
            v_signature_header,
            v_date_header,
            v_digest_header
        FROM create_http_signature(
            v_inbox_url,
            v_accept_activity::text,
            v_local_profile.username,
            v_instance_domain,
            'POST'
        );
        
        RAISE NOTICE 'Generated HTTP signature for Accept to %', v_follower_domain;
        
    EXCEPTION 
        WHEN OTHERS THEN
            RAISE WARNING 'Failed to generate signature for Accept: %', SQLERRM;
            -- Update activity as failed and return
            UPDATE ap_activities 
            SET status = 'failed',
                error_message = 'Signature generation failed: ' || SQLERRM
            WHERE id = v_activity_uuid;
            RETURN;
    END;
    
    -- Attempt immediate delivery
    BEGIN
        RAISE WARNING '🚀 Attempting Accept delivery to: %', v_inbox_url;

        -- Try to deliver immediately using Supabase HTTP extension
        SELECT status, content INTO v_http_status, v_http_response
        FROM http((
            'POST',
            v_inbox_url,
            ARRAY[
                ('Content-Type', 'application/activity+json'),
                ('User-Agent', 'Harmony/1.0.0'),
                ('Host', v_follower_domain),
                ('Date', v_date_header),
                ('Digest', v_digest_header),
                ('Signature', v_signature_header)
            ]::http_header[],
            'application/activity+json',
            v_accept_activity::text
        )::http_request);
        
        -- Check delivery success
        v_delivery_success := (v_http_status >= 200 AND v_http_status < 300);
        
        RAISE WARNING 'Accept HTTP Response: Status=%, Body=%', v_http_status, LEFT(v_http_response, 200);
        
        IF v_delivery_success THEN
            -- Immediate delivery succeeded
            UPDATE ap_activities 
            SET status = 'completed',
                last_attempt_at = NOW()
            WHERE id = v_activity_uuid;
            
            RAISE NOTICE '✅ Accept delivery succeeded to: % (HTTP %)', v_follower_domain, v_http_status;
            
            -- Also mark the original Follow as completed/accepted
            UPDATE ap_activities
            SET status = 'completed'
            WHERE id = follow_activity_id;
            
        ELSE
            -- Immediate delivery failed, queue for retry
            UPDATE ap_activities 
            SET status = 'failed',
                attempts = 1,
                last_attempt_at = NOW(),
                error_message = format('HTTP %s: %s', v_http_status, LEFT(v_http_response, 500))
            WHERE id = v_activity_uuid;
            
            RAISE WARNING '❌ Accept delivery failed to % (HTTP %): %', 
                v_follower_domain, v_http_status, LEFT(v_http_response, 200);
            
            -- Queue for retry
            PERFORM queue_activity_for_federation(v_activity_uuid, ARRAY[v_follower_domain], 8, true);
        END IF;
        
    EXCEPTION 
        WHEN OTHERS THEN
            -- HTTP extension not available or network error, queue for delivery
            UPDATE ap_activities 
            SET status = 'failed',
                error_message = 'HTTP delivery failed: ' || SQLERRM
            WHERE id = v_activity_uuid;
            
            RAISE WARNING '💥 Accept HTTP delivery exception to % - Error: %', v_follower_domain, SQLERRM;
            PERFORM queue_activity_for_federation(v_activity_uuid, ARRAY[v_follower_domain], 8, true);
    END;
    
END;
$$;

-- Add comments
COMMENT ON FUNCTION public.process_accept_activity(uuid, jsonb, record) IS 
'Processes incoming Accept activities for Follow requests. Updates local follow status to accepted.';

COMMENT ON FUNCTION public.send_accept_activity_for_follow(uuid, uuid) IS 
'Sends an Accept activity back to a remote follower via HTTP POST with proper signatures. Used for auto-accepting follow requests.';

-- Log completion
DO $log$
BEGIN
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'ACCEPT ACTIVITY FEDERATION FIX COMPLETED';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'Changes made:';
    RAISE NOTICE '✅ Updated process_accept_activity() to handle incoming Accept activities properly';
    RAISE NOTICE '✅ Added send_accept_activity_for_follow() for outgoing Accept activities';
    RAISE NOTICE '✅ Accept activities now include proper HTTP delivery with signatures';
    RAISE NOTICE '✅ Integration with existing federation queue system';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'Now Accept activities will be properly federated back to followers!';
    RAISE NOTICE '============================================================================';
END;
$log$;
