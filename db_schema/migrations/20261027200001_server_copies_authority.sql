-- A copy holds no server authority on this instance.
--
-- A copy (servers.is_local_server false) is this instance's reference to a server hosted on
-- another instance. Its owner, roles, bans, pins, invites, channels and settings are the host's.
--
--   servers.owner of a copy     the host owner's profile: the Group's attributedTo, on the
--                               Group's own host, stored here as a remote profile; NULL when
--                               none is.
--   get_user_permissions        on a copy: no owner path, ADMINISTRATOR expands nothing, and the
--                               result holds member bits only (v_copy_bits).
--   kick_server_member, ban_server_member, unban_server_member, get_server_bans,
--   delete_server_with_cleanup  refuse a copy (42501).
--   pin_message, unpin_message  refuse a message of a copy's channel.
--   set_message_embeds_suppressed
--                               in a copy's channel, the author only.
--   create_default_server_role  assigns the Admin role to the owner of a local server only.
--   caller_outranks_all         the owner of a local server; an instance admin does not outrank.
--
-- Client writes (RLS) to servers, channels, channel_categories, server_roles, user_roles, emojis
-- of scope 'server', server_settings, bot_server_permissions, channel_permission_overrides and
-- threads admit the owner or a permission holder of a local server; copies are written by the
-- service role. None admits instance admins or moderators. invites INSERT needs a local server.
-- messages UPDATE/DELETE by instance staff is unchanged. Other write policies of these commands
-- are dropped, as 20261010400001 and 20261010500001 did.
--
-- Existing copies, converged by state:
--   owner                       reset as above;
--   the Admin role's assignments on copies are removed;
--   member_kick and member_ban system rows this instance posted in a copy (no ap_id, not
--   federated) are deleted.
-- server_bans rows of copies are left to 20261027300001.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

