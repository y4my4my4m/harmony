-- Unified ActivityPub Processing: Replace simple notification triggers with unified federation/notification handling  
-- This replaces handle_simple_interaction_notifications and handle_simple_post_notifications
-- with unified functions that determine local vs remote users and handle accordingly.
-- 
-- NOTE: Post creation federation is handled by the existing handle_post_federation() trigger
-- which is comprehensive and should be preserved. This only unifies interaction processing.

-- =====================================================
-- UNIFIED POST INTERACTION PROCESSING  
-- =====================================================

-- Drop existing simple triggers and create unified ones
DROP TRIGGER IF EXISTS simple_activitypub_interaction_notifications ON post_interactions;
DROP TRIGGER IF EXISTS simple_activitypub_post_notifications ON posts;

-- =====================================================
-- UNIFIED POST INTERACTION HANDLER
-- =====================================================

CREATE OR REPLACE FUNCTION handle_unified_interaction_processing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public, pg_temp
AS $$
DECLARE
    post_record RECORD;
    user_profile RECORD;
    target_user_profile RECORD;
    is_target_local BOOLEAN;
    activity_id UUID;
    activity_data JSONB;
    instance_domain TEXT;
    user_actor_url TEXT;
    post_ap_id TEXT;
    target_inbox_url TEXT;
    
    -- HTTP signature variables
    v_signature_header TEXT;
    v_date_header TEXT;
    v_digest_header TEXT;
    v_headers_to_sign TEXT[];
    v_http_status INTEGER;
    v_http_response TEXT;
    v_delivery_success BOOLEAN := false;
