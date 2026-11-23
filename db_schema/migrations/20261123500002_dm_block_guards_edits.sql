-- A block between the two accounts of a direct conversation refuses edits as it refuses new messages.
--
-- a_messages_dm_block_edit_guard: an update that changes a direct message's content, encryption or
-- Megolm fields raises DM_UNDELIVERABLE through guard_dm_block (20261111500001_dm_blocks.sql), for
-- every role. A deletion passes: it sets is_deleted together with its [deleted] content. Authorless
-- rows and group conversations pass, as on insert.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS a_messages_dm_block_edit_guard ON public.messages;
CREATE TRIGGER a_messages_dm_block_edit_guard
    BEFORE UPDATE OF content, encrypted, encryption_metadata, megolm_session_id, megolm_message_index
    ON public.messages
    FOR EACH ROW
    WHEN (NEW.conversation_id IS NOT NULL
          AND NEW.user_id IS NOT NULL
          AND NEW.is_deleted IS NOT TRUE
          AND (NEW.content IS DISTINCT FROM OLD.content
               OR NEW.encrypted IS DISTINCT FROM OLD.encrypted
               OR NEW.encryption_metadata IS DISTINCT FROM OLD.encryption_metadata
               OR NEW.megolm_session_id IS DISTINCT FROM OLD.megolm_session_id
               OR NEW.megolm_message_index IS DISTINCT FROM OLD.megolm_message_index))
    EXECUTE FUNCTION public.guard_dm_block();

COMMIT;
