-- Migration: Add federation triggers for channel message reactions
-- This enables immediate pg-boss job creation for channel reactions (like/emoji reactions on server messages)
-- 
-- Note: This is separate from DM reactions which use 'federate-message-reaction'
-- Channel reactions use 'federate-channel-reaction' job type

-- =============================================================================
-- TRIGGER FOR CHANNEL REACTION ADD
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_reaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_is_local BOOLEAN;
    v_is_channel_message BOOLEAN;
BEGIN
    -- Check if the user is local (only federate reactions from local users)
    SELECT is_local INTO v_user_is_local
    FROM public.profiles
    WHERE id = NEW.user_id;
    
    IF v_user_is_local IS NOT TRUE THEN
        RETURN NEW;
    END IF;
    
    -- Check if this reaction is on a channel message (not a DM)
    -- Channel messages have channel_id set and conversation_id null
    SELECT 
        (channel_id IS NOT NULL AND conversation_id IS NULL) INTO v_is_channel_message
    FROM public.messages
    WHERE id = NEW.message_id;
    
    IF v_is_channel_message IS NOT TRUE THEN
        -- This is a DM reaction, handled by different trigger
        RETURN NEW;
    END IF;
    
    -- Skip if this reaction came from federation (prevent re-federation loops)
    IF NEW.metadata ? 'federated' THEN
        RETURN NEW;
    END IF;
    
    -- Set federation status and queue the job
    NEW.federation_status := 'queued';
    
    PERFORM public.queue_federation_job(
        'federate-channel-reaction',
        jsonb_build_object(
            'type', 'create',
            'reaction_id', NEW.id,
            'message_id', NEW.message_id,
            'user_id', NEW.user_id,
            'emoji_id', NEW.emoji_id,
            'custom_emoji_content', NEW.custom_emoji_content
        ),
        5,  -- priority
        3,  -- retry_limit
        1800 -- expire_in (30 min)
    );
    
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.trigger_queue_channel_reaction_federation() OWNER TO supabase_admin;

-- Create the trigger for channel reaction adds
DROP TRIGGER IF EXISTS trigger_federate_channel_reaction ON public.reactions;

CREATE TRIGGER trigger_federate_channel_reaction
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_channel_reaction_federation();

-- =============================================================================
-- TRIGGER FOR CHANNEL REACTION REMOVAL (Undo)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_reaction_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_is_local BOOLEAN;
    v_is_channel_message BOOLEAN;
BEGIN
    -- Check if the user was local
    SELECT is_local INTO v_user_is_local
    FROM public.profiles
    WHERE id = OLD.user_id;
    
    IF v_user_is_local IS NOT TRUE THEN
        RETURN OLD;
    END IF;
    
    -- Check if this reaction was on a channel message (not a DM)
    SELECT 
        (channel_id IS NOT NULL AND conversation_id IS NULL) INTO v_is_channel_message
    FROM public.messages
    WHERE id = OLD.message_id;
    
    IF v_is_channel_message IS NOT TRUE THEN
        -- This is a DM reaction, handled by different trigger
        RETURN OLD;
    END IF;
    
    -- Skip if this reaction came from federation
    IF OLD.metadata ? 'federated' THEN
        RETURN OLD;
    END IF;
    
    -- Queue the undo job
    PERFORM public.queue_federation_job(
        'federate-channel-reaction',
        jsonb_build_object(
            'type', 'delete',
            'reaction_id', OLD.id,
            'message_id', OLD.message_id,
            'user_id', OLD.user_id,
            'emoji_id', OLD.emoji_id,
            'custom_emoji_content', OLD.custom_emoji_content
        ),
        5,  -- priority
        3,  -- retry_limit
        1800 -- expire_in (30 min)
    );
    
    RETURN OLD;
END;
$$;

ALTER FUNCTION public.trigger_queue_channel_reaction_delete_federation() OWNER TO supabase_admin;

-- Create the trigger for channel reaction removals
DROP TRIGGER IF EXISTS trigger_federate_channel_reaction_delete ON public.reactions;

CREATE TRIGGER trigger_federate_channel_reaction_delete
    AFTER DELETE ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_channel_reaction_delete_federation();

-- =============================================================================
-- UPDATE enable/disable functions to include new triggers
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    
    RAISE NOTICE '✅ All federation triggers enabled (including channel reactions)';
END;
$$;

CREATE OR REPLACE FUNCTION public.disable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    
    RAISE NOTICE '⚠️ All federation triggers disabled';
END;
$$;

