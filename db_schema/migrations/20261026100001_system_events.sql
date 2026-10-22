-- System messages are authorless events. A row with is_system true has user_id and bot_id NULL
-- (messages_system_authorless); the people it is about are in metadata, under metadata.type:
--
--   member_join, member_leave          subject_id
--   member_kick, member_ban            subject_id, actor_id, reason
--   thread_created                     actor_id or actor_bot_id (a bridge bot; with discord_user
--                                      for the Discord member), thread_id, thread_name, standalone
--   group_created                      actor_id, event 'created' with participant_count, or
--                                      'members_added' with user_ids
--   call_started, call_ended           actor_id (the caller), call_type, started_at, participants;
--                                      call_ended adds ended_at, duration_seconds
--   channel_encryption_enabled|disabled, channel_voice_encryption_enabled|disabled
--                                      actor_id
--   automod_alert                      automod (unchanged)
--
-- content keeps the English text clients before 1.8.11 render for an unknown type; current
-- clients render each known type from metadata. In a conversation the actor is the sender, for
-- the dm / chat_message notification and refuse_message_to_deleted_recipient. Of a local server,
-- member_join, member_leave, member_kick and member_ban are queued for federation, delivered as
-- the server Group's own Note; other system rows are not federated live. System rows are not in
-- message_search_index.
--
-- Existing rows move user_id into subject_id or actor_id (kicked_by and banned_by become
-- actor_id) and bot_id into actor_bot_id; profiles.message_count drops the rows moved. Notices
-- of remote servers cached before 1.8.11 as ordinary messages of the member they named are
-- matched on the host's exact content and become system rows.

BEGIN;

-- Other sessions run the replaced function bodies, which write user_id on system rows, until
-- this commits; held from here, no such row lands between the row moves and the CHECK.
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.messages IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.handle_member_join_system_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel_id uuid;
    v_enabled boolean;
    v_is_local boolean;
BEGIN
    IF NEW.status IS NOT NULL AND NEW.status != 'accepted' THEN
        RETURN NEW;
    END IF;

    -- Only emit join messages for local servers, not remote server references
    SELECT is_local_server INTO v_is_local
    FROM servers
    WHERE id = NEW.server_id;

    IF v_is_local IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    SELECT system_channel_id, system_messages_enabled INTO v_channel_id, v_enabled
    FROM server_settings
    WHERE server_id = NEW.server_id;

    IF v_enabled IS FALSE THEN
        RETURN NEW;
    END IF;

    IF v_channel_id IS NULL THEN
        v_channel_id := get_default_channel(NEW.server_id);
    END IF;

    IF v_channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO messages (channel_id, content, is_system, metadata)
    VALUES (
        v_channel_id,
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'has joined the server')),
        true,
        jsonb_build_object('type', 'member_join', 'subject_id', NEW.user_id)
    );

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_member_leave_system_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel_id uuid;
    v_enabled boolean;
    v_is_local boolean;
