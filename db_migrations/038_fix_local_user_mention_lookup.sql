-- Migration 038: Fix local user mention lookup in process_activitypub_public_post
-- CRITICAL BUG: Local users have domain = NULL, not domain = instance_domain

BEGIN;

-- Fix the process_activitypub_public_post function
CREATE OR REPLACE FUNCTION public.process_activitypub_public_post(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text)
RETURNS void
LANGUAGE plpgsql
AS $$
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
    
    -- ✅ FIX: Handle mentions - create notifications for local users
    SELECT ARRAY_AGG(username) INTO v_mentioned_users
    FROM (
        SELECT DISTINCT substring(tag->>'href' from 'https://' || instance_domain || '/users/([^/]+)')::text as username
        FROM jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) as tag
        WHERE tag->>'type' = 'Mention' 
          AND tag->>'href' LIKE 'https://' || instance_domain || '/users/%'
    ) t 
    WHERE username IS NOT NULL;
    
    RAISE NOTICE '📋 Extracted mentioned usernames: %', v_mentioned_users;
    
    IF v_mentioned_users IS NOT NULL THEN
        FOREACH v_username IN ARRAY v_mentioned_users LOOP
            RAISE NOTICE '🔍 Looking for local user: %', v_username;
            
            -- ✅ FIX: Remove domain check for local users (domain = NULL for local users!)
            SELECT id INTO v_local_user_id
            FROM profiles 
            WHERE username = v_username 
              AND is_local = true;  -- FIXED: No domain check!
            
            IF FOUND THEN
                RAISE NOTICE '✅ Found local user: % (ID: %)', v_username, v_local_user_id;
                
                -- Create mention notification
                PERFORM create_simple_activitypub_notification(
                    v_local_user_id,
                    'mention',  -- Fixed: Remove 'activitypub_' prefix (function adds it)
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
                
                RAISE NOTICE '🔔 Created mention notification for %', v_username;
            ELSE
                RAISE NOTICE '❌ Local user NOT FOUND: %', v_username;
                
                -- Debug: Show available local users
                RAISE NOTICE '📋 Available local users: %', (
                    SELECT string_agg(username, ', ') 
                    FROM profiles 
                    WHERE is_local = true
                );
            END IF;
        END LOOP;
    END IF;
    
    -- Note: Other notifications (replies, etc.) are handled by existing post triggers
END;
$$;

COMMENT ON FUNCTION public.process_activitypub_public_post(uuid, jsonb, record, text) IS 'FIXED: Remove domain check for local users in mention lookup - local users have domain = NULL';

COMMIT;