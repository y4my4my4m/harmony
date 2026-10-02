-- Server-only fields on client writes, client-originated notices, deleted DM recipients,
-- moderate_user's actor, and ban evasion through user_servers.
--
-- Client write. A statement executed as authenticated or anon at trigger depth 1: a
-- PostgREST request, or a SECURITY INVOKER function it calls. Definer functions run as
-- their owner (postgres, supabase_admin), bot-gateway and federation-backend as
-- service_role, and statements issued by triggers at depth > 1. None of those is a client
-- write. enforce_channel_message_encryption() applies the same test.
--
-- messages, client writes.
--   INSERT  refuses is_system, bot_id, pin fields, a federation_status other than pending
--           and the reserved metadata keys below. created_at is now().
--   UPDATE  refuses changes to user_id, bot_id, channel_id, conversation_id, thread_id,
--           reply_to, created_at, is_system, federation_status, pin fields and reserved
--           metadata keys; un-deleting; editing a deleted row. A row whose user_id is not
--           the caller (moderator path) or an is_system row may only be soft-deleted, with
--           metadata and encryption fields unchanged. updated_at moves only with content.
--   Reserved metadata keys: type, federated, ap_id, from_domain, original_url, published,
--   conversation, in_reply_to_ap, pending_thread_ap_id, federated_at, federated_to,
--   embeds, bot, discord_user, discord_message_id, automod. Federation, link previews,
--   bot-gateway and definer functions write them; the client UI trusts them.
--
-- messages, every writer. A row in a conversation whose other participants include a
-- deleted account and no live one raises RECIPIENT_DELETED. Deleted means a local profile
-- with no auth user: delete_my_account() detaches auth_user_id before removing the auth
-- user, and auth.users deletes cascade to profiles otherwise.
--
-- Notices formerly inserted by the client as is_system rows:
--   post_thread_created_notice(thread)              'started a thread', thread creator only
--   post_group_conversation_notice(conv, added)     group created / members added
--   start_dm_call_message(conv, call_type)          call_started, finalized by
--                                                   finalize_dm_call_message()
--
-- moderate_user acts as get_current_profile_id(); it must be a non-suspended admin or
-- moderator. p_admin_id stays in the signature for deployed clients and must be null or the
-- caller's auth uid. prevent_profile_moderation_self_update() still requires is_admin for
-- the flag write itself.
--
-- user_servers. Every writer: a row with a status other than banned cannot coexist with a
-- server_bans row. Client writes: user_id, server_id, member_instance and temporary are
-- fixed after insert (server inboxes relay channel traffic to https://<member_instance>/inbox,
-- and set_member_instance() derives it on insert only); a member cannot change the status
-- of their own row unless they own the server or are an instance admin.
--
-- posts, client writes. INSERT refuses is_local = false and an ap_id other than
-- https://<host>/activities/<uuid> (the client's boost id) or a url; counters are 0,
-- created_at is now(), federation bookkeeping and edit history are reset. UPDATE keeps
-- identity, counters, federation bookkeeping, reblog snapshot, threading, edit history and
-- metadata.reblog_of, and refuses un-deleting.
--
-- profiles, client writes. INSERT refuses is_local = false, a domain other than
-- instance_config 'domain', actor URLs not derived from https://<domain>/users/<username>,
-- public_key, featured/shared inbox URLs and moderation details; counters are 0 and
-- created_at is now(). UPDATE keeps federation identity, keys, counters, created_at and
-- moderation details; profiles_update_own already refuses a changed auth_user_id.
--
-- servers, client writes. INSERT refuses remote-server fields and featuring; UPDATE keeps
-- is_local_server, ap_id, host_domain, federation_domain, federation_inbox_url,
-- is_featured, featured_order, member_count and created_at. set_server_featured() features.
--
-- channels, client writes. INSERT refuses ap_id and is_remote; UPDATE keeps ap_id,
-- is_remote, federation_status and created_at.
--
-- UPDATE guards on posts, profiles, servers and channels restore OLD values rather than
-- raise: ServerSettings saves the whole fetched row. They read columns through
-- to_jsonb(row), so a column an instance lacks is skipped (production servers has no
-- member_count).

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_message_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reserved CONSTANT text[] := ARRAY[
        'type', 'federated', 'ap_id', 'from_domain', 'original_url', 'published',
        'conversation', 'in_reply_to_ap', 'pending_thread_ap_id', 'federated_at',
        'federated_to', 'embeds', 'bot', 'discord_user', 'discord_message_id', 'automod'];
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

