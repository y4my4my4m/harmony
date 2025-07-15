-- Professional Post Federation: Single trigger approach
-- Handles ActivityPub federation for public posts with mentions
-- Follows the same pattern as professional_message_processing.sql

-- Helper function to convert text array to JSONB array
CREATE OR REPLACE FUNCTION jsonb_agg_text_array(text_array TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF text_array IS NULL OR array_length(text_array, 1) IS NULL THEN
        RETURN '[]'::jsonb;
    END IF;
    
    RETURN (SELECT jsonb_agg(item) FROM unnest(text_array) AS item);
END;
$$;

-- Create comprehensive post federation function
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
    -- Now supports: public, unlisted, followers, mentioned
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
    
    -- Create ActivityPub Note object with proper content format and mention tags
    DECLARE
        v_mention_tags JSONB;
        v_mentioned_actor_urls TEXT[];
        v_to_addresses JSONB;
        v_cc_addresses JSONB;
        v_followers_url TEXT;
    BEGIN
        -- Build followers collection URL
        v_followers_url := v_sender_url || '/followers';
        
        -- Extract mentions from content and generate proper ActivityPub Mention tags
        WITH mentioned_users AS (
            -- Handle both mention object types and mentions metadata
            SELECT DISTINCT 
                p.domain,
                p.username,
                p.federated_id,
                'https://' || p.domain || '/users/' || p.username as actor_url
            FROM (
                -- Extract mentions from mentions metadata within text objects
                SELECT 
                    mention_data->>'username' as username,
                    mention_data->>'domain' as domain
                FROM jsonb_array_elements(NEW.content) AS content_item,
                     jsonb_array_elements(content_item->'mentions') AS mention_data
                WHERE content_item->>'type' = 'text'
                  AND content_item->'mentions' IS NOT NULL
                  AND mention_data->>'username' IS NOT NULL
                
                UNION
                
                -- Extract mentions from separate mention objects
                SELECT 
                    content_item->>'username' as username,
                    content_item->>'domain' as domain
                FROM jsonb_array_elements(NEW.content) AS content_item
                WHERE content_item->>'type' = 'mention'
                  AND content_item->>'username' IS NOT NULL
            ) AS all_mentions
            LEFT JOIN profiles p ON p.username = all_mentions.username 
                                 AND (p.domain = all_mentions.domain OR (all_mentions.domain IS NULL AND p.is_local))
            WHERE p.username IS NOT NULL
        )
        SELECT 
            jsonb_agg(
                jsonb_build_object(
                    'type', 'Mention',
                    'href', actor_url,
                    'name', CASE 
                        WHEN domain IS NULL OR domain = v_instance_domain THEN '@' || username
                        ELSE '@' || username || '@' || domain
                    END
                )
            ) FILTER (WHERE actor_url IS NOT NULL),
            array_agg(actor_url) FILTER (WHERE actor_url IS NOT NULL)
        INTO v_mention_tags, v_mentioned_actor_urls
        FROM mentioned_users;
        
        -- Set default empty arrays if no mentions
        v_mention_tags := COALESCE(v_mention_tags, '[]'::jsonb);
        v_mentioned_actor_urls := COALESCE(v_mentioned_actor_urls, ARRAY[]::TEXT[]);
        
        -- Build to/cc addresses based on visibility according to ActivityStreams spec
        CASE NEW.visibility
            WHEN 'public' THEN
                -- public: Public statuses have the as:Public magic collection in to
                v_to_addresses := jsonb_build_array('https://www.w3.org/ns/activitystreams#Public');
                v_cc_addresses := jsonb_build_array(v_followers_url) || 
                                  COALESCE(jsonb_agg_text_array(v_mentioned_actor_urls), '[]'::jsonb);
                                  
            WHEN 'unlisted' THEN
                -- unlisted: Unlisted statuses have the as:Public magic collection in cc
                v_to_addresses := jsonb_build_array(v_followers_url) || 
                                  COALESCE(jsonb_agg_text_array(v_mentioned_actor_urls), '[]'::jsonb);
                v_cc_addresses := jsonb_build_array('https://www.w3.org/ns/activitystreams#Public');
                
            WHEN 'followers' THEN
                -- private: Followers-only statuses have an actor's follower collection in to or cc, but do not include the as:Public magic collection
                v_to_addresses := jsonb_build_array(v_followers_url) || 
                                  COALESCE(jsonb_agg_text_array(v_mentioned_actor_urls), '[]'::jsonb);
                v_cc_addresses := '[]'::jsonb;
                
            WHEN 'mentioned' THEN
                -- limited: Limited-audience statuses have actors in to or cc, at least one of which is not Mentioned in tag
                -- For "mentioned only" posts, we put mentioned actors in 'to' but don't include followers
                v_to_addresses := COALESCE(jsonb_agg_text_array(v_mentioned_actor_urls), '[]'::jsonb);
                v_cc_addresses := '[]'::jsonb;
                
            ELSE
                -- Default to followers-only for unknown visibility
                v_to_addresses := jsonb_build_array(v_followers_url);
                v_cc_addresses := '[]'::jsonb;
        END CASE;
        
        -- Create the Note object
        v_note_object := jsonb_build_object(
            'id', v_post_url,
            'type', 'Note',
            'content', convert_content_to_activitypub_html(NEW.content),
            'contentMap', jsonb_build_object('en', convert_content_to_activitypub_html(NEW.content)),
            'attributedTo', v_sender_url,
            'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'to', v_to_addresses,
            'cc', v_cc_addresses,
            'tag', v_mention_tags,  -- Proper ActivityPub Mention tags
            'url', v_post_url,
            'mediaType', 'text/html',
            'sensitive', COALESCE(NEW.is_sensitive, false)
        );
    END;
    
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
        ARRAY[]::TEXT[], -- Will be populated based on delivery strategy
        true,
        v_instance_domain
    ) RETURNING id INTO v_activity_uuid;
    
    -- Determine delivery strategy based on visibility and mentions
    CASE NEW.visibility
        WHEN 'public', 'unlisted' THEN
            -- For public/unlisted posts, deliver to mentioned remote users
            IF v_mentioned_actor_urls IS NOT NULL AND array_length(v_mentioned_actor_urls, 1) > 0 THEN
                -- Extract unique domains from mentioned actors
                WITH mentioned_domains AS (
                    SELECT DISTINCT 
                        substring(actor_url from 'https://([^/]+)/') as domain
                    FROM unnest(v_mentioned_actor_urls) AS actor_url
                    WHERE actor_url LIKE 'https://%'
                      AND substring(actor_url from 'https://([^/]+)/') != v_instance_domain
                )
                SELECT array_agg(domain) INTO v_mention_domains
                FROM mentioned_domains;
                
                IF v_mention_domains IS NOT NULL AND array_length(v_mention_domains, 1) > 0 THEN
                    RAISE NOTICE 'Public/unlisted post % has mentions to remote domains: %', NEW.id, v_mention_domains;
                    -- Update activity with target addresses
                    UPDATE ap_activities 
                    SET to_addresses = v_mention_domains
                    WHERE id = v_activity_uuid;
                END IF;
            END IF;
            
        WHEN 'followers' THEN
            -- For followers-only posts, deliver to followers' domains
            -- This would require a followers table and is more complex
            -- For now, just deliver to mentioned users if any
            IF v_mentioned_actor_urls IS NOT NULL AND array_length(v_mentioned_actor_urls, 1) > 0 THEN
                WITH mentioned_domains AS (
                    SELECT DISTINCT 
                        substring(actor_url from 'https://([^/]+)/') as domain
                    FROM unnest(v_mentioned_actor_urls) AS actor_url
                    WHERE actor_url LIKE 'https://%'
                      AND substring(actor_url from 'https://([^/]+)/') != v_instance_domain
                )
                SELECT array_agg(domain) INTO v_mention_domains
                FROM mentioned_domains;
                
                IF v_mention_domains IS NOT NULL THEN
                    RAISE NOTICE 'Followers-only post % has mentions to remote domains: %', NEW.id, v_mention_domains;
                    UPDATE ap_activities 
                    SET to_addresses = v_mention_domains
                    WHERE id = v_activity_uuid;
                END IF;
            ELSE
                RAISE NOTICE 'Followers-only post % has no remote mentions, no federation needed', NEW.id;
                -- Mark as completed since no remote delivery needed
                UPDATE ap_activities 
                SET status = 'completed'
                WHERE id = v_activity_uuid;
                RETURN NEW;
            END IF;
            
        WHEN 'mentioned' THEN
            -- For mentioned-only posts, only deliver to mentioned users
            IF v_mentioned_actor_urls IS NOT NULL AND array_length(v_mentioned_actor_urls, 1) > 0 THEN
                WITH mentioned_domains AS (
                    SELECT DISTINCT 
                        substring(actor_url from 'https://([^/]+)/') as domain
                    FROM unnest(v_mentioned_actor_urls) AS actor_url
                    WHERE actor_url LIKE 'https://%'
                      AND substring(actor_url from 'https://([^/]+)/') != v_instance_domain
                )
                SELECT array_agg(domain) INTO v_mention_domains
                FROM mentioned_domains;
                
                IF v_mention_domains IS NOT NULL THEN
                    RAISE NOTICE 'Mentioned-only post % delivering to domains: %', NEW.id, v_mention_domains;
                    UPDATE ap_activities 
                    SET to_addresses = v_mention_domains
                    WHERE id = v_activity_uuid;
                ELSE
                    -- No remote mentions, mark as completed
                    RAISE NOTICE 'Mentioned-only post % has no remote mentions, no federation needed', NEW.id;
                    UPDATE ap_activities 
                    SET status = 'completed'
                    WHERE id = v_activity_uuid;
                    RETURN NEW;
                END IF;
            ELSE
                -- No mentions at all, mark as completed
                UPDATE ap_activities 
                SET status = 'completed'
                WHERE id = v_activity_uuid;
                RETURN NEW;
            END IF;
            
        ELSE
            -- Unknown visibility, don't federate
            RAISE NOTICE 'Unknown visibility % for post %, skipping federation', NEW.visibility, NEW.id;
            UPDATE ap_activities 
            SET status = 'completed'
            WHERE id = v_activity_uuid;
            RETURN NEW;
    END CASE;
    
    
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
                
                RAISE NOTICE 'Generated HTTP signature using edge function for post to domain: %', v_domain;
                
                -- Attempt immediate delivery
                RAISE NOTICE 'Attempting post delivery to: % with signature: %', v_inbox_url, LEFT(v_signature_header, 100);
                
                -- Try to deliver immediately using Supabase HTTP extension with proper ActivityPub headers
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
                
                RAISE NOTICE 'HTTP Response: Status=%, Body=%', v_http_status, LEFT(v_http_response, 200);
                
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

