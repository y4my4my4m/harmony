-- Embed suppression.
--
-- metadata.suppress_embeds hides a message's link previews and media embeds for every viewer.
-- set_message_embeds_suppressed sets or clears it for the author, or, in a server channel, a
-- member holding MANAGE_MESSAGES there. The stored previews (metadata.embeds) stay, so clearing
-- the flag restores them. The key is reserved: clients set it only through the RPC. updated_at
-- does not move (handle_messages_updated_at), so the message does not read as edited.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- As 20261005600001, plus 'suppress_embeds' among the reserved keys.
CREATE OR REPLACE FUNCTION public.guard_message_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reserved CONSTANT text[] := ARRAY[
        'type', 'federated', 'ap_id', 'from_domain', 'original_url', 'published',
        'conversation', 'in_reply_to_ap', 'pending_thread_ap_id', 'federated_at',
        'federated_to', 'embeds', 'bot', 'discord_user', 'discord_message_id', 'automod',
        'suppress_embeds'];
    v_new_meta jsonb;
    v_old_meta jsonb;
    v_key text;
    v_caller uuid;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    v_new_meta := CASE WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata ELSE '{}'::jsonb END;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_system IS TRUE THEN
            RAISE EXCEPTION 'SYSTEM_MESSAGE_FORBIDDEN: system messages are server-generated'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.bot_id IS NOT NULL THEN
            RAISE EXCEPTION 'bot_id is set by the bot API' USING ERRCODE = '42501';
        END IF;
        IF NEW.is_pinned IS TRUE OR NEW.pinned_at IS NOT NULL OR NEW.pinned_by IS NOT NULL THEN
            RAISE EXCEPTION 'pin fields are set by the server' USING ERRCODE = '42501';
        END IF;
        IF NEW.federation_status IS NOT NULL AND NEW.federation_status <> 'pending' THEN
            RAISE EXCEPTION 'federation_status is set by the server' USING ERRCODE = '42501';
        END IF;
        IF v_new_meta ?| v_reserved THEN
            RAISE EXCEPTION 'metadata key reserved for the server: %',
                (SELECT string_agg(k, ', ') FROM unnest(v_reserved) k WHERE v_new_meta ? k)
                USING ERRCODE = '42501';
        END IF;
        NEW.created_at := now();
        RETURN NEW;
    END IF;

    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.bot_id IS DISTINCT FROM OLD.bot_id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
       OR NEW.reply_to IS DISTINCT FROM OLD.reply_to
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.is_system IS DISTINCT FROM OLD.is_system
       OR NEW.federation_status IS DISTINCT FROM OLD.federation_status
       OR NEW.is_pinned IS DISTINCT FROM OLD.is_pinned
       OR NEW.pinned_at IS DISTINCT FROM OLD.pinned_at
       OR NEW.pinned_by IS DISTINCT FROM OLD.pinned_by THEN
        RAISE EXCEPTION 'message author, placement, system, pin and federation fields are fixed'
            USING ERRCODE = '42501';
    END IF;

    v_old_meta := CASE WHEN jsonb_typeof(OLD.metadata) = 'object' THEN OLD.metadata ELSE '{}'::jsonb END;
    FOREACH v_key IN ARRAY v_reserved LOOP
        IF v_new_meta -> v_key IS DISTINCT FROM v_old_meta -> v_key THEN
            RAISE EXCEPTION 'metadata key reserved for the server: %', v_key USING ERRCODE = '42501';
        END IF;
    END LOOP;

    IF OLD.is_deleted IS TRUE
       AND (NEW.is_deleted IS NOT TRUE OR NEW.content IS DISTINCT FROM OLD.content) THEN
        RAISE EXCEPTION 'MESSAGE_DELETED: a deleted message cannot be restored or edited'
            USING ERRCODE = '42501';
    END IF;

    v_caller := public.get_current_profile_id();
    IF OLD.is_system IS TRUE OR OLD.user_id IS DISTINCT FROM v_caller THEN
        IF NOT (OLD.is_deleted IS NOT TRUE AND NEW.is_deleted IS TRUE)
           OR NEW.metadata IS DISTINCT FROM OLD.metadata
           OR NEW.encrypted IS DISTINCT FROM OLD.encrypted
           OR NEW.encryption_metadata IS DISTINCT FROM OLD.encryption_metadata
           OR NEW.megolm_session_id IS DISTINCT FROM OLD.megolm_session_id
           OR NEW.megolm_message_index IS DISTINCT FROM OLD.megolm_message_index THEN
            RAISE EXCEPTION 'only the author edits a message; others may soft-delete it'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF NEW.content IS NOT DISTINCT FROM OLD.content THEN
        NEW.updated_at := OLD.updated_at;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_message_client_write() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_message_embeds_suppressed(p_message_id uuid, p_suppressed boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_msg record;
    v_server uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_suppressed IS NULL THEN
        RAISE EXCEPTION 'p_suppressed is required' USING ERRCODE = '22004';
    END IF;

    SELECT id, user_id, channel_id, conversation_id, is_deleted, is_system
      INTO v_msg
      FROM public.messages WHERE id = p_message_id;
    IF NOT FOUND OR v_msg.is_deleted IS TRUE THEN
        RAISE EXCEPTION 'Message not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_msg.user_id IS DISTINCT FROM v_caller THEN
        IF v_msg.channel_id IS NULL THEN
            RAISE EXCEPTION 'Only the author changes embeds in a direct message' USING ERRCODE = '42501';
        END IF;
        SELECT server_id INTO v_server FROM public.channels WHERE id = v_msg.channel_id;
        IF NOT public.has_permission(v_caller, v_server, 'MANAGE_MESSAGES', v_msg.channel_id) THEN
            RAISE EXCEPTION 'Permission denied: MANAGE_MESSAGES required' USING ERRCODE = '42501';
        END IF;
    END IF;

    UPDATE public.messages
       SET metadata = CASE WHEN p_suppressed
                           THEN COALESCE(CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata END, '{}'::jsonb)
                                || jsonb_build_object('suppress_embeds', true)
                           ELSE COALESCE(CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata END, '{}'::jsonb)
                                - 'suppress_embeds'
                      END
     WHERE id = p_message_id;

    RETURN p_suppressed;
END;
$$;

COMMENT ON FUNCTION public.set_message_embeds_suppressed(uuid, boolean) IS
    'Hide or restore a message''s embeds for every viewer: the author, or MANAGE_MESSAGES in its server channel.';

REVOKE ALL ON FUNCTION public.set_message_embeds_suppressed(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_message_embeds_suppressed(uuid, boolean) TO authenticated, service_role;

COMMIT;
