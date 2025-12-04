-- Migration: Add federation trigger for channel messages
-- This enables immediate pg-boss job creation for channel messages (like DMs have)

-- Create the trigger function for channel message federation
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_server_is_local BOOLEAN;
    v_channel_is_remote BOOLEAN;
BEGIN
    -- Only process channel messages (channel_id is set, conversation_id is null)
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        -- Skip if already federated
        IF NEW.metadata ? 'federated' THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;
        
        -- Check if channel is remote (we don't federate messages TO remote channels - they federate themselves)
        SELECT is_remote INTO v_channel_is_remote
        FROM public.channels
        WHERE id = NEW.channel_id;
        
        IF v_channel_is_remote = true THEN
            -- Skip remote channels - they handle their own federation
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;
        
        -- Check if the server is local and has federation enabled
        SELECT s.is_local_server INTO v_server_is_local
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;
        
        IF v_server_is_local = true OR v_server_is_local IS NULL THEN
            -- Queue the federation job
            NEW.federation_status := 'queued';
            
            PERFORM public.queue_federation_job(
                'federate-channel-message',
                jsonb_build_object(
                    'type', 'create',
                    'message_id', NEW.id,
                    'channel_id', NEW.channel_id,
                    'user_id', NEW.user_id,
                    'created_at', NEW.created_at
                ),
                5,  -- priority
                5,  -- retry_limit
                900 -- expire_in (15 min)
            );
        ELSE
            -- Non-local server, skip federation from our end
            NEW.federation_status := 'skipped';
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.trigger_queue_channel_message_federation() OWNER TO supabase_admin;

COMMENT ON FUNCTION public.trigger_queue_channel_message_federation() IS 
'Queue channel messages for federation via pg-boss. Immediately creates a job for fast delivery.';

-- Create the trigger (only fires for channel messages, not DMs)
DROP TRIGGER IF EXISTS trigger_federate_channel_message ON public.messages;

CREATE TRIGGER trigger_federate_channel_message
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL)
    EXECUTE FUNCTION public.trigger_queue_channel_message_federation();

-- Update the enable/disable functions to include the new trigger
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
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    
    RAISE NOTICE '✅ All federation triggers enabled (including channel messages)';
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
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    
    RAISE NOTICE '⚠️ All federation triggers disabled';
END;
$$;

