-- Server system messages (member join, leave, kick, ban) are configurable.
--
--   server_settings.system_messages_enabled   false: no system message for a join, leave,
--                                              kick or ban. NOT NULL, default true. The
--                                              table-wide grants on server_settings
--                                              (20261007900001) cover the column.
--   set_server_system_channel                  MANAGE_SERVER on a local server, as
--                                              set_server_newcomer_alerts. Upserts
--                                              system_channel_id and system_messages_enabled;
--                                              a NULL channel posts to get_default_channel.
--   server_settings_system_channel_check       As 20261009500001, plus: the channel is a text
--                                              channel (type 0), else 22023. Rows naming another
--                                              type -> NULL.
--   get_default_channel                        A text channel @everyone can view, in the
--                                              baseline's order; NULL when there is none, and
--                                              the readers then post nothing.
--                                              Viewable is the @everyone term of
--                                              channel_is_restricted (20261001200002): the
--                                              role's permissions, less its channel deny, plus
--                                              its channel allow, carry VIEW_CHANNEL (bit 1). A
--                                              server without an @everyone role has no such
--                                              channel. Signature, volatility, security and
--                                              grants as the baseline.
--   handle_member_join_system_message,         As the baseline, plus: nothing is posted when
--   handle_member_leave_system_message,        system_messages_enabled is false.
--   kick_server_member, ban_server_member
--   handle_member_leave_system_message         Also: deleting a row whose status is pending or
--                                              banned posts nothing; such a row posted no join
--                                              message.
--   trigger_member_accept_system_message       AFTER UPDATE OF status on user_servers from
--                                              pending or banned to accepted, running
--                                              handle_member_join_system_message: redeem_invite
--                                              and join_public_server accept an existing row by
--                                              UPDATE. A NULL status reads as accepted and
--                                              already posted on INSERT, so NULL -> accepted
--                                              posts nothing.
--
-- kick_server_member and ban_server_member keep their effective search_path
-- (public, extensions, pg_temp, from the baseline's search_path pin); CREATE OR REPLACE
-- resets proconfig, so it is restated. EXECUTE on both is authenticated and service_role;
-- anon held it through PUBLIC and was refused by the caller check.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.server_settings
    ADD COLUMN IF NOT EXISTS system_messages_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.server_settings.system_messages_enabled IS
    'Post member join, leave, kick and ban messages to system_channel_id, or get_default_channel when NULL.';

-- ---------------------------------------------------------------------------
-- Integrity
-- ---------------------------------------------------------------------------

UPDATE public.server_settings ss
   SET system_channel_id = NULL
 WHERE ss.system_channel_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.channels c
                    WHERE c.id = ss.system_channel_id
                      AND c.server_id = ss.server_id
                      AND c.type = 0);

CREATE OR REPLACE FUNCTION public.server_settings_system_channel_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_type smallint;
BEGIN
    IF NEW.system_channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c.type INTO v_type
      FROM public.channels c
     WHERE c.id = NEW.system_channel_id AND c.server_id = NEW.server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Channel % is not a channel of this server', NEW.system_channel_id
            USING ERRCODE = '23514';
    END IF;
    IF v_type IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'Channel % is not a text channel', NEW.system_channel_id
            USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.server_settings_system_channel_check() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Write path
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_server_system_channel(
    p_server_id uuid,
    p_channel_id uuid,
    p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_channel_id uuid;
    v_enabled boolean;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE)
       OR NOT public.has_permission(v_caller, p_server_id, 'MANAGE_SERVER') THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;
    IF p_enabled IS NULL THEN
        RAISE EXCEPTION 'p_enabled is required' USING ERRCODE = '22004';
    END IF;

    INSERT INTO public.server_settings (server_id, system_channel_id, system_messages_enabled)
    VALUES (p_server_id, p_channel_id, p_enabled)
    ON CONFLICT (server_id) DO UPDATE
    SET system_channel_id = EXCLUDED.system_channel_id,
        system_messages_enabled = EXCLUDED.system_messages_enabled,
        updated_at = now()
    RETURNING system_channel_id, system_messages_enabled INTO v_channel_id, v_enabled;

    RETURN jsonb_build_object(
        'system_channel_id', v_channel_id,
        'system_messages_enabled', v_enabled);
END;
$$;

REVOKE ALL ON FUNCTION public.set_server_system_channel(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_server_system_channel(uuid, uuid, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fallback channel
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_default_channel(p_server_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel_id uuid;
BEGIN
    SELECT c.id INTO v_channel_id
      FROM public.channels c
      LEFT JOIN public.server_roles ev ON ev.server_id = c.server_id AND ev.is_default = true
      LEFT JOIN LATERAL (
          SELECT bit_or(COALESCE(o.allow_permissions, 0)) AS allow_p,
                 bit_or(COALESCE(o.deny_permissions, 0)) AS deny_p
            FROM public.channel_permission_overrides o
           WHERE o.channel_id = c.id AND o.role_id = ev.id AND o.user_id IS NULL
      ) eo ON true
     WHERE c.server_id = p_server_id
       AND c.type = 0
       AND (((COALESCE(ev.permissions, 0) & ~COALESCE(eo.deny_p, 0)) | COALESCE(eo.allow_p, 0)) & 2) <> 0
     ORDER BY
        CASE WHEN c.name = 'general' THEN 0 ELSE 1 END,
        c."order" ASC,
        c.created_at ASC
     LIMIT 1;

    RETURN v_channel_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_default_channel(uuid) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------

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

    INSERT INTO messages (channel_id, user_id, content, is_system, metadata)
    VALUES (
        v_channel_id,
        NEW.user_id,
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'has joined the server')),
        true,
        jsonb_build_object('type', 'member_join')
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_member_accept_system_message ON public.user_servers;
CREATE TRIGGER trigger_member_accept_system_message
    AFTER UPDATE OF status ON public.user_servers
    FOR EACH ROW
    WHEN (OLD.status <> 'accepted' AND NEW.status = 'accepted')
    EXECUTE FUNCTION public.handle_member_join_system_message();

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

    INSERT INTO messages (channel_id, user_id, content, is_system, metadata)
    VALUES (
        v_channel_id,
        OLD.user_id,
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'has left the server')),
        true,
        jsonb_build_object('type', 'member_leave')
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
            INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
            VALUES (
                v_system_channel_id,
                p_user_id,
                jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'was kicked from the server')),
                true,
                jsonb_build_object('type', 'member_kick', 'kicked_by', v_caller_id, 'reason', COALESCE(p_reason, ''))
            );
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'messages_deleted', v_deleted_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.kick_server_member(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kick_server_member(uuid, uuid, text, integer) TO authenticated, service_role;

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
            INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
            VALUES (
                v_system_channel_id,
                p_user_id,
                jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'was banned from the server')),
                true,
                jsonb_build_object('type', 'member_ban', 'banned_by', v_caller_id, 'reason', COALESCE(p_reason, ''))
            );
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'messages_deleted', v_deleted_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.ban_server_member(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ban_server_member(uuid, uuid, text, integer) TO authenticated, service_role;

COMMIT;