-- Drop any existing post federation triggers
DROP TRIGGER IF EXISTS handle_post_federation_trigger ON posts;

-- Create the trigger
CREATE TRIGGER handle_post_federation_trigger
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_post_federation();

-- Grant permissions
GRANT EXECUTE ON FUNCTION jsonb_agg_text_array(TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION jsonb_agg_text_array(TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION handle_post_federation() TO authenticated;
GRANT EXECUTE ON FUNCTION handle_post_federation() TO service_role;

-- Documentation
COMMENT ON FUNCTION jsonb_agg_text_array(TEXT[]) IS 'Helper function to convert text arrays to JSONB arrays for ActivityPub addressing';
COMMENT ON FUNCTION handle_post_federation() IS 'Handles ActivityPub federation for posts with proper visibility levels (public/unlisted/followers/mentioned) and Mention tags according to ActivityStreams specification';
COMMENT ON TRIGGER handle_post_federation_trigger ON posts IS 'Automatically federates posts based on visibility: public/unlisted posts to mentioned users, followers-only to mentioned followers, mentioned-only to mentioned users only';

-- ActivityStreams Visibility Compliance Notes:
-- ===========================================
-- public: to=[as:Public], cc=[followers, mentions] - visible to everyone
-- unlisted: to=[followers, mentions], cc=[as:Public] - visible to everyone but not in public timelines  
-- followers: to=[followers, mentions], cc=[] - visible only to followers and mentioned users
-- mentioned: to=[mentions], cc=[] - visible only to mentioned users (limited audience)
--
-- All posts include proper Mention tags in the 'tag' property for notification delivery
-- Mention tags include proper 'name' property with @username or @username@domain format