BEGIN
    -- A kick or ban posts "was kicked/banned"; "has left" is not posted for it.
    IF current_setting('harmony.skip_leave_message', true) = '1' THEN
        RETURN OLD;
    END IF;

    IF current_setting('harmony.account_delete', true) = '1' THEN
        RETURN OLD;
    END IF;

    IF OLD.status IS NOT NULL AND OLD.status != 'accepted' THEN
        RETURN OLD;
    END IF;

    -- Profile account deletion cascades user_servers after the profile is gone.
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = OLD.user_id) THEN
        RETURN OLD;
    END IF;

    -- Only emit for local servers, and skip cascade deletes (server gone).
    SELECT is_local_server INTO v_is_local
    FROM servers
    WHERE id = OLD.server_id;

    IF NOT FOUND OR v_is_local IS NOT TRUE THEN
        RETURN OLD;
    END IF;

    SELECT system_channel_id, system_messages_enabled INTO v_channel_id, v_enabled
    FROM server_settings
    WHERE server_id = OLD.server_id;

    IF v_enabled IS FALSE THEN
        RETURN OLD;
    END IF;

    IF v_channel_id IS NULL THEN
        v_channel_id := get_default_channel(OLD.server_id);
    END IF;

    IF v_channel_id IS NULL THEN
        RETURN OLD;
    END IF;

    INSERT INTO messages (channel_id, content, is_system, metadata)
    VALUES (
        v_channel_id,
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'has left the server')),
        true,
        jsonb_build_object('type', 'member_leave', 'subject_id', OLD.user_id)
    );

    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.kick_server_member(
    p_server_id uuid,
    p_user_id uuid,
    p_reason text DEFAULT NULL,
    p_delete_message_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller_id uuid;
    v_is_owner boolean;
    v_has_permission boolean;
    v_caller_position integer;
    v_target_position integer;
    v_target_is_owner boolean;
    v_deleted_count integer := 0;
    v_system_channel_id uuid;
    v_system_messages_enabled boolean;
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF v_caller_id = p_user_id THEN
        RAISE EXCEPTION 'Cannot kick yourself';
    END IF;

    SELECT (owner = p_user_id) INTO v_target_is_owner
    FROM public.servers WHERE id = p_server_id;
    IF v_target_is_owner THEN
        RAISE EXCEPTION 'Cannot kick the server owner';
    END IF;

    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;

    IF NOT v_is_owner THEN
        SELECT COALESCE((public.get_user_permissions(v_caller_id, p_server_id)->>'KICK_MEMBERS')::boolean, false)
        INTO v_has_permission;
        IF NOT v_has_permission THEN
            RAISE EXCEPTION 'Missing KICK_MEMBERS permission';
        END IF;
    END IF;

    IF NOT v_is_owner THEN
        v_caller_position := public.get_user_highest_role_position(v_caller_id, p_server_id);
        v_target_position := public.get_user_highest_role_position(p_user_id, p_server_id);
        IF v_caller_position <= v_target_position THEN
            RAISE EXCEPTION 'Cannot kick a member with an equal or higher role';
        END IF;
    END IF;

    IF p_delete_message_seconds > 0 THEN
        UPDATE public.messages
        SET is_deleted = true, content = '[{"type":"text","content":"[message deleted]"}]'::jsonb
        WHERE user_id = p_user_id
          AND channel_id IN (SELECT id FROM public.channels WHERE server_id = p_server_id)
          AND created_at > now() - (p_delete_message_seconds || ' seconds')::interval
          AND is_deleted = false;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    -- Suppresses the "has left the server" trigger; "was kicked" is posted below.
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    DELETE FROM public.user_servers
    WHERE user_id = p_user_id AND server_id = p_server_id;

    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_user_id, 'kick', jsonb_build_object(
        'kicked_by', v_caller_id,
        'reason', COALESCE(p_reason, ''),
        'messages_deleted', v_deleted_count
    ));

    SELECT system_channel_id, system_messages_enabled
      INTO v_system_channel_id, v_system_messages_enabled
    FROM public.server_settings WHERE server_id = p_server_id;
    IF v_system_messages_enabled IS NOT FALSE THEN
        IF v_system_channel_id IS NULL THEN
            v_system_channel_id := public.get_default_channel(p_server_id);
        END IF;
        IF v_system_channel_id IS NOT NULL THEN
            INSERT INTO public.messages (channel_id, content, is_system, metadata)
            VALUES (
                v_system_channel_id,
                jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'was kicked from the server')),
                true,
                jsonb_build_object('type', 'member_kick', 'subject_id', p_user_id, 'actor_id', v_caller_id,
                                   'reason', COALESCE(p_reason, ''))
            );
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'messages_deleted', v_deleted_count
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.ban_server_member(
    p_server_id uuid,
    p_user_id uuid,
    p_reason text DEFAULT NULL,
    p_delete_message_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller_id uuid;
    v_is_owner boolean;
    v_has_permission boolean;
    v_caller_position integer;
    v_target_position integer;
    v_target_is_owner boolean;
    v_deleted_count integer := 0;
    v_already_banned boolean;
    v_system_channel_id uuid;
    v_system_messages_enabled boolean;
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF v_caller_id = p_user_id THEN
        RAISE EXCEPTION 'Cannot ban yourself';
    END IF;

    SELECT (owner = p_user_id) INTO v_target_is_owner
    FROM public.servers WHERE id = p_server_id;
    IF v_target_is_owner THEN
        RAISE EXCEPTION 'Cannot ban the server owner';
    END IF;

    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;

    IF NOT v_is_owner THEN
        SELECT COALESCE((public.get_user_permissions(v_caller_id, p_server_id)->>'BAN_MEMBERS')::boolean, false)
        INTO v_has_permission;
        IF NOT v_has_permission THEN
            RAISE EXCEPTION 'Missing BAN_MEMBERS permission';
        END IF;
    END IF;

    IF NOT v_is_owner THEN
        v_caller_position := public.get_user_highest_role_position(v_caller_id, p_server_id);
        v_target_position := public.get_user_highest_role_position(p_user_id, p_server_id);
        IF v_caller_position <= v_target_position THEN
            RAISE EXCEPTION 'Cannot ban a member with an equal or higher role';
        END IF;
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM public.server_bans
        WHERE server_id = p_server_id AND user_id = p_user_id
    ) INTO v_already_banned;

    IF v_already_banned THEN
        RETURN jsonb_build_object('success', true, 'already_banned', true, 'messages_deleted', 0);
    END IF;

    IF p_delete_message_seconds > 0 THEN
        UPDATE public.messages
        SET is_deleted = true, content = '[{"type":"text","content":"[message deleted]"}]'::jsonb
        WHERE user_id = p_user_id
          AND channel_id IN (SELECT id FROM public.channels WHERE server_id = p_server_id)
          AND created_at > now() - (p_delete_message_seconds || ' seconds')::interval
          AND is_deleted = false;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    INSERT INTO public.server_bans (server_id, user_id, banned_by, reason, delete_message_seconds)
    VALUES (p_server_id, p_user_id, v_caller_id, p_reason, p_delete_message_seconds);

    -- Suppresses the "has left the server" trigger; "was banned" is posted below.
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    DELETE FROM public.user_servers
    WHERE user_id = p_user_id AND server_id = p_server_id;

    DELETE FROM public.user_roles
    WHERE user_id = p_user_id AND server_id = p_server_id;

    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_user_id, 'ban', jsonb_build_object(
        'banned_by', v_caller_id,
        'reason', COALESCE(p_reason, ''),
        'messages_deleted', v_deleted_count
    ));

    SELECT system_channel_id, system_messages_enabled
      INTO v_system_channel_id, v_system_messages_enabled
    FROM public.server_settings WHERE server_id = p_server_id;
    IF v_system_messages_enabled IS NOT FALSE THEN
        IF v_system_channel_id IS NULL THEN
            v_system_channel_id := public.get_default_channel(p_server_id);
        END IF;
        IF v_system_channel_id IS NOT NULL THEN
            INSERT INTO public.messages (channel_id, content, is_system, metadata)
            VALUES (
                v_system_channel_id,
                jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'was banned from the server')),
                true,
                jsonb_build_object('type', 'member_ban', 'subject_id', p_user_id, 'actor_id', v_caller_id,
                                   'reason', COALESCE(p_reason, ''))
            );
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'messages_deleted', v_deleted_count
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_channel_thread(p_channel_id uuid, p_name text, p_auto_archive_duration integer DEFAULT 1440)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_server_id uuid;
    v_name text := btrim(coalesce(p_name, ''));
    v_thread_id uuid := gen_random_uuid();
    v_notice_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT c.server_id INTO v_server_id
      FROM public.channels c
     WHERE c.id = p_channel_id;

    -- A channel the caller cannot view reads as absent.
    IF v_server_id IS NULL OR NOT public.can_view_channel(v_caller, p_channel_id) THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.has_permission(v_caller, v_server_id, 'CREATE_PUBLIC_THREADS', p_channel_id) THEN
        RAISE EXCEPTION 'Unauthorized: CREATE_PUBLIC_THREADS required' USING ERRCODE = '42501';
    END IF;
    PERFORM public.refuse_timed_out_caller(v_server_id);

    IF char_length(v_name) NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'Thread name must be 1 to 100 characters' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.messages (channel_id, content, is_system, metadata)
    VALUES (p_channel_id,
            '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
            jsonb_build_object('type', 'thread_created', 'actor_id', v_caller, 'thread_id', v_thread_id,
                               'thread_name', v_name, 'standalone', true))
    RETURNING id INTO v_notice_id;

    INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, auto_archive_duration)
    VALUES (v_thread_id, p_channel_id, v_notice_id, v_name, v_caller,
            coalesce(p_auto_archive_duration, 1440));

    INSERT INTO public.thread_members (thread_id, user_id)
    VALUES (v_thread_id, v_caller);

    UPDATE public.threads SET member_count = 1 WHERE id = v_thread_id;

    RETURN v_thread_id;
