-- Fix the handle_post_federation trigger function to properly filter out null domains
-- The issue: array_agg includes NULL values when local mentions are filtered out,
-- and these NULLs end up in the federation queue causing constraint violations.

CREATE OR REPLACE FUNCTION public.handle_post_federation()
 RETURNS trigger
 LANGUAGE plpgsql
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
    ),
    filtered_mentions AS (
        -- Filter out local domains to get only remote mention domains
        SELECT DISTINCT rm.domain
        FROM resolved_mentions rm
        WHERE rm.domain IS NOT NULL 
          AND rm.domain != v_instance_domain
    )
    SELECT 
        array_agg(DISTINCT rm.actor_url),
        (SELECT array_agg(DISTINCT fm.domain) FROM filtered_mentions fm)
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
            FROM all_target_domains
            WHERE domain IS NOT NULL;  -- Ensure no nulls in final array
            
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
            FROM follower_domains
            WHERE domain IS NOT NULL;  -- Ensure no nulls
            
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