-- As 20261017100003, plus the copy rules above. v_copy_bits: VIEW_CHANNEL, SEND_MESSAGES,
-- SEND_MESSAGES_IN_THREADS, CREATE_PUBLIC_THREADS, CREATE_PRIVATE_THREADS, EMBED_LINKS,
-- ATTACH_FILES, ADD_REACTIONS, USE_EXTERNAL_EMOJIS, MENTION_EVERYONE, READ_MESSAGE_HISTORY,
-- CONNECT, SPEAK, STREAM, USE_SOUNDBOARD, USE_EXTERNAL_SOUNDS (bits 1, 12-20, 22, 24-26, 30, 31).
CREATE OR REPLACE FUNCTION public.get_user_permissions(
    p_user_id uuid,
    p_server_id uuid,
    p_channel_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_names text[] := public.permission_bit_names();
    v_copy_bits CONSTANT bigint := 3344953346;
    v_is_owner boolean;
    v_is_copy boolean;
    v_mask bigint := 0;
    v_role record;
    v_override record;
    v_everyone_role_id uuid;
    v_everyone_allow bigint := 0;
    v_everyone_deny  bigint := 0;
    v_role_allow     bigint := 0;
    v_role_deny      bigint := 0;
    v_user_allow     bigint := 0;
    v_user_deny      bigint := 0;
    v_result jsonb := '{}'::jsonb;
    v_i int;
BEGIN
    SELECT s.owner = p_user_id AND s.is_local_server, NOT s.is_local_server
      INTO v_is_owner, v_is_copy
      FROM public.servers s WHERE s.id = p_server_id;

    IF v_is_owner THEN
        v_mask := -1;
    ELSIF EXISTS (SELECT 1 FROM public.user_servers us
                   WHERE us.user_id = p_user_id
                     AND us.server_id = p_server_id
                     AND us.status = 'accepted') THEN
        SELECT id, COALESCE(permissions, 0) INTO v_everyone_role_id, v_mask
          FROM public.server_roles
         WHERE server_id = p_server_id AND is_default = true
         LIMIT 1;
        v_mask := COALESCE(v_mask, 0);

        FOR v_role IN
            SELECT sr.permissions
              FROM public.user_roles ur
              JOIN public.server_roles sr ON ur.role_id = sr.id
             WHERE ur.user_id = p_user_id AND ur.server_id = p_server_id
        LOOP
            v_mask := v_mask | COALESCE(v_role.permissions, 0);
        END LOOP;

        IF v_is_copy THEN
            v_mask := v_mask & v_copy_bits;
        END IF;

        IF (v_mask & 1) != 0 THEN
            v_mask := -1;
        ELSIF p_channel_id IS NOT NULL THEN
            FOR v_override IN
                SELECT role_id, user_id,
                       COALESCE(allow_permissions, 0) AS allow_p,
                       COALESCE(deny_permissions, 0)  AS deny_p
                  FROM public.channel_permission_overrides
                 WHERE channel_id = p_channel_id
                   AND (
                        role_id = v_everyone_role_id
                     OR role_id IN (
                            SELECT ur.role_id
                              FROM public.user_roles ur
                             WHERE ur.user_id = p_user_id
                               AND ur.server_id = p_server_id
                        )
                     OR user_id = p_user_id
                   )
            LOOP
                IF v_override.user_id = p_user_id THEN
                    v_user_allow := v_user_allow | v_override.allow_p;
                    v_user_deny  := v_user_deny  | v_override.deny_p;
                ELSIF v_override.role_id = v_everyone_role_id THEN
                    v_everyone_allow := v_everyone_allow | v_override.allow_p;
                    v_everyone_deny  := v_everyone_deny  | v_override.deny_p;
                ELSIF v_override.role_id IS NOT NULL THEN
                    v_role_allow := v_role_allow | v_override.allow_p;
                    v_role_deny  := v_role_deny  | v_override.deny_p;
                END IF;
            END LOOP;

            v_mask := (v_mask & ~v_everyone_deny) | v_everyone_allow;
            v_mask := (v_mask & ~v_role_deny) | v_role_allow;
            v_mask := (v_mask & ~v_user_deny) | v_user_allow;

            IF (v_mask & 2) = 0 THEN
                v_mask := 0;
            END IF;
        END IF;

        IF v_is_copy THEN
            v_mask := v_mask & v_copy_bits;
        END IF;
    END IF;

    FOR v_i IN 1..array_length(v_names, 1) LOOP
        v_result := v_result || jsonb_build_object(
            v_names[v_i],
            (v_mask & (1::bigint << (v_i - 1))) != 0
        );
    END LOOP;

    RETURN v_result;
END;
$$;

-- As 20261010500001; the owner of a local server only.
CREATE OR REPLACE FUNCTION public.caller_outranks_all(p_server_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id
                      AND s.is_local_server
                      AND s.owner = public.get_current_profile_id())
$$;

-- As 20261012300001; the Admin role is assigned to the owner of a local server only.
CREATE OR REPLACE FUNCTION public.create_default_server_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    everyone_role_id uuid;
    admin_role_id uuid;
BEGIN
    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'everyone',
        '#99AAB5',
        0,
        true,
        false,
        3343872258
    ) RETURNING id INTO everyone_role_id;

    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'Admin',
        '#e74c3c',
        999,
        false,
        true,
        2199023255551
    ) RETURNING id INTO admin_role_id;

    IF NEW.is_local_server AND NEW.owner IS NOT NULL THEN
        INSERT INTO user_roles (user_id, role_id, server_id)
        VALUES (NEW.owner, admin_role_id, NEW.id)
        ON CONFLICT (user_id, role_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Server moderation: the host's
-- ---------------------------------------------------------------------------

-- As 20261026700001, refusing a copy.
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

    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND NOT s.is_local_server) THEN
        RAISE EXCEPTION 'Members of this server are moderated on its home instance' USING ERRCODE = '42501';
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
    -- A server without an owner has no owner path: NOT NULL would skip the permission check.
    v_is_owner := COALESCE(v_is_owner, false);

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

-- As 20261026700001, refusing a copy.
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

    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND NOT s.is_local_server) THEN
        RAISE EXCEPTION 'Members of this server are moderated on its home instance' USING ERRCODE = '42501';
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
    -- A server without an owner has no owner path: NOT NULL would skip the permission check.
    v_is_owner := COALESCE(v_is_owner, false);

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

-- As 20261026700001, refusing a copy.
CREATE OR REPLACE FUNCTION public.unban_server_member(p_server_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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

    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND NOT s.is_local_server) THEN
        RAISE EXCEPTION 'Members of this server are moderated on its home instance' USING ERRCODE = '42501';
    END IF;

    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;
    -- A server without an owner has no owner path: NOT NULL would skip the permission check.
    v_is_owner := COALESCE(v_is_owner, false);

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
$function$;

-- As 20261026700001, refusing a copy.
CREATE OR REPLACE FUNCTION public.get_server_bans(p_server_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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

    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND NOT s.is_local_server) THEN
        RAISE EXCEPTION 'Bans of this server are kept on its home instance' USING ERRCODE = '42501';
    END IF;

    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;
    -- A server without an owner has no owner path: NOT NULL would skip the permission check.
    v_is_owner := COALESCE(v_is_owner, false);

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
$function$;