END;
$$;

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

    INSERT INTO public.messages (channel_id, content, is_system, metadata)
    VALUES (v_channel_id,
            '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
            jsonb_build_object('type', 'thread_created', 'actor_id', v_caller, 'thread_id', p_thread_id,
                               'thread_name', v_name))
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_create_thread(
    p_bot_id uuid,
    p_channel_id uuid,
    p_name text,
    p_parent_message_id uuid DEFAULT NULL,
    p_discord_thread_id text DEFAULT NULL,
    p_discord_user jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id uuid;
    v_bridge_id uuid;
    v_name text := left(btrim(coalesce(p_name, '')), 100);
    v_thread_id uuid;
    v_parent record;
    v_notice_id uuid;
    v_notice jsonb;
BEGIN
    IF p_bot_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.bots WHERE id = p_bot_id) THEN
        RAISE EXCEPTION 'Bot not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT c.server_id INTO v_server_id FROM public.channels c WHERE c.id = p_channel_id;
    IF v_server_id IS NULL THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'Thread name must be 1 to 100 characters' USING ERRCODE = '22023';
    END IF;

    IF p_discord_thread_id IS NOT NULL THEN
        IF p_discord_thread_id !~ '^[0-9]{1,20}$' THEN
            RAISE EXCEPTION 'Invalid Discord thread id' USING ERRCODE = '22023';
        END IF;
        SELECT b.id INTO v_bridge_id
          FROM public.discord_bridges b
         WHERE b.server_id = v_server_id AND b.bot_id = p_bot_id;
        IF v_bridge_id IS NULL THEN
            RAISE EXCEPTION 'The bot runs no bridge on this server' USING ERRCODE = '42501';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtext('bridge_thread:' || v_bridge_id::text || ':' || p_discord_thread_id));
        SELECT bt.thread_id INTO v_thread_id
          FROM public.discord_bridge_threads bt
         WHERE bt.bridge_id = v_bridge_id AND bt.discord_thread_id = p_discord_thread_id;
        IF v_thread_id IS NOT NULL THEN
            RETURN v_thread_id;
        END IF;
    END IF;

    v_notice := jsonb_build_object('type', 'thread_created', 'actor_bot_id', p_bot_id,
                                   'thread_name', v_name, 'bridge_source', 'discord');
    -- The Discord member who started the thread names the notice (messageAuthor.ts discord_user).
    IF jsonb_typeof(p_discord_user) = 'object' AND p_discord_user->>'id' ~ '^[0-9]{1,20}$' THEN
        v_notice := v_notice || jsonb_build_object('discord_user', jsonb_strip_nulls(jsonb_build_object(
            'id', p_discord_user->>'id',
            'username', left(p_discord_user->>'username', 100),
            'display_name', left(p_discord_user->>'display_name', 100),
            'avatar_url', CASE WHEN p_discord_user->>'avatar_url' ~ '^https://' THEN left(p_discord_user->>'avatar_url', 2048) END)));
    END IF;

    IF p_parent_message_id IS NOT NULL THEN
        SELECT m.id, m.channel_id, m.user_id, m.thread_id, m.is_system
          INTO v_parent
          FROM public.messages m
         WHERE m.id = p_parent_message_id;
        IF NOT FOUND OR v_parent.channel_id IS DISTINCT FROM p_channel_id OR v_parent.thread_id IS NOT NULL THEN
            RAISE EXCEPTION 'Message not found in this channel' USING ERRCODE = 'P0002';
        END IF;

        -- One thread per message, as create_thread; an existing one is paired and returned.
        PERFORM pg_advisory_xact_lock(hashtext('create_thread:' || p_parent_message_id::text));
        SELECT t.id INTO v_thread_id FROM public.threads t WHERE t.parent_message_id = p_parent_message_id;

        IF v_thread_id IS NULL THEN
            INSERT INTO public.threads (channel_id, parent_message_id, name, created_by, auto_archive_duration)
            VALUES (p_channel_id, p_parent_message_id, v_name, NULL, 1440)
            RETURNING id INTO v_thread_id;

            INSERT INTO public.thread_members (thread_id, user_id)
            SELECT v_thread_id, v_parent.user_id
             WHERE v_parent.user_id IS NOT NULL
               AND public.can_view_channel(v_parent.user_id, p_channel_id)
            ON CONFLICT (thread_id, user_id) DO NOTHING;

            UPDATE public.threads
               SET member_count = (SELECT count(*) FROM public.thread_members WHERE thread_id = v_thread_id)
             WHERE id = v_thread_id;

            INSERT INTO public.messages (channel_id, content, is_system, metadata)
            VALUES (p_channel_id,
                    '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                    v_notice || jsonb_build_object('thread_id', v_thread_id));
        END IF;
    ELSE
        v_thread_id := gen_random_uuid();
        INSERT INTO public.messages (channel_id, content, is_system, metadata)
        VALUES (p_channel_id,
                '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                v_notice || jsonb_build_object('thread_id', v_thread_id, 'standalone', true))
        RETURNING id INTO v_notice_id;

        INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, auto_archive_duration)
        VALUES (v_thread_id, p_channel_id, v_notice_id, v_name, NULL, 1440);
    END IF;

    IF v_bridge_id IS NOT NULL THEN
        INSERT INTO public.discord_bridge_threads (thread_id, bridge_id, discord_thread_id)
        VALUES (v_thread_id, v_bridge_id, p_discord_thread_id)
        ON CONFLICT (thread_id) DO NOTHING;
    END IF;

    RETURN v_thread_id;
END;
$$;

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

    INSERT INTO public.messages (conversation_id, content, is_system, metadata)
    VALUES (p_conversation_id,
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_text)), true,
            jsonb_build_object('type', 'group_created', 'actor_id', v_caller,
                               'event', CASE WHEN cardinality(v_ids) = 0 THEN 'created' ELSE 'members_added' END,
                               'user_ids', to_jsonb(v_ids))
            || CASE WHEN cardinality(v_ids) = 0
                    THEN jsonb_build_object('participant_count', v_count) ELSE '{}'::jsonb END)
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

    INSERT INTO public.messages (conversation_id, content, is_system, metadata)
    VALUES (p_conversation_id,
            '[{"type": "text", "text": "started a call"}]'::jsonb, true,
            jsonb_build_object('type', 'call_started', 'actor_id', v_caller, 'call_type', p_call_type,
                               'started_at', now(), 'participants', jsonb_build_array(v_caller)))
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_dm_call_message(
    p_message_id uuid,
    p_ended_at timestamptz,
    p_duration_seconds integer,
    p_participants uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_msg record;
    v_profile_id uuid;
BEGIN
    SELECT id, conversation_id, metadata
    INTO v_msg
    FROM messages
    WHERE id = p_message_id
      AND is_system = true
      AND conversation_id IS NOT NULL;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Idempotent: first finalizer wins, later calls are no-ops
    IF v_msg.metadata->>'type' = 'call_ended' THEN
        RETURN;
    END IF;

    IF v_msg.metadata->>'type' IS DISTINCT FROM 'call_started' THEN
        RAISE EXCEPTION 'message is not a call system message';
    END IF;

    SELECT id INTO v_profile_id
    FROM profiles
    WHERE auth_user_id = auth.uid();

    IF v_profile_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM conversation_participants cp
        WHERE cp.conversation_id = v_msg.conversation_id
          AND cp.user_id = v_profile_id
          AND cp.left_at IS NULL
    ) THEN
        RAISE EXCEPTION 'not a participant of this conversation';
    END IF;

    UPDATE messages
    SET metadata = jsonb_build_object(
            'type', 'call_ended',
            'actor_id', v_msg.metadata->'actor_id',
            'call_type', v_msg.metadata->>'call_type',
            'started_at', v_msg.metadata->>'started_at',
            'ended_at', p_ended_at,
            'duration_seconds', p_duration_seconds,
            'participants', to_jsonb(p_participants)
        ),
        updated_at = now()
    WHERE id = p_message_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_channel_encryption(
    p_channel_id uuid,
    p_messages_encrypted boolean DEFAULT NULL,
    p_voice_encrypted boolean DEFAULT NULL,
    p_history_visibility text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_server_id uuid;
    v_owner uuid;
    v_is_local boolean;
    v_mode text;
    v_voice_mode text;
    v_row public.channel_encryption_settings;
    v_messages_before boolean;
    v_messages_after boolean;
    v_voice_before boolean;
    v_voice_after boolean;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT c.server_id, s.owner, s.is_local_server
      INTO v_server_id, v_owner, v_is_local
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;

    IF v_server_id IS NULL THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;

    IF NOT (
        public.is_current_user_admin()
        OR v_owner = v_caller
        OR (
            EXISTS (SELECT 1 FROM public.user_servers us
                     WHERE us.server_id = v_server_id
                       AND us.user_id = v_caller
                       AND us.status = 'accepted')
            AND public.has_permission(v_caller, v_server_id, 'MANAGE_CHANNELS', p_channel_id)
        )
    ) THEN
        RAISE EXCEPTION 'Missing MANAGE_CHANNELS permission for this channel' USING ERRCODE = '42501';
    END IF;

    IF v_is_local IS NOT TRUE THEN
        RAISE EXCEPTION 'Encryption settings apply to channels of local servers only' USING ERRCODE = '22023';
    END IF;

    IF p_history_visibility IS NOT NULL AND p_history_visibility NOT IN ('joined', 'shared') THEN
        RAISE EXCEPTION 'Unknown history visibility: %', p_history_visibility USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(ses.encryption_mode, 'disabled'), COALESCE(ses.voice_encryption_mode, 'disabled')
      INTO v_mode, v_voice_mode
      FROM (SELECT 1) one
      LEFT JOIN public.server_encryption_settings ses ON ses.server_id = v_server_id;

    IF p_messages_encrypted IS TRUE AND v_mode = 'disabled' THEN
        RAISE EXCEPTION 'End-to-end encryption is disabled for this server' USING ERRCODE = '22023';
    END IF;
    IF p_messages_encrypted IS FALSE AND v_mode IN ('required', 'required_local_only') THEN
        RAISE EXCEPTION 'This server requires end-to-end encryption in every channel' USING ERRCODE = '22023';
    END IF;
    IF p_voice_encrypted IS FALSE AND v_voice_mode = 'required' THEN
        RAISE EXCEPTION 'This server requires end-to-end encrypted voice in every channel' USING ERRCODE = '22023';
    END IF;

    PERFORM public.seed_channel_encryption_settings(ARRAY[p_channel_id]);

    SELECT * INTO v_row
      FROM public.channel_encryption_settings
     WHERE channel_id = p_channel_id
       FOR UPDATE;

    v_messages_before := public.channel_messages_encrypted(p_channel_id);
    v_voice_before := v_voice_mode = 'required' OR v_row.voice_encrypted;

    UPDATE public.channel_encryption_settings
       SET messages_encrypted = COALESCE(p_messages_encrypted, messages_encrypted),
           voice_encrypted = COALESCE(p_voice_encrypted, voice_encrypted),
           history_visibility = COALESCE(p_history_visibility, history_visibility),
           enabled_at = CASE
                          WHEN p_messages_encrypted IS TRUE AND NOT messages_encrypted THEN now()
                          WHEN p_messages_encrypted IS FALSE THEN NULL
                          ELSE enabled_at
                        END,
           enabled_by = CASE
                          WHEN p_messages_encrypted IS TRUE AND NOT messages_encrypted THEN v_caller
                          WHEN p_messages_encrypted IS FALSE THEN NULL
                          ELSE enabled_by
                        END,
           updated_at = now()
     WHERE channel_id = p_channel_id
    RETURNING * INTO v_row;

    v_messages_after := public.channel_messages_encrypted(p_channel_id);
    v_voice_after := v_voice_mode = 'required' OR v_row.voice_encrypted;

    IF v_messages_after AND NOT v_messages_before THEN
        PERFORM public.bump_room_epoch(p_channel_id::text, 'encryption_enabled');
    END IF;

    IF v_messages_after IS DISTINCT FROM v_messages_before THEN
        INSERT INTO public.messages (channel_id, content, is_system, metadata)
        VALUES (
            p_channel_id,
            jsonb_build_array(jsonb_build_object(
                'type', 'text',
                'text', CASE WHEN v_messages_after THEN 'turned on end-to-end encryption'
                             ELSE 'turned off end-to-end encryption' END)),
            true,
            jsonb_build_object('type', CASE WHEN v_messages_after THEN 'channel_encryption_enabled'
                                            ELSE 'channel_encryption_disabled' END,
                               'actor_id', v_caller)
        );
    END IF;

    IF v_voice_after IS DISTINCT FROM v_voice_before THEN
        INSERT INTO public.messages (channel_id, content, is_system, metadata)
        VALUES (
            p_channel_id,
            jsonb_build_array(jsonb_build_object(
                'type', 'text',
                'text', CASE WHEN v_voice_after THEN 'turned on end-to-end encryption for voice and video'
                             ELSE 'turned off end-to-end encryption for voice and video' END)),
            true,
            jsonb_build_object('type', CASE WHEN v_voice_after THEN 'channel_voice_encryption_enabled'
                                            ELSE 'channel_voice_encryption_disabled' END,
                               'actor_id', v_caller)
        );
    END IF;

    RETURN public.effective_channel_encryption(p_channel_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_federation_type TEXT;
    v_sender_profile profiles%ROWTYPE;
    content_part JSONB;
    mentioned_user_id UUID;
    current_domain TEXT;
    v_channel_id uuid;
    v_server_id uuid;
    v_channel_name TEXT;
    v_server_name TEXT;
    content_preview TEXT;
    v_sender_json jsonb;
    -- A system row has no author; its actor sends the notification.
    v_sender_id uuid := NEW.user_id;
BEGIN
    v_federation_type := determine_message_federation_type(NEW.id);

    IF NEW.is_system IS TRUE AND NEW.metadata ->> 'actor_id'
       ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_sender_id := (NEW.metadata ->> 'actor_id')::uuid;
    END IF;

    SELECT * INTO v_sender_profile FROM profiles WHERE id = v_sender_id;

    content_preview := extract_message_text(NEW.content);
    content_preview := TRIM(content_preview);
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New message';
    END IF;

    v_sender_json := message_notification_sender_json(
        v_sender_id, NEW.bot_id, NEW.metadata, v_sender_profile
    );

    -- Channel mention notifications (includes federated messages)
    IF NEW.channel_id IS NOT NULL AND NOT NEW.is_system THEN
        v_channel_id := NEW.channel_id;

        SELECT c.name, c.server_id INTO v_channel_name, v_server_id
        FROM channels c WHERE c.id = v_channel_id;

        IF FOUND AND v_server_id IS NOT NULL THEN
            SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;
        END IF;

        SELECT trim(both '"' from config_value::text) INTO current_domain
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;

        IF jsonb_typeof(NEW.content) = 'array' THEN
            FOR content_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                IF content_part->>'type' = 'mention' THEN
                    mentioned_user_id := resolve_mention_profile_id(
                        content_part, NEW.user_id, current_domain
                    );

                    IF mentioned_user_id IS NOT NULL THEN
                        PERFORM send_notification_to_user(
                            'mention',
                            mentioned_user_id,
                            jsonb_build_object(
                                'sender', v_sender_json,
                                'message', jsonb_build_object(
                                    'id', NEW.id,
                                    'content_preview', content_preview
                                ),
                                'location', jsonb_build_object(
                                    'server_id', COALESCE(v_server_id::text, NULL),
                                    'server_name', COALESCE(v_server_name, NULL),
                                    'channel_id', COALESCE(v_channel_id::text, NULL),
                                    'channel_name', COALESCE(v_channel_name, NULL)
                                ),
                                'message_id', NEW.id,
                                'mentioned_by', NEW.user_id,
                                'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                                'sender_display_name', COALESCE(
                                    v_sender_json->>'display_name',
                                    v_sender_profile.display_name
                                ),
                                'server_id', COALESCE(v_server_id::text, NULL),
                                'server_name', COALESCE(v_server_name, NULL),
                                'channel_id', COALESCE(v_channel_id::text, NULL),
                                'channel_name', COALESCE(v_channel_name, NULL),
                                'preview', content_preview
                            ),
                            v_server_id,
                            v_channel_id,
                            NULL,
                            NEW.user_id,
                            'normal'
                        );
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END IF;

    -- DM / group chat notifications
    CASE v_federation_type
        WHEN 'chat_local_only' THEN
            PERFORM send_notification(
                'chat_message',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND (v_sender_id IS NULL OR cp.user_id <> v_sender_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview
                ),
                NULL, NULL, NEW.conversation_id, v_sender_id, 'normal'
            );

        WHEN 'dm_local_only' THEN
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND (v_sender_id IS NULL OR cp.user_id <> v_sender_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview
                ),
                NULL, NULL, NEW.conversation_id, v_sender_id, 'normal'
            );

        WHEN 'dm_federated' THEN
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND (v_sender_id IS NULL OR cp.user_id <> v_sender_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview,
                    'federated', true
                ),
                NULL, NULL, NEW.conversation_id, v_sender_id, 'normal'
            );
    END CASE;

    RETURN NEW;

EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Message federation processing failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$;

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

        IF NEW.is_system IS TRUE AND v_server_is_local IS NOT TRUE THEN
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

CREATE OR REPLACE FUNCTION public.index_message_row(p_message public.messages)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
    v_text text;
BEGIN
    -- A system notice is not searchable.
    IF p_message.is_deleted = true OR p_message.is_system IS TRUE THEN
        DELETE FROM message_search_index WHERE message_id = p_message.id;
        RETURN;
    END IF;

    IF p_message.encrypted = true THEN
        v_text := '';
    ELSE
        v_text := btrim(coalesce(extract_message_text(p_message.content), '') || ' '
                        || message_file_names(p_message.content));
    END IF;

    INSERT INTO message_search_index (
        message_id, content_text, content_tsvector, channel_id, conversation_id, user_id,
        server_id, has_media, has_url, has_image, has_video, has_audio, has_embed, is_pinned,
        mentioned_user_ids, created_at
    )
    SELECT p_message.id, v_text, to_tsvector('english', v_text), p_message.channel_id,
           p_message.conversation_id, p_message.user_id,
           CASE WHEN p_message.channel_id IS NOT NULL
                THEN get_channel_server_id(p_message.channel_id) END,
           f.has_media, f.has_url, f.has_image, f.has_video, f.has_audio, f.has_embed,
           f.is_pinned, f.mentioned_user_ids, p_message.created_at
      FROM message_search_flags(p_message) f
    ON CONFLICT (message_id) DO UPDATE SET
        content_text = EXCLUDED.content_text,
        content_tsvector = EXCLUDED.content_tsvector,
        channel_id = EXCLUDED.channel_id,
        conversation_id = EXCLUDED.conversation_id,
        user_id = EXCLUDED.user_id,
        server_id = EXCLUDED.server_id,
        has_media = EXCLUDED.has_media,
        has_url = EXCLUDED.has_url,
        has_image = EXCLUDED.has_image,
        has_video = EXCLUDED.has_video,
        has_audio = EXCLUDED.has_audio,
        has_embed = EXCLUDED.has_embed,
        is_pinned = EXCLUDED.is_pinned,
        mentioned_user_ids = EXCLUDED.mentioned_user_ids,
        updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.refuse_message_to_deleted_recipient()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    -- A system row has no author; its actor is the sender.
    v_sender uuid := NEW.user_id;
