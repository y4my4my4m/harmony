-- Unified ActivityPub Processing - Part 2
-- Direct message processing, public post processing, retry system, and final setup
-- Run this after part 1

-- =====================================================
-- DIRECT MESSAGE AND POST PROCESSORS
-- =====================================================

-- Process direct messages using existing unified content processing
CREATE OR REPLACE FUNCTION process_activitypub_direct_message(
    activity_id UUID, activity_data JSONB, actor_profile RECORD, instance_domain TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_object JSONB;
    v_content JSONB;
    v_mentioned_users TEXT[];
    v_mentioned_user_id UUID;
    v_conversation_id UUID;
    v_message_id UUID;
    v_username TEXT;
    v_local_user RECORD;
BEGIN
    v_object := activity_data->'object';
    
    -- Extract mentioned local users from tags
    SELECT ARRAY_AGG(username) INTO v_mentioned_users
    FROM (
        SELECT DISTINCT substring(tag->>'href' from 'https://' || instance_domain || '/users/([^/]+)')::text as username
        FROM jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) as tag
        WHERE tag->>'type' = 'Mention' 
          AND tag->>'href' LIKE 'https://' || instance_domain || '/users/%'
    ) t 
    WHERE username IS NOT NULL;

    -- Also check direct addressing
    IF v_mentioned_users IS NULL OR array_length(v_mentioned_users, 1) = 0 THEN
        SELECT ARRAY_AGG(username) INTO v_mentioned_users
        FROM (
            SELECT DISTINCT substring(addr from 'https://' || instance_domain || '/users/([^/]+)')::text as username
            FROM (
                SELECT jsonb_array_elements_text(COALESCE(v_object->'to', '[]'::jsonb)) as addr
                UNION 
                SELECT jsonb_array_elements_text(COALESCE(v_object->'cc', '[]'::jsonb)) as addr
            ) addresses
            WHERE addr LIKE 'https://' || instance_domain || '/users/%'
        ) t 
        WHERE username IS NOT NULL;
    END IF;
    
    -- Convert ActivityPub HTML content to our JSONB format
    v_content := parse_activitypub_content_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- Process each mentioned local user
    IF v_mentioned_users IS NOT NULL THEN
        FOREACH v_username IN ARRAY v_mentioned_users LOOP
            -- Get local user
            SELECT * INTO v_local_user
            FROM profiles 
            WHERE username = v_username 
              AND domain = instance_domain 
              AND is_local = true;
            
            IF FOUND THEN
                -- Find or create conversation between sender and recipient
                SELECT id INTO v_conversation_id
                FROM conversations 
                WHERE (user1 = actor_profile.id AND user2 = v_local_user.id)
                   OR (user1 = v_local_user.id AND user2 = actor_profile.id);
            
                IF NOT FOUND THEN
                    -- Create new conversation
                    INSERT INTO conversations (user1, user2, created_at, updated_at)
                    VALUES (actor_profile.id, v_local_user.id, NOW(), NOW())
                    RETURNING id INTO v_conversation_id;
                END IF;
            
                -- Insert the DM message
                INSERT INTO messages (
                    conversation_id,
                    user_id,
                    content,
                    created_at,
                    metadata
                ) VALUES (
                    v_conversation_id,
                    actor_profile.id,
                    v_content,
                    COALESCE((v_object->>'published')::timestamptz, NOW()),
                    jsonb_build_object(
                        'federated', true,
                        'ap_id', v_object->>'id',
                        'ap_type', 'Note',
                        'from_domain', actor_profile.domain,
                        'original_url', COALESCE(v_object->>'url', v_object->>'id')
                    )
                ) RETURNING id INTO v_message_id;
            
                RAISE NOTICE '📩 Stored federated DM from %@% to %', 
                    actor_profile.username, actor_profile.domain, v_username;
            
                -- Note: DM notifications are handled by existing message triggers
            END IF;
        END LOOP;
    END IF;
END;
$$;