-- As 20261009100001, refusing a copy: a member leaves it instead.
CREATE OR REPLACE FUNCTION public.delete_server_with_cleanup(p_server_id uuid, p_owner_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_profile_id uuid;
BEGIN
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();

    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    IF v_caller_profile_id != p_owner_id THEN
        RAISE EXCEPTION 'Unauthorized: Cannot delete server as another user';
    END IF;

    IF EXISTS (SELECT 1 FROM servers WHERE id = p_server_id AND NOT is_local_server) THEN
        RAISE EXCEPTION 'This server is deleted on its home instance; leave it instead' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM servers WHERE id = p_server_id AND owner = v_caller_profile_id) THEN
        RAISE EXCEPTION 'Not authorized to delete this server';
    END IF;

    DELETE FROM servers WHERE id = p_server_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Messages of a copy's channels
-- ---------------------------------------------------------------------------

-- As 20261001200003, refusing a message of a copy's channel.
CREATE OR REPLACE FUNCTION public.pin_message(p_message_id uuid, p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
    v_channel_id uuid;
    v_conversation_id uuid;
    v_server_id uuid;
    v_pin_count integer;
    v_max_pins integer := 50;
BEGIN
    -- A client acts as its own profile; p_user_id is honoured only for trusted roles.
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        p_user_id := public.get_current_profile_id();
        IF p_user_id IS NULL THEN
            RAISE EXCEPTION 'Unauthorized: Authentication required';
        END IF;
    END IF;

    SELECT channel_id, conversation_id INTO v_channel_id, v_conversation_id
    FROM "public"."messages"
    WHERE id = p_message_id AND NOT is_deleted;

    IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
        RAISE EXCEPTION 'Message not found or already deleted';
    END IF;

    IF v_channel_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "public"."channels" c JOIN "public"."servers" s ON s.id = c.server_id
         WHERE c.id = v_channel_id AND s.is_local_server) THEN
        RAISE EXCEPTION 'Pins of this server are set on its home instance' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (SELECT 1 FROM "public"."messages" WHERE id = p_message_id AND is_pinned = true) THEN
        RETURN true;
    END IF;

    IF v_channel_id IS NOT NULL THEN
        SELECT server_id INTO v_server_id
        FROM "public"."channels"
        WHERE id = v_channel_id;

        SELECT COUNT(*) INTO v_pin_count
        FROM "public"."messages"
        WHERE channel_id = v_channel_id AND is_pinned = true;

        IF v_pin_count >= v_max_pins THEN
            RAISE EXCEPTION 'Maximum pin limit (%) reached for this channel', v_max_pins;
        END IF;

        IF NOT (
            "public"."has_permission"(p_user_id, v_server_id, 'PIN_MESSAGES', v_channel_id)
            OR
            "public"."has_permission"(p_user_id, v_server_id, 'MANAGE_MESSAGES', v_channel_id)
        ) THEN
            RAISE EXCEPTION 'Permission denied: cannot pin messages';
        END IF;
    END IF;

    IF v_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "public"."conversation_participants"
            WHERE conversation_id = v_conversation_id AND user_id = p_user_id AND left_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Permission denied: not a participant in this conversation';
        END IF;

        SELECT COUNT(*) INTO v_pin_count
        FROM "public"."messages"
        WHERE conversation_id = v_conversation_id AND is_pinned = true;

        IF v_pin_count >= v_max_pins THEN
            RAISE EXCEPTION 'Maximum pin limit (%) reached for this conversation', v_max_pins;
        END IF;
    END IF;

    UPDATE "public"."messages"
    SET
        is_pinned = true,
        pinned_at = NOW(),
        pinned_by = p_user_id
    WHERE id = p_message_id;

    RETURN true;
END;
$$;

