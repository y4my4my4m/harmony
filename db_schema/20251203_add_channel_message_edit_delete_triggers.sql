-- Migration: Add federation triggers for channel message edits and deletes
-- This enables immediate pg-boss job creation for edits/deletes (like creates)

-- =============================================================================
-- TRIGGER FOR MESSAGE EDITS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_edit_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_author_is_local BOOLEAN;
BEGIN
    -- Only process channel messages (channel_id is set, conversation_id is null)
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        -- Only trigger if content actually changed (not just federation_status)
        IF OLD.content IS NOT DISTINCT FROM NEW.content THEN
            RETURN NEW;
        END IF;
        
        -- Skip if this is a federated message (we don't re-federate incoming edits)
        IF NEW.metadata ? 'federated' THEN
            RETURN NEW;
        END IF;
        
        -- Check if the author is local
        SELECT is_local INTO v_author_is_local
        FROM public.profiles
        WHERE id = NEW.user_id;
        
        IF v_author_is_local IS NOT TRUE THEN
            RETURN NEW;
        END IF;
        
        -- Queue the edit federation job
        PERFORM public.queue_federation_job(
            'federate-channel-message-edit',
            jsonb_build_object(
                'type', 'update',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id
            ),
            5,  -- priority
            5,  -- retry_limit
            900 -- expire_in (15 min)
        );
    END IF;
    
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.trigger_queue_channel_message_edit_federation() OWNER TO supabase_admin;

-- Create the trigger for message edits
DROP TRIGGER IF EXISTS trigger_federate_channel_message_edit ON public.messages;

CREATE TRIGGER trigger_federate_channel_message_edit
    AFTER UPDATE OF content ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL AND NEW.is_deleted = FALSE)
    EXECUTE FUNCTION public.trigger_queue_channel_message_edit_federation();

-- =============================================================================
-- TRIGGER FOR MESSAGE DELETES
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_author_is_local BOOLEAN;
BEGIN
    -- Only process channel messages (channel_id is set, conversation_id is null)
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        -- Only trigger if is_deleted changed from false to true
        IF OLD.is_deleted = TRUE OR NEW.is_deleted = FALSE THEN
            RETURN NEW;
        END IF;
        
        -- Skip if this is a federated message (we don't re-federate incoming deletes)
        IF NEW.metadata ? 'federated' THEN
            RETURN NEW;
        END IF;
        
        -- Check if the author is local
        SELECT is_local INTO v_author_is_local
        FROM public.profiles
        WHERE id = NEW.user_id;
        
        IF v_author_is_local IS NOT TRUE THEN
            RETURN NEW;
        END IF;
        
        -- Queue the delete federation job
        PERFORM public.queue_federation_job(
            'federate-channel-message-delete',
            jsonb_build_object(
                'type', 'delete',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'ap_id', NEW.metadata->>'ap_id'
            ),
            5,  -- priority
            5,  -- retry_limit
            900 -- expire_in (15 min)
        );
    END IF;
    
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.trigger_queue_channel_message_delete_federation() OWNER TO supabase_admin;

-- Create the trigger for message deletes (soft delete via is_deleted flag)
DROP TRIGGER IF EXISTS trigger_federate_channel_message_delete ON public.messages;

CREATE TRIGGER trigger_federate_channel_message_delete
    AFTER UPDATE OF is_deleted ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL AND NEW.is_deleted = TRUE AND OLD.is_deleted = FALSE)
    EXECUTE FUNCTION public.trigger_queue_channel_message_delete_federation();

-- =============================================================================
-- UPDATE enable/disable functions
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
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    
    RAISE NOTICE '✅ All federation triggers enabled (including channel message edit/delete)';
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
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    
    RAISE NOTICE '⚠️ All federation triggers disabled';
END;
$$;