BEGIN
    IF NEW.is_system IS TRUE AND NEW.metadata ->> 'actor_id'
       ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_sender := (NEW.metadata ->> 'actor_id')::uuid;
    END IF;

    IF EXISTS (
            SELECT 1
              FROM public.conversation_participants cp
              JOIN public.profiles p ON p.id = cp.user_id
             WHERE cp.conversation_id = NEW.conversation_id
               AND cp.user_id IS DISTINCT FROM v_sender
               AND p.is_local IS TRUE AND p.auth_user_id IS NULL)
       AND NOT EXISTS (
            SELECT 1
              FROM public.conversation_participants cp
              JOIN public.profiles p ON p.id = cp.user_id
             WHERE cp.conversation_id = NEW.conversation_id
               AND cp.user_id IS DISTINCT FROM v_sender
               AND cp.left_at IS NULL
               AND NOT (p.is_local IS TRUE AND p.auth_user_id IS NULL)) THEN
        RAISE EXCEPTION 'RECIPIENT_DELETED: the other participant deleted their account'
            USING ERRCODE = 'P0001',
                  HINT = 'Messages to a deleted account are not delivered.';
    END IF;
    RETURN NEW;
END;
$$;

-- Existing rows. ---------------------------------------------------------------------------------
-- profiles.message_count counted each notice for the member it named.
UPDATE public.profiles p
   SET message_count = GREATEST(p.message_count - c.n, 0)
  FROM (SELECT m.user_id, count(*) AS n
          FROM public.messages m
         WHERE m.is_system IS TRUE AND m.user_id IS NOT NULL
         GROUP BY m.user_id) c
 WHERE p.id = c.user_id;

