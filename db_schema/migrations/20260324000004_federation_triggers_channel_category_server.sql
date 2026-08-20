BEGIN;

-- =========================================================================
-- Federation triggers for channels, categories, and server updates.
-- These queue jobs into BullMQ for real-time federation to remote instances.
-- Previously, these only got picked up by the periodic BullMQ sweep.
-- =========================================================================

-- Channel CRUD → federate-channel-crud
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
       OLD.is_private    IS NOT DISTINCT FROM NEW.is_private AND
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

-- Category CRUD → federate-category-crud
CREATE OR REPLACE FUNCTION public.trigger_queue_category_federation()
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
            'federate-category-crud',
            jsonb_build_object('type', 'delete', 'category_id', OLD.id, 'server_id', OLD.server_id),
            5, 5, 900
        );
        RETURN OLD;
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
       OLD.name      IS NOT DISTINCT FROM NEW.name AND
       OLD."order"   IS NOT DISTINCT FROM NEW."order" AND
       OLD.server_id IS NOT DISTINCT FROM NEW.server_id
    THEN
        RETURN NEW;
    END IF;

    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-category-crud',
        jsonb_build_object(
            'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            'category_id', NEW.id,
            'server_id', NEW.server_id
        ),
        5, 5, 900
    );
    RETURN NEW;
END;
$$;

-- Server update → federate-server-update
CREATE OR REPLACE FUNCTION public.trigger_queue_server_update_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.is_local_server IS NOT TRUE OR NEW.federation_enabled IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    IF OLD.name IS NOT DISTINCT FROM NEW.name
       AND OLD.description IS NOT DISTINCT FROM NEW.description
       AND OLD.icon IS NOT DISTINCT FROM NEW.icon
       AND OLD.banner IS NOT DISTINCT FROM NEW.banner
       AND OLD.public IS NOT DISTINCT FROM NEW.public
       AND OLD.federation_enabled IS NOT DISTINCT FROM NEW.federation_enabled
    THEN
        RETURN NEW;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-server-update',
        jsonb_build_object('type', 'update', 'server_id', NEW.id),
        5, 5, 900
    );
    RETURN NEW;
END;
$$;

-- =========================================================================
-- Triggers
-- =========================================================================

-- Channel federation (BEFORE for INSERT/UPDATE to set federation_status, AFTER for DELETE)
DROP TRIGGER IF EXISTS trigger_federate_channel ON public.channels;
CREATE TRIGGER trigger_federate_channel
    BEFORE INSERT OR UPDATE ON public.channels
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_channel_federation();

DROP TRIGGER IF EXISTS trigger_federate_channel_delete ON public.channels;
CREATE TRIGGER trigger_federate_channel_delete
    AFTER DELETE ON public.channels
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_channel_federation();

-- Category federation
DROP TRIGGER IF EXISTS trigger_federate_category ON public.channel_categories;
CREATE TRIGGER trigger_federate_category
    BEFORE INSERT OR UPDATE ON public.channel_categories
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_category_federation();

DROP TRIGGER IF EXISTS trigger_federate_category_delete ON public.channel_categories;
CREATE TRIGGER trigger_federate_category_delete
    AFTER DELETE ON public.channel_categories
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_category_federation();

-- Server update federation
DROP TRIGGER IF EXISTS trigger_federate_server_update ON public.servers;
CREATE TRIGGER trigger_federate_server_update
    AFTER UPDATE ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_server_update_federation();

NOTIFY pgrst, 'reload schema';

COMMIT;
