-- =====================================================
-- EMOJI REACTION FEDERATION - COMPLETE IMPLEMENTATION
-- =====================================================
-- 
-- This migration implements full bidirectional federation for emoji reactions
-- 
-- FEATURES:
-- - Outgoing reactions: Local reactions federated to ActivityPub network
-- - Incoming reactions: Remote ActivityPub reactions processed and stored
-- - Custom emoji support: Both local and federated custom emojis
-- - Unicode emoji support: Standard unicode emojis work seamlessly  
-- - Misskey compatibility: Special _misskey_reaction field for better integration
-- - Mastodon/Pleroma support: Standard ActivityPub EmojiReact activities
-- - Unique activity IDs: Prevents reaction conflicts and overwrites
-- - Domain-aware emoji storage: Federated emojis stored with source domain
-- - Real-time federation: Automatic trigger-based federation on reaction changes
-- 
-- BEHAVIOR:
-- - One reaction per user per post (standard ActivityPub behavior)
-- - Each reaction generates individual ActivityPub activity
-- - Reactions on local posts are federated to known instances
-- - Remote reactions on local posts are accepted and displayed
-- - Emoji names are clean (no @domain suffixes in federation)
-- 
-- Run this migration to add federation support for emoji reactions

-- =====================================================
-- ADD DOMAIN COLUMN TO EMOJIS TABLE
-- =====================================================

-- Add domain column to emojis table to support federated emojis
ALTER TABLE emojis ADD COLUMN IF NOT EXISTS domain text;

-- Create index for efficient lookups of federated emojis
CREATE INDEX IF NOT EXISTS idx_emojis_domain_name ON emojis(domain, name);

-- Create unique constraint to prevent duplicate emojis from same domain
-- For local emojis (domain IS NULL), allow duplicates for now since they might exist
-- For federated emojis (domain IS NOT NULL), enforce uniqueness per domain
CREATE UNIQUE INDEX IF NOT EXISTS idx_emojis_unique_federated_domain_name 
ON emojis(domain, name) 
WHERE domain IS NOT NULL;

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
    SELECT config_value::text INTO v_instance_domain
    FROM instance_config 
    WHERE config_key = 'domain';
    
    -- Remove JSON quotes if present
    v_instance_domain := trim(both '"' from v_instance_domain);
    
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
    
    -- Handle emoji information first to build a specific activity ID
    IF p_emoji_id IS NOT NULL THEN
        -- Custom server emoji
        SELECT * INTO v_emoji_info
        FROM emojis
        WHERE id = p_emoji_id;
        
        IF FOUND THEN
            -- Use the clean emoji name for federation
            v_reaction_content := ':' || v_emoji_info.name || ':';
            v_emoji_object := jsonb_build_object(
                'type', 'Emoji',
                'name', ':' || v_emoji_info.name || ':',
                'icon', jsonb_build_object(
                    'type', 'Image',
                    'url', v_emoji_info.url,
                    'mediaType', 'image/png'
                )
            );
            
            -- Build activity ID with emoji name for uniqueness
            v_activity_id := v_sender_url || '#emoji-reaction-' || v_emoji_info.name || '-' || p_interaction_id;
        ELSE
            RAISE EXCEPTION 'Custom emoji not found: %', p_emoji_id;
        END IF;
    ELSIF p_custom_emoji_content IS NOT NULL THEN
        -- Unicode or text emoji
        v_reaction_content := p_custom_emoji_content;
        v_emoji_object := NULL;
        
        -- Build activity ID with emoji content for uniqueness  
        v_activity_id := v_sender_url || '#emoji-reaction-' || 
            regexp_replace(p_custom_emoji_content, '[^a-zA-Z0-9]', '', 'g') || '-' || p_interaction_id;
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
        -- Get sender profile details for federation
        DECLARE
            v_sender_profile RECORD;
            v_instance_domain text;
        BEGIN
            -- Get sender profile
            SELECT * INTO v_sender_profile 
            FROM profiles 
            WHERE id = v_interaction_record.user_id AND is_local = true;
            
            IF NOT FOUND THEN
                RAISE LOG 'Sender profile not found for reaction federation: %', v_interaction_record.user_id;
                RETURN COALESCE(NEW, OLD);
            END IF;
            
            -- Get instance domain
            SELECT config_value::text INTO v_instance_domain
            FROM instance_config 
            WHERE config_key = 'domain';
            
            -- Remove JSON quotes if present
            v_instance_domain := trim(both '"' from v_instance_domain);
            
            v_activity := build_emoji_reaction_activity(
                v_interaction_record.id,
                v_interaction_record.user_id,
                v_interaction_record.post_id,
                v_interaction_record.emoji_id,
                v_interaction_record.custom_emoji_content,
                v_is_undo
            );
            
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
            
            -- Add to federation delivery queue (one row per target domain)
            IF array_length(v_target_domains, 1) > 0 THEN
                -- Get sender profile details for actor fields
                DECLARE
                    v_domain_inbox text;
                    v_target_domain text;
                BEGIN
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
                            v_sender_profile.username,
                            v_instance_domain,
                            'pending',
                            5,
                            0,
                            NOW()
                        );
                    END LOOP;
                    
                    RAISE LOG 'Queued emoji reaction federation to % domains', 
                        array_length(v_target_domains, 1);
                END;
            END IF;
        END;
        
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

