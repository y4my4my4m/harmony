-- Encrypted DM conversations refuse plaintext, and participants learn of a change.
--
-- A conversation whose conversation_encryption_settings.encryption_enabled is true refuses a
-- client INSERT of a plaintext message, as enforce_channel_message_encryption() refuses one in an
-- encrypted channel:
--   CONVERSATION_ENCRYPTED  23514 (check_violation)
-- Accepted:
--   encrypted rows that pass is_encrypted_channel_content(): content[0] the Megolm ciphertext,
--     encryption_metadata.algorithm megolm_v2_signed or megolm_v3
--   plaintext the sender consented to: metadata.plaintext_override.authorized = true, written by
--     the client's allowPlaintextFallback path (CoreMessageService.markPlaintextOverride)
--   soft-deleted rows and system messages
--   rows inserted by a server-side role (federation backend, bot gateway, SECURITY DEFINER
--     functions): current_user is neither authenticated nor anon
-- UPDATE is not checked: an edit of a message sent before the conversation was encrypted stays
-- plaintext, as the client has always written it.
--
-- conversation_encryption_settings INSERT and UPDATE of encryption_enabled send
--   {type: 'conversation:encryption', conversation_id, encryption_enabled}
-- on user:{participant} (event user_event) to every active participant.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.conversation_messages_encrypted(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT COALESCE((
        SELECT s.encryption_enabled
          FROM public.conversation_encryption_settings s
         WHERE s.conversation_id = p_conversation_id
    ), false);
$$;

REVOKE ALL ON FUNCTION public.conversation_messages_encrypted(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_messages_encrypted(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.conversation_messages_encrypted(uuid) IS
'Whether the conversation requires encrypted messages. SECURITY DEFINER: read by the SECURITY INVOKER plaintext guard.';

-- SECURITY INVOKER: current_user separates client inserts from server-side ones.
CREATE OR REPLACE FUNCTION public.enforce_conversation_message_encryption()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NEW.conversation_id IS NULL
       OR NEW.is_deleted IS TRUE
       OR NEW.is_system IS TRUE
       OR current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    IF NOT public.conversation_messages_encrypted(NEW.conversation_id) THEN
        RETURN NEW;
    END IF;

    IF NEW.encrypted IS TRUE AND public.is_encrypted_channel_content(NEW.content, NEW.encryption_metadata) THEN
        RETURN NEW;
    END IF;

    IF NEW.encrypted IS NOT TRUE
       AND jsonb_typeof(NEW.metadata) = 'object'
       AND NEW.metadata->'plaintext_override'->'authorized' = 'true'::jsonb THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'CONVERSATION_ENCRYPTED: this conversation is end-to-end encrypted and rejects plaintext messages'
        USING ERRCODE = 'check_violation',
              HINT = 'Encrypt the message, or send it with metadata.plaintext_override.authorized after the sender consents.';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_conversation_message_encryption() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_conversation_encryption ON public.messages;
CREATE TRIGGER trg_enforce_conversation_encryption
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_conversation_message_encryption();

CREATE OR REPLACE FUNCTION public.broadcast_conversation_encryption_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user uuid;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.encryption_enabled IS NOT DISTINCT FROM OLD.encryption_enabled THEN
        RETURN NEW;
    END IF;

    FOR v_user IN
        SELECT cp.user_id
          FROM public.conversation_participants cp
         WHERE cp.conversation_id = NEW.conversation_id
           AND cp.left_at IS NULL
    LOOP
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'conversation:encryption',
                'conversation_id', NEW.conversation_id,
                'encryption_enabled', COALESCE(NEW.encryption_enabled, false)
            ),
            'user_event',
            'user:' || v_user::text,
            true
        );
    END LOOP;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'broadcast_conversation_encryption_change failed: %', SQLERRM;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.broadcast_conversation_encryption_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_broadcast_conversation_encryption ON public.conversation_encryption_settings;
CREATE TRIGGER trg_broadcast_conversation_encryption
    AFTER INSERT OR UPDATE ON public.conversation_encryption_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_conversation_encryption_change();

COMMIT;