-- Keys already present win over the moved author.
UPDATE public.messages m
   SET metadata = CASE
           WHEN m.metadata ->> 'type' IN ('member_join', 'member_leave') THEN
               jsonb_build_object('subject_id', m.user_id) || b.meta
           WHEN m.metadata ->> 'type' = 'member_kick' THEN
               jsonb_strip_nulls(jsonb_build_object('subject_id', m.user_id,
                                                    'actor_id', b.meta -> 'kicked_by'))
               || (b.meta - 'kicked_by')
           WHEN m.metadata ->> 'type' = 'member_ban' THEN
               jsonb_strip_nulls(jsonb_build_object('subject_id', m.user_id,
                                                    'actor_id', b.meta -> 'banned_by'))
               || (b.meta - 'banned_by')
           WHEN m.metadata ->> 'type' = 'group_created' AND m.metadata ->> 'event' = 'created' THEN
               jsonb_strip_nulls(jsonb_build_object(
                   'actor_id', m.user_id,
                   'participant_count',
                   substring(m.content -> 0 ->> 'text' FROM 'created with ([0-9]+) participants')::integer))
               || b.meta
           ELSE jsonb_build_object('actor_id', m.user_id) || b.meta
       END,
       user_id = NULL
  FROM (SELECT x.id,
               CASE WHEN jsonb_typeof(x.metadata) = 'object' THEN x.metadata ELSE '{}'::jsonb END AS meta
          FROM public.messages x
         WHERE x.is_system IS TRUE AND x.user_id IS NOT NULL) b
 WHERE m.id = b.id;

