-- Skip federating system messages (group_created, users_added) - they are
-- internal metadata and shouldn't be sent to remote instances.
BEGIN;

CREATE OR REPLACE FUNCTION public.trigger_queue_dm_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.conversation_id IS NOT NULL
       AND NOT (NEW.metadata ? 'federated')
       AND NOT (COALESCE(NEW.is_system, false) = true)
    THEN
        NEW.federation_status := 'queued';

        PERFORM public.queue_federation_job(
            'federate-dm',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'conversation_id', NEW.conversation_id,
                'user_id', NEW.user_id,
                'created_at', NEW.created_at
            ),
            5, 5, 3600
        );
    ELSE
        NEW.federation_status := 'skipped';
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