-- As 20261001200003, refusing a message of a copy's channel.
CREATE OR REPLACE FUNCTION public.unpin_message(p_message_id uuid, p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
    v_channel_id uuid;
    v_conversation_id uuid;
    v_server_id uuid;
BEGIN
    -- A client acts as its own profile; p_user_id is honoured only for trusted roles.
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        p_user_id := public.get_current_profile_id();
        IF p_user_id IS NULL THEN
            RAISE EXCEPTION 'Unauthorized: Authentication required';
        END IF;
    END IF;

    SELECT channel_id, conversation_id INTO v_channel_id, v_conversation_id
    FROM "public"."messages"
    WHERE id = p_message_id;

    IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
        RAISE EXCEPTION 'Message not found';
    END IF;

    IF v_channel_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "public"."channels" c JOIN "public"."servers" s ON s.id = c.server_id
         WHERE c.id = v_channel_id AND s.is_local_server) THEN
        RAISE EXCEPTION 'Pins of this server are set on its home instance' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM "public"."messages" WHERE id = p_message_id AND is_pinned = true) THEN
        RETURN true;
    END IF;

    IF v_channel_id IS NOT NULL THEN
        SELECT server_id INTO v_server_id
        FROM "public"."channels"
        WHERE id = v_channel_id;

        IF NOT (
            "public"."has_permission"(p_user_id, v_server_id, 'PIN_MESSAGES', v_channel_id)
            OR
            "public"."has_permission"(p_user_id, v_server_id, 'MANAGE_MESSAGES', v_channel_id)
        ) THEN
            RAISE EXCEPTION 'Permission denied: cannot unpin messages';
        END IF;
    END IF;

    IF v_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "public"."conversation_participants"
            WHERE conversation_id = v_conversation_id AND user_id = p_user_id AND left_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Permission denied: not a participant in this conversation';
        END IF;
    END IF;

    UPDATE "public"."messages"
    SET
        is_pinned = false,
        pinned_at = NULL,
        pinned_by = NULL
    WHERE id = p_message_id;

    RETURN true;
END;
$$;

-- As 20261017100001; in a copy's channel only the author changes a message's embeds.
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
    v_local boolean;
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

    IF v_msg.channel_id IS NOT NULL THEN
        SELECT c.server_id, s.is_local_server IS NOT FALSE INTO v_server, v_local
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
         WHERE c.id = v_msg.channel_id;
    END IF;

    IF v_msg.user_id IS DISTINCT FROM v_caller THEN
        IF v_msg.channel_id IS NULL THEN
            RAISE EXCEPTION 'Only the author changes embeds in a direct message' USING ERRCODE = '42501';
        END IF;
        IF v_local IS NOT TRUE THEN
            RAISE EXCEPTION 'Only the author changes embeds in a server hosted on another instance'
                USING ERRCODE = '42501';
        END IF;
        IF NOT public.has_permission(v_caller, v_server, 'MANAGE_MESSAGES', v_msg.channel_id) THEN
            RAISE EXCEPTION 'Permission denied: MANAGE_MESSAGES required' USING ERRCODE = '42501';
        END IF;
    END IF;

    IF NOT p_suppressed AND v_local AND v_msg.user_id IS NOT NULL
       AND NOT public.channel_grants_everyone(v_msg.channel_id, 65536)
       AND NOT public.has_permission(v_msg.user_id, v_server, 'EMBED_LINKS', v_msg.channel_id) THEN
        RAISE EXCEPTION 'Missing permission: EMBED_LINKS' USING ERRCODE = '42501';
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

-- ---------------------------------------------------------------------------
-- Write policies
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.tablename, p.policyname
          FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
           AND p.roles <> '{service_role}'::name[]
           AND (p.tablename IN ('servers', 'channels', 'channel_categories', 'server_roles', 'user_roles',
                                'server_settings', 'bot_server_permissions', 'channel_permission_overrides')
                OR (p.tablename = 'emojis' AND p.policyname LIKE '%server%')
                OR (p.tablename = 'threads' AND p.cmd IN ('UPDATE', 'DELETE', 'ALL'))
                OR (p.tablename = 'invites' AND p.cmd IN ('INSERT', 'ALL')))
           AND p.policyname NOT IN (
               'Enable insert for authenticated users only', 'Server owners can update their servers',
               'Server owners can delete their servers',
               'channels_insert_manager', 'channels_update_manager', 'channels_delete_manager',
               'channel_categories_insert_manager', 'channel_categories_update_manager',
               'channel_categories_delete_manager',
               'server_roles_insert_manager', 'server_roles_update_manager', 'server_roles_delete_manager',
               'user_roles_insert_manager', 'user_roles_delete_manager',
               'emojis_insert_server_manager', 'emojis_update_server_manager', 'emojis_delete_server_manager',
               'server_settings_insert_manager', 'server_settings_update_manager', 'server_settings_delete_manager',
               'bot_server_permissions_insert_manager', 'bot_server_permissions_update_manager',
               'bot_server_permissions_delete_manager',
               'channel_permission_overrides_insert_manager', 'channel_permission_overrides_update_manager',
               'channel_permission_overrides_delete_manager',
               'threads_update_authorized', 'threads_delete_authorized',
               'invites_insert_member')
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
        RAISE NOTICE 'dropped policy % on %', r.policyname, r.tablename;
    END LOOP;
