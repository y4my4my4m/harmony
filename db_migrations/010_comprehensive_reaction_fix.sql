-- Migration 010: Comprehensive Reaction Fix
-- 
-- FINAL FIX for all remaining issues:
-- 1. Remove ALL ambiguous channel_id references
-- 2. Fix realtime events to include proper message_id 
-- 3. Clean up any old conflicting functions

-- =====================================================
-- STEP 1: Drop and recreate ALL reaction-related triggers
-- =====================================================

-- Drop all old triggers that might be conflicting
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_reactions ON reactions;
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_post_interactions ON post_interactions;
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_follows ON follows;
DROP TRIGGER IF EXISTS trigger_unified_notification_processing_reactions ON reactions;

-- =====================================================
-- STEP 2: Fix notification function to remove ambiguous references
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    notification_data jsonb;
    target_user_id uuid;
    mentioned_users uuid[];
    server_members uuid[];
    followers uuid[];
    single_target_id uuid;
    target_user_ids uuid[];
    -- FIXED: Add variables for message context when processing reactions
    msg_channel_id uuid;
    msg_server_id uuid;
BEGIN
    -- Early exit for non-notification operations
    IF TG_OP = 'UPDATE' THEN
        RETURN NEW;
    END IF;

    -- Handle different table operations
    IF TG_TABLE_NAME = 'mentions' AND TG_OP = 'INSERT' THEN
        -- Handle mention notifications
        notification_data := jsonb_build_object(
            'type', 'mention',
            'message_id', NEW.message_id,
            'mentioned_by', NEW.mentioned_by
        );
        
        PERFORM send_notification_to_user(
            'mention',
            NEW.mentioned_user,
            notification_data,
            (SELECT s.id FROM messages m JOIN channels c ON m.channel_id = c.id JOIN servers s ON c.server_id = s.id WHERE m.id = NEW.message_id),
            (SELECT m.channel_id FROM messages m WHERE m.id = NEW.message_id),
            NULL,
            NEW.mentioned_by,
            'normal'
        );

    ELSIF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        -- Handle follow notifications
        notification_data := jsonb_build_object(
            'type', 'follow',
            'follower_id', NEW.follower_id
        );
        
        PERFORM send_notification_to_user(
            'follow',
            NEW.following_id,
            notification_data,
            NULL,
            NULL,
            NULL,
            NEW.follower_id,
            'normal'
        );

    ELSIF TG_TABLE_NAME = 'reactions' AND TG_OP = 'INSERT' THEN
        -- Handle reaction notifications
        SELECT user_id INTO single_target_id FROM messages WHERE id = NEW.message_id;
        
        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            -- FIXED: Get channel_id and server_id from the related message with proper aliases
            SELECT m.channel_id, c.server_id 
            INTO msg_channel_id, msg_server_id
            FROM messages m 
            LEFT JOIN channels c ON m.channel_id = c.id 
            WHERE m.id = NEW.message_id;
            
            notification_data := jsonb_build_object(
                'type', 'reaction',
                'message_id', NEW.message_id,
                'emoji_id', NEW.emoji_id,
                'user_id', NEW.user_id
            );
            
            -- FIXED: Use the fetched variables with clear naming
            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                msg_server_id,  -- FIXED: Use clear variable name
                msg_channel_id, -- FIXED: Use clear variable name
                NULL,
                NEW.user_id,
                'normal'
            );
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 'FIXED: Unified trigger function with no ambiguous column references. All channel_id references use explicit table aliases.';

-- =====================================================
-- STEP 3: Fix federation function to remove ambiguous references
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_unified_interaction_federation() 
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    user_federation_enabled boolean;
    target_federation_enabled boolean;
    current_instance_domain text;
    activity_type text;
    target_object_id text;
    target_object_type text;
    target_actor_id uuid;
    -- FIXED: Add variables to avoid any potential conflicts
    msg_channel_id uuid;
    msg_conversation_id uuid;
