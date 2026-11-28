-- A live relay that loses to a history import.
--
-- messages_channel_discord_message_id_unique holds one live row per Discord message per channel.
-- When a history import stored a Discord message before its live relay arrived (a relay delayed
-- past the importer's recency margin), the relay's insert met the imported row and bot-gateway
-- answered with it: a quiet row (harmony.history_import, 20261110900004) that sent no realtime
-- insert, no unread count, notification or federation.
--
-- bridge_relay_supersede_import(bot, imported message, thread, reply_to, content, metadata) -> uuid
--   The imported row (this bot's, metadata.history_import, live, the same Discord id and thread)
--   gives up its Discord id under the import's flag, and the relay's row is inserted as any live
--   message of the bot. Replies, a thread started on it, reactions, reports and its pin move to the
--   new row; the imported row is then deleted, with the realtime delete that takes it off clients
--   that loaded it. NULL: the row is no such import, and the relay answers with it as before.
--   relay_dropped (P0001): AutoMod dropped the live row; nothing changes.
--
-- SECURITY INVOKER, granted to the service role alone: the insert runs as bot-gateway's own insert
-- does, and AutoMod judges it by that invoker (automod_message_guard passes current_user).

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.bridge_relay_supersede_import(
    p_bot_id uuid,
    p_message_id uuid,
    p_thread_id uuid,
    p_reply_to uuid,
    p_content jsonb,
    p_metadata jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_old public.messages;
    v_id uuid;
    v_flag text := current_setting('harmony.history_import', true);
    v_silent text := current_setting('harmony.silent_content_update', true);
BEGIN
    SELECT * INTO v_old FROM public.messages m WHERE m.id = p_message_id FOR UPDATE;
    IF NOT FOUND
       OR v_old.bot_id IS DISTINCT FROM p_bot_id
       OR v_old.channel_id IS NULL
       OR v_old.is_deleted IS TRUE
       OR v_old.metadata ->> 'history_import' IS DISTINCT FROM 'true'
       OR v_old.metadata ->> 'discord_message_id' IS DISTINCT FROM p_metadata ->> 'discord_message_id'
       OR v_old.thread_id IS DISTINCT FROM p_thread_id THEN
        RETURN NULL;
    END IF;

    -- Quiet, as the import wrote it: no realtime update, no federation, no edit time.
    PERFORM set_config('harmony.history_import', 'true', true);
    PERFORM set_config('harmony.silent_content_update', 'true', true);
    UPDATE public.messages m
       SET metadata = m.metadata - 'discord_message_id',
           is_pinned = false, pinned_at = NULL, pinned_by = NULL
     WHERE m.id = v_old.id;
    PERFORM set_config('harmony.history_import', COALESCE(v_flag, ''), true);
    PERFORM set_config('harmony.silent_content_update', COALESCE(v_silent, ''), true);

    INSERT INTO public.messages (channel_id, thread_id, bot_id, content, reply_to, metadata)
    VALUES (v_old.channel_id, p_thread_id, p_bot_id, p_content, p_reply_to, p_metadata)
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'relay_dropped' USING ERRCODE = 'P0001';
    END IF;

    PERFORM set_config('harmony.history_import', 'true', true);
    PERFORM set_config('harmony.silent_content_update', 'true', true);
    UPDATE public.messages m SET reply_to = v_id WHERE m.reply_to = v_old.id;
    IF v_old.is_pinned THEN
        UPDATE public.messages m
           SET is_pinned = true, pinned_at = v_old.pinned_at, pinned_by = v_old.pinned_by
         WHERE m.id = v_id;
    END IF;
    PERFORM set_config('harmony.history_import', COALESCE(v_flag, ''), true);
    PERFORM set_config('harmony.silent_content_update', COALESCE(v_silent, ''), true);

    UPDATE public.threads t SET parent_message_id = v_id WHERE t.parent_message_id = v_old.id;
    UPDATE public.reactions r SET message_id = v_id WHERE r.message_id = v_old.id;
    UPDATE public.reports r SET reported_message_id = v_id WHERE r.reported_message_id = v_old.id;

    DELETE FROM public.messages m WHERE m.id = v_old.id;
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_relay_supersede_import(uuid, uuid, uuid, uuid, jsonb, jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_relay_supersede_import(uuid, uuid, uuid, uuid, jsonb, jsonb)
    TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
