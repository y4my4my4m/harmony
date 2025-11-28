-- Migration: Post Federation Trigger
-- Adds a database trigger to federate new posts via federation_delivery_queue
-- This is a backup mechanism in case Supabase Realtime doesn't work reliably

-- =====================================================
-- STEP 1: Create function to build post ActivityPub activity
-- =====================================================

CREATE OR REPLACE FUNCTION public.build_post_create_activity(
    p_post_id uuid,
    p_author_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_post RECORD;
    v_author RECORD;
    v_instance_domain text;
    v_activity_id text;
    v_post_url text;
    v_author_url text;
    v_followers_url text;
    v_note_object jsonb;
    v_activity jsonb;
    v_content_html text;
    v_to_addresses jsonb;
    v_cc_addresses jsonb;
BEGIN
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    IF v_instance_domain IS NULL THEN
        v_instance_domain := 'har.mony.lol'; -- Fallback
    END IF;
    
    -- Get post data
    SELECT * INTO v_post FROM posts WHERE id = p_post_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Get author data
    SELECT * INTO v_author FROM profiles WHERE id = p_author_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Build URLs
    v_author_url := 'https://' || v_instance_domain || '/users/' || v_author.id;
    v_post_url := 'https://' || v_instance_domain || '/posts/' || v_post.id;
    v_activity_id := v_post_url || '#activity';
    v_followers_url := v_author_url || '/followers';
    
    -- Convert content to HTML (simplified - just extract text)
    SELECT string_agg(
        CASE 
            WHEN part->>'type' = 'text' THEN part->>'text'
            WHEN part->>'type' = 'mention' THEN 
                '<span class="h-card"><a href="https://' || 
                COALESCE(part->>'domain', v_instance_domain) || 
                '/users/' || (part->>'username') || 
                '" class="u-url mention">@<span>' || (part->>'username') || '</span></a></span>'
            WHEN part->>'type' = 'emoji' THEN ':' || (part->>'name') || ':'
            WHEN part->>'type' = 'hashtag' THEN '#' || (part->>'tag')
            ELSE ''
        END, ' '
    ) INTO v_content_html
    FROM jsonb_array_elements(v_post.content) AS part;
    
    -- Wrap in paragraph tag
    v_content_html := '<p>' || COALESCE(v_content_html, '') || '</p>';
    
    -- Determine addressing based on visibility
    IF v_post.visibility = 'public' THEN
        v_to_addresses := jsonb_build_array('https://www.w3.org/ns/activitystreams#Public');
        v_cc_addresses := jsonb_build_array(v_followers_url);
    ELSIF v_post.visibility = 'unlisted' THEN
        v_to_addresses := jsonb_build_array(v_followers_url);
        v_cc_addresses := jsonb_build_array('https://www.w3.org/ns/activitystreams#Public');
    ELSIF v_post.visibility = 'followers' THEN
        v_to_addresses := jsonb_build_array(v_followers_url);
        v_cc_addresses := '[]'::jsonb;
    ELSE
        -- Direct/private - would need specific recipients
        v_to_addresses := '[]'::jsonb;
        v_cc_addresses := '[]'::jsonb;
    END IF;
    
    -- Build Note object
    v_note_object := jsonb_build_object(
        'id', v_post_url,
        'type', 'Note',
        'published', to_char(v_post.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'attributedTo', v_author_url,
        'content', v_content_html,
        'url', v_post_url,
        'to', v_to_addresses,
        'cc', v_cc_addresses,
        'sensitive', COALESCE(v_post.is_sensitive, false),
        'attachment', COALESCE(v_post.media_attachments, '[]'::jsonb)
    );
    
    -- Add inReplyTo if this is a reply
    IF v_post.in_reply_to IS NOT NULL THEN
        v_note_object := v_note_object || jsonb_build_object(
            'inReplyTo', 'https://' || v_instance_domain || '/posts/' || v_post.in_reply_to
        );
    END IF;
    
    -- Add content warning if present
    IF v_post.content_warning IS NOT NULL AND v_post.content_warning != '' THEN
        v_note_object := v_note_object || jsonb_build_object(
            'summary', v_post.content_warning
        );
    END IF;
    
    -- Build Create activity
    v_activity := jsonb_build_object(
        '@context', jsonb_build_array(
            'https://www.w3.org/ns/activitystreams',
            'https://w3id.org/security/v1'
        ),
        'id', v_activity_id,
        'type', 'Create',
        'actor', v_author_url,
        'published', to_char(v_post.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'to', v_to_addresses,
        'cc', v_cc_addresses,
        'object', v_note_object
    );
    
    RETURN v_activity;
END;
$$;

COMMENT ON FUNCTION public.build_post_create_activity(uuid, uuid) IS 
    'Builds an ActivityPub Create activity for a post. Used by federation trigger.';


-- =====================================================
-- STEP 2: Create trigger function for post federation
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_post_federation()
RETURNS TRIGGER AS $$
DECLARE
    v_activity jsonb;
    v_instance_domain text;
    v_target_domains text[];
    v_target_domain text;
    v_domain_inbox text;
    v_author RECORD;
BEGIN
    -- Only process local posts with public or unlisted visibility
    IF NOT NEW.is_local OR NEW.visibility NOT IN ('public', 'unlisted') THEN
        RETURN NEW;
    END IF;
    
    -- Skip if already federated (to prevent duplicate federation)
    IF NEW.federation_status = 'federated' THEN
        RETURN NEW;
    END IF;
    
    -- Get author profile
    SELECT * INTO v_author FROM profiles WHERE id = NEW.author_id;
    IF NOT FOUND OR NOT v_author.is_local THEN
        RETURN NEW;
    END IF;
    
    -- Check if user has federation enabled
    IF NOT COALESCE(is_federation_enabled_for_user(v_author.id), true) THEN
        RETURN NEW;
    END IF;
    
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    -- Build the activity
    v_activity := build_post_create_activity(NEW.id, NEW.author_id);
    
    IF v_activity IS NULL THEN
        RAISE LOG 'Failed to build activity for post: %', NEW.id;
        RETURN NEW;
    END IF;
    
    -- Get target domains (all remote followers of the author)
    SELECT ARRAY_AGG(DISTINCT p.domain)
    INTO v_target_domains
    FROM follows f
    JOIN profiles p ON p.id = f.follower_id
    WHERE f.following_id = NEW.author_id
      AND f.status = 'accepted'
      AND p.is_local = false
      AND p.domain IS NOT NULL
      AND p.domain != '';
    
    -- If no followers, also send to known active instances (for public posts)
    IF v_target_domains IS NULL OR array_length(v_target_domains, 1) IS NULL THEN
        IF NEW.visibility = 'public' THEN
            SELECT ARRAY_AGG(DISTINCT domain)
            INTO v_target_domains
            FROM profiles
            WHERE domain IS NOT NULL
              AND domain != ''
              AND is_local = false
            LIMIT 20;
        END IF;
    END IF;
    
    -- Queue for federation delivery
    IF v_target_domains IS NOT NULL AND array_length(v_target_domains, 1) > 0 THEN
        FOREACH v_target_domain IN ARRAY v_target_domains LOOP
            v_domain_inbox := 'https://' || v_target_domain || '/inbox';
            
            INSERT INTO federation_delivery_queue (
                activity_data,
                target_domain,
                target_inbox_url,
                actor_username,
                actor_domain,
                status,
                priority,
                attempts,
                next_attempt_at
            ) VALUES (
                v_activity,
                v_target_domain,
                v_domain_inbox,
                v_author.username,
                v_instance_domain,
                'pending',
                5,
                0,
                NOW()
            );
        END LOOP;
        
        RAISE LOG 'Queued post % for federation to % domains', NEW.id, array_length(v_target_domains, 1);
        
        -- Update federation status
        UPDATE posts SET federation_status = 'federated' WHERE id = NEW.id;
    END IF;
    
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'Error in handle_post_federation for post %: % %', NEW.id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.handle_post_federation() IS 
    'Handles automatic federation of new local posts. Queues Create activities to federation_delivery_queue.';


-- =====================================================
-- STEP 3: Create trigger on posts table
-- =====================================================

-- Drop existing trigger if it exists (to make migration idempotent)
DROP TRIGGER IF EXISTS trigger_post_federation ON public.posts;

-- Create trigger for new posts
CREATE TRIGGER trigger_post_federation
    AFTER INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_post_federation();

COMMENT ON TRIGGER trigger_post_federation ON public.posts IS 
    'Automatically federates new local public/unlisted posts to remote instances.';


-- =====================================================
-- STEP 4: Grant necessary permissions
-- =====================================================

GRANT EXECUTE ON FUNCTION public.build_post_create_activity(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_post_federation() TO authenticated;

