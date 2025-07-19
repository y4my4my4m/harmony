-- =====================================================
-- HARMONY DATABASE REFACTOR - PHASE 6: REACTIONS FEDERATION FIX
-- Fix ActivityPub constraint violations and implement Pleroma/Misskey compatibility
-- =====================================================

BEGIN;

-- =====================================================
-- STEP 1: FIX CONSTRAINT VIOLATION - Use Standard ActivityPub Types
-- =====================================================

-- Update the reactions federation function to use 'Like' instead of 'EmojiReact'
-- This follows W3C ActivityPub standards while remaining compatible with Pleroma/Misskey
CREATE OR REPLACE FUNCTION public.handle_reactions_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    message_type text;
    message_data record;
BEGIN
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;

    -- Check federation for reaction user
    SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Get message data to determine if this should be federated
    SELECT m.*, c.server_id, cv.id as conversation_id
    INTO message_data
    FROM messages m
    LEFT JOIN channels c ON m.channel_id = c.id
    LEFT JOIN conversations cv ON m.conversation_id = cv.id
    WHERE m.id = COALESCE(NEW.message_id, OLD.message_id);

    -- Determine message type for federation decision
    IF message_data.conversation_id IS NOT NULL THEN
        message_type := 'dm';
    ELSIF message_data.channel_id IS NOT NULL THEN
        message_type := 'chat';
    ELSE
        message_type := 'unknown';
    END IF;

    -- LOCAL-FIRST LOGIC: Only federate DM reactions, not chat reactions
    IF message_type = 'chat' THEN
        -- Chat reactions stay local, no federation
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Only federate DM and post reactions
    IF TG_OP = 'INSERT' THEN
        activity_type := 'Like';  -- ✅ Use standard W3C ActivityPub type
        target_object_id := (SELECT 'message-' || NEW.message_id);
        -- Get message author
        SELECT user_id INTO target_actor_id FROM messages WHERE id = NEW.message_id;
    ELSIF TG_OP = 'DELETE' THEN
        activity_type := 'Undo';  -- ✅ Standard AP Undo activity
        target_object_id := (SELECT 'message-' || OLD.message_id);
        SELECT user_id INTO target_actor_id FROM messages WHERE id = OLD.message_id;
    END IF;

    -- Create ActivityPub activity for federation (DMs only)
    IF activity_type IS NOT NULL AND target_object_id IS NOT NULL AND message_type = 'dm' THEN
        -- Get emoji data for proper ActivityPub formatting
        DECLARE
            emoji_data record;
            reaction_content text;
            activity_content jsonb;
        BEGIN
            -- Get emoji information
            SELECT e.name, e.url INTO emoji_data
            FROM emojis e 
            WHERE e.id = COALESCE(NEW.emoji_id, OLD.emoji_id);

            -- Format reaction content for Pleroma/Misskey compatibility
            IF emoji_data.name IS NOT NULL THEN
                reaction_content := ':' || emoji_data.name || ':';
            ELSE
                reaction_content := '👍'; -- fallback
            END IF;

            -- Build ActivityPub Like activity with content (Pleroma/Misskey compatible)
            activity_content := jsonb_build_object(
                'type', activity_type,
                'actor', (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
                'object', target_object_id,
                'content', reaction_content,
                'tag', CASE 
                    WHEN emoji_data.name IS NOT NULL AND emoji_data.url IS NOT NULL THEN
                        jsonb_build_array(
                            jsonb_build_object(
                                'type', 'Emoji',
                                'name', reaction_content,
                                'icon', jsonb_build_object(
                                    'type', 'Image',
                                    'url', emoji_data.url
                                ),
                                'id', 'https://' || current_instance_domain || '/emojis/' || COALESCE(NEW.emoji_id, OLD.emoji_id)
                            )
                        )
                    ELSE '[]'::jsonb
                END
            );

            INSERT INTO ap_activities (
                ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                target_id, target_type, activity_data, status, is_local
            ) VALUES (
                current_instance_domain || '/activities/' || gen_random_uuid(),
                activity_type,  -- 'Like' or 'Undo' - both are valid in constraint
                COALESCE(NEW.user_id, OLD.user_id),
                (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
                target_object_id, 'Note', target_actor_id, 'Person',
                activity_content,
                'pending', true
            );
        END;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_reactions_federation IS 'OUTGOING ONLY: Federate DM reactions as ActivityPub Like activities with custom emoji support. Chat reactions stay local. Pleroma/Misskey compatible.';

-- =====================================================
-- STEP 2: ADD POST REACTIONS FEDERATION SUPPORT
-- =====================================================

-- Create federation function for post reactions (similar to messages but for posts)
CREATE OR REPLACE FUNCTION public.handle_post_reactions_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    emoji_data record;
    reaction_content text;
    activity_content jsonb;
BEGIN
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;

    -- Check federation for reaction user
    SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Only process emoji reactions for federation
    IF COALESCE(NEW.interaction_type, OLD.interaction_type) != 'emoji_reaction' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'INSERT' THEN
        activity_type := 'Like';
        target_object_id := (SELECT 'post-' || NEW.post_id);
        SELECT user_id INTO target_actor_id FROM posts WHERE id = NEW.post_id;
    ELSIF TG_OP = 'DELETE' THEN
        activity_type := 'Undo';
        target_object_id := (SELECT 'post-' || OLD.post_id);
        SELECT user_id INTO target_actor_id FROM posts WHERE id = OLD.post_id;
    END IF;

    -- Get emoji information for proper federation
    IF COALESCE(NEW.emoji_id, OLD.emoji_id) IS NOT NULL THEN
        SELECT e.name, e.url INTO emoji_data
        FROM emojis e 
        WHERE e.id = COALESCE(NEW.emoji_id, OLD.emoji_id);
        
        reaction_content := ':' || emoji_data.name || ':';
    ELSIF COALESCE(NEW.custom_emoji_content, OLD.custom_emoji_content) IS NOT NULL THEN
        reaction_content := COALESCE(NEW.custom_emoji_content, OLD.custom_emoji_content);
    ELSE
        reaction_content := '👍'; -- fallback
    END IF;

    -- Build Pleroma/Misskey compatible ActivityPub Like with emoji content
    activity_content := jsonb_build_object(
        'type', activity_type,
        'actor', (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
        'object', target_object_id,
        'content', reaction_content,
        'tag', CASE 
            WHEN emoji_data.name IS NOT NULL AND emoji_data.url IS NOT NULL THEN
                jsonb_build_array(
                    jsonb_build_object(
                        'type', 'Emoji',
                        'name', reaction_content,
                        'icon', jsonb_build_object(
                            'type', 'Image',
                            'url', emoji_data.url
                        ),
                        'id', 'https://' || current_instance_domain || '/emojis/' || COALESCE(NEW.emoji_id, OLD.emoji_id)
                    )
                )
            ELSE '[]'::jsonb
        END
    );

    -- Create ActivityPub activity for federation
    INSERT INTO ap_activities (
        ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
        target_id, target_type, activity_data, status, is_local
    ) VALUES (
        current_instance_domain || '/activities/' || gen_random_uuid(),
        activity_type,
        COALESCE(NEW.user_id, OLD.user_id),
        (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
        target_object_id, 'Note', target_actor_id, 'Person',
        activity_content,
        'pending', true
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Create trigger for post reactions federation
DROP TRIGGER IF EXISTS handle_post_reactions_federation_trigger ON post_interactions;
CREATE TRIGGER handle_post_reactions_federation_trigger
    AFTER INSERT OR DELETE ON post_interactions
    FOR EACH ROW
    WHEN (NEW.interaction_type = 'emoji_reaction' OR OLD.interaction_type = 'emoji_reaction')
    EXECUTE FUNCTION public.handle_post_reactions_federation();

COMMENT ON FUNCTION public.handle_post_reactions_federation IS 'OUTGOING ONLY: Federate post emoji reactions as ActivityPub Like activities. Pleroma/Misskey compatible format.';

-- =====================================================
-- STEP 3: ENHANCE CUSTOM EMOJI SUPPORT FOR FEDERATION
-- =====================================================

-- Update the emoji extraction function to be more robust for federation
CREATE OR REPLACE FUNCTION public.extract_custom_emoji_for_federation(content_text text)
RETURNS TABLE(emoji_id uuid, emoji_name text, emoji_url text)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id,
        e.name,
        e.url
    FROM emojis e
    WHERE content_text ~ (':' || e.name || ':') 
       OR content_text ~ (':' || e.id::text || ':');
END;
$$;

COMMENT ON FUNCTION public.extract_custom_emoji_for_federation IS 'Extract custom emoji data from content for ActivityPub federation tags';

-- =====================================================
-- STEP 4: ADD INCOMING REACTION PROCESSING
-- =====================================================

-- Function to process incoming ActivityPub emoji reactions (from Pleroma/Misskey)
CREATE OR REPLACE FUNCTION public.process_incoming_emoji_reaction(
    activity_data jsonb,
    actor_id uuid,
    target_object_id text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    emoji_content text;
    emoji_name text;
    emoji_url text;
    emoji_id uuid;
    target_message_id uuid;
    target_post_id uuid;
    reaction_exists boolean;
BEGIN
    -- Extract emoji information from activity
    emoji_content := activity_data->>'content';
    
    -- Try to extract emoji from tags
    IF activity_data ? 'tag' AND jsonb_array_length(activity_data->'tag') > 0 THEN
        SELECT 
            (tag_item->>'name'),
            (tag_item->'icon'->>'url')
        INTO emoji_name, emoji_url
        FROM jsonb_array_elements(activity_data->'tag') AS tag_item
        WHERE tag_item->>'type' = 'Emoji'
        LIMIT 1;
        
        -- Try to find matching local emoji
        SELECT id INTO emoji_id
        FROM emojis 
        WHERE name = trim(both ':' from emoji_name)
        LIMIT 1;
    END IF;

    -- Determine target type and ID
    IF target_object_id LIKE 'message-%' THEN
        target_message_id := (regexp_match(target_object_id, 'message-(.+)'))[1]::uuid;
        
        -- Check if reaction already exists
        SELECT EXISTS(
            SELECT 1 FROM reactions 
            WHERE message_id = target_message_id 
              AND user_id = actor_id 
              AND emoji_id = COALESCE(emoji_id, (SELECT id FROM emojis WHERE name = 'thumbsup'))
        ) INTO reaction_exists;
        
        -- Add reaction if it doesn't exist
        IF NOT reaction_exists THEN
            INSERT INTO reactions (message_id, user_id, emoji_id, is_local)
            VALUES (target_message_id, actor_id, COALESCE(emoji_id, (SELECT id FROM emojis WHERE name = 'thumbsup')), false);
        END IF;
        
    ELSIF target_object_id LIKE 'post-%' THEN
        target_post_id := (regexp_match(target_object_id, 'post-(.+)'))[1]::uuid;
        
        -- Check if reaction already exists
        SELECT EXISTS(
            SELECT 1 FROM post_interactions 
            WHERE post_id = target_post_id 
              AND user_id = actor_id 
              AND interaction_type = 'emoji_reaction'
              AND emoji_id = COALESCE(emoji_id, (SELECT id FROM emojis WHERE name = 'thumbsup'))
        ) INTO reaction_exists;
        
        -- Add reaction if it doesn't exist
        IF NOT reaction_exists THEN
            INSERT INTO post_interactions (post_id, user_id, interaction_type, emoji_id, custom_emoji_content, is_local)
            VALUES (target_post_id, actor_id, 'emoji_reaction', emoji_id, emoji_content, false);
        END IF;
    END IF;
    
    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.process_incoming_emoji_reaction IS 'Process incoming ActivityPub emoji reactions from Pleroma/Misskey and other platforms';

COMMIT;