-- Process public posts using unified content processing  
CREATE OR REPLACE FUNCTION process_activitypub_public_post(
    activity_id UUID, activity_data JSONB, actor_profile RECORD, instance_domain TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_object JSONB;
    v_content JSONB;
    v_post_id UUID;
    v_visibility TEXT := 'public';
    v_in_reply_to TEXT;
    v_parent_post_id UUID;
    v_mentioned_users TEXT[];
    v_local_user_id UUID;
    v_username TEXT;
BEGIN
    v_object := activity_data->'object';
    
    -- Convert ActivityPub HTML content to our JSONB format
    v_content := parse_activitypub_content_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- Determine visibility
    IF v_object ? 'to' THEN
        IF jsonb_array_length(COALESCE(v_object->'to', '[]'::jsonb)) = 0 
           OR (v_object->'to' @> '"https://www.w3.org/ns/activitystreams#Public"'::jsonb) THEN
            v_visibility := 'public';
        ELSE
            v_visibility := 'unlisted';
        END IF;
    END IF;
    
    -- Handle replies
    v_in_reply_to := v_object->>'inReplyTo';
    IF v_in_reply_to IS NOT NULL THEN
        SELECT id INTO v_parent_post_id
        FROM posts 
        WHERE ap_id = v_in_reply_to;
    END IF;
    
    -- Create the post
    INSERT INTO posts (
        author_id,
        content,
        visibility,
        in_reply_to,
        is_local,
        is_federated,
        ap_id,
        ap_type,
        content_warning,
        is_sensitive,
        url,
        created_at,
        metadata
    ) VALUES (
        actor_profile.id,
        v_content,
        v_visibility,
        v_parent_post_id,
        false,
        true,
        v_object->>'id',
        'Note',
        v_object->>'summary',
        COALESCE((v_object->>'sensitive')::boolean, false),
        COALESCE(v_object->>'url', v_object->>'id'),
        COALESCE((v_object->>'published')::timestamptz, NOW()),
        jsonb_build_object(
            'federated', true,
            'from_domain', actor_profile.domain,
            'original_activity', activity_data->>'id'
        )
    ) RETURNING id INTO v_post_id;
    
    RAISE NOTICE '📢 Stored federated post from %@%: %', 
        actor_profile.username, actor_profile.domain, v_object->>'id';
    
    -- Handle mentions - create notifications for local users
    SELECT ARRAY_AGG(username) INTO v_mentioned_users
    FROM (
        SELECT DISTINCT substring(tag->>'href' from 'https://' || instance_domain || '/users/([^/]+)')::text as username
        FROM jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) as tag
        WHERE tag->>'type' = 'Mention' 
          AND tag->>'href' LIKE 'https://' || instance_domain || '/users/%'
    ) t 
    WHERE username IS NOT NULL;
    
    IF v_mentioned_users IS NOT NULL THEN
        FOREACH v_username IN ARRAY v_mentioned_users LOOP
            SELECT id INTO v_local_user_id
            FROM profiles 
            WHERE username = v_username 
              AND domain = instance_domain 
              AND is_local = true;
            
            IF FOUND THEN
                -- Create mention notification
                PERFORM create_simple_activitypub_notification(
                    v_local_user_id,
                    'activitypub_mention',
                    jsonb_build_object(
                        'author', jsonb_build_object(
                            'id', actor_profile.id,
                            'username', actor_profile.username,
                            'display_name', actor_profile.display_name,
                            'avatar_url', actor_profile.avatar_url,
                            'domain', actor_profile.domain
                        ),
                        'post', jsonb_build_object(
                            'id', v_post_id,
                            'content', v_content,
                            'ap_id', v_object->>'id'
                        )
                    )
                );
                
                RAISE NOTICE '📬 Created mention notification for %', v_username;
            END IF;
        END LOOP;
    END IF;
    
    -- Note: Other notifications (replies, etc.) are handled by existing post triggers
END;
$$;

-- =====================================================
-- ACTIVITY RETRY PROCESSOR
-- =====================================================

CREATE OR REPLACE FUNCTION process_failed_activities_retry()
RETURNS TABLE(
    processed_count INTEGER,
    retried_count INTEGER,
    abandoned_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_processed_count INTEGER := 0;
    v_retried_count INTEGER := 0;
    v_abandoned_count INTEGER := 0;
    activity_record RECORD;
BEGIN
    RAISE NOTICE '🔄 Starting failed activity retry processor...';

    -- Process activities ready for retry
    FOR activity_record IN 
        SELECT id, ap_id, ap_type, attempts, error_message
        FROM ap_activities 
        WHERE status = 'pending' 
        AND next_attempt_at IS NOT NULL 
        AND next_attempt_at <= NOW()
        AND attempts > 0
        ORDER BY next_attempt_at ASC
        LIMIT 100 -- Process in batches
    LOOP
        v_processed_count := v_processed_count + 1;
        
        -- Update status to trigger processing
        UPDATE ap_activities 
        SET status = 'processing',
            updated_at = NOW()
        WHERE id = activity_record.id;
        
        v_retried_count := v_retried_count + 1;
        
        RAISE NOTICE '🔄 Retrying activity: % (attempt %)', 
            activity_record.ap_id, activity_record.attempts;
    END LOOP;

    -- Check for activities that have been stuck in pending too long (> 24 hours)
    -- and abandon them to prevent queue buildup
    UPDATE ap_activities 
    SET status = 'failed',
        error_message = COALESCE(error_message, '') || ' - Abandoned after 24 hours in retry queue',
        processed_at = NOW()
    WHERE status = 'pending'
    AND attempts > 0
    AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - interval '24 hours');
    
    GET DIAGNOSTICS v_abandoned_count = ROW_COUNT;
    
    IF v_abandoned_count > 0 THEN
        RAISE NOTICE '🗑️ Abandoned % activities stuck in retry queue for >24 hours', v_abandoned_count;
    END IF;

    RAISE NOTICE '✅ Retry processor completed: processed=%s, retried=%s, abandoned=%s', 
        v_processed_count, v_retried_count, v_abandoned_count;

    RETURN QUERY SELECT v_processed_count, v_retried_count, v_abandoned_count;
END;
$$;

-- =====================================================
-- CREATE THE TRIGGER
-- =====================================================

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS unified_activitypub_processing_trigger ON ap_activities;

