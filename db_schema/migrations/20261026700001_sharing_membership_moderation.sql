-- Who reads conversation membership, public-bucket listings, server moderation and reports.
--
-- Conversation membership is answered only to members of the room:
--   is_conversation_participant, is_room_member   a client caller (role anon or authenticated)
--       asks about another account only for a room it is an active member of itself.
--       RLS policies and SECURITY DEFINER callers pass the caller, or act for a member.
--   get_room_epoch                                 1 for a client caller outside the room.
--   room_epoch_state                               rows of the caller's rooms only.
-- Public buckets (avatars, banners, emojis, group-icons, server_icons, server_banners,
-- soundboard): storage-api serves /object/public/ without consulting RLS, so their SELECT
-- policies only decide listing, authenticated reads and the rows INSERT/UPDATE/DELETE RETURNING
-- reads back. A policy over every row and role lets anyone list folder names: group-icons
-- folders are conversation ids, server_icons/server_banners folders are server ids. A bucket's
-- rows are readable by their uploader and by whoever may write them.
--
-- Server moderation:
--   kick_server_member, ban_server_member, unban_server_member, get_server_bans: the owner flag is
--   false, not NULL, on a server with no owner (servers.owner ON DELETE SET NULL); NOT NULL
--   skips the permission check.
--   profiles_delete_own is dropped and DELETE on profiles revoked from client roles: a direct
--   delete skips delete_my_account's re-authentication and ownership transfer and leaves owned
--   servers without an owner.
--
-- Reports scoped to a server: can_current_user_moderate_report(report) is the server moderator's
-- read of one report: MANAGE_MESSAGES in the reported message's channel, which has_permission
-- answers false without VIEW_CHANNEL there. get_reports_with_details, message_media_reported and
-- moderate_report apply it per report. The reports SELECT policy keeps instance staff and the
-- reporter: server moderators read through get_reports_with_details, which withholds reporter
-- identity. get_server_automod_events lists events of channels the caller views.
--
-- bot_server_permissions.allowed_channel_ids changes only through set_bot_allowed_channels,
-- which checks each channel against the caller's view (guard_bot_permission_grants).
--
-- Lesser reads: get_server_encryption_stats answers members, the owner and instance admins;
-- is_current_user_admin, is_current_user_moderator, is_current_user_admin_or_mod are false for a
-- suspended account; thread_members self-inserts name a thread the caller can see.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Room membership
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_conversation_participant(p_conversation_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM public.conversation_participants cp
         WHERE cp.conversation_id = p_conversation_id
           AND cp.user_id = p_user_id
           AND cp.left_at IS NULL)
       AND (coalesce(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
            OR EXISTS (
                SELECT 1 FROM public.conversation_participants me
                  JOIN public.profiles p ON p.id = me.user_id
                 WHERE me.conversation_id = p_conversation_id
                   AND me.left_at IS NULL
                   AND p.auth_user_id = auth.uid()));
$function$;

CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id text, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_room_uuid uuid;
    v_channel boolean;
    v_caller uuid;
BEGIN
    IF p_room_id IS NULL OR p_user_id IS NULL THEN
        RETURN false;
    END IF;

    BEGIN
        v_room_uuid := p_room_id::uuid;
    EXCEPTION WHEN others THEN
        RETURN false;
    END;

    v_channel := EXISTS (SELECT 1 FROM public.channels WHERE id = v_room_uuid);

    IF coalesce(current_setting('role', true), '') IN ('anon', 'authenticated') THEN
        v_caller := public.get_current_profile_id();
        IF v_caller IS DISTINCT FROM p_user_id AND NOT (CASE
               WHEN v_caller IS NULL THEN false
               WHEN v_channel THEN public.can_view_channel(v_caller, v_room_uuid)
               ELSE EXISTS (SELECT 1 FROM public.conversation_participants cp
                             WHERE cp.conversation_id = v_room_uuid
                               AND cp.user_id = v_caller
                               AND cp.left_at IS NULL)
           END) THEN
            RETURN false;
        END IF;
    END IF;

    IF v_channel THEN
        RETURN public.can_view_channel(p_user_id, v_room_uuid);
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.conversation_participants
         WHERE conversation_id = v_room_uuid
           AND user_id = p_user_id
           AND left_at IS NULL
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_room_epoch(p_room_id text)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF coalesce(current_setting('role', true), '') IN ('anon', 'authenticated')
       AND NOT public.is_room_member(p_room_id, public.get_current_profile_id()) THEN
        RETURN 1;
    END IF;
    RETURN COALESCE(
        (SELECT current_epoch FROM public.room_epoch_state WHERE room_id = p_room_id),
        1
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_room_epoch(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_epoch(text) TO authenticated, service_role;

DROP POLICY IF EXISTS room_epoch_state_select ON public.room_epoch_state;
CREATE POLICY room_epoch_state_select ON public.room_epoch_state
    FOR SELECT TO public
    USING ((SELECT auth.role()) = 'service_role'
           OR public.is_room_member(room_id, (SELECT public.get_current_profile_id())));

-- ---------------------------------------------------------------------------
-- Public buckets: rows readable by uploader and writers
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RAISE NOTICE 'storage.objects absent, public bucket read policies skipped';
        RETURN;
    END IF;

    DROP POLICY IF EXISTS "Public read access for avatars" ON storage.objects;
    DROP POLICY IF EXISTS "Writers read avatars" ON storage.objects;
    CREATE POLICY "Writers read avatars" ON storage.objects
        AS PERMISSIVE FOR SELECT TO authenticated
        USING (bucket_id = 'avatars' AND (
            owner = (SELECT auth.uid())
            OR (storage.foldername(name))[1] = (SELECT auth.uid())::text
            OR (storage.foldername(name))[1] = (SELECT public.get_current_profile_id())::text
            OR ((storage.foldername(name))[1] = 'bots'
                AND EXISTS (SELECT 1 FROM public.bots b
                             WHERE b.id::text = (storage.foldername(objects.name))[2]
                               AND b.owner_id = (SELECT public.get_current_profile_id())))
            OR (SELECT public.is_current_user_admin())));

    DROP POLICY IF EXISTS "Public read access for banners" ON storage.objects;
    DROP POLICY IF EXISTS "Writers read banners" ON storage.objects;
    CREATE POLICY "Writers read banners" ON storage.objects
        AS PERMISSIVE FOR SELECT TO authenticated
        USING (bucket_id = 'banners' AND (
            owner = (SELECT auth.uid())
            OR (storage.foldername(name))[1] = (SELECT auth.uid())::text
            OR (storage.foldername(name))[1] = (SELECT public.get_current_profile_id())::text
            OR (SELECT public.is_current_user_admin())));

    DROP POLICY IF EXISTS "Public read access for emojis" ON storage.objects;
    DROP POLICY IF EXISTS "Writers read emojis" ON storage.objects;
    CREATE POLICY "Writers read emojis" ON storage.objects
        AS PERMISSIVE FOR SELECT TO authenticated
        USING (bucket_id = 'emojis' AND (
            owner = (SELECT auth.uid())
            OR (array_length(storage.foldername(name), 1) = 1
                AND (storage.foldername(name))[1] = (SELECT public.get_current_profile_id())::text)
            OR public.has_permission((SELECT public.get_current_profile_id()),
                CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                     THEN ((storage.foldername(name))[1])::uuid END, 'MANAGE_EMOJIS'::text)
            OR (SELECT public.is_current_user_admin())));

    DROP POLICY IF EXISTS "Public read access for group-icons" ON storage.objects;
    DROP POLICY IF EXISTS "Writers read group-icons" ON storage.objects;
    CREATE POLICY "Writers read group-icons" ON storage.objects
        AS PERMISSIVE FOR SELECT TO authenticated
        USING (bucket_id = 'group-icons' AND (
            owner = (SELECT auth.uid())
            OR EXISTS (SELECT 1 FROM public.conversation_participants cp
                        WHERE cp.conversation_id = CASE
                                WHEN (storage.foldername(objects.name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                THEN ((storage.foldername(objects.name))[1])::uuid END
                          AND cp.user_id = (SELECT public.get_current_profile_id())
                          AND cp.left_at IS NULL)));

    DROP POLICY IF EXISTS "Public read access for server_icons" ON storage.objects;
    DROP POLICY IF EXISTS "Writers read server_icons" ON storage.objects;
    CREATE POLICY "Writers read server_icons" ON storage.objects
        AS PERMISSIVE FOR SELECT TO authenticated
        USING (bucket_id = 'server_icons' AND (
            owner = (SELECT auth.uid())
            OR public.has_permission((SELECT public.get_current_profile_id()),
                CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                     THEN ((storage.foldername(name))[1])::uuid END, 'MANAGE_SERVER'::text)
            OR (SELECT public.is_current_user_admin())));

    DROP POLICY IF EXISTS "Public read access for server_banners" ON storage.objects;
    DROP POLICY IF EXISTS "Writers read server_banners" ON storage.objects;
    CREATE POLICY "Writers read server_banners" ON storage.objects
        AS PERMISSIVE FOR SELECT TO authenticated
        USING (bucket_id = 'server_banners' AND (
            owner = (SELECT auth.uid())
            OR public.has_permission((SELECT public.get_current_profile_id()),
                CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                     THEN ((storage.foldername(name))[1])::uuid END, 'MANAGE_SERVER'::text)
            OR (SELECT public.is_current_user_admin())));

    DROP POLICY IF EXISTS "Public read access for soundboard" ON storage.objects;
    DROP POLICY IF EXISTS "Writers read soundboard" ON storage.objects;
    CREATE POLICY "Writers read soundboard" ON storage.objects
        AS PERMISSIVE FOR SELECT TO authenticated
        USING (bucket_id = 'soundboard' AND (
            owner = (SELECT auth.uid())
            OR public.can_manage_server_sounds(public.soundboard_object_server(name))));
END;
$$;

-- ---------------------------------------------------------------------------
-- Server moderation
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS profiles_delete_own ON public.profiles;
REVOKE DELETE ON public.profiles FROM anon, authenticated;

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
    -- A server without an owner (a remote reference whose owner profile is gone) has no owner
    -- path: NOT NULL would skip the permission check below.
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
    -- A server without an owner (a remote reference whose owner profile is gone) has no owner
    -- path: NOT NULL would skip the permission check below.
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

    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;
    -- A server without an owner (a remote reference whose owner profile is gone) has no owner
    -- path: NOT NULL would skip the permission check below.
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

    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;
    -- A server without an owner (a remote reference whose owner profile is gone) has no owner
    -- path: NOT NULL would skip the permission check below.
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


-- ---------------------------------------------------------------------------
-- Reports scoped to a server
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_current_user_moderate_report(p_report public.reports)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_channel uuid;
BEGIN
    IF v_caller IS NULL OR p_report.scope_server_id IS NULL
       OR NOT public.can_current_user_moderate_server_reports(p_report.scope_server_id) THEN
        RETURN false;
    END IF;

    -- The live message's channel, else the one its snapshot recorded.
    SELECT m.channel_id INTO v_channel FROM public.messages m WHERE m.id = p_report.reported_message_id;
    IF v_channel IS NULL
       AND p_report.content_snapshot -> 'message' ->> 'channel_id'
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_channel := (p_report.content_snapshot -> 'message' ->> 'channel_id')::uuid;
    END IF;
    IF v_channel IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (SELECT 1 FROM public.channels c
                    WHERE c.id = v_channel AND c.server_id = p_report.scope_server_id)
       AND public.has_permission(v_caller, p_report.scope_server_id, 'MANAGE_MESSAGES', v_channel);
END;
$function$;

REVOKE ALL ON FUNCTION public.can_current_user_moderate_report(public.reports) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_current_user_moderate_report(public.reports) TO service_role;

DROP POLICY IF EXISTS "Moderators can view reports they moderate" ON public.reports;
CREATE POLICY "Moderators can view reports they moderate" ON public.reports
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin_or_mod()));

CREATE OR REPLACE FUNCTION public.get_reports_with_details(p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_server_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, updated_at timestamp with time zone, status text, report_type text, category text, reason text, comment text, source text, source_instance text, source_actor text, reporter_id uuid, reporter_username text, reporter_display_name text, reporter_avatar_url text, reporter_domain text, reporter_is_local boolean, reported_user_id uuid, reported_user_username text, reported_user_display_name text, reported_user_avatar_url text, reported_user_domain text, reported_user_is_local boolean, reported_user_is_suspended boolean, reported_user_is_silenced boolean, reported_domain_blocked boolean, reported_domain_limited boolean, reported_post_id uuid, reported_message_id uuid, reported_server_id uuid, scope_server_id uuid, reported_post_preview text, reported_post_ap_id text, reported_post_url text, reported_post_is_sensitive boolean, reported_post_content_warning text, reported_post_is_deleted boolean, reported_message_preview text, reported_message_is_deleted boolean, content_snapshot jsonb, forward boolean, forwarded_at timestamp with time zone, federation_status text, assigned_to uuid, assigned_username text, resolved_at timestamp with time zone, resolver_username text, resolution_note text, open_reports_on_target bigint, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_instance boolean := public.is_current_user_admin_or_mod();
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Permission denied: moderator access required' USING ERRCODE = '42501';
    END IF;
    IF NOT v_instance AND (p_server_id IS NULL
                           OR NOT public.can_current_user_moderate_server_reports(p_server_id)) THEN
        RAISE EXCEPTION 'Permission denied: moderator access required' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        r.id,
        r.created_at,
        r.updated_at,
        r.status,
        r.report_type,
        r.category,
        r.reason,
        r.comment,
        r.source,
        r.source_instance,
        (r.metadata->>'actor')::text,
        CASE WHEN v_instance THEN r.reporter_id END,
        CASE WHEN v_instance THEN reporter.username::text END,
        CASE WHEN v_instance THEN reporter.display_name::text END,
        CASE WHEN v_instance THEN reporter.avatar_url::text END,
        CASE WHEN v_instance THEN reporter.domain::text END,
        CASE WHEN v_instance THEN COALESCE(reporter.is_local, r.source = 'local') END,
        r.reported_user_id,
        COALESCE(ru.username, r.content_snapshot->'account'->>'username')::text,
        COALESCE(ru.display_name, r.content_snapshot->'account'->>'display_name')::text,
        COALESCE(ru.avatar_url, r.content_snapshot->'account'->>'avatar_url')::text,
        COALESCE(ru.domain, r.content_snapshot->'account'->>'domain')::text,
        COALESCE(ru.is_local, (r.content_snapshot->'account'->>'is_local')::boolean, true),
        COALESCE(ru.is_suspended, false),
        COALESCE(ru.is_silenced, false),
        COALESCE(fi.is_blocked, false),
        fi.limited_at IS NOT NULL,
        r.reported_post_id,
        r.reported_message_id,
        r.reported_server_id,
        r.scope_server_id,
        CASE WHEN po.id IS NOT NULL THEN
            LEFT(COALESCE((
                SELECT string_agg(
                    CASE
                        WHEN part->>'type' = 'text' THEN COALESCE(part->>'text', '')
                        WHEN part->>'type' = 'url' THEN COALESCE(part->>'url', '[link]')
                        WHEN part->>'type' = 'mention' THEN '@' || COALESCE(part->>'username', 'user')
                        WHEN part->>'type' = 'hashtag' THEN '#' || COALESCE(part->>'name', 'tag')
                        WHEN part->>'type' = 'emoji' THEN ':' || COALESCE(part->'emoji'->>'name', 'emoji') || ':'
                        ELSE ''
                    END, ' ')
                  FROM jsonb_array_elements(po.content) AS part), '[Post content unavailable]'), 500)
        END::text,
        po.ap_id::text,
        po.url::text,
        po.is_sensitive,
        po.content_warning::text,
        CASE WHEN r.reported_post_id IS NOT NULL OR r.report_type = 'post'
             THEN COALESCE(po.is_deleted, true) END,
        CASE WHEN m.id IS NOT NULL THEN
            LEFT(COALESCE((
                SELECT string_agg(
                    CASE
                        WHEN part->>'type' = 'text' THEN COALESCE(part->>'text', '')
                        WHEN part->>'type' = 'file' THEN '[' || COALESCE(part->>'fileType', 'file') || ': ' || COALESCE(part->>'filename', part->>'url', 'attachment') || ']'
                        WHEN part->>'type' = 'url' THEN COALESCE(part->>'url', '[link]')
                        WHEN part->>'type' = 'emoji' THEN COALESCE(part->'emoji'->>'name', ':emoji:')
                        WHEN part->>'type' = 'mention' THEN COALESCE(part->>'mention', '@user')
                        ELSE '[' || COALESCE(part->>'type', 'unknown') || ']'
                    END, ' ')
                  FROM jsonb_array_elements(m.content) AS part), '[Message content unavailable]'), 300)
        END::text,
        CASE WHEN r.reported_message_id IS NOT NULL OR r.report_type = 'message'
             THEN COALESCE(m.is_deleted, true) END,
        r.content_snapshot,
        r.forward,
        r.forwarded_at,
        r.federation_status,
        CASE WHEN v_instance THEN r.assigned_to END,
        CASE WHEN v_instance THEN assignee.username::text END,
        r.resolved_at,
        CASE WHEN v_instance THEN resolver.username::text END,
        r.resolution_note,
        (SELECT count(*) FROM public.reports o
          WHERE r.reported_user_id IS NOT NULL
            AND o.reported_user_id = r.reported_user_id
            AND o.status IN ('pending', 'investigating')),
        count(*) OVER ()
    FROM public.reports r
    LEFT JOIN public.profiles reporter ON reporter.id = r.reporter_id
    LEFT JOIN public.profiles ru ON ru.id = r.reported_user_id
    LEFT JOIN public.profiles assignee ON assignee.id = r.assigned_to
    LEFT JOIN public.profiles resolver ON resolver.id = r.resolved_by
    LEFT JOIN public.posts po ON po.id = r.reported_post_id
    LEFT JOIN public.messages m ON m.id = r.reported_message_id
    LEFT JOIN public.federated_instances fi
           ON NOT COALESCE(ru.is_local, true) AND fi.domain = lower(ru.domain)
    WHERE (p_status IS NULL OR r.status = p_status)
      AND (p_server_id IS NULL OR r.scope_server_id = p_server_id)
      AND (v_instance OR public.can_current_user_moderate_report(r))
    ORDER BY r.created_at DESC, r.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.message_media_reported(p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM public.reports r
         WHERE r.reported_message_id IS NOT NULL
           AND r.content_snapshot -> 'message' -> 'content'
               @> jsonb_build_array(jsonb_build_object('path', p_name))
           AND (public.is_current_user_admin_or_mod()
                OR public.can_current_user_moderate_report(r))
    );
$function$;

CREATE OR REPLACE FUNCTION public.moderate_report(p_report_id uuid, p_action text, p_note text DEFAULT NULL::text, p_reason text DEFAULT NULL::text, p_show_resolver boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_is_admin boolean := public.is_current_user_admin();
    v_is_mod boolean := public.is_current_user_admin_or_mod();
    v_server_mod boolean := false;
    r public.reports%ROWTYPE;
    v_target public.profiles%ROWTYPE;
    v_status text;
    v_open boolean;
    v_note text := NULLIF(left(btrim(COALESCE(p_note, '')), 1000), '');
    v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 500), '');
    v_resolver jsonb := '{}'::jsonb;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO r FROM public.reports WHERE id = p_report_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Report not found' USING ERRCODE = 'P0002';
    END IF;

    v_server_mod := public.can_current_user_moderate_report(r);
    IF NOT v_is_mod AND NOT v_server_mod THEN
        RAISE EXCEPTION 'Permission denied: moderator access required' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_mod AND p_action NOT IN ('investigate', 'resolve', 'dismiss', 'reopen',
                                         'assign', 'unassign', 'delete_message') THEN
        RAISE EXCEPTION 'Permission denied: % requires an instance moderator', p_action USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_admin AND p_action IN ('limit_domain', 'suspend_domain') THEN
        RAISE EXCEPTION 'Permission denied: % requires an instance admin', p_action USING ERRCODE = '42501';
    END IF;

    v_open := r.status IN ('pending', 'investigating');
    v_status := r.status;

    IF r.reported_user_id IS NOT NULL THEN
        SELECT * INTO v_target FROM public.profiles WHERE id = r.reported_user_id;
    END IF;

    CASE p_action
    WHEN 'investigate' THEN
        IF r.status <> 'pending' THEN
            RAISE EXCEPTION 'Only a pending report can move to investigating' USING ERRCODE = '22023';
        END IF;
        v_status := 'investigating';
    WHEN 'resolve' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        v_status := 'resolved';
    WHEN 'dismiss' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        v_status := 'dismissed';
    WHEN 'reopen' THEN
        IF v_open THEN RAISE EXCEPTION 'Report is open' USING ERRCODE = '22023'; END IF;
        v_status := 'pending';
    WHEN 'assign' THEN
        UPDATE public.reports SET assigned_to = v_caller, updated_at = now() WHERE id = r.id;
    WHEN 'unassign' THEN
        UPDATE public.reports SET assigned_to = NULL, updated_at = now() WHERE id = r.id;
    WHEN 'forward' THEN
        IF r.source <> 'local' OR v_target.id IS NULL OR COALESCE(v_target.is_local, true) THEN
            RAISE EXCEPTION 'Only a local report about a remote account can be forwarded' USING ERRCODE = '22023';
        END IF;
        IF r.forwarded_at IS NOT NULL OR r.federation_status IN ('queued', 'processing') THEN
            RAISE EXCEPTION 'Report already forwarded' USING ERRCODE = '22023';
        END IF;
        UPDATE public.reports
           SET forward = true, federation_status = 'queued', updated_at = now()
         WHERE id = r.id;
        PERFORM public.queue_federation_job(
            'federate-report', jsonb_build_object('type', 'create', 'report_id', r.id), 10, 5, 7200);
    WHEN 'delete_post' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF r.reported_post_id IS NULL THEN
            RAISE EXCEPTION 'Report names no post' USING ERRCODE = '22023';
        END IF;
        UPDATE public.posts SET is_deleted = true, deleted_at = now() WHERE id = r.reported_post_id;
        v_status := 'resolved';
    WHEN 'mark_sensitive' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF r.reported_post_id IS NULL THEN
            RAISE EXCEPTION 'Report names no post' USING ERRCODE = '22023';
        END IF;
        UPDATE public.posts SET is_sensitive = true WHERE id = r.reported_post_id;
        v_status := 'resolved';
    WHEN 'delete_message' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF r.reported_message_id IS NULL THEN
            RAISE EXCEPTION 'Report names no message' USING ERRCODE = '22023';
        END IF;
        IF NOT v_is_mod AND NOT EXISTS (
            SELECT 1 FROM public.messages m
              JOIN public.channels c ON c.id = m.channel_id
             WHERE m.id = r.reported_message_id
               AND public.has_permission(v_caller, c.server_id, 'MANAGE_MESSAGES', m.channel_id)) THEN
            RAISE EXCEPTION 'Permission denied: MANAGE_MESSAGES required in the message''s channel'
                USING ERRCODE = '42501';
        END IF;
        -- Same write as CoreMessageService.deleteMessage.
        UPDATE public.messages
           SET content = '[{"type": "text", "text": "[deleted]"}]'::jsonb, is_deleted = true
         WHERE id = r.reported_message_id;
        v_status := 'resolved';
    WHEN 'warn' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF v_target.id IS NULL OR NOT COALESCE(v_target.is_local, true) THEN
            RAISE EXCEPTION 'Only a local account can be warned' USING ERRCODE = '22023';
        END IF;
        PERFORM public.send_notification_to_user(
            'moderation_warning', v_target.id,
            jsonb_build_object('text', v_reason, 'category', r.category, 'report_type', r.report_type),
            NULL, NULL, NULL, NULL, 'high');
        v_status := 'resolved';
    WHEN 'silence_account', 'suspend_account', 'force_sensitive_account' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF v_target.id IS NULL THEN
            RAISE EXCEPTION 'Report names no account' USING ERRCODE = '22023';
        END IF;
        IF v_target.id = v_caller THEN
            RAISE EXCEPTION 'Cannot moderate your own account' USING ERRCODE = '42501';
        END IF;
        IF NOT v_is_admin AND (v_target.is_admin IS TRUE OR v_target.is_moderator IS TRUE) THEN
            RAISE EXCEPTION 'Moderators cannot act on instance staff' USING ERRCODE = '42501';
        END IF;
        IF p_action = 'silence_account' THEN
            UPDATE public.profiles
               SET is_silenced = true, silenced_at = now(), silenced_reason = v_reason
             WHERE id = v_target.id;
        ELSIF p_action = 'suspend_account' THEN
            UPDATE public.profiles
               SET is_suspended = true, suspended_at = now(), suspension_reason = v_reason
             WHERE id = v_target.id;
        ELSE
            UPDATE public.profiles SET force_sensitive = true WHERE id = v_target.id;
        END IF;
        v_status := 'resolved';
    WHEN 'limit_domain', 'suspend_domain' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF v_target.id IS NULL OR COALESCE(v_target.is_local, true) THEN
            RAISE EXCEPTION 'Only a remote account''s domain can be limited or suspended' USING ERRCODE = '22023';
        END IF;
        PERFORM public.set_domain_moderation(
            v_target.domain,
            CASE p_action WHEN 'limit_domain' THEN 'limit' ELSE 'suspend' END,
            v_reason);
        v_status := 'resolved';
    ELSE
        RAISE EXCEPTION 'Invalid report action: %', p_action USING ERRCODE = '22023';
    END CASE;

    IF v_status IS DISTINCT FROM r.status THEN
        UPDATE public.reports
           SET status = v_status,
               updated_at = now(),
               resolved_at = CASE WHEN v_status IN ('resolved', 'dismissed') THEN now() END,
               resolved_by = CASE WHEN v_status IN ('resolved', 'dismissed') THEN v_caller END,
               resolution_note = CASE WHEN v_status IN ('resolved', 'dismissed') THEN v_note
                                      WHEN v_status = 'pending' THEN NULL
                                      ELSE resolution_note END
         WHERE id = r.id;
    END IF;

    PERFORM public.log_admin_action(
        v_caller, 'report_' || p_action, 'report', r.id::text,
        jsonb_strip_nulls(jsonb_build_object(
            'status', v_status,
            'previous_status', r.status,
            'report_type', r.report_type,
            'category', r.category,
            'reported_user_id', r.reported_user_id,
            'reported_post_id', r.reported_post_id,
            'reported_message_id', r.reported_message_id,
            'domain', CASE WHEN p_action IN ('limit_domain', 'suspend_domain') THEN lower(v_target.domain) END,
            'reason', v_reason,
            'note', v_note,
            'server_scope', CASE WHEN NOT v_is_mod THEN r.scope_server_id END)));

    IF r.reporter_id IS NOT NULL
       AND v_status IS DISTINCT FROM r.status
       AND v_status IN ('investigating', 'resolved', 'dismissed') THEN
        IF p_show_resolver THEN
            SELECT jsonb_build_object('resolver_username', p.username,
                                      'resolver_display_name', p.display_name,
                                      'resolver_avatar_url', p.avatar_url)
              INTO v_resolver
              FROM public.profiles p WHERE p.id = v_caller;
        END IF;
        PERFORM public.send_notification_to_user(
            'report_update', r.reporter_id,
            jsonb_build_object(
                'report_id', r.id,
                'status', v_status,
                'report_type', r.report_type,
                'category', r.category,
                'resolution_note', CASE WHEN v_status IN ('resolved', 'dismissed') THEN v_note END,
                'show_resolver', COALESCE(p_show_resolver, false))
            || COALESCE(v_resolver, '{}'::jsonb),
            NULL, NULL, NULL,
            CASE WHEN p_show_resolver THEN v_caller END,
            'normal');
    END IF;

    RETURN jsonb_build_object('report_id', r.id, 'action', p_action, 'status', v_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_server_automod_events(p_server_id uuid, p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    PERFORM public.automod_require(p_server_id, ARRAY['MANAGE_SERVER', 'VIEW_AUDIT_LOG']);
    RETURN COALESCE((
        SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.last_hit_at DESC)
          FROM (SELECT e.id, e.event_type, e.rule_id, e.rule_name, e.rule_type, e.actions, e.matched,
                       e.content_excerpt, e.details, e.hits, e.created_at, e.last_hit_at,
                       e.channel_id, c.name AS channel_name,
                       e.user_id, p.username, p.display_name, p.avatar_url, p.domain, p.is_local,
                       e.bot_id, COALESCE(b.display_name, b.username) AS bot_name,
                       t.until AS timeout_until
                  FROM public.automod_events e
                  LEFT JOIN public.channels c ON c.id = e.channel_id
                  LEFT JOIN public.profiles p ON p.id = e.user_id
                  LEFT JOIN public.bots b ON b.id = e.bot_id
                  LEFT JOIN public.server_member_timeouts t
                         ON t.server_id = e.server_id AND t.user_id = e.user_id AND t.until > now()
                 WHERE e.server_id = p_server_id
                   AND (e.channel_id IS NULL
                        OR public.can_view_channel(public.get_current_profile_id(), e.channel_id))
                   AND (p_before IS NULL OR e.last_hit_at < p_before)
                 ORDER BY e.last_hit_at DESC
                 LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) x), '[]'::jsonb);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Bot channel grants
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_bot_permission_grants()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.server_id IS DISTINCT FROM OLD.server_id OR NEW.bot_id IS DISTINCT FROM OLD.bot_id) THEN
        RAISE EXCEPTION 'an installation stays with its bot and server' USING ERRCODE = '42501';
    END IF;
    -- allowed_channel_ids grants VIEW_CHANNEL past @everyone's deny; set_bot_allowed_channels
    -- checks each channel against the caller's own view and is its only client writer.
    IF (TG_OP = 'INSERT' AND NEW.allowed_channel_ids IS NOT NULL)
       OR (TG_OP = 'UPDATE' AND NEW.allowed_channel_ids IS DISTINCT FROM OLD.allowed_channel_ids) THEN
        RAISE EXCEPTION 'allowed_channel_ids is set through set_bot_allowed_channels' USING ERRCODE = '42501';
    END IF;
    PERFORM public.assert_grantable_bot_flags(NEW.server_id, to_jsonb(NEW),
                                              CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END);
    RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Lesser reads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_server_encryption_stats(p_server_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_caller uuid := public.get_current_profile_id();
  v_total int;
  v_with_keys int;
BEGIN
  IF coalesce(current_setting('role', true), '') IN ('anon', 'authenticated')
     AND NOT public.is_current_user_admin()
     AND NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v_caller)
     AND NOT EXISTS (SELECT 1 FROM public.user_servers us
                      WHERE us.server_id = p_server_id AND us.user_id = v_caller AND us.status = 'accepted') THEN
    RAISE EXCEPTION 'Not a member of this server' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_total
  FROM user_servers WHERE server_id = p_server_id;

  SELECT count(DISTINCT us.user_id) INTO v_with_keys
  FROM user_servers us
  JOIN user_key_pairs ukp ON ukp.user_id = us.user_id
  WHERE us.server_id = p_server_id;

  RETURN jsonb_build_object(
    'total', v_total,
    'with_keys', v_with_keys,
    'percentage', CASE WHEN v_total > 0
      THEN round((v_with_keys::numeric / v_total) * 100)
      ELSE 0 END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_server_encryption_stats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_server_encryption_stats(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_current_user_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT COALESCE(
        (SELECT is_admin AND is_suspended IS NOT TRUE FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$function$;

CREATE OR REPLACE FUNCTION public.is_current_user_moderator()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT COALESCE(
        (SELECT is_moderator AND is_suspended IS NOT TRUE FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$function$;

CREATE OR REPLACE FUNCTION public.is_current_user_admin_or_mod()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT COALESCE(
        (SELECT (is_admin OR is_moderator) AND is_suspended IS NOT TRUE
           FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$function$;

DROP POLICY IF EXISTS thread_members_insert_self ON public.thread_members;
CREATE POLICY thread_members_insert_self ON public.thread_members
    FOR INSERT TO public
    WITH CHECK (user_id = (SELECT public.get_current_profile_id())
                AND EXISTS (SELECT 1 FROM public.threads t WHERE t.id = thread_members.thread_id));

COMMIT;
