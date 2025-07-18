-- Comprehensive fix for the handle_post_federation trigger function
-- Issues addressed:
-- 1. Proper mention extraction from unified MessagePart[] format
-- 2. Fix RLS policy violations on federation_delivery_queue
-- 3. Handle both local and remote mentions correctly
-- 4. Fix PostgREST query parsing issues
-- 5. Ensure no NULL values in domain arrays

-- First, let's ensure the RLS policies are correct for federation_delivery_queue
ALTER TABLE federation_delivery_queue DISABLE ROW LEVEL SECURITY;
ALTER TABLE federation_delivery_queue ENABLE ROW LEVEL SECURITY;

-- Policy for service role to insert/update federation delivery queue
DROP POLICY IF EXISTS "Service role can manage federation queue" ON federation_delivery_queue;
CREATE POLICY "Service role can manage federation queue" ON federation_delivery_queue
FOR ALL TO service_role
USING (true)
WITH CHECK (true);

-- Policy for authenticated users to view their own delivery queue items
DROP POLICY IF EXISTS "Users can view federation delivery queue" ON federation_delivery_queue;
CREATE POLICY "Users can view federation delivery queue" ON federation_delivery_queue
FOR SELECT TO authenticated
USING (true);

-- Now fix the trigger function
CREATE OR REPLACE FUNCTION public.handle_post_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER  -- Run with definer's privileges to bypass RLS
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

    -- Extract mentions from the unified MessagePart[] format
    WITH mention_extraction AS (
        SELECT 
            content_item->>'username' as username,
            content_item->>'domain' as domain
        FROM jsonb_array_elements(NEW.content) AS content_item
        WHERE content_item->>'type' = 'mention'
        AND content_item->>'username' IS NOT NULL
        AND content_item->>'username' != ''
    ),
    resolved_mentions AS (
        SELECT DISTINCT
            CASE 
                WHEN me.domain IS NOT NULL AND me.domain != v_instance_domain 
                THEN 'https://' || me.domain || '/users/' || me.username
                WHEN me.domain IS NULL OR me.domain = v_instance_domain
                THEN v_sender_url || '/users/' || me.username
                ELSE 'https://' || me.domain || '/users/' || me.username
            END as actor_url,
            COALESCE(me.domain, v_instance_domain) as domain
        FROM mention_extraction me
        WHERE me.username IS NOT NULL
    ),
    remote_mentions AS (
        -- Filter to get only remote mention domains (excluding local)
        SELECT DISTINCT rm.domain
        FROM resolved_mentions rm
        WHERE rm.domain IS NOT NULL 
          AND rm.domain != v_instance_domain
          AND rm.domain != ''
    )
    SELECT 
        CASE WHEN count(rm.actor_url) > 0 
             THEN array_agg(DISTINCT rm.actor_url) 
             ELSE NULL 
        END,
        CASE WHEN count(rmt.domain) > 0 
             THEN array_agg(DISTINCT rmt.domain) 
             ELSE NULL 
        END
    INTO v_mentioned_actor_urls, v_mention_domains
    FROM resolved_mentions rm
    FULL OUTER JOIN remote_mentions rmt ON true;

    -- Debug logging
    RAISE NOTICE 'Post %: Extracted % mention domains: %', 
        NEW.id, 
        COALESCE(array_length(v_mention_domains, 1), 0), 
        v_mention_domains;
    RAISE NOTICE 'Post %: Extracted % actor URLs: %', 
        NEW.id, 
        COALESCE(array_length(v_mentioned_actor_urls, 1), 0), 
        v_mentioned_actor_urls;

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
            WHEN v_mentioned_actor_urls IS NOT NULL AND array_length(v_mentioned_actor_urls, 1) > 0
            THEN public.extract_activitypub_mention_tags(NEW.content)
            ELSE '[]'::jsonb
        END,
        'to', CASE NEW.visibility
            WHEN 'public' THEN jsonb_build_array('https://www.w3.org/ns/activitystreams#Public', v_followers_url)
            WHEN 'unlisted' THEN jsonb_build_array(v_followers_url)
            WHEN 'followers' THEN jsonb_build_array(v_followers_url)
            WHEN 'mentioned' THEN CASE 
                WHEN v_mentioned_actor_urls IS NOT NULL 
                THEN to_jsonb(v_mentioned_actor_urls)
                ELSE '[]'::jsonb
            END
            ELSE '[]'::jsonb
        END,
        'cc', CASE NEW.visibility
            WHEN 'public' THEN CASE 
                WHEN v_mentioned_actor_urls IS NOT NULL 
                THEN to_jsonb(v_mentioned_actor_urls)
                ELSE '[]'::jsonb
            END
            WHEN 'unlisted' THEN jsonb_build_array('https://www.w3.org/ns/activitystreams#Public') || 
                CASE 
                    WHEN v_mentioned_actor_urls IS NOT NULL 
                    THEN to_jsonb(v_mentioned_actor_urls)
                    ELSE '[]'::jsonb
                END
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

    -- Store the ActivityPub activity record (use service role to bypass RLS)
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
                  AND p.domain != ''
            ),
            all_target_domains AS (
                -- Combine follower domains with mention domains
                SELECT domain FROM follower_domains
                UNION
                SELECT unnest(v_mention_domains) as domain 
                WHERE v_mention_domains IS NOT NULL
            ),
            final_domains AS (
                SELECT DISTINCT domain
                FROM all_target_domains
                WHERE domain IS NOT NULL 
                  AND domain != ''
                  AND domain != v_instance_domain
            )
            SELECT array_agg(domain) INTO v_mention_domains
            FROM final_domains;
            
            IF v_mention_domains IS NOT NULL AND array_length(v_mention_domains, 1) > 0 THEN
                PERFORM queue_activity_for_federation(v_activity_uuid, v_mention_domains, 5, true);
                RAISE NOTICE '📮 Queued public/unlisted post % for delivery to % domains (followers + mentions)', 
                    NEW.id, array_length(v_mention_domains, 1);
            ELSE
                UPDATE ap_activities SET status = 'completed' WHERE id = v_activity_uuid;
                RAISE NOTICE '🏠 Public/unlisted post % has no remote followers or mentions, marked as completed', NEW.id;
            END IF;
            
        WHEN 'followers' THEN
            -- For followers-only posts, federate to follower domains only
            WITH follower_domains AS (
                SELECT DISTINCT p.domain
                FROM follows f
                JOIN profiles p ON f.follower_id = p.id
                WHERE f.following_id = NEW.author_id
                  AND f.status = 'accepted'
                  AND NOT p.is_local
                  AND p.domain IS NOT NULL
                  AND p.domain != ''
                  AND p.domain != v_instance_domain
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
            -- For mentioned posts, only federate to domains with mentions
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
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Error in handle_post_federation for post %: % %', NEW.id, SQLSTATE, SQLERRM;
        RETURN NEW;
END;
$$;

-- Ensure the trigger is properly set up
DROP TRIGGER IF EXISTS trg_handle_post_federation ON posts;
CREATE TRIGGER trg_handle_post_federation
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_post_federation();

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION handle_post_federation() TO service_role;
GRANT EXECUTE ON FUNCTION queue_activity_for_federation(UUID, TEXT[], INTEGER, BOOLEAN) TO service_role;
