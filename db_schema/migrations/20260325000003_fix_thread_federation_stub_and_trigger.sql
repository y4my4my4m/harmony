BEGIN;

-- =============================================
-- Fix: Thread federation - prevent stub/federated threads from being re-federated
--
-- The trigger_queue_thread_federation function previously only checked if the
-- creator was local. Stub threads created by the federation backend (from
-- incoming thread messages) have ap_id set at INSERT time. Locally created
-- threads do not have ap_id at INSERT time. This guard prevents the trigger
-- from queuing federation jobs for threads that came from federation.
-- =============================================

CREATE OR REPLACE FUNCTION public.trigger_queue_thread_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_creator_is_local BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Threads with ap_id already set came from federation (stub or ChatThread)
        IF NEW.ap_id IS NOT NULL THEN
            NEW.federation_status := 'synced';
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server INTO v_server_id, v_server_is_local
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        SELECT is_local INTO v_creator_is_local FROM public.profiles WHERE id = NEW.created_by;

        IF v_creator_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-thread',
            jsonb_build_object(
                'type', 'create', 'thread_id', NEW.id, 'channel_id', NEW.channel_id,
                'server_id', v_server_id, 'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by, 'created_at', NEW.created_at
            ), 5, 5, 900
        );
    ELSIF TG_OP = 'UPDATE' THEN
        IF (OLD.name IS NOT DISTINCT FROM NEW.name AND
            OLD.archived IS NOT DISTINCT FROM NEW.archived AND
            OLD.locked IS NOT DISTINCT FROM NEW.locked) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server INTO v_server_id, v_server_is_local
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        SELECT is_local INTO v_creator_is_local FROM public.profiles WHERE id = NEW.created_by;
        IF v_creator_is_local IS NOT TRUE THEN RETURN NEW; END IF;

        IF NEW.federation_status = 'local' OR NEW.federation_status IS NULL THEN
            NEW.federation_status := 'queued';
        END IF;

        PERFORM public.queue_federation_job(
            'federate-thread',
            jsonb_build_object(
                'type', 'update', 'thread_id', NEW.id, 'channel_id', NEW.channel_id,
                'server_id', v_server_id, 'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by
            ), 5, 5, 900
        );
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN undefined_table THEN RETURN NEW;
    WHEN OTHERS THEN
        RAISE WARNING 'trigger_queue_thread_federation error: %', SQLERRM;
        RETURN NEW;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
