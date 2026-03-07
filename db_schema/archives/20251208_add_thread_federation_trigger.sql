-- =============================================
-- Add thread federation trigger
-- =============================================
-- Queues thread creation/updates for federation via pg-boss

CREATE OR REPLACE FUNCTION "public"."trigger_queue_thread_federation"() RETURNS "trigger"
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_channel_id UUID;
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_creator_is_local BOOLEAN;
BEGIN
    -- Only process thread creation/updates
    IF TG_OP = 'INSERT' THEN
        -- Get channel and server info
        SELECT c.server_id, s.is_local_server
        INTO v_server_id, v_server_is_local
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;
        
        -- Check if creator is local
        SELECT is_local INTO v_creator_is_local
        FROM public.profiles
        WHERE id = NEW.created_by;
        
        -- Only federate if creator is local
        IF v_creator_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;
        
        -- Queue for federation
        NEW.federation_status := 'queued';
        
        PERFORM public.queue_federation_job(
            'federate-thread',
            jsonb_build_object(
                'type', 'create',
                'thread_id', NEW.id,
                'channel_id', NEW.channel_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by,
                'created_at', NEW.created_at
            ),
            5,  -- priority
            5,  -- retry_limit
            900 -- expire_in (15 min)
        );
    ELSIF TG_OP = 'UPDATE' THEN
        -- Only federate updates if relevant fields changed
        IF (
            OLD.name IS NOT DISTINCT FROM NEW.name AND
            OLD.archived IS NOT DISTINCT FROM NEW.archived AND
            OLD.locked IS NOT DISTINCT FROM NEW.locked
        ) THEN
            -- No federable fields changed, skip
            RETURN NEW;
        END IF;
        
        -- Get channel and server info
        SELECT c.server_id, s.is_local_server
        INTO v_server_id, v_server_is_local
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;
        
        -- Check if creator is local
        SELECT is_local INTO v_creator_is_local
        FROM public.profiles
        WHERE id = NEW.created_by;
        
        -- Only federate if creator is local
        IF v_creator_is_local IS NOT TRUE THEN
            RETURN NEW;
        END IF;
        
        -- Queue for federation
        IF NEW.federation_status = 'local' OR NEW.federation_status IS NULL THEN
            NEW.federation_status := 'queued';
        END IF;
        
        PERFORM public.queue_federation_job(
            'federate-thread',
            jsonb_build_object(
                'type', 'update',
                'thread_id', NEW.id,
                'channel_id', NEW.channel_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by
            ),
            5,  -- priority
            5,  -- retry_limit
            900 -- expire_in (15 min)
        );
    END IF;
    
    RETURN NEW;
EXCEPTION
    WHEN undefined_table THEN
        -- pg-boss not available - skip federation
        RETURN NEW;
    WHEN OTHERS THEN
        -- Log error but don't fail the transaction
        RAISE LOG 'Thread federation error: %', SQLERRM;
        RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."trigger_queue_thread_federation"() IS 'Queue thread creation/updates for federation via pg-boss. Handles both local servers with remote members AND local users creating threads in remote servers.';

-- Create trigger
DROP TRIGGER IF EXISTS "trigger_federate_thread" ON "public"."threads";
CREATE TRIGGER "trigger_federate_thread"
    AFTER INSERT OR UPDATE ON "public"."threads"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."trigger_queue_thread_federation"();