-- Create the unified trigger
CREATE TRIGGER unified_activitypub_processing_trigger
    AFTER UPDATE ON ap_activities
    FOR EACH ROW
    EXECUTE FUNCTION handle_activitypub_activity_processing();

-- =====================================================
-- DOCUMENTATION
-- =====================================================

COMMENT ON FUNCTION handle_activitypub_activity_processing() IS 
'Unified ActivityPub activity processor. Handles all activity types with proper separation of concerns. Triggered when activities are marked as processing by the inbox.';

COMMENT ON TRIGGER unified_activitypub_processing_trigger ON ap_activities IS 
'Processes ActivityPub activities ready for processing. Replaces business logic that was previously in the inbox for better performance and maintainability.';

COMMENT ON FUNCTION process_failed_activities_retry() IS 
'Processes failed ActivityPub activities ready for retry. Should be called periodically (e.g., every 5 minutes) to handle retry queue.';

-- =====================================================
-- GRANTS AND PERMISSIONS
-- =====================================================

-- Grant permissions to all functions
GRANT EXECUTE ON FUNCTION handle_activitypub_activity_processing() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_follow_activity(UUID, JSONB, RECORD, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_create_activity(UUID, JSONB, RECORD, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_accept_activity(UUID, JSONB, RECORD) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_reject_activity(UUID, JSONB, RECORD) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_undo_activity(UUID, JSONB, RECORD) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_update_activity(UUID, JSONB, RECORD) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_delete_activity(UUID, JSONB, RECORD) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_like_activity(UUID, JSONB, RECORD) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_announce_activity(UUID, JSONB, RECORD) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_activitypub_direct_message(UUID, JSONB, RECORD, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_activitypub_public_post(UUID, JSONB, RECORD, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION is_activitypub_direct_message(JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION parse_activitypub_content_to_jsonb(TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_failed_activities_retry() TO authenticated, service_role;

-- =====================================================
-- LOGGING AND MONITORING SETUP
-- =====================================================

-- Create a table for logging processing events
CREATE TABLE IF NOT EXISTS activity_processing_logs (
    id SERIAL PRIMARY KEY,
    activity_id UUID NOT NULL,
    ap_id TEXT NOT NULL,
    ap_type TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Create an index on activity_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_activity_processing_logs_activity_id ON activity_processing_logs(activity_id);

-- Create a function to log activity processing events
CREATE OR REPLACE FUNCTION log_activity_processing_event(
    p_activity_id UUID,
    p_ap_id TEXT,
    p_ap_type TEXT,
    p_status TEXT,
    p_error_message TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO activity_processing_logs (activity_id, ap_id, ap_type, status, error_message, created_at, updated_at)
    VALUES (p_activity_id, p_ap_id, p_ap_type, p_status, p_error_message, NOW(), NOW())
    ON CONFLICT (activity_id) DO UPDATE 
    SET status = EXCLUDED.status,
        attempts = activity_processing_logs.attempts + 1,
        error_message = EXCLUDED.error_message,
        updated_at = NOW(),
        processed_at = CASE WHEN EXCLUDED.status = 'processed' THEN NOW() ELSE activity_processing_logs.processed_at END;
END;
$$;

-- Grant permissions to the logging function
GRANT EXECUTE ON FUNCTION log_activity_processing_event(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- =====================================================
-- COMPLETION AND USAGE INSTRUCTIONS
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '🎯 UNIFIED ACTIVITYPUB PROCESSING SYSTEM WITH RETRY LOGIC DEPLOYED';
    RAISE NOTICE '📝 Activities flow: received → processing → processed (or failed with retry)';
    RAISE NOTICE '🔄 Failed activities automatically retry with exponential backoff (5min, 20min, 60min)';
    RAISE NOTICE '⚡ Professional separation: Inbox validates, triggers process';
    RAISE NOTICE '🛡️ Robust error handling: transient failures retry, permanent failures logged';
    RAISE NOTICE '📊 Setup cron job: SELECT process_failed_activities_retry(); every 5 minutes';
    RAISE NOTICE '🔍 Monitor: SELECT status, count(*) FROM ap_activities GROUP BY status;';
    RAISE NOTICE '';
    RAISE NOTICE '📋 DEPLOYMENT COMPLETE:';
    RAISE NOTICE '  1. ✅ Main trigger and activity processors';
    RAISE NOTICE '  2. ✅ Retry system with exponential backoff';
    RAISE NOTICE '  3. ✅ DM and public post processing';
    RAISE NOTICE '  4. ✅ Error handling and logging';
    RAISE NOTICE '  5. ✅ Proper permissions and documentation';
    RAISE NOTICE '';
    RAISE NOTICE '🚀 NEXT STEPS:';
    RAISE NOTICE '  • Deploy both migration files in order (part1, then part2)';
    RAISE NOTICE '  • Setup cron job for retry processor';
    RAISE NOTICE '  • Test with incoming ActivityPub activities';
    RAISE NOTICE '  • Monitor activity_processing_logs table';
    RAISE NOTICE '  • Remove legacy triggers/functions once verified';
END $$;