-- Function to resolve ActivityPub emoji to local emoji_id (creating if needed)
CREATE OR REPLACE FUNCTION resolve_activitypub_emoji(
    p_emoji_tag jsonb,
    p_content text,
    p_actor_domain text
) RETURNS TABLE(emoji_id uuid, custom_emoji_content text)
LANGUAGE plpgsql
AS $$
DECLARE
    v_emoji_name text;
    v_emoji_url text;
    v_local_emoji_id uuid;
    v_custom_content text;
BEGIN
    -- Handle custom emoji from tag (Mastodon/Pleroma style)
    IF p_emoji_tag IS NOT NULL AND p_emoji_tag->>'type' = 'Emoji' THEN
        v_emoji_name := p_emoji_tag->>'name';
        v_emoji_url := p_emoji_tag->'icon'->>'url';
        
        -- Remove colons from emoji name if present
        v_emoji_name := trim(both ':' from v_emoji_name);
        
        -- Try to find existing federated emoji
        SELECT id INTO v_local_emoji_id
        FROM emojis
        WHERE name = v_emoji_name AND domain = p_actor_domain;
        
        IF v_local_emoji_id IS NULL THEN
            -- Try to create new federated emoji
            BEGIN
                INSERT INTO emojis (name, url, domain, usage_count, last_used)
                VALUES (v_emoji_name, v_emoji_url, p_actor_domain, 1, NOW())
                RETURNING id INTO v_local_emoji_id;
            EXCEPTION WHEN unique_violation THEN
                -- Another process created the same emoji, find it
                SELECT id INTO v_local_emoji_id
                FROM emojis
                WHERE name = v_emoji_name AND domain = p_actor_domain;
                
                IF v_local_emoji_id IS NOT NULL THEN
                    -- Update usage stats and URL for existing emoji
                    UPDATE emojis 
                    SET usage_count = usage_count + 1, 
                        last_used = NOW(),
                        url = v_emoji_url  -- Update URL in case it changed
                    WHERE id = v_local_emoji_id;
                END IF;
            END;
        ELSE
            -- Update usage stats for existing emoji
            UPDATE emojis 
            SET usage_count = usage_count + 1, last_used = NOW()
            WHERE id = v_local_emoji_id;
        END IF;
        
        emoji_id := v_local_emoji_id;
        custom_emoji_content := NULL;
        RETURN NEXT;
        RETURN;
    END IF;
    
    -- Handle unicode emoji content or shortcodes
    IF p_content IS NOT NULL AND length(p_content) > 0 THEN
        -- Check if it's a simple unicode emoji (common case)
        IF length(p_content) <= 4 AND p_content ~ '^[\x{1F600}-\x{1F64F}\x{1F300}-\x{1F5FF}\x{1F680}-\x{1F6FF}\x{1F1E0}-\x{1F1FF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}]+$' THEN
            emoji_id := NULL;
            custom_emoji_content := p_content;
            RETURN NEXT;
            RETURN;
        END IF;
        
        -- Handle shortcode format like :emoji_name: (could be local or from Misskey)
        IF p_content ~ '^:[a-zA-Z0-9_]+:$' THEN
            v_emoji_name := trim(both ':' from p_content);
            
            -- First try to find federated emoji from this domain
            SELECT id INTO v_local_emoji_id
            FROM emojis
            WHERE name = v_emoji_name AND domain = p_actor_domain;
            
            -- If not found, try to find local emoji
            IF v_local_emoji_id IS NULL THEN
                SELECT id INTO v_local_emoji_id
                FROM emojis
                WHERE name = v_emoji_name AND domain IS NULL;
            END IF;
            
            IF v_local_emoji_id IS NOT NULL THEN
                -- Found existing emoji (local or federated)
                UPDATE emojis 
                SET usage_count = usage_count + 1, last_used = NOW()
                WHERE id = v_local_emoji_id;
                
                emoji_id := v_local_emoji_id;
                custom_emoji_content := NULL;
                RETURN NEXT;
                RETURN;
            ELSE
                -- Store as custom content if no emoji found
                emoji_id := NULL;
                custom_emoji_content := p_content;
                RETURN NEXT;
                RETURN;
            END IF;
        END IF;
        
        -- Fallback: store content as-is for unicode emojis
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
    v_rows_affected integer;
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
    
    -- Find or create the actor profile
    SELECT * INTO v_actor_profile
    FROM profiles
    WHERE federated_id = p_actor_uri;
    
    IF NOT FOUND THEN
        -- Actor doesn't exist, create it by fetching from remote
        DECLARE
            v_actor_response jsonb;
            v_actor_username text;
            v_actor_domain text;
            v_new_profile_id uuid;
        BEGIN
            -- Parse domain from actor URI
            v_actor_domain := split_part(split_part(p_actor_uri, '://', 2), '/', 1);
            
            -- Try to extract username from URI path
            v_actor_username := split_part(p_actor_uri, '/', array_length(string_to_array(p_actor_uri, '/'), 1));
            
            -- Create a basic federated profile for this actor
            SELECT create_federated_profile(
                p_username := COALESCE(v_actor_username, 'unknown'),
                p_display_name := COALESCE(v_actor_username, 'Remote User'),
                p_domain := v_actor_domain,
                p_federated_id := p_actor_uri,
                p_bio := 'Federated ActivityPub user'
            ) INTO v_new_profile_id;
            
            -- Now fetch the created profile
            SELECT * INTO v_actor_profile
            FROM profiles
            WHERE id = v_new_profile_id;
            
            RAISE LOG 'Created federated profile for actor: % (id: %)', p_actor_uri, v_new_profile_id;
        EXCEPTION WHEN OTHERS THEN
            RAISE LOG 'Failed to create federated profile for actor: % - %', p_actor_uri, SQLERRM;
            RETURN false;
        END;
    END IF;
    
    -- Find the target post
    SELECT * INTO v_target_post
    FROM posts
    WHERE ap_id = v_object_id 
       OR id::text = v_object_id
       OR (v_object_id ~ '^https?://[^/]+/posts/([a-f0-9-]{36})$' 
           AND id::text = substring(v_object_id from '^https?://[^/]+/posts/([a-f0-9-]{36})$'));
    
    IF NOT FOUND THEN
        RAISE LOG 'Target post not found for emoji reaction: % (checked ap_id and extracted UUID)', v_object_id;
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
        
        GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
        
        IF v_rows_affected > 0 THEN
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
        ON CONFLICT (ap_id) DO NOTHING;
        
        GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
        
        IF v_rows_affected > 0 THEN
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
COMMENT ON FUNCTION resolve_activitypub_emoji IS 'Resolves ActivityPub emoji tags and content to local emoji_id by creating federated emoji records as needed. Handles custom emojis, unicode emojis, and shortcodes.';
COMMENT ON FUNCTION process_incoming_emoji_reaction IS 'Processes incoming EmojiReact and Like activities from ActivityPub federation. Handles both creation and removal (Undo) of emoji reactions.';
COMMENT ON TRIGGER trigger_post_interaction_federation ON post_interactions IS 'Automatically federates emoji reactions to ActivityPub network when users add/remove reactions.';