END;
$$;

-- The caller owns the local server p_server, or holds p_permission there (on p_channel when given).
CREATE OR REPLACE FUNCTION pg_temp.local_manager_check(p_server text, p_permission text, p_channel text DEFAULT 'NULL')
RETURNS text LANGUAGE sql IMMUTABLE AS $f$
    SELECT format($c$EXISTS (SELECT 1 FROM public.servers s
                       WHERE s.id = %1$s
                         AND s.is_local_server
                         AND (s.owner = (SELECT public.get_current_profile_id())
                              OR public.has_permission((SELECT public.get_current_profile_id()), s.id, %2$L, %3$s)))$c$,
                  p_server, p_permission, p_channel)
$f$;

DO $$
DECLARE
    v_channels_server text := pg_temp.local_manager_check('channels.server_id', 'MANAGE_CHANNELS');
    v_channels_row text := pg_temp.local_manager_check('channels.server_id', 'MANAGE_CHANNELS', 'channels.id');
    v_categories text := pg_temp.local_manager_check('channel_categories.server_id', 'MANAGE_CHANNELS');
    v_roles text := pg_temp.local_manager_check('server_roles.server_id', 'MANAGE_ROLES');
    v_user_roles text := pg_temp.local_manager_check('user_roles.server_id', 'MANAGE_ROLES');
    v_emojis text := pg_temp.local_manager_check('emojis.server_id', 'MANAGE_EMOJIS');
    v_settings text := pg_temp.local_manager_check('server_settings.server_id', 'MANAGE_SERVER');
    v_bots text := pg_temp.local_manager_check('bot_server_permissions.server_id', 'MANAGE_SERVER');
    v_override_server text := '(SELECT c.server_id FROM public.channels c WHERE c.id = channel_permission_overrides.channel_id)';
    v_thread_server text := '(SELECT c.server_id FROM public.channels c WHERE c.id = threads.channel_id)';
    v_overrides text;
    v_threads text;
