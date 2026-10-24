-- Messages no profile wrote (a bot, a channel webhook, a person the Discord bridge relays) reach
-- the copies of their server: its Group sends them with the author in harmony:author
-- (federation-backend activitypub/groupAuthor.ts), and a copy stores them with no profile and no
-- bot, the author in metadata.remote_author.
--
-- trigger_queue_channel_message_federation queues such a row (bot_id set, no user_id) in a local
-- server's channel; earlier it skipped every row without a local profile.
-- guard_message_client_write reserves remote_author and host_ap_id: a client posing as a remote
-- bot, or naming its message after a host's (resolveMessageInChannel), is refused.
BEGIN;

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF NEW.metadata ? 'federated' THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        IF NEW.encrypted IS TRUE OR public.channel_messages_encrypted(NEW.channel_id) THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        -- A system row has no author. Member events of a local server go out as its Group's
        -- (LIVE_SYSTEM_NOTE_TYPES in federation-backend systemNotes.ts); other notices stay here.
        IF NEW.is_system IS TRUE THEN
            IF COALESCE(NEW.metadata ->> 'type', '') NOT IN ('member_join', 'member_leave', 'member_kick', 'member_ban') THEN
                NEW.federation_status := 'skipped';
                RETURN NEW;
            END IF;
        ELSIF NEW.user_id IS NULL THEN
            -- A bot, webhook or bridged message: its server's Group speaks for it (local servers,
            -- below; federation-backend groupAuthor.ts).
            IF NEW.bot_id IS NULL THEN
                NEW.federation_status := 'skipped';
                RETURN NEW;
            END IF;
        ELSE
            SELECT is_local INTO v_author_is_local
            FROM public.profiles
            WHERE id = NEW.user_id;

            IF v_author_is_local IS NOT TRUE THEN
                NEW.federation_status := 'skipped';
                RETURN NEW;
            END IF;
        END IF;

        SELECT c.server_id, s.is_local_server
        INTO v_server_id, v_server_is_local
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF (NEW.is_system IS TRUE OR NEW.user_id IS NULL) AND v_server_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        NEW.federation_status := 'queued';

        PERFORM public.queue_federation_job(
            'federate-channel-message',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true),
                'created_at', NEW.created_at
            ),
            5, 5, 900
        );
    END IF;

    RETURN NEW;
END;
$$;

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
        'suppress_embeds', 'webhook', 'remote_author', 'host_ap_id'];
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

COMMIT;
