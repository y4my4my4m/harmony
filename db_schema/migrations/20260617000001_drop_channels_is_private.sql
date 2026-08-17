BEGIN;

-- Channel visibility is role/permission overrides, not a boolean flag.
ALTER TABLE public.channels DROP COLUMN IF EXISTS is_private;

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_is_local boolean;
    v_federation_enabled boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT s.is_local_server, s.federation_enabled
        INTO v_server_is_local, v_federation_enabled
        FROM servers s WHERE s.id = OLD.server_id;

        IF v_server_is_local IS NOT TRUE OR v_federation_enabled IS NOT TRUE THEN
            RETURN OLD;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-crud',
            jsonb_build_object('type', 'delete', 'channel_id', OLD.id, 'server_id', OLD.server_id),
            5, 5, 900
        );
        RETURN OLD;
    END IF;

    IF NEW.is_remote THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    SELECT s.is_local_server, s.federation_enabled
    INTO v_server_is_local, v_federation_enabled
    FROM servers s WHERE s.id = NEW.server_id;

    IF v_server_is_local IS NOT TRUE OR v_federation_enabled IS NOT TRUE THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    -- Skip re-federation when only federation_status changed (prevents infinite loop)
    IF TG_OP = 'UPDATE' AND
       OLD.name          IS NOT DISTINCT FROM NEW.name AND
       OLD.description   IS NOT DISTINCT FROM NEW.description AND
       OLD.type          IS NOT DISTINCT FROM NEW.type AND
       OLD.category      IS NOT DISTINCT FROM NEW.category AND
       OLD.server_id     IS NOT DISTINCT FROM NEW.server_id AND
       OLD."order"       IS NOT DISTINCT FROM NEW."order" AND
       OLD.slowmode_seconds IS NOT DISTINCT FROM NEW.slowmode_seconds AND
       OLD.ap_id         IS NOT DISTINCT FROM NEW.ap_id
    THEN
        RETURN NEW;
    END IF;

    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-channel-crud',
        jsonb_build_object(
            'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            'channel_id', NEW.id,
            'server_id', NEW.server_id
        ),
        5, 5, 900
    );
    RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