BEGIN
    v_overrides := format('(%s OR %s)',
        pg_temp.local_manager_check(v_override_server, 'MANAGE_ROLES', 'channel_permission_overrides.channel_id'),
        pg_temp.local_manager_check(v_override_server, 'MANAGE_CHANNELS', 'channel_permission_overrides.channel_id'));
    v_threads := format(
        '(channel_id IN (SELECT public.current_user_viewable_channel_ids()) AND (created_by = (SELECT public.get_current_profile_id()) OR %s))',
        pg_temp.local_manager_check(v_thread_server, 'MANAGE_CHANNELS', 'threads.channel_id'));

    DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.servers;
    CREATE POLICY "Enable insert for authenticated users only" ON public.servers FOR INSERT TO authenticated
        WITH CHECK (is_local_server
                    AND EXISTS (SELECT 1 FROM public.profiles p
                                 WHERE p.id = servers.owner AND p.auth_user_id = (SELECT auth.uid())));
    DROP POLICY IF EXISTS "Server owners can update their servers" ON public.servers;
    CREATE POLICY "Server owners can update their servers" ON public.servers FOR UPDATE TO authenticated
        USING (is_local_server
               AND EXISTS (SELECT 1 FROM public.profiles p
                            WHERE p.id = servers.owner AND p.auth_user_id = (SELECT auth.uid())))
        WITH CHECK (is_local_server
                    AND EXISTS (SELECT 1 FROM public.profiles p
                                 WHERE p.id = servers.owner AND p.auth_user_id = (SELECT auth.uid())));
    DROP POLICY IF EXISTS "Server owners can delete their servers" ON public.servers;
    CREATE POLICY "Server owners can delete their servers" ON public.servers FOR DELETE TO authenticated
        USING (is_local_server
               AND EXISTS (SELECT 1 FROM public.profiles p
                            WHERE p.id = servers.owner AND p.auth_user_id = (SELECT auth.uid())));

    DROP POLICY IF EXISTS channels_insert_manager ON public.channels;
    EXECUTE format('CREATE POLICY channels_insert_manager ON public.channels FOR INSERT TO authenticated WITH CHECK (%s)', v_channels_server);
    DROP POLICY IF EXISTS channels_update_manager ON public.channels;
    EXECUTE format('CREATE POLICY channels_update_manager ON public.channels FOR UPDATE TO authenticated USING (%1$s) WITH CHECK (%1$s)', v_channels_row);
    DROP POLICY IF EXISTS channels_delete_manager ON public.channels;
    EXECUTE format('CREATE POLICY channels_delete_manager ON public.channels FOR DELETE TO authenticated USING (%s)', v_channels_row);

    DROP POLICY IF EXISTS channel_categories_insert_manager ON public.channel_categories;
    EXECUTE format('CREATE POLICY channel_categories_insert_manager ON public.channel_categories FOR INSERT TO authenticated WITH CHECK (%s)', v_categories);
    DROP POLICY IF EXISTS channel_categories_update_manager ON public.channel_categories;
    EXECUTE format('CREATE POLICY channel_categories_update_manager ON public.channel_categories FOR UPDATE TO authenticated USING (%1$s) WITH CHECK (%1$s)', v_categories);
    DROP POLICY IF EXISTS channel_categories_delete_manager ON public.channel_categories;
    EXECUTE format('CREATE POLICY channel_categories_delete_manager ON public.channel_categories FOR DELETE TO authenticated USING (%s)', v_categories);

    DROP POLICY IF EXISTS server_roles_insert_manager ON public.server_roles;
    EXECUTE format('CREATE POLICY server_roles_insert_manager ON public.server_roles FOR INSERT TO authenticated WITH CHECK (%s)', v_roles);
    DROP POLICY IF EXISTS server_roles_update_manager ON public.server_roles;
    EXECUTE format('CREATE POLICY server_roles_update_manager ON public.server_roles FOR UPDATE TO authenticated USING (%1$s) WITH CHECK (%1$s)', v_roles);
    DROP POLICY IF EXISTS server_roles_delete_manager ON public.server_roles;
    EXECUTE format('CREATE POLICY server_roles_delete_manager ON public.server_roles FOR DELETE TO authenticated USING (NOT is_default AND %s)', v_roles);

    DROP POLICY IF EXISTS user_roles_insert_manager ON public.user_roles;
    EXECUTE format('CREATE POLICY user_roles_insert_manager ON public.user_roles FOR INSERT TO authenticated WITH CHECK (%s)', v_user_roles);
    DROP POLICY IF EXISTS user_roles_delete_manager ON public.user_roles;
    EXECUTE format('CREATE POLICY user_roles_delete_manager ON public.user_roles FOR DELETE TO authenticated USING (%s)', v_user_roles);

    DROP POLICY IF EXISTS emojis_insert_server_manager ON public.emojis;
    EXECUTE format('CREATE POLICY emojis_insert_server_manager ON public.emojis FOR INSERT TO authenticated WITH CHECK (scope = ''server'' AND server_id IS NOT NULL AND %s)', v_emojis);
    DROP POLICY IF EXISTS emojis_update_server_manager ON public.emojis;
    EXECUTE format('CREATE POLICY emojis_update_server_manager ON public.emojis FOR UPDATE TO authenticated USING (scope = ''server'' AND server_id IS NOT NULL AND %1$s) WITH CHECK (scope = ''server'' AND server_id IS NOT NULL AND %1$s)', v_emojis);
    DROP POLICY IF EXISTS emojis_delete_server_manager ON public.emojis;
    EXECUTE format('CREATE POLICY emojis_delete_server_manager ON public.emojis FOR DELETE TO authenticated USING (scope = ''server'' AND server_id IS NOT NULL AND %s)', v_emojis);

    DROP POLICY IF EXISTS server_settings_insert_manager ON public.server_settings;
    EXECUTE format('CREATE POLICY server_settings_insert_manager ON public.server_settings FOR INSERT TO authenticated WITH CHECK (%s)', v_settings);
    DROP POLICY IF EXISTS server_settings_update_manager ON public.server_settings;
    EXECUTE format('CREATE POLICY server_settings_update_manager ON public.server_settings FOR UPDATE TO authenticated USING (%1$s) WITH CHECK (%1$s)', v_settings);
    DROP POLICY IF EXISTS server_settings_delete_manager ON public.server_settings;
    EXECUTE format('CREATE POLICY server_settings_delete_manager ON public.server_settings FOR DELETE TO authenticated USING (%s)', v_settings);

    DROP POLICY IF EXISTS bot_server_permissions_insert_manager ON public.bot_server_permissions;
    EXECUTE format('CREATE POLICY bot_server_permissions_insert_manager ON public.bot_server_permissions FOR INSERT TO authenticated WITH CHECK (%s)', v_bots);
    DROP POLICY IF EXISTS bot_server_permissions_update_manager ON public.bot_server_permissions;
    EXECUTE format('CREATE POLICY bot_server_permissions_update_manager ON public.bot_server_permissions FOR UPDATE TO authenticated USING (%1$s) WITH CHECK (%1$s)', v_bots);
    DROP POLICY IF EXISTS bot_server_permissions_delete_manager ON public.bot_server_permissions;
    EXECUTE format('CREATE POLICY bot_server_permissions_delete_manager ON public.bot_server_permissions FOR DELETE TO authenticated USING (%s)', v_bots);

    DROP POLICY IF EXISTS channel_permission_overrides_insert_manager ON public.channel_permission_overrides;
    EXECUTE format('CREATE POLICY channel_permission_overrides_insert_manager ON public.channel_permission_overrides FOR INSERT TO authenticated WITH CHECK %s', v_overrides);
    DROP POLICY IF EXISTS channel_permission_overrides_update_manager ON public.channel_permission_overrides;
    EXECUTE format('CREATE POLICY channel_permission_overrides_update_manager ON public.channel_permission_overrides FOR UPDATE TO authenticated USING %1$s WITH CHECK %1$s', v_overrides);
    DROP POLICY IF EXISTS channel_permission_overrides_delete_manager ON public.channel_permission_overrides;
    EXECUTE format('CREATE POLICY channel_permission_overrides_delete_manager ON public.channel_permission_overrides FOR DELETE TO authenticated USING %s', v_overrides);

    DROP POLICY IF EXISTS threads_update_authorized ON public.threads;
    EXECUTE format('CREATE POLICY threads_update_authorized ON public.threads FOR UPDATE TO authenticated USING %1$s WITH CHECK %1$s', v_threads);
    DROP POLICY IF EXISTS threads_delete_authorized ON public.threads;
    EXECUTE format('CREATE POLICY threads_delete_authorized ON public.threads FOR DELETE TO authenticated USING %s', v_threads);
