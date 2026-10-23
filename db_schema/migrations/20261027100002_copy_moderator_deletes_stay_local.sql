-- A message deleted in this instance's copy of a remote server federates as its author's own Delete
-- (federation-backend listeners/ChannelMessageHandler.ts), which the host accepts from the author.
-- Only the author's own delete, or one with no signed-in deleter (service paths: account removal,
-- retention), leaves the instance; a delete by anyone else (instance staff, a moderator of the copy,
-- kick or ban with "delete messages") hides the message on this instance only.
-- Body: 20261001000001_channel_encryption_settings.sql plus the deleter check.

BEGIN;

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
    v_deleter UUID;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.is_deleted = TRUE OR NEW.is_deleted = FALSE THEN RETURN NEW; END IF;

        IF NEW.federation_status = 'skipped'
           AND NOT (NEW.metadata ? 'federated')
           AND (NEW.encrypted IS TRUE OR public.channel_messages_encrypted(NEW.channel_id)) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server, s.federation_enabled
        INTO v_server_id, v_server_is_local, v_federation_enabled
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF v_server_is_local IS TRUE THEN
            IF v_federation_enabled IS NOT TRUE THEN RETURN NEW; END IF;
        ELSE
            IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
            SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
            IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;
            v_deleter := public.get_current_profile_id();
            IF v_deleter IS NOT NULL AND v_deleter IS DISTINCT FROM NEW.user_id THEN RETURN NEW; END IF;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-delete',
            jsonb_build_object(
                'type', 'delete',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'ap_id', NEW.metadata->>'ap_id',
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
