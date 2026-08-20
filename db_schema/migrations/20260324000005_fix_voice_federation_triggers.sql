BEGIN;

-- =============================================================================
-- Fix voice join/leave federation triggers
--
-- These were no-op stubs (just RETURN NEW/OLD) despite fully implemented
-- backend handlers. Fill in the actual queue_federation_job calls.
-- =============================================================================

-- Voice channel JOIN
CREATE OR REPLACE FUNCTION public.trigger_queue_voice_channel_join_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server servers%ROWTYPE;
BEGIN
    SELECT * INTO v_server FROM servers WHERE id = NEW.server_id;

    IF v_server IS NULL OR NOT v_server.federation_enabled THEN
        RETURN NEW;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-voice-join',
        jsonb_build_object(
            'channel_id', NEW.channel_id,
            'server_id', NEW.server_id,
            'user_id', NEW.user_id
        ),
        5, 3, 1800
    );

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Voice join federation trigger failed: %', SQLERRM;
        RETURN NEW;
END;
$$;

-- Voice channel LEAVE
CREATE OR REPLACE FUNCTION public.trigger_queue_voice_channel_leave_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server servers%ROWTYPE;
BEGIN
    SELECT * INTO v_server FROM servers WHERE id = OLD.server_id;

    IF v_server IS NULL OR NOT v_server.federation_enabled THEN
        RETURN OLD;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-voice-leave',
        jsonb_build_object(
            'channel_id', OLD.channel_id,
            'server_id', OLD.server_id,
            'user_id', OLD.user_id
        ),
        5, 3, 1800
    );

    RETURN OLD;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Voice leave federation trigger failed: %', SQLERRM;
        RETURN OLD;
END;
$$;

-- Ensure triggers exist (idempotent)
DROP TRIGGER IF EXISTS trigger_federate_voice_channel_join ON public.voice_channel_participants;
CREATE TRIGGER trigger_federate_voice_channel_join
    BEFORE INSERT ON public.voice_channel_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_voice_channel_join_federation();

DROP TRIGGER IF EXISTS trigger_federate_voice_channel_leave ON public.voice_channel_participants;
CREATE TRIGGER trigger_federate_voice_channel_leave
    AFTER DELETE ON public.voice_channel_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_voice_channel_leave_federation();

NOTIFY pgrst, 'reload schema';

COMMIT;