END;
$$;

DROP POLICY IF EXISTS invites_insert_member ON public.invites;
CREATE POLICY invites_insert_member ON public.invites FOR INSERT TO authenticated
    WITH CHECK (created_by = (SELECT public.get_current_profile_id())
                AND EXISTS (SELECT 1 FROM public.servers s
                             WHERE s.id = invites.server_id AND s.is_local_server)
                AND EXISTS (SELECT 1 FROM public.user_servers us
                             WHERE us.server_id = invites.server_id
                               AND us.user_id = (SELECT public.get_current_profile_id())
                               AND us.status = 'accepted')
                AND public.has_permission((SELECT public.get_current_profile_id()), server_id, 'CREATE_INVITE'));

-- Body of 20261001200002_enforce_channel_view_permission.sql; ownership and ADMINISTRATOR show every
-- channel of a server hosted here only, as get_user_permissions grants them.
CREATE OR REPLACE FUNCTION public.current_user_viewable_channel_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH srv AS (
        SELECT us.server_id
          FROM public.user_servers us
         WHERE us.user_id = v_me AND us.status = 'accepted'
        UNION
        SELECT s.id
          FROM public.servers s
         WHERE s.owner = v_me
    ),
    my_roles AS (
        SELECT ur.server_id, ur.role_id
          FROM public.user_roles ur
         WHERE ur.user_id = v_me
    ),
    base AS (
        SELECT srv.server_id,
               s.owner = v_me AND s.is_local_server IS NOT FALSE AS is_owner,
               s.is_local_server IS NOT FALSE AS is_local,
               ev.id AS everyone_id,
               COALESCE(ev.permissions, 0) | COALESCE(rm.mask, 0) AS mask
          FROM srv
          JOIN public.servers s ON s.id = srv.server_id
          LEFT JOIN public.server_roles ev ON ev.server_id = srv.server_id AND ev.is_default = true
          LEFT JOIN (
              SELECT mr.server_id, bit_or(sr.permissions) AS mask
                FROM my_roles mr
                JOIN public.server_roles sr ON sr.id = mr.role_id
               GROUP BY mr.server_id
          ) rm ON rm.server_id = srv.server_id
    ),
    chan AS (
        SELECT c.id, b.server_id, b.is_owner, b.is_local, b.everyone_id, b.mask
          FROM base b
          JOIN public.channels c ON c.server_id = b.server_id
    ),
    ovr AS (
        SELECT l.channel_id,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 1), 0) AS everyone_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 1), 0) AS everyone_deny,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 2), 0) AS role_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 2), 0) AS role_deny,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 3), 0) AS user_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 3), 0) AS user_deny
          FROM (
              SELECT ov.channel_id,
                     CASE WHEN ov.user_id = v_me THEN 3
                          WHEN ov.role_id = chan.everyone_id THEN 1
                          WHEN ov.role_id IS NOT NULL THEN 2
                     END AS layer,
                     COALESCE(ov.allow_permissions, 0) AS allow_p,
                     COALESCE(ov.deny_permissions, 0) AS deny_p
                FROM chan
                JOIN public.channel_permission_overrides ov ON ov.channel_id = chan.id
               WHERE ov.role_id = chan.everyone_id
                  OR ov.user_id = v_me
                  OR EXISTS (SELECT 1 FROM my_roles mr
                              WHERE mr.server_id = chan.server_id AND mr.role_id = ov.role_id)
          ) l
         GROUP BY l.channel_id
    )
    SELECT chan.id
      FROM chan
      LEFT JOIN ovr ON ovr.channel_id = chan.id
     WHERE chan.is_owner
        OR (chan.is_local AND (chan.mask & 1) <> 0)
        OR ((((((((chan.mask & ~COALESCE(ovr.everyone_deny, 0)) | COALESCE(ovr.everyone_allow, 0))
                  & ~COALESCE(ovr.role_deny, 0)) | COALESCE(ovr.role_allow, 0))
                  & ~COALESCE(ovr.user_deny, 0)) | COALESCE(ovr.user_allow, 0)) & 2) <> 0);
