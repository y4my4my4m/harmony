-- =============================================================================
-- Migration: Server Moderation (Kick / Ban / Unban)
-- =============================================================================
-- Adds server_bans table and RPCs for kick, ban, unban with permission checks,
-- role hierarchy enforcement, and optional message purge.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TABLE: server_bans
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_bans (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    banned_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    reason text,
    delete_message_seconds integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,

    UNIQUE(server_id, user_id)
);

ALTER TABLE public.server_bans REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_server_bans_server ON public.server_bans(server_id);
CREATE INDEX IF NOT EXISTS idx_server_bans_user ON public.server_bans(user_id);

COMMENT ON TABLE public.server_bans IS 'Server-level ban records for moderation';

-- ---------------------------------------------------------------------------
-- RLS for server_bans
-- ---------------------------------------------------------------------------
ALTER TABLE public.server_bans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "server_bans_select_moderator" ON public.server_bans;
CREATE POLICY "server_bans_select_moderator" ON public.server_bans
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "server_bans_insert_rpc" ON public.server_bans;
CREATE POLICY "server_bans_insert_rpc" ON public.server_bans
    FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "server_bans_delete_rpc" ON public.server_bans;
CREATE POLICY "server_bans_delete_rpc" ON public.server_bans
    FOR DELETE TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- HELPER: get highest role position for a user in a server
-- Returns 0 (lowest) if user has no assigned roles.
-- Server owner is treated as having position MAX_INT.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_highest_role_position(
    p_user_id uuid,
    p_server_id uuid
) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    v_is_owner boolean;
    v_max_position integer;