BEGIN
    -- Only handle new interactions
    IF TG_OP != 'INSERT' THEN
        RETURN NEW;
    END IF;

    -- Get post info
    SELECT p.id, p.author_id, p.content, p.ap_id, p.visibility
    INTO post_record
    FROM posts p
    WHERE p.id = NEW.post_id;

    -- Get interacting user profile
    SELECT id, username, display_name, avatar_url, domain, is_local, federated_id, inbox_url
    INTO user_profile
    FROM profiles 
    WHERE id = NEW.user_id;

    -- Get target user (post author) profile
    SELECT id, username, display_name, avatar_url, domain, is_local, federated_id, inbox_url
    INTO target_user_profile
    FROM profiles 
    WHERE id = post_record.author_id;

    -- Skip if post doesn't exist, user doesn't exist, or self-interaction
    IF NOT FOUND OR post_record.author_id = NEW.user_id THEN
        RETURN NEW;
    END IF;

    -- Use the is_local column from profiles table (much more efficient)
    is_target_local := target_user_profile.is_local;
    
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO instance_domain 
    FROM instance_config 
    WHERE config_key = 'domain' 
    LIMIT 1;
    
    IF instance_domain IS NULL THEN
        instance_domain := 'har.mony.lol';
    END IF;

    -- Handle based on interaction type
    IF NEW.interaction_type = 'favorite' THEN
        IF is_target_local THEN
            -- LOCAL USER: Create notification
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
            -- REMOTE USER: Federation (Like activity)
            activity_id := gen_random_uuid();
            user_actor_url := format('https://%s/users/%s', instance_domain, user_profile.username);
            
            activity_data := jsonb_build_object(
                '@context', 'https://www.w3.org/ns/activitystreams',
                'id', format('https://%s/activities/%s', instance_domain, activity_id),
                'type', 'Like',
                'actor', user_actor_url,
                'object', post_record.ap_id,
                'published', now()
            );

            -- Store activity
            INSERT INTO ap_activities (
                ap_id,
                ap_type,
                actor_id,
                actor_ap_id,
                object_id,
                object_type,
                activity_data,
                status,
                is_local,
                origin_domain
            ) VALUES (
                activity_data->>'id',
                'Like',
                NEW.user_id,
                user_actor_url,
                post_record.ap_id,
                'Note',
                activity_data,
                'pending',
                true,
                instance_domain
            );
            
            -- Attempt immediate delivery
            target_inbox_url := COALESCE(target_user_profile.inbox_url, format('https://%s/inbox', target_user_profile.domain));
            
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
                    target_inbox_url,
                    activity_data::text,
                    user_profile.username,
                    instance_domain,
                    'POST'
                );
                
                -- Attempt delivery
                SELECT status, content INTO v_http_status, v_http_response
                FROM http((
                    'POST',
                    target_inbox_url,
                    ARRAY[
                        ('Content-Type', 'application/activity+json'),
                        ('User-Agent', 'Harmony/1.0.0'),
                        ('Host', target_user_profile.domain),
                        ('Date', v_date_header),
                        ('Digest', v_digest_header),
                        ('Signature', v_signature_header)
                    ]::http_header[],
                    'application/activity+json',
                    activity_data::text
                )::http_request);
                
                v_delivery_success := (v_http_status >= 200 AND v_http_status < 300);
                
                IF v_delivery_success THEN
                    UPDATE ap_activities 
                    SET status = 'completed', last_attempt_at = NOW()
                    WHERE ap_id = activity_data->>'id';
                ELSE
                    UPDATE ap_activities 
                    SET status = 'failed', attempts = 1, last_attempt_at = NOW(), 
                        error_message = format('HTTP %s: %s', v_http_status, LEFT(v_http_response, 200))
                    WHERE ap_id = activity_data->>'id';
                    
                    -- Queue for retry
                    PERFORM queue_activity_for_federation(activity_id, ARRAY[target_user_profile.domain]);
                END IF;
                
            EXCEPTION WHEN OTHERS THEN
                UPDATE ap_activities 
                SET status = 'failed', attempts = 1, last_attempt_at = NOW(),
                    error_message = format('Exception: %s', SQLERRM)
                WHERE ap_id = activity_data->>'id';
                
                -- Queue for retry
                PERFORM queue_activity_for_federation(activity_id, ARRAY[target_user_profile.domain]);
            END;
        END IF;

    ELSIF NEW.interaction_type = 'reblog' THEN
        IF is_target_local THEN
            -- LOCAL USER: Create notification
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
            -- REMOTE USER: Federation (Announce activity)  
            activity_id := gen_random_uuid();
            user_actor_url := format('https://%s/users/%s', instance_domain, user_profile.username);
            
            activity_data := jsonb_build_object(
                '@context', 'https://www.w3.org/ns/activitystreams',
                'id', format('https://%s/activities/%s', instance_domain, activity_id),
                'type', 'Announce',
                'actor', user_actor_url,
                'object', post_record.ap_id,
                'published', now()
            );

            -- Store activity
            INSERT INTO ap_activities (
                ap_id,
                ap_type,
                actor_id,
                actor_ap_id,
                object_id,
                object_type,
                activity_data,
                status,
                is_local,
                origin_domain
            ) VALUES (
                activity_data->>'id',
                'Announce',
                NEW.user_id,
                user_actor_url,
                post_record.ap_id,
                'Note',
                activity_data,
                'pending',
                true,
                instance_domain
            );
            
            -- Attempt immediate delivery (same pattern as Like)
            target_inbox_url := COALESCE(target_user_profile.inbox_url, format('https://%s/inbox', target_user_profile.domain));
            
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
                    target_inbox_url,
                    activity_data::text,
                    user_profile.username,
                    instance_domain,
                    'POST'
                );
                
                -- Attempt delivery
                SELECT status, content INTO v_http_status, v_http_response
                FROM http((
                    'POST',
                    target_inbox_url,
                    ARRAY[
                        ('Content-Type', 'application/activity+json'),
                        ('User-Agent', 'Harmony/1.0.0'),
                        ('Host', target_user_profile.domain),
                        ('Date', v_date_header),
                        ('Digest', v_digest_header),
                        ('Signature', v_signature_header)
                    ]::http_header[],
                    'application/activity+json',
                    activity_data::text
                )::http_request);
                
                v_delivery_success := (v_http_status >= 200 AND v_http_status < 300);
                
                IF v_delivery_success THEN
                    UPDATE ap_activities 
                    SET status = 'completed', last_attempt_at = NOW()
                    WHERE ap_id = activity_data->>'id';
                ELSE
                    UPDATE ap_activities 
                    SET status = 'failed', attempts = 1, last_attempt_at = NOW(),
                        error_message = format('HTTP %s: %s', v_http_status, LEFT(v_http_response, 200))
                    WHERE ap_id = activity_data->>'id';
                    
                    -- Queue for retry
                    PERFORM queue_activity_for_federation(activity_id, ARRAY[target_user_profile.domain]);
                END IF;
                
            EXCEPTION WHEN OTHERS THEN
                UPDATE ap_activities 
                SET status = 'failed', attempts = 1, last_attempt_at = NOW(),
                    error_message = format('Exception: %s', SQLERRM)
                WHERE ap_id = activity_data->>'id';
                
                -- Queue for retry
                PERFORM queue_activity_for_federation(activity_id, ARRAY[target_user_profile.domain]);
            END;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- =====================================================