END;
$$;

-- Existing copies. ------------------------------------------------------------------------------
-- The Group document stored at creation names the host owner in attributedTo.
WITH resolved AS (
    SELECT s.id,
           (SELECT p.id
              FROM public.profiles p
             WHERE p.federated_id = s.federation_metadata ->> 'attributedTo'
               AND p.is_local IS FALSE
               AND lower(substring(p.federated_id FROM '^[a-z]+://([^/?#]+)'))
                   = lower(substring(s.ap_id FROM '^[a-z]+://([^/?#]+)'))
             ORDER BY p.created_at
             LIMIT 1) AS owner
      FROM public.servers s
     WHERE s.is_local_server IS FALSE
)
UPDATE public.servers s
   SET owner = r.owner
  FROM resolved r
 WHERE s.id = r.id
   AND s.owner IS DISTINCT FROM r.owner;

-- Roles and overrides of a copy are this instance's own: none arrive from the host. Those set
-- before this migration (stand-in owners, instance admins) are dropped and @everyone takes the
-- default of a new server (create_default_server_role), so no copy-local edit outlives the
-- loss of anyone able to change it.
DELETE FROM public.user_roles ur
 USING public.server_roles sr, public.servers s
 WHERE sr.id = ur.role_id
   AND s.id = ur.server_id
   AND s.is_local_server IS FALSE
   AND sr.is_default IS NOT TRUE;

DELETE FROM public.channel_permission_overrides o
 USING public.channels c, public.servers s
 WHERE c.id = o.channel_id
   AND s.id = c.server_id
   AND s.is_local_server IS FALSE;

DELETE FROM public.channel_category_permission_overrides o
 USING public.channel_categories k, public.servers s
 WHERE k.id = o.category_id
   AND s.id = k.server_id
   AND s.is_local_server IS FALSE;

-- The Admin role stays (prevent_protected_role_deletion), with no member left to hold it.
DELETE FROM public.server_roles sr
 USING public.servers s
 WHERE s.id = sr.server_id
   AND s.is_local_server IS FALSE
   AND sr.is_default IS NOT TRUE
   AND sr.is_admin IS NOT TRUE;

UPDATE public.server_roles sr
   SET permissions = 3343872258
  FROM public.servers s
 WHERE s.id = sr.server_id
   AND s.is_local_server IS FALSE
   AND sr.is_default IS TRUE
   AND sr.permissions IS DISTINCT FROM 3343872258;

-- Posted here by kick_server_member and ban_server_member; the host's notices carry ap_id.
DELETE FROM public.messages m
 USING public.channels c, public.servers s
 WHERE c.id = m.channel_id
   AND s.id = c.server_id
   AND s.is_local_server IS FALSE
   AND m.is_system IS TRUE
   AND m.metadata ->> 'type' IN ('member_kick', 'member_ban')
   AND NOT (m.metadata ? 'ap_id')
   AND NOT (m.metadata ? 'federated');

COMMIT;

NOTIFY pgrst, 'reload schema';