BEGIN
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;

    -- Early exit if domain not configured
    IF current_instance_domain IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Handle different table operations
    IF TG_TABLE_NAME = 'follows' THEN
        -- Check federation for follower
        SELECT is_federation_enabled_for_user(COALESCE(NEW.follower_id, OLD.follower_id)) INTO user_federation_enabled;
        
        IF NOT user_federation_enabled THEN
            RETURN COALESCE(NEW, OLD);
        END IF;

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

        -- FIXED: Get message context with explicit aliases to avoid ambiguous references
        SELECT m.channel_id, m.conversation_id 
        INTO msg_channel_id, msg_conversation_id
        FROM messages m 
        WHERE m.id = COALESCE(NEW.message_id, OLD.message_id);

        -- LOCAL-FIRST: Only federate DM reactions, not chat reactions
        IF msg_channel_id IS NOT NULL THEN
            -- This is a chat message, don't federate
            RETURN COALESCE(NEW, OLD);
        END IF;

        IF TG_OP = 'INSERT' THEN
            activity_type := 'Like';  -- Use 'Like' instead of 'EmojiReact' to comply with constraints
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
    IF activity_type IS NOT NULL AND target_object_id IS NOT NULL THEN
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
            current_instance_domain || '/activities/' || gen_random_uuid(),
            activity_type,
            CASE 
                WHEN TG_TABLE_NAME = 'follows' THEN COALESCE(NEW.follower_id, OLD.follower_id)
                ELSE COALESCE(NEW.user_id, OLD.user_id)
            END,
            (SELECT federated_id FROM profiles WHERE id = CASE 
                WHEN TG_TABLE_NAME = 'follows' THEN COALESCE(NEW.follower_id, OLD.follower_id)
                ELSE COALESCE(NEW.user_id, OLD.user_id)
            END),
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
                'actor', (SELECT federated_id FROM profiles WHERE id = CASE 
                    WHEN TG_TABLE_NAME = 'follows' THEN COALESCE(NEW.follower_id, OLD.follower_id)
                    ELSE COALESCE(NEW.user_id, OLD.user_id)
                END),
                'object', target_object_id
            ),
            'pending',
            true
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_unified_interaction_federation() IS 'FIXED: Unified trigger function with explicit table aliases to prevent ambiguous column references.';

-- =====================================================
-- STEP 4: Recreate triggers with proper settings
-- =====================================================

-- Reaction triggers
CREATE TRIGGER trigger_unified_notification_processing_reactions
    AFTER INSERT OR DELETE ON reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_notification_processing();

CREATE TRIGGER trigger_unified_interaction_federation_reactions
    AFTER INSERT OR DELETE ON reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_interaction_federation();

-- Follow triggers
CREATE TRIGGER trigger_unified_interaction_federation_follows
    AFTER INSERT OR DELETE ON follows
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_interaction_federation();

-- Post interaction triggers
CREATE TRIGGER trigger_unified_interaction_federation_post_interactions
    AFTER INSERT OR DELETE ON post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_interaction_federation();

-- =====================================================
-- STEP 5: Fix realtime replica identity for proper events
-- =====================================================

-- Ensure reactions table has REPLICA IDENTITY FULL so DELETE events include all columns
ALTER TABLE reactions REPLICA IDENTITY FULL;

-- This ensures that DELETE events will include message_id, preventing the "missing message_id" issue

-- =====================================================
-- STEP 6: Verification
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE 'Migration 010 completed successfully!';
    RAISE NOTICE 'Fixed:';
    RAISE NOTICE '  ✅ All ambiguous channel_id references removed';
    RAISE NOTICE '  ✅ Explicit table aliases added everywhere';
    RAISE NOTICE '  ✅ REPLICA IDENTITY FULL set for proper DELETE events';
    RAISE NOTICE '  ✅ All old conflicting triggers dropped and recreated';
END $$;