BEGIN
    SELECT (owner = p_user_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;

    IF v_is_owner THEN
        RETURN 2147483647; -- max int, owner is always highest
    END IF;

    SELECT COALESCE(MAX(sr.position), 0) INTO v_max_position
    FROM public.user_roles ur
    JOIN public.server_roles sr ON sr.id = ur.role_id
    WHERE ur.user_id = p_user_id
      AND ur.server_id = p_server_id;

    RETURN v_max_position;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: kick_server_member
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kick_server_member(
    p_server_id uuid,
    p_user_id uuid,
    p_reason text DEFAULT NULL,
    p_delete_message_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
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
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Cannot kick yourself
    IF v_caller_id = p_user_id THEN
        RAISE EXCEPTION 'Cannot kick yourself';
    END IF;

    -- Check if target is server owner
    SELECT (owner = p_user_id) INTO v_target_is_owner
    FROM public.servers WHERE id = p_server_id;
    IF v_target_is_owner THEN
        RAISE EXCEPTION 'Cannot kick the server owner';
    END IF;

    -- Check caller is owner or has KICK_MEMBERS permission
    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;

    IF NOT v_is_owner THEN
        SELECT COALESCE((public.get_user_permissions(v_caller_id, p_server_id)->>'KICK_MEMBERS')::boolean, false)
        INTO v_has_permission;
        IF NOT v_has_permission THEN
            RAISE EXCEPTION 'Missing KICK_MEMBERS permission';
        END IF;
    END IF;

    -- Role hierarchy: caller must have a higher role position than target
    IF NOT v_is_owner THEN
        v_caller_position := public.get_user_highest_role_position(v_caller_id, p_server_id);
        v_target_position := public.get_user_highest_role_position(p_user_id, p_server_id);
        IF v_caller_position <= v_target_position THEN
            RAISE EXCEPTION 'Cannot kick a member with an equal or higher role';
        END IF;
    END IF;

    -- Optionally delete recent messages
    IF p_delete_message_seconds > 0 THEN
        UPDATE public.messages
        SET is_deleted = true, content = '[{"type":"text","content":"[message deleted]"}]'::jsonb
        WHERE user_id = p_user_id
          AND channel_id IN (SELECT id FROM public.channels WHERE server_id = p_server_id)
          AND created_at > now() - (p_delete_message_seconds || ' seconds')::interval
          AND is_deleted = false;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    -- Remove from server
    DELETE FROM public.user_servers
    WHERE user_id = p_user_id AND server_id = p_server_id;

    -- Log membership event
    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_user_id, 'kick', jsonb_build_object(
        'kicked_by', v_caller_id,
        'reason', COALESCE(p_reason, ''),
        'messages_deleted', v_deleted_count
    ));

    -- System message in the system channel
    SELECT system_channel_id INTO v_system_channel_id
    FROM public.server_settings WHERE server_id = p_server_id;
    IF v_system_channel_id IS NULL THEN
        v_system_channel_id := public.get_default_channel(p_server_id);
    END IF;
    IF v_system_channel_id IS NOT NULL THEN
        INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
        VALUES (
            v_system_channel_id,
            p_user_id,
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'was kicked from the server')),
            true,
            jsonb_build_object('type', 'member_kick', 'kicked_by', v_caller_id, 'reason', COALESCE(p_reason, ''))
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'messages_deleted', v_deleted_count
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: ban_server_member
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ban_server_member(
    p_server_id uuid,
    p_user_id uuid,
    p_reason text DEFAULT NULL,
    p_delete_message_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
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

    -- Check if already banned
    SELECT EXISTS(
        SELECT 1 FROM public.server_bans
        WHERE server_id = p_server_id AND user_id = p_user_id
    ) INTO v_already_banned;

    IF v_already_banned THEN
        RETURN jsonb_build_object('success', true, 'already_banned', true, 'messages_deleted', 0);
    END IF;

    -- Optionally delete recent messages
    IF p_delete_message_seconds > 0 THEN
        UPDATE public.messages
        SET is_deleted = true, content = '[{"type":"text","content":"[message deleted]"}]'::jsonb
        WHERE user_id = p_user_id
          AND channel_id IN (SELECT id FROM public.channels WHERE server_id = p_server_id)
          AND created_at > now() - (p_delete_message_seconds || ' seconds')::interval
          AND is_deleted = false;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    -- Create ban record
    INSERT INTO public.server_bans (server_id, user_id, banned_by, reason, delete_message_seconds)
    VALUES (p_server_id, p_user_id, v_caller_id, p_reason, p_delete_message_seconds);

    -- Remove from server membership
    DELETE FROM public.user_servers
    WHERE user_id = p_user_id AND server_id = p_server_id;

    -- Remove role assignments
    DELETE FROM public.user_roles
    WHERE user_id = p_user_id AND server_id = p_server_id;

    -- Log membership event
    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_user_id, 'ban', jsonb_build_object(
        'banned_by', v_caller_id,
        'reason', COALESCE(p_reason, ''),
        'messages_deleted', v_deleted_count
    ));

    -- System message in the system channel
    SELECT system_channel_id INTO v_system_channel_id
    FROM public.server_settings WHERE server_id = p_server_id;
    IF v_system_channel_id IS NULL THEN
        v_system_channel_id := public.get_default_channel(p_server_id);
    END IF;
    IF v_system_channel_id IS NOT NULL THEN
        INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
        VALUES (
            v_system_channel_id,
            p_user_id,
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'was banned from the server')),
            true,
            jsonb_build_object('type', 'member_ban', 'banned_by', v_caller_id, 'reason', COALESCE(p_reason, ''))
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'messages_deleted', v_deleted_count
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: unban_server_member
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unban_server_member(
    p_server_id uuid,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_caller_id uuid;
    v_is_owner boolean;
    v_has_permission boolean;
    v_ban_exists boolean;
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
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

    SELECT EXISTS(
        SELECT 1 FROM public.server_bans
        WHERE server_id = p_server_id AND user_id = p_user_id
    ) INTO v_ban_exists;

    IF NOT v_ban_exists THEN
        RETURN jsonb_build_object('success', false, 'error', 'User is not banned');
    END IF;

    DELETE FROM public.server_bans
    WHERE server_id = p_server_id AND user_id = p_user_id;

    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_user_id, 'unban', jsonb_build_object(
        'unbanned_by', v_caller_id
    ));

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: get_server_bans
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_server_bans(
    p_server_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    v_caller_id uuid;
    v_is_owner boolean;
    v_has_permission boolean;
    v_result jsonb;
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
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

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', sb.id,
        'user_id', sb.user_id,
        'username', p.username,
        'display_name', p.display_name,
        'avatar_url', p.avatar_url,
        'banned_by', sb.banned_by,
        'banned_by_username', bp.username,
        'reason', sb.reason,
        'created_at', sb.created_at
    ) ORDER BY sb.created_at DESC), '[]'::jsonb) INTO v_result
    FROM public.server_bans sb
    JOIN public.profiles p ON p.id = sb.user_id
    LEFT JOIN public.profiles bp ON bp.id = sb.banned_by
    WHERE sb.server_id = p_server_id;

    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trigger: increment_unread_messages on new message
