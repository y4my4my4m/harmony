BEGIN;

-- =============================================
-- Fix: Message edit/delete not federated properly
--
-- Previously, the edit/delete federation triggers:
-- 1. Skipped ALL messages with metadata.federated (blocking mod actions on remote users' messages)
-- 2. Skipped ALL messages by non-local authors (blocking federation of mod deletions)
-- 3. Did not include server_id in the job payload
--
-- New logic:
-- - Local server (authoritative): federate ALL edits/deletes when federation is enabled
-- - Non-local server (mirror): only federate local author's own non-federated messages
-- =============================================

-- 1. Fix edit trigger
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_edit_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.content IS NOT DISTINCT FROM NEW.content THEN RETURN NEW; END IF;

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
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-edit',
            jsonb_build_object(
                'type', 'update',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$$;

-- 2. Fix delete trigger
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.is_deleted = TRUE OR NEW.is_deleted = FALSE THEN RETURN NEW; END IF;

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

NOTIFY pgrst, 'reload schema';
