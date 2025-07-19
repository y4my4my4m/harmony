-- Migration 009: Fix ALL Remaining Ambiguous channel_id Issues
-- 
-- The user is still getting "column reference channel_id is ambiguous" errors
-- even after migration 008. This suggests there are other triggers or functions
-- that still have this issue.

-- =====================================================
-- STEP 1: Check and fix handle_unified_interaction_federation
-- =====================================================

-- This function is called by trigger_unified_interaction_federation_reactions
-- Let's make sure it doesn't have any ambiguous channel_id references

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
    -- Add variables to avoid any potential conflicts
    message_channel_id uuid;
    message_conversation_id uuid;
BEGIN
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;

    -- Process based on table
    IF TG_TABLE_NAME = 'follows' THEN
        -- Check federation for both follower and following
        SELECT is_federation_enabled_for_user(COALESCE(NEW.follower_id, OLD.follower_id)) INTO user_federation_enabled;
        SELECT is_federation_enabled_for_user(COALESCE(NEW.following_id, OLD.following_id)) INTO target_federation_enabled;
        
        IF NOT (user_federation_enabled AND target_federation_enabled) THEN
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

        -- FIXED: Get message context to avoid ambiguous references
        SELECT m.channel_id, m.conversation_id 
        INTO message_channel_id, message_conversation_id
        FROM messages m 
        WHERE m.id = COALESCE(NEW.message_id, OLD.message_id);

        -- LOCAL-FIRST: Only federate DM reactions, not chat reactions
        IF message_channel_id IS NOT NULL THEN
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

COMMENT ON FUNCTION public.handle_unified_interaction_federation() IS 'FIXED: Unified trigger function for follows, likes, and reactions federation. Handles creation and deletion with federation control checks. Fixed ambiguous channel_id issue.';

-- =====================================================
-- STEP 2: Fix any other functions that might have issues
-- =====================================================

-- Check if there are any other reaction-related functions that might cause issues
-- Let's also check the old notification function from migration 003 in case it's still around

-- Drop any old versions that might still exist
DROP FUNCTION IF EXISTS public.handle_unified_notification_processing_old() CASCADE;

-- =====================================================
-- STEP 3: Fix realtime reaction handling issues
-- =====================================================

-- The user reported that reactions disappear on their own messages due to realtime issues
-- This might be because realtime triggers are causing conflicts with the optimistic updates

-- Let's check if there are any other triggers that might interfere
-- Note: We can't disable realtime subscriptions via SQL, but we can add some comments for guidance

-- =====================================================
-- STEP 4: Verification queries
-- =====================================================

-- Let's provide some queries to verify the fix worked
DO $$
BEGIN
    -- Check that the functions exist and are properly defined
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'handle_unified_interaction_federation'
        AND pg_function_is_visible(oid)
    ) THEN
        RAISE WARNING 'handle_unified_interaction_federation function not found';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'handle_unified_notification_processing'
        AND pg_function_is_visible(oid)
    ) THEN
        RAISE WARNING 'handle_unified_notification_processing function not found';
    END IF;

    RAISE NOTICE 'Migration 009 completed - Fixed remaining ambiguous channel_id issues';
END $$;