-- For every server member (except sender), increment unread_messages in
-- the unread_counts table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_message_unread()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_server_id uuid;
BEGIN
    IF NEW.channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT server_id INTO v_server_id
    FROM public.channels WHERE id = NEW.channel_id;

    IF v_server_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.unread_counts (user_id, server_id, channel_id, unread_messages)
    SELECT us.user_id, v_server_id, NEW.channel_id, 1
    FROM public.user_servers us
    WHERE us.server_id = v_server_id
      AND us.status = 'accepted'
      AND us.user_id != NEW.user_id
    ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
    DO UPDATE SET
        unread_messages = unread_counts.unread_messages + 1,
        updated_at = now();

    RETURN NEW;
END;
$$;

-- Need a partial unique index for the ON CONFLICT to work
CREATE UNIQUE INDEX IF NOT EXISTS idx_unread_counts_user_channel
    ON public.unread_counts(user_id, channel_id) WHERE channel_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_unread_counts_user_conversation
    ON public.unread_counts(user_id, conversation_id) WHERE conversation_id IS NOT NULL;

DROP TRIGGER IF EXISTS trigger_new_message_unread ON public.messages;
CREATE TRIGGER trigger_new_message_unread
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION public.handle_new_message_unread();

-- ---------------------------------------------------------------------------
-- Enable realtime for server_bans
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'server_bans'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.server_bans;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Trigger: handle role mention notifications on new channel messages
-- Detects role_mention parts and creates notifications for all role members
-- For is_default roles (@everyone), notifies all server members.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_role_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_server_id uuid;
    v_channel_id uuid;
    v_channel_name text;
    v_server_name text;
    v_sender_profile record;
    v_role_id uuid;
    v_role_is_default boolean;
    v_member_id uuid;
    content_part jsonb;
    content_preview text;
BEGIN
    IF NEW.channel_id IS NULL OR NEW.is_system THEN
        RETURN NEW;
    END IF;

    SELECT c.server_id, c.name INTO v_server_id, v_channel_name
    FROM channels c WHERE c.id = NEW.channel_id;
    IF v_server_id IS NULL THEN RETURN NEW; END IF;

    SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;

    -- Check if content has any role_mention parts
    IF jsonb_typeof(NEW.content) != 'array' THEN RETURN NEW; END IF;

    -- Quick check: skip if no role_mention in content
    IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) elem
        WHERE elem->>'type' = 'role_mention'
    ) THEN
        RETURN NEW;
    END IF;

    SELECT p.id, p.username, p.display_name, p.avatar_url
    INTO v_sender_profile
    FROM profiles p WHERE p.id = NEW.user_id;

    content_preview := LEFT(
        (SELECT string_agg(elem->>'text', ' ')
         FROM jsonb_array_elements(NEW.content) elem
         WHERE elem->>'type' = 'text'), 100);

    v_channel_id := NEW.channel_id;

    FOR content_part IN SELECT jsonb_array_elements(NEW.content)
    LOOP
        IF content_part->>'type' = 'role_mention' THEN
            v_role_id := (content_part->>'roleId')::uuid;
            IF v_role_id IS NULL THEN CONTINUE; END IF;

            SELECT is_default INTO v_role_is_default
            FROM server_roles WHERE id = v_role_id AND server_id = v_server_id;

            IF NOT FOUND THEN CONTINUE; END IF;

            IF v_role_is_default THEN
                -- @everyone: notify all server members except sender
                FOR v_member_id IN
                    SELECT us.user_id FROM user_servers us
                    WHERE us.server_id = v_server_id
                      AND us.status = 'accepted'
                      AND us.user_id != NEW.user_id
                LOOP
                    PERFORM send_notification_to_user(
                        'mention', v_member_id,
                        jsonb_build_object(
                            'sender', jsonb_build_object(
                                'user_id', v_sender_profile.id,
                                'username', v_sender_profile.username,
                                'display_name', v_sender_profile.display_name,
                                'avatar_url', v_sender_profile.avatar_url
                            ),
                            'message', jsonb_build_object('id', NEW.id, 'content_preview', content_preview),
                            'location', jsonb_build_object(
                                'server_id', v_server_id::text,
                                'server_name', v_server_name,
                                'channel_id', v_channel_id::text,
                                'channel_name', v_channel_name
                            ),
                            'message_id', NEW.id,
                            'mentioned_by', NEW.user_id,
                            'sender_username', v_sender_profile.username,
                            'sender_display_name', v_sender_profile.display_name,
                            'server_id', v_server_id::text,
                            'server_name', v_server_name,
                            'channel_id', v_channel_id::text,
                            'channel_name', v_channel_name,
                            'preview', content_preview
                        ),
                        v_server_id, v_channel_id, NULL, NEW.user_id, 'normal'
                    );
                END LOOP;
            ELSE
                -- Specific role: notify members who have this role
                FOR v_member_id IN
                    SELECT ur.user_id FROM user_roles ur
                    WHERE ur.role_id = v_role_id
                      AND ur.server_id = v_server_id
                      AND ur.user_id != NEW.user_id
                LOOP
                    PERFORM send_notification_to_user(
                        'mention', v_member_id,
                        jsonb_build_object(
                            'sender', jsonb_build_object(
                                'user_id', v_sender_profile.id,
                                'username', v_sender_profile.username,
                                'display_name', v_sender_profile.display_name,
                                'avatar_url', v_sender_profile.avatar_url
                            ),
                            'message', jsonb_build_object('id', NEW.id, 'content_preview', content_preview),
                            'location', jsonb_build_object(
                                'server_id', v_server_id::text,
                                'server_name', v_server_name,
                                'channel_id', v_channel_id::text,
                                'channel_name', v_channel_name
                            ),
                            'message_id', NEW.id,
                            'mentioned_by', NEW.user_id,
                            'sender_username', v_sender_profile.username,
                            'sender_display_name', v_sender_profile.display_name,
                            'server_id', v_server_id::text,
                            'server_name', v_server_name,
                            'channel_id', v_channel_id::text,
                            'channel_name', v_channel_name,
                            'preview', content_preview
                        ),
                        v_server_id, v_channel_id, NULL, NEW.user_id, 'normal'
                    );
                END LOOP;
            END IF;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_role_mention_notifications ON public.messages;