-- =====================================================
-- VERIFICATION AND SUCCESS
-- =====================================================

-- Verify that all functions were created successfully
DO $$
BEGIN
    -- Check that all required functions exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'build_emoji_reaction_activity'
    ) THEN
        RAISE EXCEPTION 'Function build_emoji_reaction_activity was not created';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'handle_post_interaction_federation'
    ) THEN
        RAISE EXCEPTION 'Function handle_post_interaction_federation was not created';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'resolve_activitypub_emoji'
    ) THEN
        RAISE EXCEPTION 'Function resolve_activitypub_emoji was not created';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'process_incoming_emoji_reaction'
    ) THEN
        RAISE EXCEPTION 'Function process_incoming_emoji_reaction was not created';
    END IF;
    
    -- Check that trigger exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers 
        WHERE trigger_name = 'trigger_post_interaction_federation'
    ) THEN
        RAISE EXCEPTION 'Trigger trigger_post_interaction_federation was not created';
    END IF;
    
    -- Check that domain column was added to emojis table
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'emojis' AND column_name = 'domain'
    ) THEN
        RAISE EXCEPTION 'Domain column was not added to emojis table';
    END IF;
    
    RAISE NOTICE '✅ Emoji reaction federation migration completed successfully!';
    RAISE NOTICE '📡 All functions, triggers, and schema changes are in place';
    RAISE NOTICE '🎉 Emoji reactions will now federate to/from ActivityPub network';
END;
$$;