DROP TRIGGER IF EXISTS a_messages_client_write_guard ON public.messages;
CREATE TRIGGER a_messages_client_write_guard
    BEFORE INSERT OR UPDATE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.guard_message_client_write();

-- A local profile without an auth user is a deleted account.
CREATE OR REPLACE FUNCTION public.refuse_message_to_deleted_recipient()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (
            SELECT 1
              FROM public.conversation_participants cp
              JOIN public.profiles p ON p.id = cp.user_id
             WHERE cp.conversation_id = NEW.conversation_id
               AND cp.user_id IS DISTINCT FROM NEW.user_id
               AND p.is_local IS TRUE AND p.auth_user_id IS NULL)
       AND NOT EXISTS (
            SELECT 1
              FROM public.conversation_participants cp
              JOIN public.profiles p ON p.id = cp.user_id
             WHERE cp.conversation_id = NEW.conversation_id
               AND cp.user_id IS DISTINCT FROM NEW.user_id
               AND cp.left_at IS NULL
               AND NOT (p.is_local IS TRUE AND p.auth_user_id IS NULL)) THEN
        RAISE EXCEPTION 'RECIPIENT_DELETED: the other participant deleted their account'
            USING ERRCODE = 'P0001',
                  HINT = 'Messages to a deleted account are not delivered.';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_message_to_deleted_recipient() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_deleted_recipient_guard ON public.messages;
CREATE TRIGGER a_messages_deleted_recipient_guard
    BEFORE INSERT ON public.messages
    FOR EACH ROW WHEN (NEW.conversation_id IS NOT NULL)
    EXECUTE FUNCTION public.refuse_message_to_deleted_recipient();

-- ---------------------------------------------------------------------------
-- Notices
-- ---------------------------------------------------------------------------

