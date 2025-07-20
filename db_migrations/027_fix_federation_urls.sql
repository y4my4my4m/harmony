-- Migration 027: Fix Federation URL Generation
-- 
-- ISSUE: ActivityPub IDs are missing https:// protocol
-- PROBLEM: current_instance_domain is "har.mony.lol" but should be "https://har.mony.lol"
-- FIX: Update all federation triggers to generate proper ActivityPub URLs

BEGIN;

-- =====================================================
-- STEP 1: Fix unified interaction federation function
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_unified_interaction_federation() 
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    user_federation_enabled boolean;
    target_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;  -- NEW: Full URL with protocol
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    actor_user_id uuid;
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;  -- NEW: Add protocol

    -- Determine the actor user ID based on table type
    IF TG_TABLE_NAME = 'follows' THEN
        actor_user_id := COALESCE(NEW.follower_id, OLD.follower_id);
    ELSE
        actor_user_id := COALESCE(NEW.user_id, OLD.user_id);
    END IF;

    -- Check federation for actor user
    SELECT is_federation_enabled_for_user(actor_user_id) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Determine activity details based on table and operation
    IF TG_TABLE_NAME = 'follows' THEN
        IF TG_OP = 'INSERT' THEN
            activity_type := 'Follow';
            target_object_id := (SELECT federated_id FROM profiles WHERE id = NEW.following_id);
            target_actor_id := NEW.following_id;
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT federated_id FROM profiles WHERE id = OLD.following_id);
            target_actor_id := OLD.following_id;
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' THEN
        -- Check federation for interaction user
        SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
        
        IF NOT user_federation_enabled THEN
            RETURN COALESCE(NEW, OLD);
        END IF;

        IF TG_OP = 'INSERT' THEN
            activity_type := CASE 
                WHEN NEW.interaction_type = 'favorite' THEN 'Like'
                WHEN NEW.interaction_type = 'reblog' THEN 'Announce' 
                ELSE 'Like'
            END;
            target_object_id := (SELECT ap_id FROM posts WHERE id = NEW.post_id);
            target_actor_id := (SELECT author_id FROM posts WHERE id = NEW.post_id);
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT ap_id FROM posts WHERE id = OLD.post_id);
            target_actor_id := (SELECT author_id FROM posts WHERE id = OLD.post_id);
        END IF;

    ELSIF TG_TABLE_NAME = 'reactions' THEN
        -- Check federation for reaction user
        SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
        
        IF NOT user_federation_enabled THEN
            RETURN COALESCE(NEW, OLD);
        END IF;

        IF TG_OP = 'INSERT' THEN
            activity_type := 'Like';  -- FIXED: Use 'Like' instead of 'EmojiReact'
            target_object_id := (SELECT 'message-' || NEW.message_id);
            -- Get message author
            SELECT user_id INTO target_actor_id FROM messages WHERE id = NEW.message_id;
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT 'message-' || OLD.message_id);
            SELECT user_id INTO target_actor_id FROM messages WHERE id = OLD.message_id;
        END IF;
    END IF;

    -- Create federation activity if we have the required data
    IF activity_type IS NOT NULL AND target_object_id IS NOT NULL AND actor_user_id IS NOT NULL THEN
        INSERT INTO ap_activities (
            ap_id,
            ap_type,
            actor_id,
            actor_ap_id, 
            object_id,
            object_type,
            target_id,
            target_type,
            activity_data,
            status,
            is_local
        ) VALUES (
            full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
            activity_type,
            actor_user_id,
            (SELECT federated_id FROM profiles WHERE id = actor_user_id),
            target_object_id,
            CASE 
                WHEN TG_TABLE_NAME = 'follows' THEN 'Person'
                WHEN TG_TABLE_NAME = 'post_interactions' THEN 'Note'
                WHEN TG_TABLE_NAME = 'reactions' THEN 'Note'
                ELSE 'Object'
            END,
            target_actor_id,
            'Person',
            jsonb_build_object(
                'type', activity_type,
                'actor', (SELECT federated_id FROM profiles WHERE id = actor_user_id),
                'object', target_object_id
            ),
            'pending',
            true
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_unified_interaction_federation() IS 'FIXED: ActivityPub URLs now include https:// protocol. Uses Like instead of EmojiReact for reactions.';

-- =====================================================
-- STEP 2: Fix unified content federation function  
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_unified_content_federation() 
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;  -- NEW: Full URL with protocol
    remote_participants uuid[];
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;  -- NEW: Add protocol

    -- Check federation for user
    SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, NEW.author_id, OLD.user_id, OLD.author_id)) 
    INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_TABLE_NAME = 'posts' THEN
        -- Handle post federation
        IF TG_OP = 'INSERT' THEN
            -- Create ActivityPub activity for the post
            INSERT INTO ap_activities (
                ap_id, 
                ap_type,
                actor_id,
                actor_ap_id,
                object_id,
                object_type,
                activity_data,
                status,
                is_local
            ) VALUES (
                full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
                'Create',
                NEW.author_id,
                (SELECT federated_id FROM profiles WHERE id = NEW.author_id),
                NEW.id::text,
                'Note',
                create_activitypub_note_activity(NEW.id),
                'pending',
                true
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'messages' THEN
        -- Handle DM federation (only if there are remote participants)
        IF TG_OP = 'INSERT' THEN
            -- Get remote participants from conversation
            SELECT array_agg(cp.user_id) 
            INTO remote_participants
            FROM conversation_participants cp
            JOIN profiles p ON cp.user_id = p.id
            WHERE cp.conversation_id = NEW.conversation_id
              AND NOT p.is_local;

            -- Only federate if there are remote participants
            IF array_length(remote_participants, 1) > 0 THEN
                INSERT INTO ap_activities (
                    ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                    activity_data, status, is_local, to_addresses
                ) VALUES (
                    full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
                    'Create',
                    NEW.user_id,
                    (SELECT federated_id FROM profiles WHERE id = NEW.user_id),
                    NEW.id::text,
                    'Note',
                    jsonb_build_object(
                        'type', 'Create',
                        'actor', (SELECT federated_id FROM profiles WHERE id = NEW.user_id),
                        'object', jsonb_build_object(
                            'type', 'Note',
                            'id', full_instance_url || '/messages/' || NEW.id,  -- FIXED: Use full URL
                            'attributedTo', (SELECT federated_id FROM profiles WHERE id = NEW.user_id),
                            'content', convert_jsonb_to_ap(NEW.content),
                            'to', array_to_json(ARRAY(
                                SELECT p.federated_id 
                                FROM profiles p 
                                WHERE p.id = ANY(remote_participants)
                            ))::jsonb
                        )
                    ),
                    'pending',
                    true
                );
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_unified_content_federation() IS 'FIXED: ActivityPub URLs now include https:// protocol for both activities and objects.';

-- =====================================================
-- STEP 3: Fix post reactions federation function
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_post_reactions_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;  -- NEW: Full URL with protocol
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    emoji_data record;
    reaction_content text;
    activity_content jsonb;
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;  -- NEW: Add protocol

    -- Check federation for user
    SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Only federate reactions on post_interactions (not regular reactions table)
    IF TG_OP = 'INSERT' THEN
        activity_type := 'Like';
        target_object_id := (SELECT ap_id FROM posts WHERE id = NEW.post_id);
        target_actor_id := (SELECT author_id FROM posts WHERE id = NEW.post_id);
        
        -- Get emoji data for custom emoji federation
        SELECT name, url INTO emoji_data 
        FROM emojis WHERE id = NEW.emoji_id;
        
        -- Build reaction content
        reaction_content := CASE 
            WHEN emoji_data.name IS NOT NULL THEN ':' || emoji_data.name || ':'
            ELSE '❤️'  -- Default heart emoji
        END;
        
    ELSIF TG_OP = 'DELETE' THEN
        activity_type := 'Undo';
        target_object_id := (SELECT ap_id FROM posts WHERE id = OLD.post_id);
        target_actor_id := (SELECT author_id FROM posts WHERE id = OLD.post_id);
        
        -- For undo, we don't need emoji data
        reaction_content := NULL;
    END IF;

    -- Build activity content
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
                        'id', full_instance_url || '/emojis/' || COALESCE(NEW.emoji_id, OLD.emoji_id)  -- FIXED: Use full URL
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
        full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
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

COMMENT ON FUNCTION public.handle_post_reactions_federation() IS 'FIXED: ActivityPub URLs now include https:// protocol. Compatible with Pleroma/Misskey custom emoji federation.';

-- =====================================================
-- STEP 4: Fix reactions federation function
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_reactions_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;  -- NEW: Full URL with protocol
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    emoji_data record;
    reaction_content text;
    activity_content jsonb;
    is_dm_message boolean := false;
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;  -- NEW: Add protocol

    -- Check federation for user
    SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check if this is a DM message (has remote participants)
    SELECT EXISTS(
        SELECT 1 FROM messages m
        JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id  
        JOIN profiles p ON cp.user_id = p.id
        WHERE m.id = COALESCE(NEW.message_id, OLD.message_id)
          AND NOT p.is_local
    ) INTO is_dm_message;

    -- Only federate DM reactions, not server chat reactions (local-first design)
    IF NOT is_dm_message THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'INSERT' THEN
        activity_type := 'Like';  -- FIXED: Use 'Like' instead of 'EmojiReact'
        target_object_id := full_instance_url || '/messages/' || NEW.message_id;  -- FIXED: Use full URL
        
        -- Get message author
        SELECT user_id INTO target_actor_id FROM messages WHERE id = NEW.message_id;
        
        -- Get emoji data for custom emoji federation
        SELECT name, url INTO emoji_data 
        FROM emojis WHERE id = NEW.emoji_id;
        
        -- Build reaction content (Pleroma/Misskey compatible)
        reaction_content := CASE 
            WHEN emoji_data.name IS NOT NULL THEN ':' || emoji_data.name || ':'
            ELSE '❤️'  -- Default heart emoji
        END;
        
    ELSIF TG_OP = 'DELETE' THEN
        activity_type := 'Undo';
        target_object_id := full_instance_url || '/messages/' || OLD.message_id;  -- FIXED: Use full URL
        SELECT user_id INTO target_actor_id FROM messages WHERE id = OLD.message_id;
        reaction_content := NULL;
    END IF;

    -- Build activity content with custom emoji support
    IF activity_type IS NOT NULL AND target_object_id IS NOT NULL THEN
        activity_content := jsonb_build_object(
            'type', activity_type,
            'actor', (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
            'object', target_object_id
        );

        -- Add custom emoji data for federation compatibility
        IF reaction_content IS NOT NULL THEN
            activity_content := activity_content || jsonb_build_object(
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
                                'id', full_instance_url || '/emojis/' || COALESCE(NEW.emoji_id, OLD.emoji_id)  -- FIXED: Use full URL
                            )
                        )
                    ELSE '[]'::jsonb
                END
            );
        END IF;

        -- Create ActivityPub activity for federation  
        INSERT INTO ap_activities (
            ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
            target_id, target_type, activity_data, status, is_local
        ) VALUES (
            full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
            activity_type,
            COALESCE(NEW.user_id, OLD.user_id),
            (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
            target_object_id, 
            'Note', 
            target_actor_id, 
            'Person',
            activity_content,
            'pending', 
            true
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_reactions_federation() IS 'FIXED: ActivityPub URLs now include https:// protocol. Only federates DM reactions (local-first design). Uses Like activity type for ActivityPub compliance.';

COMMIT; 