-- A bridge bot's thread notice names the bot in metadata.
UPDATE public.messages m
   SET metadata = jsonb_build_object('actor_bot_id', m.bot_id)
                  || CASE WHEN jsonb_typeof(m.metadata) = 'object' THEN m.metadata ELSE '{}'::jsonb END,
       bot_id = NULL
 WHERE m.is_system IS TRUE AND m.bot_id IS NOT NULL;

-- Notices of a remote server that its channel collection served as plain Notes before
-- 1.8.11, cached here as messages of the member they named. Matched on the exact content
-- the host wrote.
WITH legacy(text, type, role) AS (
    VALUES ('has joined the server', 'member_join', 'subject_id'),
           ('has left the server', 'member_leave', 'subject_id'),
           ('was kicked from the server', 'member_kick', 'subject_id'),
           ('was banned from the server', 'member_ban', 'subject_id'),
           ('started a thread', 'thread_created', 'actor_id'),
           ('turned on end-to-end encryption', 'channel_encryption_enabled', 'actor_id'),
           ('turned off end-to-end encryption', 'channel_encryption_disabled', 'actor_id'),
           ('turned on end-to-end encryption for voice and video', 'channel_voice_encryption_enabled', 'actor_id'),
           ('turned off end-to-end encryption for voice and video', 'channel_voice_encryption_disabled', 'actor_id')
), cached AS (
    SELECT m.id, m.user_id, l.type, l.role
      FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      JOIN public.servers s ON s.id = c.server_id
      JOIN legacy l ON l.text = m.content -> 0 ->> 'text'
     WHERE s.is_local_server IS NOT TRUE
       AND m.is_system IS NOT TRUE
       AND m.user_id IS NOT NULL
       AND m.thread_id IS NULL
       AND m.metadata ? 'federated'
       AND jsonb_array_length(m.content) = 1
       AND m.content -> 0 ->> 'type' = 'text'
), counted AS (
    UPDATE public.profiles p
       SET message_count = GREATEST(p.message_count - c.n, 0)
      FROM (SELECT user_id, count(*) AS n FROM cached GROUP BY user_id) c
     WHERE p.id = c.user_id
)
UPDATE public.messages m
   SET is_system = true,
       metadata = m.metadata || jsonb_build_object('type', c.type, c.role, c.user_id),
       user_id = NULL
  FROM cached c
 WHERE m.id = c.id;

DELETE FROM public.message_search_index s
 USING public.messages m
 WHERE m.id = s.message_id AND m.is_system IS TRUE;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_system_authorless;
ALTER TABLE public.messages ADD CONSTRAINT messages_system_authorless
    CHECK (is_system IS NOT TRUE OR (user_id IS NULL AND bot_id IS NULL));

COMMIT;
