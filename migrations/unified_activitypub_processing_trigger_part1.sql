-- Unified ActivityPub Activity Processing Trigger
-- This replaces the business logic removed from the inbox
-- Handles all activity types: Follow, Create, Accept, Reject, Undo, Like, Announce, etc.
-- Professional approach: Inbox validates and stores, triggers handle business logic

-- =====================================================
-- UNIFIED ACTIVITYPUB ACTIVITY PROCESSOR
-- =====================================================

CREATE OR REPLACE FUNCTION handle_activitypub_activity_processing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public, pg_temp
AS $$
DECLARE
    v_actor_profile RECORD;
    v_target_profile RECORD;
    v_activity_object JSONB;
    v_object_id TEXT;
    v_instance_domain TEXT;
    v_result JSONB;
BEGIN
    -- Process activities that are:
    -- 1. In 'processing' status (freshly validated by inbox)
    -- 2. In 'pending' status and ready for retry (next_attempt_at <= now)
    -- Skip if already processed
    IF OLD.status = 'processed' THEN
        RETURN NEW;
    END IF;

    IF NOT (
        (NEW.status = 'processing') OR 
        (NEW.status = 'pending' AND NEW.next_attempt_at IS NOT NULL AND NEW.next_attempt_at <= NOW())
    ) THEN
        RETURN NEW;
    END IF;

    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config 
    WHERE config_key = 'domain' 
    LIMIT 1;

    IF v_instance_domain IS NULL THEN
        v_instance_domain := 'har.mony.lol'; -- fallback
    END IF;

    -- Get actor profile by resolving from actor_ap_id
    SELECT * INTO v_actor_profile
    FROM profiles 
    WHERE ap_id = NEW.actor_ap_id 
       OR federated_id = NEW.actor_ap_id;

    IF NOT FOUND THEN
        -- Try to get or create the remote profile
        RAISE NOTICE 'Actor profile not found for %s, attempting to create...', NEW.actor_ap_id;
        
        -- For now, we'll fail the activity if actor profile doesn't exist
        -- In a production system, you might want to fetch the actor and create the profile
        UPDATE ap_activities 
        SET status = 'failed', 
            error_message = 'Actor profile not found: ' || NEW.actor_ap_id,
            processed_at = NOW()
        WHERE id = NEW.id;
        RETURN NEW;
    END IF;

    -- Extract object from activity data
    v_activity_object := NEW.activity_data->'object';
    v_object_id := CASE 
        WHEN jsonb_typeof(v_activity_object) = 'string' THEN v_activity_object::text
        ELSE v_activity_object->>'id'
    END;

    RAISE NOTICE 'Processing % activity % from %', NEW.ap_type, NEW.ap_id, v_actor_profile.username;

    BEGIN
        -- Process based on activity type
        CASE NEW.ap_type
            WHEN 'Follow' THEN
                PERFORM process_follow_activity(NEW.id, NEW.activity_data, v_actor_profile, v_instance_domain);
                
            WHEN 'Accept' THEN
                PERFORM process_accept_activity(NEW.id, NEW.activity_data, v_actor_profile);
                
            WHEN 'Reject' THEN
                PERFORM process_reject_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Undo' THEN
                PERFORM process_undo_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Create' THEN
                PERFORM process_create_activity(NEW.id, NEW.activity_data, v_actor_profile, v_instance_domain);
            
            WHEN 'Update' THEN
                PERFORM process_update_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Delete' THEN
                PERFORM process_delete_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Like' THEN
                PERFORM process_like_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Announce' THEN
                PERFORM process_announce_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            ELSE
                RAISE NOTICE 'Unhandled activity type: %', NEW.ap_type;
        END CASE;

        -- Mark as processed
        UPDATE ap_activities 
        SET status = 'processed', processed_at = NOW()
        WHERE id = NEW.id;

        RAISE NOTICE '✅ Successfully processed % activity: %', NEW.ap_type, NEW.ap_id;

    EXCEPTION WHEN OTHERS THEN
        -- Implement retry logic for processing failures
        DECLARE
            v_max_attempts INTEGER := 3;
            v_retry_delay INTERVAL;
        BEGIN
            -- Calculate exponential backoff: 5 min, 20 min, 60 min
            v_retry_delay := CASE 
                WHEN NEW.attempts < 1 THEN interval '5 minutes'
                WHEN NEW.attempts < 2 THEN interval '20 minutes'
                ELSE interval '60 minutes'
            END;

            -- Check if we should retry
            IF NEW.attempts < v_max_attempts THEN
                -- Schedule for retry
                UPDATE ap_activities 
                SET status = 'pending',
                    attempts = NEW.attempts + 1,
                    last_attempt_at = NOW(),
                    next_attempt_at = NOW() + v_retry_delay,
                    error_message = format('Processing attempt %s failed: %s', NEW.attempts + 1, SQLERRM)
                WHERE id = NEW.id;
                
                RAISE NOTICE '🔄 Scheduled % activity for retry (attempt %s/%s): %', 
                    NEW.ap_type, NEW.attempts + 1, v_max_attempts, NEW.ap_id;
            ELSE
                -- Max attempts reached, mark as permanently failed
                UPDATE ap_activities 
                SET status = 'failed',
                    attempts = NEW.attempts + 1,
                    last_attempt_at = NOW(),
                    error_message = format('Processing failed after %s attempts: %s', v_max_attempts, SQLERRM),
                    processed_at = NOW()
                WHERE id = NEW.id;
                
                RAISE WARNING '❌ Permanently failed % activity after %s attempts: %', 
                    NEW.ap_type, v_max_attempts, NEW.ap_id;
            END IF;
        END;
    END;

    RETURN NEW;