-- UNIFIED POST REPLY PROCESSING  
-- =====================================================
-- Note: Post creation federation is handled by handle_post_federation() trigger
-- This only handles reply notifications for local users vs federation for remote users

CREATE OR REPLACE FUNCTION handle_unified_reply_processing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public, pg_temp
AS $$
DECLARE
    parent_post RECORD;
    author_profile RECORD;
    target_user_profile RECORD;
    is_target_local BOOLEAN;
BEGIN
    -- Only handle new posts that are replies
    -- Post creation federation is already handled by handle_post_federation()
    IF TG_OP != 'INSERT' OR NEW.in_reply_to IS NULL THEN
        RETURN NEW;
    END IF;

    -- Get parent post
    SELECT id, author_id, ap_id
    INTO parent_post
    FROM posts
    WHERE id = NEW.in_reply_to;

    -- Get reply author profile
    SELECT id, username, display_name, avatar_url, domain
    INTO author_profile
    FROM profiles 
    WHERE id = NEW.author_id;

    -- Get target user (parent post author) profile
    SELECT id, username, display_name, avatar_url, domain
    INTO target_user_profile
    FROM profiles 
    WHERE id = parent_post.author_id;

    -- Skip if parent doesn't exist, profiles don't exist, or replying to self
    IF NOT FOUND OR parent_post.author_id = NEW.author_id THEN
        RETURN NEW;
    END IF;

    -- Use the is_local column from profiles table
    is_target_local := target_user_profile.is_local;

    IF is_target_local THEN
        -- LOCAL USER: Create notification
        -- (Federation of the reply itself is handled by handle_post_federation())
        PERFORM create_simple_activitypub_notification(
            parent_post.author_id,
            'activitypub_reply',
            jsonb_build_object(
                'author', jsonb_build_object(
                    'id', author_profile.id,
                    'username', author_profile.username,
                    'display_name', author_profile.display_name,
                    'avatar_url', author_profile.avatar_url,
                    'domain', author_profile.domain
                ),
                'post_id', NEW.id,
                'parent_post_id', parent_post.id
            )
        );
    END IF;
    
    -- Note: Federation is handled by handle_post_federation() trigger
    -- which already handles replies with inReplyTo properly

    RETURN NEW;
END;
$$;

-- =====================================================
-- CREATE UNIFIED TRIGGERS
-- =====================================================

DROP TRIGGER IF EXISTS unified_activitypub_interaction_processing ON post_interactions;
DROP TRIGGER IF EXISTS unified_activitypub_reply_processing ON posts;
-- Create unified triggers to replace the simple notification-only ones
CREATE TRIGGER unified_activitypub_interaction_processing
    AFTER INSERT ON post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION handle_unified_interaction_processing();

CREATE TRIGGER unified_activitypub_reply_processing
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_unified_reply_processing();

-- Grant permissions
GRANT EXECUTE ON FUNCTION handle_unified_interaction_processing() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION handle_unified_reply_processing() TO authenticated, service_role;

-- Log the changes
DO $$
BEGIN
    RAISE NOTICE 'Unified ActivityPub processing installed successfully';
    RAISE NOTICE 'Replaced simple notification triggers with unified federation/notification handling';
    RAISE NOTICE 'Post creation federation continues to use existing handle_post_federation() trigger';
    RAISE NOTICE 'Local users will receive notifications, remote users will receive federation activities';
    RAISE NOTICE 'Interactions (likes/reblogs) now handle both local notifications and remote federation';
END;
$$;