CREATE TRIGGER trigger_role_mention_notifications
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION public.handle_role_mention_notifications();

-- ---------------------------------------------------------------------------
-- Fix: rename '@everyone' role to 'everyone' (@ is display, not name)
-- Must temporarily disable the protection trigger that blocks renames.
-- ---------------------------------------------------------------------------
ALTER TABLE public.server_roles DISABLE TRIGGER ALL;

UPDATE public.server_roles
SET name = 'everyone'
WHERE is_default = true AND name = '@everyone';

ALTER TABLE public.server_roles ENABLE TRIGGER ALL;

-- Update the protection trigger to use the new name
CREATE OR REPLACE FUNCTION public.prevent_protected_role_modification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.is_admin = true AND NEW.is_admin = false THEN
        RAISE EXCEPTION 'Cannot remove admin status from the Admin role.';
    END IF;

    IF OLD.is_default = true AND NEW.is_default = false THEN
        RAISE EXCEPTION 'Cannot remove default status from the everyone role.';
    END IF;

    IF (OLD.is_admin = true OR OLD.is_default = true) AND OLD.name != NEW.name THEN
        RAISE EXCEPTION 'Cannot rename protected roles.';
    END IF;

    RETURN NEW;
END;
$$;

-- Update the trigger function for new servers
CREATE OR REPLACE FUNCTION public.create_default_server_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    everyone_role_id uuid;
    admin_role_id uuid;
BEGIN
    INSERT INTO server_roles (server_id, name, color, position, is_default, is_admin, permissions)
    VALUES (NEW.id, 'everyone', '#99AAB5', 0, true, false, 104324161)
    RETURNING id INTO everyone_role_id;

    INSERT INTO server_roles (server_id, name, color, position, is_default, is_admin, permissions)
    VALUES (NEW.id, 'Admin', '#e74c3c', 1, false, true, 2147483647)
    RETURNING id INTO admin_role_id;

    INSERT INTO user_roles (user_id, role_id, server_id, assigned_by)
    VALUES (NEW.owner, admin_role_id, NEW.id, NEW.owner);

    RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
