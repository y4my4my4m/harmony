BEGIN;

-- Fix: trigger_queue_profile_federation was inserting directly into pgboss.job
-- which doesn't work with BullMQ mode. Switch to queue_federation_job() which
-- uses pg_notify and is consistent with all other federation triggers.

CREATE OR REPLACE FUNCTION public.trigger_queue_profile_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.is_local != true THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF (
            OLD.display_name IS NOT DISTINCT FROM NEW.display_name AND
            OLD.bio IS NOT DISTINCT FROM NEW.bio AND
            OLD.avatar_url IS NOT DISTINCT FROM NEW.avatar_url AND
            OLD.banner_url IS NOT DISTINCT FROM NEW.banner_url AND
            OLD.custom_status IS NOT DISTINCT FROM NEW.custom_status
        ) THEN
            RETURN NEW;
        END IF;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-profile',
        jsonb_build_object(
            'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            'profile_id', NEW.id,
            'username', NEW.username,
            'display_name', NEW.display_name,
            'bio', NEW.bio,
            'avatar_url', NEW.avatar_url,
            'banner_url', NEW.banner_url,
            'custom_status', NEW.custom_status
        ),
        3, 5, 3600
    );

    RETURN NEW;
END;
$$;

-- Ensure the trigger exists (idempotent)
DROP TRIGGER IF EXISTS trigger_federate_profile ON public.profiles;
CREATE TRIGGER trigger_federate_profile
    AFTER UPDATE ON public.profiles
    FOR EACH ROW
    WHEN (NEW.is_local = true)
    EXECUTE FUNCTION public.trigger_queue_profile_federation();

NOTIFY pgrst, 'reload schema';

COMMIT;
