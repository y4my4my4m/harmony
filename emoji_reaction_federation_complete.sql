-- Complete emoji reaction federation implementation
-- Run this migration to add federation support for emoji reactions

-- =====================================================
-- OUTGOING REACTION FEDERATION
-- =====================================================

-- Function to build ActivityPub EmojiReact activity from local reaction
CREATE OR REPLACE FUNCTION build_emoji_reaction_activity(
    p_interaction_id uuid,
    p_user_id uuid,
    p_post_id uuid,
    p_emoji_id uuid DEFAULT NULL,
    p_custom_emoji_content text DEFAULT NULL,
    p_is_undo boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_sender_profile RECORD;
    v_target_post RECORD;
    v_instance_domain text;
    v_emoji_info RECORD;
    v_activity_id text;
    v_sender_url text;
    v_post_url text;
    v_activity jsonb;
    v_emoji_object jsonb;
    v_reaction_content text;
BEGIN
    -- Get instance domain
    SELECT config_value->>'domain' INTO v_instance_domain
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    -- Get sender profile
    SELECT * INTO v_sender_profile 
    FROM profiles 
    WHERE id = p_user_id AND is_local = true;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Local user profile not found: %', p_user_id;
    END IF;
    
    -- Get target post
    SELECT * INTO v_target_post
    FROM posts
    WHERE id = p_post_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target post not found: %', p_post_id;
    END IF;
    
    -- Build URLs
    v_sender_url := 'https://' || v_instance_domain || '/users/' || v_sender_profile.username;
    v_post_url := COALESCE(v_target_post.ap_id, 'https://' || v_instance_domain || '/posts/' || v_target_post.id);
    v_activity_id := v_sender_url || '#emoji-reaction-' || p_interaction_id;
    
    -- Handle emoji information
    IF p_emoji_id IS NOT NULL THEN
        -- Custom server emoji
        SELECT * INTO v_emoji_info
        FROM emojis
        WHERE id = p_emoji_id;
        
        IF FOUND THEN
            v_reaction_content := ':' || v_emoji_info.name || ':';
            v_emoji_object := jsonb_build_object(
                'type', 'Emoji',
                'name', ':' || v_emoji_info.name || ':',
                'icon', jsonb_build_object(
                    'type', 'Image',
                    'url', v_emoji_info.url,
                    'mediaType', COALESCE(v_emoji_info.content_type, 'image/png')
                )
            );
        ELSE
            RAISE EXCEPTION 'Custom emoji not found: %', p_emoji_id;
        END IF;
    ELSIF p_custom_emoji_content IS NOT NULL THEN
        -- Unicode or text emoji
        v_reaction_content := p_custom_emoji_content;
        v_emoji_object := NULL;
    ELSE
        RAISE EXCEPTION 'Either emoji_id or custom_emoji_content must be provided';
    END IF;
    
    -- Build the ActivityPub activity
    IF p_is_undo THEN
        -- Undo activity for reaction removal
        v_activity := jsonb_build_object(
            '@context', 'https://www.w3.org/ns/activitystreams',
            'id', v_activity_id || '-undo',
            'type', 'Undo',
            'actor', v_sender_url,
            'published', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'object', jsonb_build_object(
                'id', v_activity_id,
                'type', 'EmojiReact',
                'actor', v_sender_url,
                'object', v_post_url,
                'content', v_reaction_content
            )
        );
    ELSE
        -- Create EmojiReact activity
        v_activity := jsonb_build_object(
            '@context', jsonb_build_array(
                'https://www.w3.org/ns/activitystreams',
                jsonb_build_object(
                    'EmojiReact', 'as:EmojiReact',
                    'toot', 'http://joinmastodon.org/ns#',
                    'Emoji', 'toot:Emoji'
                )
            ),
            'id', v_activity_id,
            'type', 'EmojiReact',
            'actor', v_sender_url,
            'object', v_post_url,
            'published', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'content', v_reaction_content
        );
        
        -- Add custom emoji tag if present
        IF v_emoji_object IS NOT NULL THEN
            v_activity := v_activity || jsonb_build_object(
                'tag', jsonb_build_array(v_emoji_object)
            );
        END IF;
        
        -- Add Misskey compatibility field
        v_activity := v_activity || jsonb_build_object(
            '_misskey_reaction', v_reaction_content
        );
    END IF;
    
    RETURN v_activity;
END;
$$;

-- Function to handle federation of post interactions (reactions)
CREATE OR REPLACE FUNCTION handle_post_interaction_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_activity jsonb;
    v_target_post RECORD;
    v_target_domains text[];
    v_activity_id text;
    v_is_undo boolean := false;
    v_interaction_record RECORD;
BEGIN
    -- Only process emoji reactions
    IF COALESCE(NEW.interaction_type, OLD.interaction_type) != 'emoji_reaction' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Determine if this is an undo (DELETE) or create (INSERT)
    IF TG_OP = 'DELETE' THEN
        v_is_undo := true;
        v_interaction_record := OLD;
    ELSE
        v_interaction_record := NEW;
    END IF;
    
    -- Get target post info
    SELECT * INTO v_target_post
    FROM posts
    WHERE id = v_interaction_record.post_id;
    
    IF NOT FOUND THEN
        RAISE LOG 'Target post not found for reaction federation: %', v_interaction_record.post_id;
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Only federate reactions on local posts or when we're the actor
    -- (Don't relay reactions on remote posts to avoid loops)
    IF NOT v_target_post.is_local THEN
        RAISE LOG 'Skipping federation for reaction on remote post: %', v_target_post.id;
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Build ActivityPub activity
    BEGIN
        v_activity := build_emoji_reaction_activity(
            v_interaction_record.id,
            v_interaction_record.user_id,
            v_interaction_record.post_id,
            v_interaction_record.emoji_id,
            v_interaction_record.custom_emoji_content,
            v_is_undo
        );
        
        v_activity_id := v_activity->>'id';
        
        -- Determine target domains for federation
        -- For now, federate to all known instances that might be interested
        SELECT ARRAY(
            SELECT DISTINCT domain
            FROM profiles 
            WHERE domain IS NOT NULL 
            AND domain != ''
            AND is_local = false
            LIMIT 50  -- Reasonable limit to avoid overwhelming the system
        ) INTO v_target_domains;
        
        -- Add to federation delivery queue
        IF array_length(v_target_domains, 1) > 0 THEN
            INSERT INTO federation_delivery_queue (
                activity_id,
                activity_type,
                activity_data,
                target_domains,
                actor_id,
                object_id,
                object_type,
                priority,
                max_attempts,
                status,
                metadata
            ) VALUES (
                v_activity_id,
                CASE WHEN v_is_undo THEN 'Undo' ELSE 'EmojiReact' END,
                v_activity,
                v_target_domains,
                v_interaction_record.user_id,
                v_target_post.id,
                'Note',
                'normal',
                5,
                'pending',
                jsonb_build_object(
                    'reaction_type', CASE 
                        WHEN v_interaction_record.emoji_id IS NOT NULL THEN 'custom_emoji' 
                        ELSE 'unicode_emoji' 
                    END,
                    'emoji_content', COALESCE(
                        (SELECT ':' || name || ':' FROM emojis WHERE id = v_interaction_record.emoji_id),
                        v_interaction_record.custom_emoji_content
                    ),
                    'post_visibility', v_target_post.visibility,
                    'federation_scope', 'public'
                )
            );
            
            RAISE LOG 'Queued emoji reaction federation: % to % domains', 
                v_activity_id, array_length(v_target_domains, 1);
        END IF;
        
    EXCEPTION WHEN OTHERS THEN
        -- Log error but don't block the interaction
        RAISE LOG 'Failed to federate emoji reaction: %', SQLERRM;
    END;
    
    RETURN COALESCE(NEW, OLD);
END;
$$;

-- =====================================================
-- INCOMING REACTION FEDERATION  
-- =====================================================

-- Function to resolve ActivityPub emoji to local emoji_id or custom content
CREATE OR REPLACE FUNCTION resolve_activitypub_emoji(
    p_emoji_tag jsonb,
    p_content text,
    p_actor_domain text
) RETURNS TABLE(emoji_id uuid, custom_emoji_content text)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_emoji_name text;
    v_emoji_url text;
    v_local_emoji_id uuid;
    v_custom_content text;
BEGIN
    -- Handle custom emoji from tag
    IF p_emoji_tag IS NOT NULL AND p_emoji_tag->>'type' = 'Emoji' THEN
        v_emoji_name := p_emoji_tag->>'name';
        v_emoji_url := p_emoji_tag->'icon'->>'url';
        
        -- Remove colons from emoji name if present
        v_emoji_name := trim(both ':' from v_emoji_name);
        
        -- Try to find matching local emoji by name
        SELECT id INTO v_local_emoji_id
        FROM emojis
        WHERE name = v_emoji_name
        AND (domain IS NULL OR domain = p_actor_domain)
        LIMIT 1;
        
        IF v_local_emoji_id IS NOT NULL THEN
            -- Found local emoji match
            emoji_id := v_local_emoji_id;
            custom_emoji_content := NULL;
            RETURN NEXT;
            RETURN;
        ELSE
            -- Store as custom emoji with domain prefix for uniqueness
            v_custom_content := ':' || v_emoji_name || '@' || p_actor_domain || ':';
            emoji_id := NULL;
            custom_emoji_content := v_custom_content;
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;
    
    -- Handle unicode emoji content
    IF p_content IS NOT NULL AND length(p_content) > 0 THEN
        -- Check if it's a simple unicode emoji (common case)
        IF length(p_content) <= 4 AND p_content ~ '^[\x{1F600}-\x{1F64F}\x{1F300}-\x{1F5FF}\x{1F680}-\x{1F6FF}\x{1F1E0}-\x{1F1FF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}]+$' THEN
            emoji_id := NULL;
            custom_emoji_content := p_content;
            RETURN NEXT;
            RETURN;
        END IF;
        
        -- Handle shortcode format like :emoji_name:
        IF p_content ~ '^:[a-zA-Z0-9_]+:$' THEN
            v_emoji_name := trim(both ':' from p_content);
            
            -- Try to find local emoji
            SELECT id INTO v_local_emoji_id
            FROM emojis
            WHERE name = v_emoji_name
            AND domain IS NULL  -- Local emojis only
            LIMIT 1;
            
            IF v_local_emoji_id IS NOT NULL THEN
                emoji_id := v_local_emoji_id;
                custom_emoji_content := NULL;
                RETURN NEXT;
                RETURN;
            ELSE
                -- Store as-is if no local match
                emoji_id := NULL;
                custom_emoji_content := p_content;
                RETURN NEXT;
                RETURN;
            END IF;
        END IF;
        
        -- Fallback: store content as-is
        emoji_id := NULL;
        custom_emoji_content := p_content;
        RETURN NEXT;
        RETURN;
    END IF;
    
    -- No valid emoji found
    RAISE EXCEPTION 'No valid emoji content provided';
END;
$$;

-- Function to process incoming emoji reaction activities
CREATE OR REPLACE FUNCTION process_incoming_emoji_reaction(
    p_activity_id text,
    p_activity jsonb,
    p_actor_uri text,
    p_actor_domain text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_actor_profile RECORD;
    v_target_post RECORD;
    v_object_id text;
    v_emoji_content text;
    v_emoji_tag jsonb;
    v_emoji_resolution RECORD;
    v_existing_reaction_id uuid;
    v_is_undo boolean := false;
    v_inner_object jsonb;
BEGIN
    -- Handle Undo activities
    IF p_activity->>'type' = 'Undo' THEN
        v_is_undo := true;
        v_inner_object := p_activity->'object';
        
        -- Extract info from the undone activity
        IF v_inner_object->>'type' IN ('EmojiReact', 'Like') THEN
            v_object_id := v_inner_object->>'object';
            v_emoji_content := v_inner_object->>'content';
            v_emoji_tag := CASE 
                WHEN jsonb_array_length(COALESCE(v_inner_object->'tag', '[]'::jsonb)) > 0 
                THEN v_inner_object->'tag'->0 
                ELSE NULL 
            END;
        ELSE
            RAISE LOG 'Unknown object type in Undo activity: %', v_inner_object->>'type';
            RETURN false;
        END IF;
    ELSIF p_activity->>'type' IN ('EmojiReact', 'Like') THEN
        -- Direct reaction activity
        v_object_id := p_activity->>'object';
        v_emoji_content := COALESCE(
            p_activity->>'content',
            p_activity->>'_misskey_reaction'  -- Misskey compatibility
        );
        v_emoji_tag := CASE 
            WHEN jsonb_array_length(COALESCE(p_activity->'tag', '[]'::jsonb)) > 0 
            THEN p_activity->'tag'->0 
            ELSE NULL 
        END;
    ELSE
        RAISE LOG 'Unsupported activity type for emoji reaction: %', p_activity->>'type';
        RETURN false;
    END IF;
    
    -- Validate required fields
    IF v_object_id IS NULL THEN
        RAISE LOG 'Missing object ID in emoji reaction activity';
        RETURN false;
    END IF;
    
    IF v_emoji_content IS NULL AND v_emoji_tag IS NULL THEN
        RAISE LOG 'Missing emoji content and tag in reaction activity';
        RETURN false;
    END IF;
    
    -- Find the actor profile (must exist from previous processing)
    SELECT * INTO v_actor_profile
    FROM profiles
    WHERE federated_id = p_actor_uri OR ap_id = p_actor_uri;
    
    IF NOT FOUND THEN
        RAISE LOG 'Actor profile not found for emoji reaction: %', p_actor_uri;
        RETURN false;
    END IF;
    
    -- Find the target post
    SELECT * INTO v_target_post
    FROM posts
    WHERE ap_id = v_object_id OR id::text = v_object_id;
    
    IF NOT FOUND THEN
        RAISE LOG 'Target post not found for emoji reaction: %', v_object_id;
        RETURN false;
    END IF;
    
    -- Only process reactions on local posts
    IF NOT v_target_post.is_local THEN
        RAISE LOG 'Ignoring reaction on remote post: %', v_target_post.id;
        RETURN true;  -- Not an error, just not our concern
    END IF;
    
    -- Resolve the emoji
    BEGIN
        SELECT * INTO v_emoji_resolution
        FROM resolve_activitypub_emoji(v_emoji_tag, v_emoji_content, p_actor_domain)
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'Failed to resolve emoji for reaction: %', SQLERRM;
        RETURN false;
    END;
    
    IF v_is_undo THEN
        -- Remove existing reaction
        DELETE FROM post_interactions
        WHERE user_id = v_actor_profile.id
        AND post_id = v_target_post.id
        AND interaction_type = 'emoji_reaction'
        AND (
            (emoji_id = v_emoji_resolution.emoji_id) OR
            (emoji_id IS NULL AND custom_emoji_content = v_emoji_resolution.custom_emoji_content)
        );
        
        GET DIAGNOSTICS v_existing_reaction_id = ROW_COUNT;
        
        IF v_existing_reaction_id > 0 THEN
            RAISE LOG 'Removed federated emoji reaction: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        ELSE
            RAISE LOG 'No matching reaction found to remove: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        END IF;
        
        RETURN true;
    ELSE
        -- Add new reaction (if not already exists)
        INSERT INTO post_interactions (
            user_id,
            post_id,
            interaction_type,
            emoji_id,
            custom_emoji_content,
            ap_id,
            is_local,
            metadata
        ) VALUES (
            v_actor_profile.id,
            v_target_post.id,
            'emoji_reaction',
            v_emoji_resolution.emoji_id,
            v_emoji_resolution.custom_emoji_content,
            p_activity_id,
            false,  -- This is a federated reaction
            jsonb_build_object(
                'activity_id', p_activity_id,
                'actor_uri', p_actor_uri,
                'actor_domain', p_actor_domain,
                'original_content', v_emoji_content,
                'federation_source', 'activitypub',
                'processed_at', NOW()
            )
        )
        ON CONFLICT (user_id, post_id, interaction_type, COALESCE(emoji_id::text, ''), COALESCE(custom_emoji_content, ''))
        DO NOTHING;  -- Ignore duplicates
        
        GET DIAGNOSTICS v_existing_reaction_id = ROW_COUNT;
        
        IF v_existing_reaction_id > 0 THEN
            RAISE LOG 'Added federated emoji reaction: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        ELSE
            RAISE LOG 'Duplicate emoji reaction ignored: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        END IF;
        
        RETURN true;
    END IF;
END;
$$;

-- Function to check if an activity is an emoji reaction
CREATE OR REPLACE FUNCTION is_emoji_reaction_activity(p_activity jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    -- Direct EmojiReact activity
    IF p_activity->>'type' = 'EmojiReact' THEN
        RETURN true;
    END IF;
    
    -- Like activity with emoji content (Misskey style)
    IF p_activity->>'type' = 'Like' AND (
        p_activity->>'content' IS NOT NULL OR
        p_activity->>'_misskey_reaction' IS NOT NULL
    ) THEN
        RETURN true;
    END IF;
    
    -- Undo of emoji reaction
    IF p_activity->>'type' = 'Undo' AND 
       p_activity->'object'->>'type' IN ('EmojiReact', 'Like') AND (
        p_activity->'object'->>'content' IS NOT NULL OR
        p_activity->'object'->>'_misskey_reaction' IS NOT NULL
    ) THEN
        RETURN true;
    END IF;
    
    RETURN false;
END;
$$;

-- =====================================================
-- CREATE TRIGGERS
-- =====================================================

-- Create the trigger for post interaction federation
DROP TRIGGER IF EXISTS trigger_post_interaction_federation ON post_interactions;
CREATE TRIGGER trigger_post_interaction_federation
    AFTER INSERT OR DELETE ON post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION handle_post_interaction_federation();

-- =====================================================
-- COMMENTS FOR DOCUMENTATION
-- =====================================================

COMMENT ON FUNCTION build_emoji_reaction_activity IS 'Builds ActivityPub EmojiReact activity from local emoji reaction. Supports both custom and unicode emojis with Misskey/Pleroma compatibility.';
COMMENT ON FUNCTION handle_post_interaction_federation IS 'Handles automatic federation of emoji reactions. Triggers on post_interactions INSERT/DELETE for emoji_reaction type.';
COMMENT ON FUNCTION resolve_activitypub_emoji IS 'Resolves ActivityPub emoji tags and content to local emoji_id or custom_emoji_content. Handles custom emojis, unicode emojis, and shortcodes.';
COMMENT ON FUNCTION process_incoming_emoji_reaction IS 'Processes incoming EmojiReact and Like activities from ActivityPub federation. Handles both creation and removal (Undo) of emoji reactions.';
COMMENT ON FUNCTION is_emoji_reaction_activity IS 'Checks if an ActivityPub activity is an emoji reaction (EmojiReact, Like with emoji content, or Undo thereof).';
COMMENT ON TRIGGER trigger_post_interaction_federation ON post_interactions IS 'Automatically federates emoji reactions to ActivityPub network when users add/remove reactions.';

-- =====================================================
-- VERIFICATION QUERIES (OPTIONAL)
-- =====================================================

-- Test that functions exist
SELECT 
    proname,
    pg_get_function_result(oid) as returns,
    pg_get_function_arguments(oid) as arguments
FROM pg_proc 
WHERE proname IN (
    'build_emoji_reaction_activity',
    'handle_post_interaction_federation', 
    'resolve_activitypub_emoji',
    'process_incoming_emoji_reaction',
    'is_emoji_reaction_activity'
)
ORDER BY proname;

-- Test that trigger exists
SELECT 
    trigger_name,
    event_manipulation,
    action_timing,
    action_statement
FROM information_schema.triggers 
WHERE trigger_name = 'trigger_post_interaction_federation';

-- Log successful migration
SELECT 'Emoji reaction federation functions installed successfully!' as status;