END;
$$;

-- =====================================================
-- FOLLOW ACTIVITY PROCESSOR
-- =====================================================

CREATE OR REPLACE FUNCTION process_follow_activity(
    activity_id UUID,
    activity_data JSONB,
    actor_profile RECORD,
    instance_domain TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_following_url TEXT;
    v_following_profile RECORD;
    v_username TEXT;
    v_follow_id UUID;
BEGIN
    -- Extract the user being followed
    v_following_url := CASE 
        WHEN jsonb_typeof(activity_data->'object') = 'string' 
        THEN activity_data->>'object'
        ELSE activity_data->'object'->>'id'
    END;

    -- Extract username from URL
    v_username := substring(v_following_url from 'https://[^/]+/users/([^/]+)');
    
    IF v_username IS NULL THEN
        RAISE WARNING 'Could not extract username from follow object: %', v_following_url;
        RETURN;
    END IF;

    -- Get the local user being followed
    SELECT * INTO v_following_profile
    FROM profiles 
    WHERE username = v_username 
      AND domain = instance_domain 
      AND is_local = true;

    IF NOT FOUND THEN
        RAISE WARNING 'Local user not found: %', v_username;
        RETURN;
    END IF;

    -- Create or update follow relationship
    INSERT INTO follows (
        follower_id,
        following_id,
        ap_id,
        status,
        accepted_at,
        is_local,
        created_at
    ) VALUES (
        actor_profile.id,
        v_following_profile.id,
        activity_data->>'id',
        'accepted', -- Auto-accept for now
        NOW(),
        false,
        NOW()
    )
    ON CONFLICT (follower_id, following_id) 
    DO UPDATE SET
        ap_id = EXCLUDED.ap_id,
        status = 'accepted',
        accepted_at = NOW(),
        updated_at = NOW()
    RETURNING id INTO v_follow_id;

    RAISE NOTICE '✅ Follow relationship created: % now follows %', 
        actor_profile.username, v_following_profile.username;

    -- Note: Follow notifications are handled by the existing follow notification trigger
    -- TODO: Send Accept activity back to follower (queue for federation)
END;
$$;

-- =====================================================
-- CREATE ACTIVITY PROCESSOR (Posts, DMs, etc.)
-- =====================================================

CREATE OR REPLACE FUNCTION process_create_activity(
    activity_id UUID,
    activity_data JSONB,
    actor_profile RECORD,
    instance_domain TEXT
) RETURNS VOID
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
        PERFORM process_activitypub_direct_message(activity_id, activity_data, actor_profile, instance_domain);
    ELSE
        RAISE NOTICE '📢 Processing as public post';
        PERFORM process_activitypub_public_post(activity_id, activity_data, actor_profile, instance_domain);
    END IF;
END;
$$;

-- =====================================================
-- DIRECT MESSAGE DETECTION
-- =====================================================

CREATE OR REPLACE FUNCTION is_activitypub_direct_message(
    object_data JSONB,
    instance_domain TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_to JSONB;
    v_cc JSONB;
    v_visibility TEXT;
    v_public_indicators TEXT[];
    v_local_recipients TEXT[];
BEGIN
    -- Method 1: Check visibility property
    v_visibility := object_data->>'visibility';
    IF v_visibility = 'direct' THEN
        RETURN true;
    END IF;

    -- Method 2: Check directMessage flag
    IF (object_data->>'directMessage')::boolean = true THEN
        RETURN true;
    END IF;

    -- Method 3: Check addressing
    v_to := COALESCE(object_data->'to', '[]'::jsonb);
    v_cc := COALESCE(object_data->'cc', '[]'::jsonb);

    -- Convert to text arrays for easier processing
    SELECT array_agg(value::text) INTO v_public_indicators
    FROM jsonb_array_elements(v_to || v_cc) AS value
    WHERE value::text IN (
        '"https://www.w3.org/ns/activitystreams#Public"',
        '"as:Public"',
        '"Public"'
    ) OR value::text LIKE '%/followers';

    -- Check for local recipients
    SELECT array_agg(value::text) INTO v_local_recipients
    FROM jsonb_array_elements(v_to || v_cc) AS value
    WHERE value::text LIKE '%' || instance_domain || '/users/%';

    -- It's a DM if:
    -- - Has local recipients
    -- - No public indicators
    -- - Limited addressing (to <= 2, cc = 0)
    IF array_length(v_local_recipients, 1) > 0 
       AND (v_public_indicators IS NULL OR array_length(v_public_indicators, 1) = 0)
       AND jsonb_array_length(v_to) <= 2 
       AND jsonb_array_length(v_cc) = 0 THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

-- =====================================================
-- HELPER FUNCTIONS  
-- =====================================================

-- Parse ActivityPub HTML content to our JSONB format
CREATE OR REPLACE FUNCTION parse_activitypub_content_to_jsonb(
    html_content TEXT,
    tags JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_result JSONB := '[]'::jsonb;
    v_text_content TEXT;
    v_mention_tags JSONB;
    v_tag JSONB;
    v_mention_href TEXT;
    v_mention_name TEXT;
    v_username TEXT;
    v_domain TEXT;
BEGIN
    -- If no content, return empty array
    IF html_content IS NULL OR html_content = '' THEN
        RETURN v_result;
    END IF;
    
    -- Extract mention tags for later processing
    v_mention_tags := COALESCE(
        (SELECT jsonb_agg(tag) 
         FROM jsonb_array_elements(COALESCE(tags, '[]'::jsonb)) tag 
         WHERE tag->>'type' = 'Mention'),
        '[]'::jsonb
    );
    
    -- Simple HTML to text conversion (basic approach)
    -- Remove HTML tags but preserve content
    v_text_content := regexp_replace(html_content, '<[^>]+>', '', 'g');
    v_text_content := regexp_replace(v_text_content, '&lt;', '<', 'g');
    v_text_content := regexp_replace(v_text_content, '&gt;', '>', 'g');
    v_text_content := regexp_replace(v_text_content, '&amp;', '&', 'g');
    v_text_content := trim(v_text_content);
    
    -- For now, return as simple text content
    -- TODO: Parse mentions and convert to proper mention objects
    IF v_text_content != '' THEN
        v_result := jsonb_build_array(
            jsonb_build_object(
                'type', 'text',
                'text', v_text_content
            )
        );
    END IF;
    
    -- Add mention objects if any
    FOR v_tag IN SELECT jsonb_array_elements(v_mention_tags) LOOP
        v_mention_href := v_tag->>'href';
        v_mention_name := v_tag->>'name';
        
        IF v_mention_href IS NOT NULL AND v_mention_name IS NOT NULL THEN
            -- Extract username and domain from href
            v_username := substring(v_mention_href from '/users/([^/]+)');
            v_domain := substring(v_mention_href from 'https://([^/]+)/');
            
            IF v_username IS NOT NULL AND v_domain IS NOT NULL THEN
                v_result := v_result || jsonb_build_array(
                    jsonb_build_object(
                        'type', 'mention',
                        'username', v_username,
                        'domain', v_domain,
                        'href', v_mention_href,
                        'name', v_mention_name
                    )
                );
            END IF;
        END IF;
    END LOOP;
    
    RETURN v_result;
END;
$$;

-- =====================================================
-- ACTIVITY PROCESSORS (IMPLEMENTED)
-- =====================================================

-- Accept activity - handles follow accepts and other accepts
CREATE OR REPLACE FUNCTION process_accept_activity(
    activity_id UUID, activity_data JSONB, actor_profile RECORD
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_object JSONB;
    v_original_follow_id TEXT;
    v_follow_record RECORD;
BEGIN
    v_object := activity_data->'object';
    
    -- Handle Accept of Follow activities
    IF v_object->>'type' = 'Follow' THEN
        v_original_follow_id := v_object->>'id';
        
        -- Find the follow request in our database
        SELECT * INTO v_follow_record
        FROM follows 
        WHERE ap_id = v_original_follow_id 
          AND status = 'pending';
        
        IF FOUND THEN
            -- Update follow status to accepted
            UPDATE follows 
            SET status = 'accepted', 
                accepted_at = NOW(),
                updated_at = NOW()
            WHERE id = v_follow_record.id;
            
            RAISE NOTICE '✅ Follow request accepted: % -> %', 
                v_follow_record.follower_id, v_follow_record.following_id;
        END IF;
    END IF;
END;
$$;

-- Reject activity - handles follow rejects and other rejects
CREATE OR REPLACE FUNCTION process_reject_activity(
    activity_id UUID, activity_data JSONB, actor_profile RECORD
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_object JSONB;
    v_original_follow_id TEXT;
    v_follow_record RECORD;
BEGIN
    v_object := activity_data->'object';
    
    -- Handle Reject of Follow activities
    IF v_object->>'type' = 'Follow' THEN
        v_original_follow_id := v_object->>'id';
        
        -- Find the follow request in our database
        SELECT * INTO v_follow_record
        FROM follows 
        WHERE ap_id = v_original_follow_id 
          AND status = 'pending';
        
        IF FOUND THEN
            -- Update follow status to rejected (or delete)
            UPDATE follows 
            SET status = 'rejected',
                updated_at = NOW()
            WHERE id = v_follow_record.id;
            
            RAISE NOTICE '❌ Follow request rejected: % -> %', 
                v_follow_record.follower_id, v_follow_record.following_id;
        END IF;
    END IF;
END;
$$;

-- Undo activity - handles unfollows, unlikes, etc.
CREATE OR REPLACE FUNCTION process_undo_activity(
    activity_id UUID, activity_data JSONB, actor_profile RECORD
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_object JSONB;
    v_original_activity_id TEXT;
    v_object_type TEXT;
BEGIN
    v_object := activity_data->'object';
    v_original_activity_id := v_object->>'id';
    v_object_type := v_object->>'type';
    
    CASE v_object_type
        WHEN 'Follow' THEN
            -- Undo follow = unfollow
            DELETE FROM follows 
            WHERE ap_id = v_original_activity_id 
              AND follower_id = actor_profile.id;
        
            RAISE NOTICE '🔄 Undone follow activity: %', v_original_activity_id;
        
        WHEN 'Like' THEN
            -- Undo like = unfavorite
            DELETE FROM post_interactions 
            WHERE ap_id = v_original_activity_id 
              AND user_id = actor_profile.id 
              AND interaction_type = 'favorite';
          
            RAISE NOTICE '🔄 Undone like activity: %', v_original_activity_id;
        
        WHEN 'Announce' THEN
            -- Undo announce = unreblog
            DELETE FROM post_interactions 
            WHERE ap_id = v_original_activity_id 
              AND user_id = actor_profile.id 
              AND interaction_type = 'reblog';
          
            RAISE NOTICE '🔄 Undone announce activity: %', v_original_activity_id;
        
        ELSE
            RAISE NOTICE '⚠️ Unhandled undo object type: %', v_object_type;
    END CASE;
END;
$$;

-- Update activity - handles post edits
CREATE OR REPLACE FUNCTION process_update_activity(
    activity_id UUID, activity_data JSONB, actor_profile RECORD
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_object JSONB;
    v_object_id TEXT;
    v_post_record RECORD;
    v_content JSONB;
BEGIN
    v_object := activity_data->'object';
    v_object_id := v_object->>'id';
    
    -- Only handle Note updates (post edits)
    IF v_object->>'type' != 'Note' THEN
        RETURN;
    END IF;
    
    -- Find the existing post
    SELECT * INTO v_post_record
    FROM posts 
    WHERE ap_id = v_object_id;
    
    IF FOUND THEN
        -- Convert ActivityPub content to our format
        v_content := parse_activitypub_content_to_jsonb(
            v_object->>'content', 
            v_object->'tag'
        );
        
        -- Update the post
        UPDATE posts 
        SET content = v_content,
            content_warning = v_object->>'summary',
            is_sensitive = COALESCE((v_object->>'sensitive')::boolean, false),
            updated_at = NOW(),
            edited_at = NOW()
        WHERE id = v_post_record.id;
        
        RAISE NOTICE '📝 Updated post: %', v_object_id;
    END IF;
END;
$$;

-- Delete activity - handles post deletions
CREATE OR REPLACE FUNCTION process_delete_activity(
    activity_id UUID, activity_data JSONB, actor_profile RECORD
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_object_id TEXT;
    v_post_record RECORD;
BEGIN
    -- Object can be string ID or object with ID
    v_object_id := CASE 
        WHEN jsonb_typeof(activity_data->'object') = 'string' 
        THEN activity_data->>'object'
        ELSE activity_data->'object'->>'id'
    END;
    
    -- Find and soft-delete the post
    SELECT * INTO v_post_record
    FROM posts 
    WHERE ap_id = v_object_id 
      AND author_id = actor_profile.id; -- Security: only author can delete
    
    IF FOUND THEN
        UPDATE posts 
        SET is_deleted = true,
            deleted_at = NOW(),
            content = '[{"type": "text", "text": "[deleted]"}]'::jsonb
        WHERE id = v_post_record.id;
        
        RAISE NOTICE '🗑️ Deleted post: %', v_object_id;
    END IF;
END;
$$;

-- Like activity - handles incoming favorites/likes
CREATE OR REPLACE FUNCTION process_like_activity(
    activity_id UUID, activity_data JSONB, actor_profile RECORD
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_object_id TEXT;
    v_post_record RECORD;
    v_ap_id TEXT;
BEGIN
    v_object_id := activity_data->>'object';
    v_ap_id := activity_data->>'id';

    -- Find the post being liked
    SELECT * INTO v_post_record
    FROM posts 
    WHERE ap_id = v_object_id;

    IF FOUND THEN
        -- Create the like interaction
        INSERT INTO post_interactions (
            user_id,
            post_id,
            interaction_type,
            ap_id,
            is_local,
            created_at
        ) VALUES (
            actor_profile.id,
            v_post_record.id,
            'favorite',
            v_ap_id,
            false,
            NOW()
        ) ON CONFLICT (user_id, post_id, interaction_type) DO NOTHING;
        
        RAISE NOTICE '❤️ Post liked: % by %', v_object_id, actor_profile.username;
    END IF;
END;
$$;

-- Announce activity - handles incoming reblogs/boosts
CREATE OR REPLACE FUNCTION process_announce_activity(
    activity_id UUID, activity_data JSONB, actor_profile RECORD
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_object_id TEXT;
    v_post_record RECORD;
    v_ap_id TEXT;
BEGIN
    v_object_id := activity_data->>'object';
    v_ap_id := activity_data->>'id';

    -- Find the post being announced
    SELECT * INTO v_post_record
    FROM posts 
    WHERE ap_id = v_object_id;

    IF FOUND THEN
        -- Create the reblog interaction
        INSERT INTO post_interactions (
            user_id,
            post_id,
            interaction_type,
            ap_id,
            is_local,
            created_at
        ) VALUES (
            actor_profile.id,
            v_post_record.id,
            'reblog',
            v_ap_id,
            false,
            NOW()
        ) ON CONFLICT (user_id, post_id, interaction_type) DO NOTHING;
        
        RAISE NOTICE '🔄 Post announced: % by %', v_object_id, actor_profile.username;
    END IF;
END;
$$;

-- Continue to part 2 for DM/post processing and setup...