-- One notice per thread, by the thread's creator.
CREATE OR REPLACE FUNCTION public.post_thread_created_notice(p_thread_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_channel_id uuid;
    v_name text;
    v_creator uuid;
    v_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT t.channel_id, t.name, t.created_by INTO v_channel_id, v_name, v_creator
      FROM public.threads t
     WHERE t.id = p_thread_id;

    IF v_channel_id IS NULL OR v_creator IS DISTINCT FROM v_caller
       OR NOT public.can_view_channel(v_caller, v_channel_id) THEN
        RAISE EXCEPTION 'Thread not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('thread_created_notice:' || p_thread_id::text));

    SELECT m.id INTO v_id
      FROM public.messages m
     WHERE m.channel_id = v_channel_id
       AND m.is_system IS TRUE
       AND m.metadata ->> 'type' = 'thread_created'
       AND m.metadata ->> 'thread_id' = p_thread_id::text
     LIMIT 1;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
    VALUES (v_channel_id, v_caller,
            '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
            jsonb_build_object('type', 'thread_created', 'thread_id', p_thread_id,
                               'thread_name', v_name))
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- Group conversation notice. Without p_added_user_ids: the creation notice, once, by the
-- conversation's creator. With it: names the listed users who joined within the last ten
-- minutes. Text is built here; display names are the only user-chosen text.
CREATE OR REPLACE FUNCTION public.post_group_conversation_notice(
    p_conversation_id uuid, p_added_user_ids uuid[] DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_type text;
    v_creator uuid;
    v_text text;
    v_count integer;
    v_names text[];
    v_ids uuid[];
    v_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT c.type, c.created_by INTO v_type, v_creator
      FROM public.conversations c
     WHERE c.id = p_conversation_id;

    IF v_type IS DISTINCT FROM 'group' OR NOT EXISTS (
            SELECT 1 FROM public.conversation_participants cp
             WHERE cp.conversation_id = p_conversation_id
               AND cp.user_id = v_caller
               AND cp.left_at IS NULL) THEN
        RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('group_notice:' || p_conversation_id::text));

    IF p_added_user_ids IS NULL OR cardinality(p_added_user_ids) = 0 THEN
        IF v_creator IS DISTINCT FROM v_caller THEN
            RAISE EXCEPTION 'Only the creator announces the conversation' USING ERRCODE = '42501';
        END IF;
        SELECT m.id INTO v_id
          FROM public.messages m
         WHERE m.conversation_id = p_conversation_id
           AND m.is_system IS TRUE
           AND m.metadata ->> 'type' = 'group_created'
           AND m.metadata ->> 'event' = 'created'
         LIMIT 1;
        IF v_id IS NOT NULL THEN
            RETURN v_id;
        END IF;
        SELECT count(*) INTO v_count
          FROM public.conversation_participants cp
         WHERE cp.conversation_id = p_conversation_id AND cp.left_at IS NULL;
        v_text := format('Group conversation created with %s participants', v_count);
        v_ids := ARRAY[]::uuid[];
    ELSE
        SELECT array_agg(COALESCE(NULLIF(btrim(p.display_name), ''), p.username) ORDER BY cp.joined_at, p.id),
               array_agg(p.id ORDER BY cp.joined_at, p.id)
          INTO v_names, v_ids
          FROM public.conversation_participants cp
          JOIN public.profiles p ON p.id = cp.user_id
         WHERE cp.conversation_id = p_conversation_id
           AND cp.user_id = ANY (p_added_user_ids)
           AND cp.user_id <> v_caller
           AND cp.left_at IS NULL
           AND cp.joined_at >= now() - interval '10 minutes';
        IF v_ids IS NULL THEN
            RAISE EXCEPTION 'No recently added participants' USING ERRCODE = 'P0002';
        END IF;
        v_text := format('%s %s added to the conversation', array_to_string(v_names, ', '),
                         CASE WHEN cardinality(v_ids) = 1 THEN 'was' ELSE 'were' END);
    END IF;

    INSERT INTO public.messages (conversation_id, user_id, content, is_system, metadata)
    VALUES (p_conversation_id, v_caller,
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_text)), true,
            jsonb_build_object('type', 'group_created',
                               'event', CASE WHEN cardinality(v_ids) = 0 THEN 'created' ELSE 'members_added' END,
                               'user_ids', to_jsonb(v_ids)))
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_dm_call_message(p_conversation_id uuid, p_call_type text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_call_type IS NULL OR p_call_type NOT IN ('voice', 'video') THEN
        RAISE EXCEPTION 'call type is voice or video' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
            SELECT 1 FROM public.conversation_participants cp
             WHERE cp.conversation_id = p_conversation_id
               AND cp.user_id = v_caller
               AND cp.left_at IS NULL) THEN
        RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.messages (conversation_id, user_id, content, is_system, metadata)
    VALUES (p_conversation_id, v_caller,
            '[{"type": "text", "text": "started a call"}]'::jsonb, true,
            jsonb_build_object('type', 'call_started', 'call_type', p_call_type,
                               'started_at', now(), 'participants', jsonb_build_array(v_caller)))
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('post_thread_created_notice', 'post_group_conversation_notice',
                             'start_dm_call_message')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- moderate_user
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.moderate_user(
    p_admin_id uuid, p_target_user_id uuid, p_action text, p_reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_target_username text;
BEGIN
    IF p_admin_id IS NOT NULL AND p_admin_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'p_admin_id must be the caller' USING ERRCODE = '42501';
    END IF;

    SELECT p.id INTO v_actor
      FROM public.profiles p
     WHERE p.id = public.get_current_profile_id()
       AND (p.is_admin IS TRUE OR p.is_moderator IS TRUE)
       AND p.is_suspended IS NOT TRUE;

    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Insufficient permissions' USING ERRCODE = '42501';
    END IF;

    SELECT username INTO v_target_username FROM public.profiles WHERE id = p_target_user_id;
    IF v_target_username IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    IF p_action = 'suspend' THEN
        UPDATE public.profiles
           SET is_suspended = true, suspended_at = now(), suspension_reason = p_reason
         WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_suspend'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('reason', p_reason, 'username', v_target_username));
    ELSIF p_action = 'unsuspend' THEN
        UPDATE public.profiles
           SET is_suspended = false, suspended_at = NULL, suspension_reason = NULL
         WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_unsuspend'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('username', v_target_username));
    ELSIF p_action = 'force_sensitive' THEN
        UPDATE public.profiles SET force_sensitive = true WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_force_sensitive'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('reason', p_reason, 'username', v_target_username));
    ELSIF p_action = 'unforce_sensitive' THEN
        UPDATE public.profiles SET force_sensitive = false WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_unforce_sensitive'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('username', v_target_username));
    ELSIF p_action = 'silence' THEN
        UPDATE public.profiles
           SET is_silenced = true, silenced_at = now(), silenced_reason = p_reason
         WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_silence'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('reason', p_reason, 'username', v_target_username));
    ELSIF p_action = 'unsilence' THEN
        UPDATE public.profiles
           SET is_silenced = false, silenced_at = NULL, silenced_reason = NULL
         WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_unsilence'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('username', v_target_username));
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;

    RETURN true;
END;
$$;

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'moderate_user'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;
END;
$$;

COMMENT ON FUNCTION public.moderate_user(uuid, uuid, text, text) IS
    'Suspend, silence or force-sensitive a profile as the calling admin or moderator. p_admin_id is null or auth.uid(); p_target_user_id is profiles.id.';

-- ---------------------------------------------------------------------------
-- user_servers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refuse_banned_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM 'banned' AND EXISTS (
            SELECT 1 FROM public.server_bans b
             WHERE b.server_id = NEW.server_id AND b.user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'BANNED_FROM_SERVER: this account is banned from the server'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_banned_membership() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_user_servers_ban_guard ON public.user_servers;
CREATE TRIGGER a_user_servers_ban_guard
    BEFORE INSERT OR UPDATE OF status, user_id, server_id ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.refuse_banned_membership();

CREATE OR REPLACE FUNCTION public.guard_user_server_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.server_id IS DISTINCT FROM OLD.server_id
       OR NEW.member_instance IS DISTINCT FROM OLD.member_instance
       OR NEW.temporary IS DISTINCT FROM OLD.temporary THEN
        RAISE EXCEPTION 'membership identity, instance and temporary flag are fixed'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_caller := public.get_current_profile_id();
        IF OLD.user_id = v_caller
           AND NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = OLD.server_id AND s.owner = v_caller)
           AND NOT public.is_current_user_admin() THEN
            RAISE EXCEPTION 'a member cannot change their own membership status'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_user_server_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_user_servers_client_write_guard ON public.user_servers;
CREATE TRIGGER a_user_servers_client_write_guard
    BEFORE UPDATE ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.guard_user_server_client_write();

-- ---------------------------------------------------------------------------
-- posts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_post_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY[
        'is_local', 'ap_id', 'ap_type', 'url', 'created_at', 'replies_count',
        'reblogs_count', 'favorites_count', 'federation_status', 'federated_to',
        'last_federated_at', 'reblog', 'reblog_author', 'in_reply_to', 'conversation_id',
        'conversation_root_id', 'edit_history'];
    v_old jsonb;
    v_keep jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_local IS FALSE THEN
            RAISE EXCEPTION 'remote posts arrive through federation' USING ERRCODE = '42501';
        END IF;
        IF NEW.ap_id IS NOT NULL
           AND NEW.ap_id !~ '^https://[^/]+/activities/[0-9a-fA-F-]{36}$' THEN
            RAISE EXCEPTION 'ap_id is assigned by the server' USING ERRCODE = '42501';
        END IF;
        IF NEW.url IS NOT NULL THEN
            RAISE EXCEPTION 'url is assigned by the server' USING ERRCODE = '42501';
        END IF;
        NEW.created_at := now();
        NEW.replies_count := 0;
        NEW.reblogs_count := 0;
        NEW.favorites_count := 0;
        NEW.federated_to := NULL;
        NEW.last_federated_at := NULL;
        NEW.edit_history := '[]'::jsonb;
        NEW.is_deleted := false;
        NEW.deleted_at := NULL;
        RETURN NEW;
    END IF;

    IF OLD.is_deleted IS TRUE AND NEW.is_deleted IS NOT TRUE THEN
        RAISE EXCEPTION 'a deleted post cannot be restored' USING ERRCODE = '42501';
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;

    IF (NEW.metadata -> 'reblog_of') IS DISTINCT FROM (OLD.metadata -> 'reblog_of') THEN
        NEW.metadata := CASE
            WHEN OLD.metadata ? 'reblog_of'
                THEN COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object('reblog_of', OLD.metadata -> 'reblog_of')
            ELSE NEW.metadata - 'reblog_of'
        END;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_post_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_posts_client_write_guard ON public.posts;
CREATE TRIGGER a_posts_client_write_guard
    BEFORE INSERT OR UPDATE ON public.posts
    FOR EACH ROW EXECUTE FUNCTION public.guard_post_client_write();

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_profile_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY[
        'federated_id', 'inbox_url', 'outbox_url', 'followers_url', 'following_url',
        'featured_url', 'shared_inbox_url', 'public_key', 'domain', 'is_local',
        'followers_count', 'following_count', 'posts_count',
        'message_count', 'voice_minutes', 'created_at', 'suspended_at', 'suspension_reason',
        'silenced_at', 'silenced_reason', 'last_synced_at', 'last_federation_sync',
        'supported_activities'];
    v_domain text;
    v_actor text;
    v_old jsonb;
    v_keep jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_local IS FALSE THEN
            RAISE EXCEPTION 'remote profiles arrive through federation' USING ERRCODE = '42501';
        END IF;
        IF NEW.public_key IS NOT NULL OR NEW.featured_url IS NOT NULL OR NEW.shared_inbox_url IS NOT NULL
           OR NEW.suspended_at IS NOT NULL OR NEW.suspension_reason IS NOT NULL
           OR NEW.silenced_at IS NOT NULL OR NEW.silenced_reason IS NOT NULL THEN
            RAISE EXCEPTION 'keys and moderation details are set by the server' USING ERRCODE = '42501';
        END IF;

        SELECT lower(btrim(replace(c.config_value #>> '{}', '"', ''))) INTO v_domain
          FROM public.instance_config c
         WHERE c.config_key = 'domain';
        IF NEW.domain IS NOT NULL AND v_domain IS NOT NULL AND v_domain <> ''
           AND lower(NEW.domain) <> v_domain THEN
            RAISE EXCEPTION 'a local profile is on this instance''s domain' USING ERRCODE = '42501';
        END IF;

        v_actor := 'https://' || NEW.domain || '/users/' || NEW.username;
        IF (NEW.federated_id IS NOT NULL OR NEW.inbox_url IS NOT NULL OR NEW.outbox_url IS NOT NULL
            OR NEW.followers_url IS NOT NULL OR NEW.following_url IS NOT NULL)
           AND (v_actor IS NULL
                OR NEW.federated_id IS DISTINCT FROM v_actor
                OR (NEW.inbox_url IS NOT NULL AND NEW.inbox_url <> v_actor || '/inbox')
                OR (NEW.outbox_url IS NOT NULL AND NEW.outbox_url <> v_actor || '/outbox')
                OR (NEW.followers_url IS NOT NULL AND NEW.followers_url <> v_actor || '/followers')
                OR (NEW.following_url IS NOT NULL AND NEW.following_url <> v_actor || '/following')) THEN
            RAISE EXCEPTION 'actor URLs derive from https://<domain>/users/<username>' USING ERRCODE = '42501';
        END IF;

        NEW.created_at := now();
        NEW.followers_count := 0;
        NEW.following_count := 0;
        NEW.posts_count := 0;
        NEW.message_count := 0;
        NEW.voice_minutes := 0;
        RETURN NEW;
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profile_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_profiles_client_write_guard ON public.profiles;
CREATE TRIGGER a_profiles_client_write_guard
    BEFORE INSERT OR UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.guard_profile_client_write();

-- ---------------------------------------------------------------------------
-- servers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_server_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY[
        'is_local_server', 'ap_id', 'host_domain', 'federation_domain',
        'federation_inbox_url', 'is_featured', 'featured_order', 'member_count', 'created_at'];
    v_new jsonb;
    v_old jsonb;
    v_keep jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW);
        IF NEW.is_local_server IS FALSE OR NEW.ap_id IS NOT NULL OR NEW.host_domain IS NOT NULL
           OR NEW.federation_domain IS NOT NULL OR NEW.federation_inbox_url IS NOT NULL THEN
            RAISE EXCEPTION 'remote servers arrive through federation' USING ERRCODE = '42501';
        END IF;
        IF NEW.is_featured IS TRUE OR COALESCE((v_new ->> 'featured_order')::integer, 0) <> 0
           OR COALESCE((v_new ->> 'member_count')::integer, 0) <> 0 THEN
            RAISE EXCEPTION 'featuring and member counts are set by the server' USING ERRCODE = '42501';
        END IF;
        NEW.created_at := now();
        RETURN NEW;
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_server_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_servers_client_write_guard ON public.servers;
CREATE TRIGGER a_servers_client_write_guard
    BEFORE INSERT OR UPDATE ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.guard_server_client_write();

-- ---------------------------------------------------------------------------
-- channels
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_channel_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY['ap_id', 'is_remote', 'federation_status', 'created_at'];
    v_old jsonb;
    v_keep jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.ap_id IS NOT NULL OR NEW.is_remote IS TRUE THEN
            RAISE EXCEPTION 'remote channels arrive through federation' USING ERRCODE = '42501';
        END IF;
        NEW.created_at := now();
        RETURN NEW;
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_channel_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_channels_client_write_guard ON public.channels;
CREATE TRIGGER a_channels_client_write_guard
    BEFORE INSERT OR UPDATE ON public.channels
    FOR EACH ROW EXECUTE FUNCTION public.guard_channel_client_write();

-- Accepted memberships that coexist with a ban predate refuse_banned_membership(). They
-- are reported, not removed: removal fires leave notices and federation.
DO $$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*) INTO v_count
      FROM public.user_servers us
      JOIN public.server_bans b ON b.server_id = us.server_id AND b.user_id = us.user_id
     WHERE us.status IS DISTINCT FROM 'banned';
    IF v_count > 0 THEN
        RAISE NOTICE 'user_servers: % membership row(s) coexist with a server ban', v_count;
    END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
