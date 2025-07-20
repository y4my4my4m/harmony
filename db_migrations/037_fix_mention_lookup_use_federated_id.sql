-- Migration 037: Fix mention processing to use federated_id instead of constructing URLs
-- Critical fix: ActivityPub servers use different URL patterns (Misskey uses IDs, not usernames)

BEGIN;

-- =====================================================
-- STEP 1: Fix extract_activitypub_mention_tags to lookup federated_id
-- =====================================================

CREATE OR REPLACE FUNCTION public.extract_activitypub_mention_tags(content jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    mention_tags JSONB := '[]'::JSONB;
    part_type TEXT;
    mention_username TEXT;
    mention_domain TEXT;
    mention_href TEXT;
    mention_name TEXT;
    mention_tag JSONB;
    current_instance_domain TEXT;
    user_record RECORD;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'mention' THEN
            mention_username := content_part->>'username';
            mention_domain := content_part->>'domain';
            
            IF mention_username IS NOT NULL THEN
                -- ✅ FIX: Look up actual user to get federated_id
                IF mention_domain IS NOT NULL THEN
                    -- Remote user: lookup by username + domain
                    SELECT username, domain, federated_id 
                    INTO user_record
                    FROM profiles 
                    WHERE username = mention_username 
                    AND domain = mention_domain 
                    AND NOT is_local
                    LIMIT 1;
                    
                    IF user_record.federated_id IS NOT NULL THEN
                        -- Use actual federated_id (correct ActivityPub actor URL)
                        mention_href := user_record.federated_id;
                        mention_name := '@' || mention_username || '@' || mention_domain;
                    ELSE
                        -- Fallback: construct URL (but this should be rare)
                        mention_href := 'https://' || mention_domain || '/users/' || mention_username;
                        mention_name := '@' || mention_username || '@' || mention_domain;
                        RAISE WARNING 'Missing federated_id for user %@%, using constructed URL', mention_username, mention_domain;
                    END IF;
                ELSE
                    -- Local user: use our domain
                    mention_href := 'https://' || current_instance_domain || '/users/' || mention_username;
                    mention_name := '@' || mention_username || '@' || current_instance_domain;
                END IF;
                
                -- Build the ActivityPub Mention tag
                mention_tag := jsonb_build_object(
                    'type', 'Mention',
                    'href', mention_href,
                    'name', mention_name
                );
                
                -- Add to tags array
                mention_tags := mention_tags || jsonb_build_array(mention_tag);
            END IF;
        END IF;
    END LOOP;
    
    RETURN mention_tags;
END;
$$;

-- =====================================================
-- STEP 2: Fix convert_unified_content_to_activitypub_html to use federated_id
-- =====================================================

CREATE OR REPLACE FUNCTION public.convert_unified_content_to_activitypub_html(content jsonb)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    content_part JSONB;
    html_content TEXT := '';
    part_type TEXT;
    part_text TEXT;
    part_url TEXT;
    part_shortcode TEXT;
    mention_username TEXT;
    mention_domain TEXT;
    mention_href TEXT;
    mention_text TEXT;
    current_instance_domain TEXT;
    hashtag_name TEXT;
    file_url TEXT;
    mention_display_name TEXT;
    mention_is_local BOOLEAN;
    user_record RECORD;
BEGIN
    -- Handle null or empty content
    IF content IS NULL THEN
        RETURN '';
    END IF;
    
    -- Handle string content (convert to simple text)
    IF jsonb_typeof(content) = 'string' THEN
        RETURN content #>> '{}';
    END IF;
    
    -- Handle array content (MessagePart[])
    IF jsonb_typeof(content) != 'array' THEN
        RETURN '';
    END IF;
    
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        CASE part_type
            WHEN 'text' THEN
                part_text := content_part->>'text';
                IF part_text IS NOT NULL THEN
                    html_content := html_content || part_text;
                END IF;
                
            WHEN 'mention' THEN
                -- Extract mention data from the unified format (username, domain, etc.)
                mention_username := content_part->>'username';
                mention_domain := content_part->>'domain';
                mention_display_name := content_part->>'displayName';
                mention_is_local := COALESCE((content_part->>'isLocal')::boolean, false);
                
                IF mention_username IS NOT NULL THEN
                    -- ✅ FIX: Look up actual user to get federated_id
                    IF mention_domain IS NOT NULL AND mention_domain != current_instance_domain THEN
                        -- Remote user: lookup by username + domain  
                        SELECT username, domain, federated_id 
                        INTO user_record
                        FROM profiles 
                        WHERE username = mention_username 
                        AND domain = mention_domain 
                        AND NOT is_local
                        LIMIT 1;
                        
                        IF user_record.federated_id IS NOT NULL THEN
                            -- Use actual federated_id (correct ActivityPub actor URL)
                            mention_href := user_record.federated_id;
                            mention_text := '@' || mention_username || '@' || mention_domain;
                        ELSE
                            -- Fallback: construct URL (but this should be rare)
                            mention_href := 'https://' || mention_domain || '/users/' || mention_username;
                            mention_text := '@' || mention_username || '@' || mention_domain;
                            RAISE WARNING 'Missing federated_id for user %@%, using constructed URL', mention_username, mention_domain;
                        END IF;
                    ELSE
                        -- Local user: use our domain  
                        mention_href := 'https://' || current_instance_domain || '/users/' || mention_username;
                        mention_text := '@' || mention_username || '@' || current_instance_domain;
                    END IF;
                    
                    -- Create the HTML mention link
                    html_content := html_content || format('<a href="%s" class="mention">%s</a>', 
                        mention_href, mention_text);
                END IF;
                
            WHEN 'emoji' THEN
                -- Handle custom emojis - use shortcode format for ActivityPub compatibility
                part_shortcode := content_part->'emoji'->>'name';
                
                IF part_shortcode IS NOT NULL THEN
                    -- Always render as shortcode - emoji metadata goes in ActivityPub tags
                    html_content := html_content || ':' || part_shortcode || ':';
                END IF;
                
            WHEN 'hashtag' THEN
                hashtag_name := content_part->>'name';
                IF hashtag_name IS NOT NULL THEN
                    html_content := html_content || format('<a href="https://%s/tags/%s" class="mention hashtag" rel="tag">#<span>%s</span></a>', 
                        current_instance_domain, hashtag_name, hashtag_name);
                END IF;
                
            WHEN 'url' THEN
                part_url := content_part->>'url';
                IF part_url IS NOT NULL THEN
                    html_content := html_content || format('<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>', 
                        part_url, part_url);
                END IF;
                
            WHEN 'file' THEN
                -- Files are handled as ActivityPub attachments, not inline content
                -- Just add a placeholder or nothing for the content
                file_url := content_part->>'url';
                IF file_url IS NOT NULL THEN
                    html_content := html_content || format('<p><a href="%s">[Attachment]</a></p>', file_url);
                END IF;
                
            ELSE
                -- Unknown part type, skip
                NULL;
        END CASE;
    END LOOP;
    
    RETURN html_content;
END;
$$;

-- =====================================================
-- STEP 3: Update handle_post_federation to use federated_id in mention resolution
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_post_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
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

    -- ✅ FIX: Extract mentions using actual federated_id lookup
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
                WHEN me.domain IS NOT NULL AND me.domain != v_instance_domain THEN
                    -- Use actual federated_id from profiles table
                    COALESCE(p.federated_id, 'https://' || me.domain || '/users/' || me.username)
                WHEN me.domain IS NULL OR me.domain = v_instance_domain THEN
                    'https://' || v_instance_domain || '/users/' || me.username
                ELSE 
                    COALESCE(p.federated_id, 'https://' || me.domain || '/users/' || me.username)
            END as actor_url,
            COALESCE(me.domain, v_instance_domain) as domain
        FROM mention_extraction me
        LEFT JOIN profiles p ON (
            p.username = me.username 
            AND p.domain = me.domain 
            AND NOT p.is_local
        )
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
        'tag', public.extract_all_activitypub_tags(NEW.content),
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

COMMIT;