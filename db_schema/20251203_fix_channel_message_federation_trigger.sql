-- Migration: Fix channel message federation trigger and prevent "edited" issue
-- 
-- Issue 1: The trigger was skipping remote channels, but we SHOULD federate
--          messages sent by local users to remote servers
-- Issue 2: The moddatetime trigger was updating updated_at when federation_status
--          changes, making messages appear "edited"

-- =============================================================================
-- FIX 1: Update channel message federation trigger to handle remote servers
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    -- Only process channel messages (channel_id is set, conversation_id is null)
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        -- Skip if already federated (incoming federated message)
        IF NEW.metadata ? 'federated' THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;
        
        -- Check if the author is local (only federate messages from local users)
        SELECT is_local INTO v_author_is_local
        FROM public.profiles
        WHERE id = NEW.user_id;
        
        IF v_author_is_local IS NOT TRUE THEN
            -- Remote user's message - don't re-federate
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;
        
        -- Get server info for the channel
        SELECT c.server_id, s.is_local_server 
        INTO v_server_id, v_server_is_local
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;
        
        -- Always queue for federation if author is local
        -- The backend handler will determine:
        -- - If server is local: send to remote members' shared inboxes
        -- - If server is remote: send to that server's inbox
        NEW.federation_status := 'queued';
        
        PERFORM public.queue_federation_job(
            'federate-channel-message',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true),
                'created_at', NEW.created_at
            ),
            5,  -- priority
            5,  -- retry_limit
            900 -- expire_in (15 min)
        );
    END IF;
    
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.trigger_queue_channel_message_federation() OWNER TO supabase_admin;

COMMENT ON FUNCTION public.trigger_queue_channel_message_federation() IS 
'Queue channel messages for federation via pg-boss. Handles both local servers with remote members AND local users sending to remote servers.';

-- =============================================================================
-- FIX 2: Replace moddatetime trigger with smart version that ignores federation_status
-- =============================================================================

-- Create a smarter updated_at function that ignores federation_status changes
CREATE OR REPLACE FUNCTION public.handle_messages_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Only update updated_at if content-related fields changed, NOT federation_status
    -- This prevents messages from appearing "edited" when only federation_status changes
    IF (
        OLD.content IS DISTINCT FROM NEW.content OR
        OLD.metadata IS DISTINCT FROM NEW.metadata OR
        OLD.is_deleted IS DISTINCT FROM NEW.is_deleted OR
        OLD.reply_to IS DISTINCT FROM NEW.reply_to
    ) AND (
        -- But ignore if ONLY federation_status or metadata.federated_at changed
        OLD.content IS DISTINCT FROM NEW.content OR
        OLD.is_deleted IS DISTINCT FROM NEW.is_deleted OR
        OLD.reply_to IS DISTINCT FROM NEW.reply_to OR
        -- For metadata, check if something other than federation fields changed
        (OLD.metadata - 'federated_at' - 'federated_to' - 'ap_id') IS DISTINCT FROM 
        (NEW.metadata - 'federated_at' - 'federated_to' - 'ap_id')
    ) THEN
        NEW.updated_at = NOW();
    ELSE
        -- Preserve the old updated_at
        NEW.updated_at = OLD.updated_at;
    END IF;
    
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_messages_updated_at() OWNER TO supabase_admin;

COMMENT ON FUNCTION public.handle_messages_updated_at() IS 
'Smart updated_at handler that ignores federation_status changes to prevent false "edited" indicators.';

-- Drop the old moddatetime trigger and create our smart one
DROP TRIGGER IF EXISTS handle_updated_at ON public.messages;

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_messages_updated_at();

-- =============================================================================
-- VERIFY: Ensure the channel message trigger exists
-- =============================================================================

DROP TRIGGER IF EXISTS trigger_federate_channel_message ON public.messages;

CREATE TRIGGER trigger_federate_channel_message
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL)
    EXECUTE FUNCTION public.trigger_queue_channel_message_federation();

