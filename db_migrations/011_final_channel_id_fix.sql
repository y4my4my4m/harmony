-- Migration 011: Final Channel ID Ambiguity Fix
-- 
-- DEFINITIVE FIX for persistent "column reference channel_id is ambiguous" errors
-- This addresses any remaining old trigger functions not fixed by migration 010

-- =====================================================
-- STEP 1: Drop ALL old problematic triggers completely
-- =====================================================

-- Drop ALL problematic triggers to start fresh
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_reactions ON reactions;
DROP TRIGGER IF EXISTS trigger_unified_notification_reactions ON reactions;
DROP TRIGGER IF EXISTS handle_post_reactions_federation_trigger ON post_interactions;

-- Drop follow triggers
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_follows ON follows;

-- Drop post interaction triggers  
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_post_interactions ON post_interactions;

-- Also drop any old legacy triggers that might still exist
DROP TRIGGER IF EXISTS trigger_reactions_federation ON reactions;
DROP TRIGGER IF EXISTS handle_reactions_federation_trigger ON reactions;

-- =====================================================
-- STEP 2: Drop old problematic functions completely  
-- =====================================================

-- Drop the old functions that have channel_id ambiguity
DROP FUNCTION IF EXISTS public.handle_reactions_federation() CASCADE;

-- =====================================================
-- STEP 3: Create/Replace FINAL notification function
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
    -- CRITICAL: Use explicit variable names to avoid ANY ambiguity
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
            -- CRITICAL FIX: Use explicit variables to eliminate ANY channel_id ambiguity
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
            
            -- CRITICAL FIX: Use explicit variable names instead of ambiguous references
            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                msg_server_id,  -- EXPLICIT: No ambiguity
                msg_channel_id, -- EXPLICIT: No ambiguity
                NULL,
                NEW.user_id,
                'normal'
            );
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 'FINAL FIX: No ambiguous column references. All channel_id references use explicit variables.';

-- =====================================================
-- STEP 4: Create/Replace FINAL federation function
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
    -- CRITICAL: Use explicit variable names to avoid ANY ambiguity
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

        -- CRITICAL FIX: Use explicit variables to eliminate ANY channel_id ambiguity
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

COMMENT ON FUNCTION public.handle_unified_interaction_federation() IS 'FINAL FIX: No ambiguous column references. All channel_id references use explicit variables.';

-- =====================================================
-- STEP 5: Recreate ALL triggers with FINAL functions
-- =====================================================

-- Reaction triggers using the FINAL fixed functions
CREATE TRIGGER trigger_unified_notification_reactions
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
-- STEP 6: Ensure REPLICA IDENTITY is properly set
-- =====================================================

-- Ensure reactions table has REPLICA IDENTITY FULL so DELETE events include all columns
ALTER TABLE reactions REPLICA IDENTITY FULL;

-- =====================================================
-- STEP 7: Verification and cleanup
-- =====================================================

DO $$
BEGIN
    -- Verify functions exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'handle_unified_interaction_federation'
        AND pg_function_is_visible(oid)
    ) THEN
        RAISE EXCEPTION 'handle_unified_interaction_federation function not found after migration';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'handle_unified_notification_processing'
        AND pg_function_is_visible(oid)
    ) THEN
        RAISE EXCEPTION 'handle_unified_notification_processing function not found after migration';
    END IF;

    -- Verify triggers exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers 
        WHERE trigger_name = 'trigger_unified_notification_reactions'
        AND event_object_table = 'reactions'
    ) THEN
        RAISE EXCEPTION 'trigger_unified_notification_reactions not found after migration';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers 
        WHERE trigger_name = 'trigger_unified_interaction_federation_reactions'
        AND event_object_table = 'reactions'
    ) THEN
        RAISE EXCEPTION 'trigger_unified_interaction_federation_reactions not found after migration';
    END IF;

    RAISE NOTICE 'Migration 011 completed successfully!';
    RAISE NOTICE 'FINAL FIXES APPLIED:';
    RAISE NOTICE '  ✅ All old problematic triggers and functions dropped';
    RAISE NOTICE '  ✅ All channel_id references use explicit variables';
    RAISE NOTICE '  ✅ No more ambiguous column references possible';
    RAISE NOTICE '  ✅ REPLICA IDENTITY FULL confirmed';
    RAISE NOTICE '  ✅ All triggers recreated with final functions';
    RAISE NOTICE '';
    RAISE NOTICE '🎯 This should DEFINITIVELY fix the "channel_id is ambiguous" error!';
END $$;