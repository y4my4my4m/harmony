-- =============================================================================
-- MISSING RPC FUNCTIONS - Extracted from supabase_minimal.sql
-- =============================================================================
-- These functions are used by the frontend but missing from the init schema
-- Run this after sync_with_production.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Function: is_user_viewing_context
-- Checks if user is viewing a specific channel/DM. Used by send_notification
-- to suppress notifications at database level (Discord-like behavior).
-- Must be created BEFORE send_notification which depends on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_user_viewing_context(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_view_context RECORD;
BEGIN
    SELECT * INTO v_view_context
    FROM public.user_view_contexts
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Check if viewing the exact server channel
    IF p_server_id IS NOT NULL AND p_channel_id IS NOT NULL THEN
        IF v_view_context.view_type = 'server_channel' AND
           v_view_context.server_id = p_server_id AND
           v_view_context.channel_id = p_channel_id THEN
            RETURN TRUE;
        END IF;
    END IF;

    -- Check if viewing the exact DM conversation
    IF p_conversation_id IS NOT NULL THEN
        IF v_view_context.view_type = 'dm' AND
           v_view_context.conversation_id = p_conversation_id THEN
            RETURN TRUE;
        END IF;
    END IF;

    RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION public.is_user_viewing_context(uuid, uuid, uuid, uuid)
IS 'Checks if user is viewing a specific channel/DM. Used by send_notification to suppress notifications at database level.';

-- ---------------------------------------------------------------------------
-- Function: sync_view_context_from_presence
-- Syncs ephemeral presence state to the user_view_contexts table so
-- is_user_viewing_context() can check it. Called from frontend on navigation.
-- Resolves auth.uid() to profiles.id since they are different UUIDs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_view_context_from_presence(
    p_view_type text,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_id UUID := auth.uid();
    v_profile_id UUID;
BEGIN
    IF v_auth_id IS NULL THEN
        RETURN;
    END IF;

    -- Resolve auth user ID to profile ID (they are different UUIDs)
    SELECT id INTO v_profile_id
    FROM public.profiles
    WHERE auth_user_id = v_auth_id
    LIMIT 1;

    IF v_profile_id IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO public.user_view_contexts (user_id, view_type, server_id, channel_id, conversation_id, last_active_at)
    VALUES (v_profile_id, p_view_type, p_server_id, p_channel_id, p_conversation_id, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET
        view_type = EXCLUDED.view_type,
        server_id = EXCLUDED.server_id,
        channel_id = EXCLUDED.channel_id,
        conversation_id = EXCLUDED.conversation_id,
        last_active_at = EXCLUDED.last_active_at;
END;
$$;

COMMENT ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid)
IS 'Syncs ephemeral presence state to database table for PostgreSQL function access. Resolves auth.uid() to profiles.id before writing. Called from frontend when view context changes.';

GRANT EXECUTE ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Function: can_manage_group_icon
-- Returns true if the user is an active participant in the conversation (used by group icon RPCs/storage).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_manage_group_icon(conversation_uuid uuid, user_profile_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM conversation_participants cp
    WHERE cp.conversation_id = conversation_uuid
      AND cp.user_id = user_profile_id
      AND cp.left_at IS NULL
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: send_notification (BASE function - must be created first)
-- Other functions like send_notification_to_user depend on this
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_notification(
    p_notification_type character varying,
    to_user_ids uuid[],
    notification_data jsonb DEFAULT '{}'::jsonb,
    p_server_id uuid DEFAULT NULL::uuid,
    p_channel_id uuid DEFAULT NULL::uuid,
    p_conversation_id uuid DEFAULT NULL::uuid,
    p_from_user_id uuid DEFAULT NULL::uuid,
    p_priority character varying DEFAULT 'normal'::character varying
) RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    created_notification_ids uuid[] := '{}';
    recipient_id uuid;
    user_prefs record;
    should_send boolean;
    notification_id uuid;
    current_timestamp timestamp with time zone := now();
    enhanced_data jsonb;
    is_blocked boolean;
    is_muted boolean;
    is_channel_muted boolean;
    v_muted_until timestamp with time zone;
    is_rate_limited boolean;
    is_activitypub_type boolean;
    v_time_threshold timestamp with time zone := NOW() - INTERVAL '2 minutes';
    v_notification_level varchar(20);
    v_server_default varchar(20);
    v_is_mention_type boolean;
    v_is_content_feedback_type boolean;
BEGIN
    IF p_notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    is_activitypub_type := p_notification_type LIKE 'activitypub_%';
    v_is_mention_type := p_notification_type IN ('mention', 'activitypub_mention');
    -- Reactions / favorites / reblogs are about the recipient's own message or post;
    -- allow them when a channel is set to "mentions only" (general chat noise stays off).
    v_is_content_feedback_type := p_notification_type IN (
        'reaction', 'activitypub_reaction', 'activitypub_favorite', 'activitypub_reblog'
    );

    FOREACH recipient_id IN ARRAY to_user_ids LOOP
        IF p_from_user_id IS NOT NULL AND recipient_id = p_from_user_id THEN
            CONTINUE;
        END IF;

        -- Check if sender is blocked by recipient
        IF p_from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM user_blocks ub
                WHERE ub.blocker_id = recipient_id
                AND ub.blocked_user_id = p_from_user_id
                AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
            ) INTO is_blocked;
            IF is_blocked THEN CONTINUE; END IF;
        END IF;

        -- Check if sender is muted by recipient
        IF p_from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM user_mutes um
                WHERE um.muter_id = recipient_id
                AND um.muted_user_id = p_from_user_id
                AND um.hide_notifications = true
                AND (um.expires_at IS NULL OR um.expires_at > NOW())
            ) INTO is_muted;
            IF is_muted THEN CONTINUE; END IF;
        END IF;

        -- Check channel/conversation mute + notification level
        IF p_channel_id IS NOT NULL OR p_conversation_id IS NOT NULL THEN
            SELECT nc.muted, nc.notification_level, nc.muted_until
            INTO is_channel_muted, v_notification_level, v_muted_until
            FROM notification_channels nc
            WHERE nc.user_id = recipient_id
            AND (
                (p_channel_id IS NOT NULL AND nc.channel_id = p_channel_id)
                OR
                (p_conversation_id IS NOT NULL AND nc.conversation_id = p_conversation_id)
            )
            LIMIT 1;

            -- Check if temporary mute has expired
            IF COALESCE(is_channel_muted, false) = true
               AND v_muted_until IS NOT NULL
               AND v_muted_until <= NOW() THEN
                is_channel_muted := false;
            END IF;

            -- Muted channel: skip everything EXCEPT mentions (Discord behavior)
            IF COALESCE(is_channel_muted, false) = true THEN
                IF NOT v_is_mention_type THEN
                    CONTINUE;
                END IF;
            END IF;

            -- Notification level enforcement (only for channels, not conversations).
            -- Fallback is 'mentions' (was 'all') so new channels notify only on
            -- @mentions by default. See 20260520_default_notification_level_mentions.sql.
            IF p_channel_id IS NOT NULL AND v_notification_level IS NULL THEN
                SELECT ss.default_message_notifications INTO v_server_default
                FROM server_settings ss
                WHERE ss.server_id = p_server_id;
                v_notification_level := COALESCE(v_server_default, 'mentions');
            END IF;

            IF v_notification_level = 'none' THEN
                CONTINUE;
            ELSIF v_notification_level = 'mentions' THEN
                IF NOT v_is_mention_type AND NOT v_is_content_feedback_type THEN
                    CONTINUE;
                END IF;
            END IF;
        END IF;

        -- View-context suppression
        IF (p_server_id IS NOT NULL AND p_channel_id IS NOT NULL) OR p_conversation_id IS NOT NULL THEN
            IF public.is_user_viewing_context(recipient_id, p_server_id, p_channel_id, p_conversation_id) THEN
                CONTINUE;
            END IF;
        END IF;

        -- Rate limit reaction notifications (sliding window: resets after 2 min of quiet)
        IF p_from_user_id IS NOT NULL AND p_notification_type IN ('reaction', 'activitypub_reaction') THEN
            INSERT INTO notification_rate_limits (user_id, notification_type, source_user_id,
                                                  notification_count, last_notification_at, suppressed_until)
            VALUES (recipient_id, p_notification_type, p_from_user_id, 1, NOW(), NULL)
            ON CONFLICT (user_id, notification_type, source_user_id)
            DO UPDATE SET
                notification_count = CASE
                    WHEN notification_rate_limits.last_notification_at < v_time_threshold
                    THEN 1
                    ELSE notification_rate_limits.notification_count + 1
                END,
                last_notification_at = NOW(),
                suppressed_until = CASE
                    WHEN notification_rate_limits.last_notification_at < v_time_threshold
                    THEN NULL
                    ELSE notification_rate_limits.suppressed_until
                END;

            SELECT
                nrl.notification_count > 3 OR
                (nrl.suppressed_until IS NOT NULL AND nrl.suppressed_until > NOW())
            INTO is_rate_limited
            FROM notification_rate_limits nrl
            WHERE nrl.user_id = recipient_id
              AND nrl.notification_type = p_notification_type
              AND nrl.source_user_id = p_from_user_id;

            IF is_rate_limited THEN
                UPDATE notification_rate_limits nrl
                SET suppressed_until = NOW() + INTERVAL '2 minutes'
                WHERE nrl.user_id = recipient_id
                  AND nrl.notification_type = p_notification_type
                  AND nrl.source_user_id = p_from_user_id;
                CONTINUE;
            END IF;
        END IF;

        -- Get user notification preferences
        user_prefs := NULL;
        BEGIN
            SELECT * INTO user_prefs FROM notification_preferences WHERE user_id = recipient_id;
        EXCEPTION
            WHEN undefined_table THEN
                user_prefs := NULL;
        END;

        should_send := true;

        IF user_prefs IS NOT NULL THEN
            IF is_activitypub_type THEN
                IF COALESCE(user_prefs.activitypub_notifications, true) = false THEN
                    should_send := false;
                ELSE
                    CASE p_notification_type
                        WHEN 'activitypub_follow' THEN
                            should_send := COALESCE(user_prefs.activitypub_follows, true);
                        WHEN 'activitypub_follow_request' THEN
                            should_send := COALESCE(user_prefs.activitypub_follow_requests, true);
                        WHEN 'activitypub_favorite' THEN
                            should_send := COALESCE(user_prefs.activitypub_favorites, true);
                        WHEN 'activitypub_reblog' THEN
                            should_send := COALESCE(user_prefs.activitypub_reblogs, true);
                        WHEN 'activitypub_mention' THEN
                            should_send := COALESCE(user_prefs.activitypub_mentions, true);
                        WHEN 'activitypub_reply' THEN
                            should_send := COALESCE(user_prefs.activitypub_replies, true);
                        WHEN 'activitypub_reaction' THEN
                            should_send := COALESCE(user_prefs.activitypub_favorites, true);
                        ELSE
                            should_send := true;
                    END CASE;
                END IF;
            ELSE
                IF COALESCE(user_prefs.desktop_notifications, true) = false THEN
                    IF p_notification_type NOT IN ('mention', 'dm') THEN
                        should_send := false;
                    END IF;
                END IF;

                IF should_send THEN
                    CASE p_notification_type
                        WHEN 'mention' THEN
                            should_send := COALESCE(user_prefs.desktop_mentions, true);
                        WHEN 'reply' THEN
                            should_send := COALESCE(user_prefs.desktop_replies, true);
                        WHEN 'dm' THEN
                            should_send := COALESCE(user_prefs.desktop_dms, true);
                        WHEN 'chat_message' THEN
                            should_send := COALESCE(user_prefs.desktop_chat_messages, true);
                        WHEN 'reaction' THEN
                            should_send := COALESCE(user_prefs.desktop_reactions, true);
                        WHEN 'voice_channel_activity' THEN
                            should_send := COALESCE(user_prefs.sound_voice_activity, true);
                        WHEN 'server_invite' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'friend_request' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'server_update' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'emoji_added' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'thread_reply' THEN
                            should_send := COALESCE(user_prefs.desktop_replies, true);
                        ELSE
                            should_send := true;
                    END CASE;
                END IF;
            END IF;

            -- DND enforcement
            IF user_prefs.dnd_enabled IS TRUE AND should_send THEN
                DECLARE
                    current_time_of_day time := current_timestamp::time;
                    dnd_start time := COALESCE(user_prefs.dnd_start_time, '22:00'::time);
                    dnd_end time := COALESCE(user_prefs.dnd_end_time, '08:00'::time);
                BEGIN
                    IF dnd_start > dnd_end THEN
                        IF current_time_of_day >= dnd_start OR current_time_of_day <= dnd_end THEN
                            should_send := false;
                        END IF;
                    ELSE
                        IF current_time_of_day >= dnd_start AND current_time_of_day <= dnd_end THEN
                            should_send := false;
                        END IF;
                    END IF;
                END;
            END IF;
        END IF;

        -- Build enhanced data
        enhanced_data := notification_data;
        IF p_server_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('server_id', p_server_id);
        END IF;
        IF p_channel_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('channel_id', p_channel_id);
        END IF;
        IF p_conversation_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('conversation_id', p_conversation_id);
        END IF;
        IF p_from_user_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('from_user_id', p_from_user_id);
        END IF;
        IF p_priority IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('priority', p_priority);
        END IF;

        IF should_send THEN
            INSERT INTO notifications (type, user_id, data, created_at)
            VALUES (p_notification_type, recipient_id, enhanced_data, current_timestamp)
            RETURNING id INTO notification_id;

            created_notification_ids := array_append(created_notification_ids, notification_id);
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$$;

COMMENT ON FUNCTION public.send_notification IS 'Send notifications to multiple users with preference checking';

-- ---------------------------------------------------------------------------
-- Function: check_encryption_policy
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_encryption_policy(p_server_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_settings public.server_encryption_settings;
    v_result JSONB;
BEGIN
    SELECT * INTO v_settings
    FROM public.server_encryption_settings
    WHERE server_id = p_server_id;
    
    -- If no settings exist, default to optional
    IF v_settings IS NULL THEN
        v_result := jsonb_build_object(
            'encryption_mode', 'optional',
            'allow_federation', true,
            'require_verified_devices', false,
            'is_encrypted', false
        );
    ELSE
        v_result := jsonb_build_object(
            'encryption_mode', v_settings.encryption_mode,
            'allow_federation', v_settings.allow_federation,
            'require_verified_devices', v_settings.require_verified_devices,
            'is_encrypted', v_settings.encryption_mode IN ('required', 'required_local_only')
        );
    END IF;
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: claim_session_share
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_session_share(p_share_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_caller uuid;
BEGIN
    -- CALLER BINDING: SECURITY DEFINER bypasses RLS, so without this an attacker
    -- could mark another user's shares claimed (DoS on key delivery). Bind to
    -- the authenticated caller and ignore a mismatched client-supplied id.
    v_caller := public.get_current_profile_id();
    IF v_caller IS NULL OR p_user_id IS DISTINCT FROM v_caller THEN
        RETURN false;
    END IF;

    UPDATE public.megolm_session_shares
    SET
        is_claimed = true,
        claimed_at = NOW()
    WHERE id = p_share_id
    AND recipient_user_id = v_caller
    AND is_claimed = false;

    RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: is_room_member
-- Server-authoritative membership check used to authorize Megolm key requests.
-- room_id may be a channel id (-> server membership) or a conversation id
-- (-> active conversation participant). Returns false for unknown/garbage ids.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id text, p_user_id uuid)
RETURNS boolean
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_room_uuid uuid;
    v_server_id uuid;
BEGIN
    IF p_room_id IS NULL OR p_user_id IS NULL THEN
        RETURN false;
    END IF;

    BEGIN
        v_room_uuid := p_room_id::uuid;
    EXCEPTION WHEN others THEN
        RETURN false;
    END;

    -- Channel? Resolve to server and check server membership.
    SELECT server_id INTO v_server_id FROM public.channels WHERE id = v_room_uuid;
    IF v_server_id IS NOT NULL THEN
        RETURN EXISTS (
            SELECT 1 FROM public.user_servers
            WHERE server_id = v_server_id AND user_id = p_user_id
        );
    END IF;

    -- Otherwise treat as a conversation (DM / group DM).
    RETURN EXISTS (
        SELECT 1 FROM public.conversation_participants
        WHERE conversation_id = v_room_uuid
          AND user_id = p_user_id
          AND left_at IS NULL
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_room_member(text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Function: bump_room_epoch
-- Increment a room's membership epoch. Forces clients to rotate to a new
-- Megolm session for that room (so post-change messages use a fresh key).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_room_epoch(p_room_id text, p_reason text DEFAULT 'manual_rotate')
RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_epoch integer;
BEGIN
    IF p_room_id IS NULL THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.room_epoch_state (room_id, current_epoch, reason, updated_at)
    VALUES (p_room_id, 2, p_reason, now())
    ON CONFLICT (room_id) DO UPDATE
        SET current_epoch = public.room_epoch_state.current_epoch + 1,
            reason = EXCLUDED.reason,
            updated_at = now()
    RETURNING current_epoch INTO v_epoch;

    RETURN v_epoch;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_room_epoch
-- Current epoch for a room (1 if never bumped).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_room_epoch(p_room_id text)
RETURNS integer
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $$
    SELECT COALESCE(
        (SELECT current_epoch FROM public.room_epoch_state WHERE room_id = p_room_id),
        1
    );
$$;

-- bump_room_epoch is privileged: it's reused by membership-change triggers
-- (incl. member_leave, where the actor is no longer a room member), so it can't
-- carry a membership check itself. Revoke direct client access and expose a
-- guarded wrapper (request_room_epoch_bump) for manual client rotation.
-- Revoke from PUBLIC (not just authenticated): CREATE FUNCTION grants EXECUTE to
-- PUBLIC by default, so a bare authenticated revoke would leave it reachable.
REVOKE EXECUTE ON FUNCTION public.bump_room_epoch(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bump_room_epoch(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_room_epoch(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_room_epoch(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Function: request_room_epoch_bump
-- Client-facing, membership-gated wrapper around bump_room_epoch. Prevents any
-- authenticated user from forcing key rotation on rooms they don't belong to.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_room_epoch_bump(p_room_id text, p_reason text DEFAULT 'manual_rotate')
RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
BEGIN
    IF p_room_id IS NULL THEN
        RETURN NULL;
    END IF;
    IF NOT public.is_room_member(p_room_id, public.get_current_profile_id()) THEN
        RAISE EXCEPTION 'Permission denied: not a member of this room'
            USING ERRCODE = '42501';
    END IF;
    RETURN public.bump_room_epoch(p_room_id, p_reason);
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_room_epoch_bump(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Function: approve_device_request
-- Server-enforced device approval. Direct UPDATEs to device_approval_requests
-- are blocked by RLS (no client UPDATE policy); approval MUST go through this
-- RPC so the server can verify the approving device is an ESTABLISHED one.
-- A freshly-logged-in (potentially attacker) device cannot approve itself:
-- the approver device must predate the request, or already carry recovery/
-- verified trust. On success the requesting device is elevated to 'verified'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_device_request(
    p_request_id uuid,
    p_approver_device_id text,
    p_encrypted_sync_bundle text DEFAULT NULL
)
RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_caller uuid;
    v_req record;
    v_approver record;
BEGIN
    v_caller := public.get_current_profile_id();
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_req FROM public.device_approval_requests
    WHERE id = p_request_id;
    IF v_req IS NULL OR v_req.user_id IS DISTINCT FROM v_caller THEN
        RAISE EXCEPTION 'Approval request not found' USING ERRCODE = '42501';
    END IF;
    IF v_req.status <> 'pending' THEN
        RETURN false; -- already resolved
    END IF;
    IF p_approver_device_id IS NULL OR p_approver_device_id = v_req.requesting_device_id THEN
        RAISE EXCEPTION 'A device cannot approve its own login' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_approver FROM public.user_devices
    WHERE user_id = v_caller AND device_id = p_approver_device_id;
    IF v_approver IS NULL OR v_approver.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Approving device is not a valid device on this account'
            USING ERRCODE = '42501';
    END IF;

    -- The approver must be an ESTABLISHED device: registered before this request
    -- (small skew tolerance) OR already trusted at recovery/verified level.
    IF NOT (
        v_approver.trust_state IN ('verified', 'recovery')
        OR v_approver.created_at <= v_req.created_at - interval '5 seconds'
    ) THEN
        RAISE EXCEPTION 'Only an established device can approve a new login'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.device_approval_requests
    SET status = 'approved',
        approved_by_device_id = p_approver_device_id,
        encrypted_sync_bundle = p_encrypted_sync_bundle,
        resolved_at = now()
    WHERE id = p_request_id;

    -- Elevate the newly-approved device.
    UPDATE public.user_devices
    SET trust_state = 'verified'
    WHERE user_id = v_caller AND device_id = v_req.requesting_device_id;

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_device_request(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Function: deny_device_request
-- Deny/secure a pending login. Any device on the account may deny (securing
-- the account is always allowed). Also revokes the requesting device row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deny_device_request(p_request_id uuid)
RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_caller uuid;
    v_req record;
BEGIN
    v_caller := public.get_current_profile_id();
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_req FROM public.device_approval_requests
    WHERE id = p_request_id;
    IF v_req IS NULL OR v_req.user_id IS DISTINCT FROM v_caller THEN
        RAISE EXCEPTION 'Approval request not found' USING ERRCODE = '42501';
    END IF;

    UPDATE public.device_approval_requests
    SET status = 'denied', resolved_at = now()
    WHERE id = p_request_id AND status = 'pending';

    -- Defense in depth: a denied login should not keep a usable device row.
    UPDATE public.user_devices
    SET trust_state = 'revoked', revoked_at = now()
    WHERE user_id = v_caller AND device_id = v_req.requesting_device_id;

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.deny_device_request(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Function: bump_server_channel_epochs
-- Bump the epoch of every channel in a server (used on server membership
-- changes, which affect all channels at once).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_server_channel_epochs(p_server_id uuid, p_reason text)
RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_channel RECORD;
BEGIN
    FOR v_channel IN SELECT id FROM public.channels WHERE server_id = p_server_id LOOP
        PERFORM public.bump_room_epoch(v_channel.id::text, p_reason);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trigger fn: epoch bump on conversation membership change
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_conversation_epoch_bump()
RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.bump_room_epoch(NEW.conversation_id::text, 'member_join');
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.bump_room_epoch(OLD.conversation_id::text, 'member_leave');
    ELSIF TG_OP = 'UPDATE' AND OLD.left_at IS NULL AND NEW.left_at IS NOT NULL THEN
        PERFORM public.bump_room_epoch(NEW.conversation_id::text, 'member_leave');
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trigger fn: epoch bump on server membership change (affects all channels)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_server_epoch_bump()
RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.bump_server_channel_epochs(NEW.server_id, 'member_join');
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.bump_server_channel_epochs(OLD.server_id, 'member_leave');
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: convert_jsonb_to_ap
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_jsonb_to_ap(content jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    content_part JSONB;
    html_content TEXT := '';
    part_type TEXT;
    part_text TEXT;
    part_url TEXT;
    part_shortcode TEXT;
    -- Variables for mention handling
    mention_username TEXT;
    mention_domain TEXT;
    mention_href TEXT;
    mention_text TEXT;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL THEN
        RETURN '';
    END IF;
    
    -- Handle string content (legacy format)
    IF jsonb_typeof(content) = 'string' THEN
        RETURN content #>> '{}';
    END IF;
    
    -- Get current instance domain for local mention detection
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    -- Handle array content (your universal format)
    IF jsonb_typeof(content) = 'array' THEN
        FOR content_part IN SELECT jsonb_array_elements(content)
        LOOP
            part_type := content_part->>'type';
            
            CASE part_type
                WHEN 'text' THEN
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        -- Escape HTML entities in text content for safety
                        part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || part_text;
                    END IF;
                    
                WHEN 'mention' THEN
                    -- Extract mention data from your universal format
                    mention_username := content_part->>'username';
                    mention_domain := content_part->>'domain';
                    
                    IF mention_username IS NOT NULL THEN
                        -- Always build full mention format for federation compatibility
                        IF mention_domain IS NOT NULL THEN
                            -- Use provided domain
                            mention_href := 'https://' || mention_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || mention_domain;
                        ELSE
                            -- Fallback to current instance domain for local users
                            mention_href := 'https://' || current_instance_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || current_instance_domain;
                        END IF;
                        
                        -- Create the HTML mention link
                        html_content := html_content || format('<a href="%s" class="mention">%s</a>', 
                            mention_href, mention_text);
                    END IF;
                    
                WHEN 'emoji' THEN
                    -- Handle custom emojis - use shortcode format for ActivityPub compatibility
                    part_shortcode := content_part->'emoji'->>'name';
                    
                    IF part_shortcode IS NOT NULL THEN
                        -- Always render as shortcode - emoji metadata goes in ActivityPub tags
                        html_content := html_content || ':' || part_shortcode || ':';
                    END IF;
                    
                WHEN 'file' THEN
                    -- Files should not be inline in ActivityPub content (handled as attachments)
                    CONTINUE;
                    
                WHEN 'url' THEN
                    -- Handle URLs
                    part_url := content_part->>'url';
                    IF part_url IS NOT NULL THEN
                        -- Escape URL for safety and create link
                        part_url := replace(replace(replace(part_url, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || format('<a href="%s" rel="noopener noreferrer" target="_blank">%s</a>', 
                            part_url, part_url);
                    END IF;
                    
                ELSE
                    -- Unknown type, try to extract text and escape it
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || part_text;
                    END IF;
            END CASE;
        END LOOP;
        
        RETURN html_content;
    END IF;
    
    -- Fallback: convert to text and escape
    part_text := content::TEXT;
    part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    RETURN part_text;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: create_federated_profile
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_activitypub_conversation_context
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_activitypub_conversation_root
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_root(post_id uuid) RETURNS TABLE(root_id uuid)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  current_id uuid := post_id;
  parent_id uuid;
  max_depth int := 100; -- Prevent infinite loops
  depth int := 0;
BEGIN
  LOOP
    -- Get the parent post ID
    SELECT in_reply_to INTO parent_id
    FROM public.posts
    WHERE id = current_id;
    
    -- If no parent, we've found the root
    IF parent_id IS NULL THEN
      RETURN QUERY SELECT current_id;
      RETURN;
    END IF;
    
    -- Move to parent
    current_id := parent_id;
    depth := depth + 1;
    
    -- Safety check
    IF depth >= max_depth THEN
      RETURN QUERY SELECT current_id;
      RETURN;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_activitypub_conversation_thread
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_batch_post_emoji_reactions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_batch_post_emoji_reactions(p_post_ids uuid[], p_user_limit integer DEFAULT 5) RETURNS TABLE(post_id uuid, emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    current_profile_id uuid;
BEGIN
    -- FIXED: Use get_current_profile_id() instead of auth.uid()
    -- post_interactions.user_id stores PROFILE IDs, not auth user IDs
    current_profile_id := public.get_current_profile_id();
    
    RETURN QUERY
    SELECT 
        pi.post_id,
        pi.emoji_id,
        e.name::text as emoji_name,
        -- Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = pi.post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- FIXED: Check if current user has reacted using PROFILE ID
        CASE 
            WHEN current_profile_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = pi.post_id
                  AND check_pi.user_id = current_profile_id  -- FIXED: was auth.uid()
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = ANY(p_post_ids)
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY pi.post_id, MIN(pi.created_at) ASC;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_conversation_encryption_status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_conversation_encryption_status(p_conversation_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_settings public.conversation_encryption_settings;
    v_all_users_encrypted BOOLEAN;
    v_participant_ids UUID[];
    v_result JSONB;
BEGIN
    -- Get conversation encryption settings
    SELECT * INTO v_settings
    FROM public.conversation_encryption_settings
    WHERE conversation_id = p_conversation_id;
    
    -- Get all participant IDs
    SELECT ARRAY_AGG(user_id) INTO v_participant_ids
    FROM public.conversation_participants
    WHERE conversation_id = p_conversation_id;
    
    -- Check if all participants have encryption enabled
    SELECT bool_and(public.user_has_encryption(user_id)) INTO v_all_users_encrypted
    FROM unnest(v_participant_ids) as user_id;
    
    v_result := jsonb_build_object(
        'conversation_id', p_conversation_id,
        'encryption_enabled', COALESCE(v_settings.encryption_enabled, false),
        'verified', COALESCE(v_settings.verified, false),
        'all_users_have_keys', COALESCE(v_all_users_encrypted, false),
        'participant_count', COALESCE(array_length(v_participant_ids, 1), 0),
        'can_enable_encryption', COALESCE(v_all_users_encrypted, false)
    );
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_conversation_thread
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_conversation_thread(p_conversation_id text, p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  root_post jsonb;
  thread_posts jsonb;
  reply_count integer;
  participant_count integer;
  last_updated timestamptz;
BEGIN
  -- Get the root post (the one that started the conversation)
  SELECT to_jsonb(tp.*) INTO root_post
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id
    AND tp.reply_context IS NULL
  ORDER BY tp.created_at ASC
  LIMIT 1;
  
  -- Get all posts in the conversation with user interaction state
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', tp.id,
      'content', tp.content,
      'author', tp.author,
      'created_at', tp.created_at,
      'reply_context', tp.reply_context,
      'replies_count', tp.replies_count,
      'reblogs_count', tp.reblogs_count,
      'favorites_count', tp.favorites_count,
      'is_favorited', COALESCE(fav.user_id IS NOT NULL, false),
      'is_reblogged', COALESCE(reb.user_id IS NOT NULL, false),
      'is_bookmarked', COALESCE(book.user_id IS NOT NULL, false)
    ) ORDER BY tp.created_at ASC
  ) INTO thread_posts
  FROM timeline_posts tp
  LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = p_user_id AND fav.interaction_type IN ('favorite', 'emoji_reaction')
  LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
    AND reb.user_id = p_user_id AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON tp.id = book.post_id 
    AND book.user_id = p_user_id AND book.interaction_type = 'bookmark'
  WHERE tp.conversation_id = p_conversation_id;
  
  -- Get conversation stats
  SELECT 
    COUNT(*) - 1, -- Subtract 1 for root post
    COUNT(DISTINCT tp.author_id),
    MAX(tp.created_at)
  INTO reply_count, participant_count, last_updated
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id;
  
  RETURN jsonb_build_object(
    'root_post', root_post,
    'posts', COALESCE(thread_posts, '[]'::jsonb),
    'reply_count', COALESCE(reply_count, 0),
    'participant_count', COALESCE(participant_count, 0),
    'last_updated', last_updated
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_emoji_usage_analytics
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_enhanced_timeline_posts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text DEFAULT 'home'::text, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, reply_context jsonb, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, is_deleted boolean, deleted_at timestamp with time zone, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean, reblog jsonb, reblog_author jsonb)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        tp.id::TEXT,
        tp.created_at,
        tp.updated_at,
        tp.content,
        tp.content_warning,
        'en'::TEXT as language,
        (tp.author->>'id')::TEXT as author_id,
        p.ap_id::TEXT,
        COALESCE(p.ap_type, 'Note')::TEXT as ap_type,
        tp.url,
        tp.reply_context,
        tp.conversation_id::TEXT,
        tp.visibility,
        (tp.author->>'is_local')::BOOLEAN as is_local,
        NOT (tp.author->>'is_local')::BOOLEAN as is_federated,
        tp.replies_count,
        tp.reblogs_count,
        tp.favorites_count,
        tp.media_attachments,
        COALESCE(p.metadata, '{}'::JSONB) as metadata,
        tp.is_sensitive,
        COALESCE(p.is_deleted, false) as is_deleted,
        p.deleted_at,
        tp.author,
        
        -- User interaction states
        COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
        COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
        COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked,
        
        -- Reblog fields
        tp.reblog,
        tp.reblog_author
        
    FROM timeline_posts tp
    JOIN posts p ON tp.id = p.id
    LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
        AND fav.user_id = p_user_id 
        AND fav.interaction_type IN ('favorite', 'emoji_reaction')
    LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
        AND reb.user_id = p_user_id 
        AND reb.interaction_type = 'reblog'
    LEFT JOIN post_interactions book ON tp.id = book.post_id 
        AND book.user_id = p_user_id 
        AND book.interaction_type = 'bookmark'
    
    WHERE 
        CASE 
            -- HOME: Use timeline_entries for proper following logic
            WHEN p_timeline_type = 'home' THEN 
                EXISTS (
                    SELECT 1 FROM timeline_entries te 
                    WHERE te.user_id = p_user_id 
                      AND te.post_id = tp.id 
                      AND te.timeline_type = 'home'
                )
            
            -- LOCAL: Only public posts from local users
            WHEN p_timeline_type = 'local' THEN 
                tp.visibility = 'public' 
                AND (tp.author->>'is_local')::BOOLEAN = true
            
            -- PUBLIC/FEDERATED: All public posts (local + remote) - standard ActivityPub timeline
            WHEN p_timeline_type IN ('public', 'federated') THEN 
                tp.visibility = 'public'
                
            ELSE tp.visibility = 'public'
        END
        
        -- Hide silenced users from public/local/federated timelines (keep on home)
        AND (
            p_timeline_type = 'home'
            OR NOT EXISTS (
                SELECT 1 FROM profiles spr
                WHERE spr.id = tp.author_id
                  AND spr.is_silenced = true
            )
        )
        
        -- Pagination
        AND (p_max_id IS NULL OR tp.created_at < (
            SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::UUID
        ))
    
    ORDER BY tp.created_at DESC
    LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_federated_timeline
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_federated_timeline(p_user_id uuid, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean)
    LANGUAGE plpgsql STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id::TEXT,
        p.created_at,
        p.updated_at,
        p.content,
        p.content_warning,
        p.language,
        p.author_id::TEXT,
        p.ap_id,
        p.ap_type,
        p.url,
        p.conversation_id::TEXT,
        p.visibility,
        p.is_local,
        p.is_federated,
        COALESCE(p.replies_count, 0)::INTEGER,
        COALESCE(p.reblogs_count, 0)::INTEGER,
        COALESCE(p.favorites_count, 0)::INTEGER,
        COALESCE(p.media_attachments, '[]'::jsonb),
        COALESCE(p.metadata, '{}'::jsonb),
        COALESCE(p.is_sensitive, false),
        -- Author object
        jsonb_build_object(
            'id', pr.id,
            'username', pr.username,
            'display_name', pr.display_name,
            'avatar_url', pr.avatar_url,
            'domain', COALESCE(pr.domain, 'har.mony.lol'),
            'handle', CASE 
                WHEN COALESCE(pr.is_local, true) THEN '@' || pr.username
                ELSE '@' || pr.username || '@' || pr.domain
            END,
            'is_local', COALESCE(pr.is_local, true),
            'bio', pr.bio,
            'color', pr.color
        ) AS author,
        -- User interaction states
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type IN ('favorite', 'emoji_reaction')
        ) AS is_favorited,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type = 'reblog'
        ) AS is_reblogged,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type = 'bookmark'
        ) AS is_bookmarked
        
    FROM posts p
    INNER JOIN profiles pr ON p.author_id = pr.id
    
    WHERE 
        -- Remote posts only (federated content from other instances)
        p.is_local = false
        -- Public visibility only
        AND p.visibility = 'public'
        -- Not deleted (check both fields for safety)
        AND (p.is_deleted = false OR p.is_deleted IS NULL)
        AND p.deleted_at IS NULL
        -- Not from suspended or silenced users
        AND (pr.is_suspended = false OR pr.is_suspended IS NULL)
        AND (pr.is_silenced = false OR pr.is_silenced IS NULL)
        -- Top-level posts only (not replies)
        AND p.in_reply_to IS NULL
        -- Pagination
        AND (p_max_id IS NULL OR p.created_at < (
            SELECT p2.created_at FROM posts p2 WHERE p2.id::TEXT = p_max_id
        ))
    
    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_instance_domain
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_instance_domain() RETURNS text
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    domain_value text;
BEGIN
    -- Get domain from instance_config
    SELECT trim(both '"' from config_value::text) INTO domain_value
    FROM instance_config 
    WHERE config_key = 'domain';
    
    -- Return domain or fallback
    RETURN COALESCE(domain_value, 'localhost');
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_most_used_emojis
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_post_emoji_reactions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_post_emoji_reactions(p_post_id uuid, p_user_limit integer DEFAULT 5) RETURNS TABLE(emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    current_profile_id uuid;
BEGIN
    -- FIXED: Use get_current_profile_id() instead of auth.uid()
    -- post_interactions.user_id stores PROFILE IDs, not auth user IDs
    current_profile_id := public.get_current_profile_id();
    
    RETURN QUERY
    SELECT 
        pi.emoji_id,
        e.name::text as emoji_name,
        -- Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Only include limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = p_post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- FIXED: Check if current user has reacted using PROFILE ID
        CASE 
            WHEN current_profile_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = p_post_id
                  AND check_pi.user_id = current_profile_id  -- FIXED: was auth.uid()
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = p_post_id 
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY MIN(pi.created_at) ASC;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_post_with_context
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_post_with_context(p_post_id uuid, p_user_id uuid, p_context_type text DEFAULT 'minimal'::text, p_highlight_reply uuid DEFAULT NULL::uuid, p_max_depth integer DEFAULT 10, p_include_interactions boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_main_post JSONB;
  v_ancestors JSONB := '[]'::jsonb;
  v_descendants JSONB := '[]'::jsonb;
  v_thread_info JSONB;
  v_thread_id UUID;
  v_root_post_id UUID;
  v_total_posts INTEGER := 1;
  v_participant_count INTEGER := 1;
  v_max_depth INTEGER := 0;
  v_last_activity TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Get the main post with all required fields and user interaction states
  SELECT to_jsonb(post_data) INTO v_main_post
  FROM (
    SELECT 
      p.*,
      profiles.id as author_id,
      profiles.username as author_username,
      profiles.display_name as author_display_name,
      profiles.avatar_url as author_avatar_url,
      profiles.domain as author_domain,
      profiles.bio as author_bio,
      profiles.is_local as author_is_local,
      profiles.followers_count as author_followers_count,
      profiles.following_count as author_following_count,
      profiles.posts_count as author_posts_count,
      profiles.created_at as author_created_at,
      profiles.updated_at as author_updated_at,
      -- Generate handle from username and domain
      CASE 
        WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
          '@' || profiles.username || '@' || profiles.domain
        ELSE 
          '@' || profiles.username
      END as author_handle,
      -- User interaction states (only if p_include_interactions is true)
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type IN ('favorite', 'emoji_reaction'))
        ELSE false
      END as is_favorited,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'reblog')
        ELSE false
      END as is_reblogged,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'bookmark')
        ELSE false
      END as is_bookmarked,
      -- Author object for nested structure
      jsonb_build_object(
        'id', profiles.id,
        'username', profiles.username,
        'display_name', profiles.display_name,
        'avatar_url', profiles.avatar_url,
        'domain', profiles.domain,
        'bio', profiles.bio,
        'is_local', profiles.is_local,
        'followers_count', profiles.followers_count,
        'following_count', profiles.following_count,
        'posts_count', profiles.posts_count,
        'created_at', profiles.created_at,
        'updated_at', profiles.updated_at,
        'handle', CASE 
          WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
            '@' || profiles.username || '@' || profiles.domain
          ELSE 
            '@' || profiles.username
        END
      ) as author
    FROM posts p
    JOIN profiles ON profiles.id = p.author_id
    WHERE p.id = p_post_id
      AND p.is_deleted = false
  ) as post_data;

  -- If main post not found, return error
  IF v_main_post IS NULL THEN
    RETURN jsonb_build_object('error', 'Post not found');
  END IF;

  -- Get thread_id for thread context (may be null, that's ok)
  SELECT conversation_id INTO v_thread_id 
  FROM posts 
  WHERE id = p_post_id;

  -- For non-minimal contexts, get thread data
  IF p_context_type != 'minimal' THEN
    -- Find root post of the thread by following in_reply_to chain upward
    WITH RECURSIVE thread_root AS (
      -- Base case: start with the current post
      SELECT id, in_reply_to, 0 as depth
      FROM posts 
      WHERE id = p_post_id
      
      UNION ALL
      
      -- Recursive case: follow in_reply_to chain upward
      SELECT p.id, p.in_reply_to, tr.depth + 1
      FROM posts p
      JOIN thread_root tr ON p.id = tr.in_reply_to
      WHERE tr.depth < 50 -- Prevent infinite recursion
    )
    SELECT id INTO v_root_post_id 
    FROM thread_root 
    WHERE in_reply_to IS NULL
    ORDER BY depth DESC 
    LIMIT 1;

    -- If no root found, current post is the root
    IF v_root_post_id IS NULL THEN
      v_root_post_id := p_post_id;
    END IF;

    -- Get thread statistics using the conversation_root_id chain instead of conversation_id
    WITH RECURSIVE all_thread_posts AS (
      -- Start from the root post
      SELECT id, in_reply_to, author_id, created_at, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      -- Get all posts that are replies in this thread
      SELECT p.id, p.in_reply_to, p.author_id, p.created_at, atp.depth + 1
      FROM posts p
      JOIN all_thread_posts atp ON p.in_reply_to = atp.id
      WHERE atp.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT 
      COUNT(DISTINCT id),
      COUNT(DISTINCT author_id),
      MAX(created_at)
    INTO v_total_posts, v_participant_count, v_last_activity
    FROM all_thread_posts;

    -- Get ancestors (posts this is replying to) if requested
    IF p_context_type IN ('thread', 'ancestors') THEN
      WITH RECURSIVE ancestors AS (
        -- Base case: direct parent
        SELECT p.*, 0 as depth
        FROM posts p
        WHERE p.id = (SELECT in_reply_to FROM posts WHERE id = p_post_id)
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow the reply chain upward
        SELECT p.*, a.depth + 1
        FROM posts p
        JOIN ancestors a ON p.id = (SELECT in_reply_to FROM posts WHERE id = a.id)
        WHERE a.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'created_at', a.created_at,
          'updated_at', a.updated_at,
          'content', a.content,
          'content_warning', a.content_warning,
          'language', a.language,
          'author_id', a.author_id,
          'ap_id', a.ap_id,
          'ap_type', a.ap_type,
          'url', a.url,
          'conversation_id', a.conversation_id,
          'visibility', a.visibility,
          'is_local', a.is_local,
          'is_federated', a.is_federated,
          'replies_count', a.replies_count,
          'reblogs_count', a.reblogs_count,
          'favorites_count', a.favorites_count,
          'media_attachments', a.media_attachments,
          'metadata', a.metadata,
          'is_sensitive', a.is_sensitive,
          'is_deleted', a.is_deleted,
          'deleted_at', a.deleted_at,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type IN ('favorite', 'emoji_reaction'))
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY a.depth DESC -- Oldest ancestor first
      ) INTO v_ancestors
      FROM ancestors a
      JOIN profiles ON profiles.id = a.author_id;
    END IF;

    -- Get descendants (replies to this post) if requested
    IF p_context_type IN ('thread', 'descendants') THEN
      WITH RECURSIVE descendants AS (
        -- Base case: direct replies
        SELECT p.*, 0 as depth, ARRAY[p.created_at::text, p.id::text] as sort_path
        FROM posts p
        WHERE p.in_reply_to = p_post_id
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow reply chains downward
        SELECT p.*, d.depth + 1, d.sort_path || ARRAY[p.created_at::text, p.id::text]
        FROM posts p
        JOIN descendants d ON p.in_reply_to = d.id
        WHERE d.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'created_at', d.created_at,
          'updated_at', d.updated_at,
          'content', d.content,
          'content_warning', d.content_warning,
          'language', d.language,
          'author_id', d.author_id,
          'ap_id', d.ap_id,
          'ap_type', d.ap_type,
          'url', d.url,
          'conversation_id', d.conversation_id,
          'visibility', d.visibility,
          'is_local', d.is_local,
          'is_federated', d.is_federated,
          'replies_count', d.replies_count,
          'reblogs_count', d.reblogs_count,
          'favorites_count', d.favorites_count,
          'media_attachments', d.media_attachments,
          'metadata', d.metadata,
          'is_sensitive', d.is_sensitive,
          'is_deleted', d.is_deleted,
          'deleted_at', d.deleted_at,
          'depth', d.depth,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type IN ('favorite', 'emoji_reaction'))
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY d.sort_path -- Chronological order preserving thread structure
      ) INTO v_descendants
      FROM descendants d
      JOIN profiles ON profiles.id = d.author_id;
    END IF;

    -- Calculate max depth for thread info using reply chain instead of conversation_id
    WITH RECURSIVE depth_calc AS (
      SELECT id, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      SELECT p.id, dc.depth + 1
      FROM posts p
      JOIN depth_calc dc ON p.in_reply_to = dc.id
      WHERE dc.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT COALESCE(MAX(depth), 0) INTO v_max_depth
    FROM depth_calc;
  END IF;

  -- Build thread info
  v_thread_info := jsonb_build_object(
    'totalPosts', COALESCE(v_total_posts, 1),
    'participantCount', COALESCE(v_participant_count, 1),
    'depth', COALESCE(v_max_depth, 0),
    'rootPostId', COALESCE(v_root_post_id, p_post_id),
    'lastActivity', COALESCE(v_last_activity, (v_main_post->>'created_at')::timestamp with time zone)
  );

  -- Return the complete result
  RETURN jsonb_build_object(
    'mainPost', v_main_post,
    'ancestors', COALESCE(v_ancestors, '[]'::jsonb),
    'descendants', COALESCE(v_descendants, '[]'::jsonb),
    'threadInfo', v_thread_info
  );

EXCEPTION WHEN OTHERS THEN
  -- Log error and return structured error response
  RAISE LOG 'Error in get_post_with_context: %', SQLERRM;
  RETURN jsonb_build_object(
    'error', 'Database error: ' || SQLERRM,
    'mainPost', null,
    'ancestors', '[]'::jsonb,
    'descendants', '[]'::jsonb,
    'threadInfo', jsonb_build_object(
      'totalPosts', 0,
      'participantCount', 0,
      'depth', 0,
      'rootPostId', null,
      'lastActivity', null
    )
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_unclaimed_session_shares
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_unclaimed_session_shares(p_user_id uuid) RETURNS TABLE(share_id uuid, room_id text, session_id text, sender_user_id uuid, encrypted_session_key text, first_known_index integer, created_at timestamp with time zone)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_caller uuid;
BEGIN
    -- CALLER BINDING: only return the authenticated caller's own pending shares,
    -- regardless of the client-supplied p_user_id (SECURITY DEFINER bypasses RLS).
    v_caller := public.get_current_profile_id();
    IF v_caller IS NULL OR p_user_id IS DISTINCT FROM v_caller THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT 
        s.id as share_id,
        s.room_id,
        s.session_id,
        s.sender_user_id,
        s.encrypted_session_key,
        s.first_known_index,
        s.created_at
    FROM public.megolm_session_shares s
    WHERE s.recipient_user_id = v_caller
    AND s.is_claimed = false
    ORDER BY s.created_at DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_user_emoji_stats
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_user_handle
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_handle(p_user_id uuid) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT username || '@' || domain
  FROM profiles
  WHERE id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_user_notifications
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_notifications(p_user_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_unread_only boolean DEFAULT false, p_notification_types character varying[] DEFAULT NULL::character varying[]) RETURNS TABLE(id uuid, user_id uuid, type character varying, data jsonb, is_read boolean, is_clicked boolean, created_at timestamp with time zone, updated_at timestamp with time zone, expires_at timestamp with time zone, read_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        n.id,
        n.user_id,
        n.type,
        n.data,
        n.is_read,
        n.is_clicked,
        n.created_at,
        n.updated_at,
        n.expires_at,
        n.read_at
    FROM notifications n
    WHERE n.user_id = p_user_id
    AND (NOT p_unread_only OR n.is_read = FALSE)
    AND (p_notification_types IS NULL OR n.type = ANY(p_notification_types))
    
    -- Filter out notifications from blocked users
    -- Extract sender ID from various possible JSONB structures
    AND NOT EXISTS (
        SELECT 1 
        FROM user_blocks ub
        WHERE ub.blocker_id = p_user_id
        AND ub.blocked_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
    )
    
    -- Filter out notifications from muted users (notifications_only or all)
    AND NOT EXISTS (
        SELECT 1 
        FROM user_mutes um
        WHERE um.muter_id = p_user_id
        AND um.muted_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND um.hide_notifications = true
        AND (um.expires_at IS NULL OR um.expires_at > NOW())
    )
    
    -- Filter out notifications from muted channels/conversations
    AND NOT EXISTS (
        SELECT 1 
        FROM notification_channels nc
        WHERE nc.user_id = p_user_id
        AND nc.muted = true
        AND (
            (nc.channel_id IS NOT NULL AND nc.channel_id = COALESCE(
                NULLIF((n.data->>'channel_id'), '')::uuid,
                NULLIF((n.data->'location'->>'channel_id'), '')::uuid
            ))
            OR
            (nc.conversation_id IS NOT NULL AND nc.conversation_id = COALESCE(
                NULLIF((n.data->>'conversation_id'), '')::uuid,
                NULLIF((n.data->'conversation'->>'id'), '')::uuid
            ))
        )
        AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
    )
    
    ORDER BY n.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_user_permissions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_permissions(
    p_user_id uuid,
    p_server_id uuid,
    p_channel_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_owner boolean;
    v_base_mask bigint := 0;
    v_allow_mask bigint := 0;
    v_deny_mask bigint := 0;
    v_final_mask bigint;
    v_role record;
    v_override record;
    v_result jsonb := '{}'::jsonb;
    v_bit_map jsonb := '[
        "ADMINISTRATOR","VIEW_CHANNEL","MANAGE_CHANNELS","MANAGE_ROLES",
        "MANAGE_EMOJIS","VIEW_AUDIT_LOG","MANAGE_WEBHOOKS","MANAGE_SERVER",
        "CREATE_INVITE","KICK_MEMBERS","BAN_MEMBERS","TIMEOUT_MEMBERS",
        "SEND_MESSAGES","SEND_MESSAGES_IN_THREADS","CREATE_PUBLIC_THREADS","CREATE_PRIVATE_THREADS",
        "EMBED_LINKS","ATTACH_FILES","ADD_REACTIONS","USE_EXTERNAL_EMOJIS",
        "MENTION_EVERYONE","MANAGE_MESSAGES","READ_MESSAGE_HISTORY","PIN_MESSAGES",
        "CONNECT","SPEAK","STREAM","MUTE_MEMBERS","DEAFEN_MEMBERS","MOVE_MEMBERS"
    ]'::jsonb;
    v_i int;
    v_perm_name text;
BEGIN
    SELECT (owner = p_user_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;

    -- Server owner gets all permissions
    IF v_is_owner THEN
        FOR v_i IN 0..29 LOOP
            v_perm_name := v_bit_map->>v_i;
            IF v_perm_name IS NOT NULL THEN
                v_result := v_result || jsonb_build_object(v_perm_name, true);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

    -- Start with @everyone role
    SELECT COALESCE(permissions, 0) INTO v_base_mask
    FROM public.server_roles
    WHERE server_id = p_server_id AND is_default = true;

    v_base_mask := COALESCE(v_base_mask, 0);

    -- Merge all user's roles (OR the bitmasks)
    FOR v_role IN
        SELECT sr.permissions
        FROM public.user_roles ur
        JOIN public.server_roles sr ON ur.role_id = sr.id
        WHERE ur.user_id = p_user_id AND ur.server_id = p_server_id
    LOOP
        v_base_mask := v_base_mask | COALESCE(v_role.permissions, 0);
    END LOOP;

    -- ADMINISTRATOR bit (0) grants everything
    IF (v_base_mask & 1) != 0 THEN
        FOR v_i IN 0..29 LOOP
            v_perm_name := v_bit_map->>v_i;
            IF v_perm_name IS NOT NULL THEN
                v_result := v_result || jsonb_build_object(v_perm_name, true);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

    -- =====================================================================
    -- Channel permission overrides - DISCORD-STYLE LAYERED PRECEDENCE
    -- =====================================================================
    -- Reference: https://discord.com/developers/docs/topics/permissions
    --
    -- The previous implementation OR'd all allows + all denies into one
    -- mask, which broke the common "deny @everyone in #announcements, allow
    -- @mods to still send" pattern: the @everyone DENY would erase the
    -- @mods ALLOW because they were combined before being applied.
    --
    -- Discord's actual order is:
    --   1) Start with base = merged server-role permissions (computed above)
    --   2) Apply @everyone channel override: clear deny, then set allow
    --   3) Apply COMBINED non-everyone role channel overrides: clear all
    --      role-denies, then set all role-allows  (any role allow > role deny)
    --   4) Apply user-specific channel override: clear deny, then set allow
    --
    -- Each layer's ALLOW comes after its DENY, and a higher layer always
    -- wins over a lower layer. This matches Discord exactly and is what
    -- the rest of the app (frontend gating, role docs) assumes.
    -- =====================================================================
    v_final_mask := v_base_mask;

    IF p_channel_id IS NOT NULL THEN
        DECLARE
            v_everyone_role_id uuid;
            v_everyone_allow bigint := 0;
            v_everyone_deny  bigint := 0;
            v_role_allow     bigint := 0;
            v_role_deny      bigint := 0;
            v_user_allow     bigint := 0;
            v_user_deny      bigint := 0;
        BEGIN
            -- Resolve @everyone role id for this server (single lookup).
            SELECT id INTO v_everyone_role_id
              FROM public.server_roles
             WHERE server_id = p_server_id AND is_default = true
             LIMIT 1;

            -- Pull ALL overrides for this channel that could apply to this
            -- user, then partition into the three layers below in a single
            -- pass. We over-fetch a little so we only hit the table once.
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

            -- Layer 2: @everyone channel override
            v_final_mask := (v_final_mask & ~v_everyone_deny) | v_everyone_allow;
            -- Layer 3: combined non-everyone role overrides
            v_final_mask := (v_final_mask & ~v_role_deny) | v_role_allow;
            -- Layer 4: user-specific override
            v_final_mask := (v_final_mask & ~v_user_deny) | v_user_allow;
        END;
    END IF;

    -- Convert bitmask to jsonb result
    FOR v_i IN 0..29 LOOP
        v_perm_name := v_bit_map->>v_i;
        IF v_perm_name IS NOT NULL THEN
            v_result := v_result || jsonb_build_object(
                v_perm_name,
                (v_final_mask & (1::bigint << v_i)) != 0
            );
        END IF;
    END LOOP;

    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: has_permission
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_permission(
    p_user_id uuid,
    p_server_id uuid,
    p_permission text,
    p_channel_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_permissions jsonb;
BEGIN
    v_permissions := public.get_user_permissions(p_user_id, p_server_id, p_channel_id);
    RETURN COALESCE((v_permissions->>p_permission)::boolean, false);
END;
$$;

-- Used by storage RLS (server icon/banner/emoji uploads) which is evaluated as
-- the authenticated role, so the helpers must be explicitly executable by it.
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_permissions(uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Function: get_user_prekey_bundle
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_prekey_bundle(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_identity_key TEXT;
    v_signed_prekey JSONB;
    v_one_time_prekey JSONB;
    v_result JSONB;
BEGIN
    -- Get identity public key
    SELECT identity_public_key INTO v_identity_key
    FROM public.user_key_pairs
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_active = true
    ORDER BY key_version DESC
    LIMIT 1;
    
    IF v_identity_key IS NULL THEN
        RAISE EXCEPTION 'No identity key found for user % device %', p_user_id, p_device_id;
    END IF;
    
    -- Get signed prekey
    SELECT jsonb_build_object(
        'id', prekey_id,
        'public_key', public_key,
        'signature', signature
    ) INTO v_signed_prekey
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_signed = true
        AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Get and mark one-time prekey as used
    SELECT jsonb_build_object(
        'id', prekey_id,
        'public_key', public_key
    ) INTO v_one_time_prekey
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false
        AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    
    -- Mark the one-time prekey as used
    IF v_one_time_prekey IS NOT NULL THEN
        UPDATE public.prekeys
        SET 
            is_used = true,
            used_at = NOW(),
            used_by = auth.uid()
        WHERE user_id = p_user_id
            AND device_id = p_device_id
            AND prekey_id = (v_one_time_prekey->>'id')::INTEGER;
    END IF;
    
    -- Build result bundle
    v_result := jsonb_build_object(
        'user_id', p_user_id,
        'device_id', p_device_id,
        'identity_key', v_identity_key,
        'signed_prekey', v_signed_prekey,
        'one_time_prekey', v_one_time_prekey,
        'retrieved_at', NOW()
    );
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: upsert_remote_emoji
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_remote_emoji(
    p_shortcode text,
    p_origin_domain text,
    p_full_code text,
    p_url text,
    p_static_url text DEFAULT NULL,
    p_category text DEFAULT NULL,
    p_is_animated boolean DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.remote_emojis_cache (
    shortcode, origin_domain, full_code, url, static_url, category, is_animated
  ) VALUES (
    p_shortcode, p_origin_domain, p_full_code, p_url, p_static_url, p_category, p_is_animated
  )
  ON CONFLICT (shortcode, origin_domain) DO UPDATE SET
    url = EXCLUDED.url,
    static_url = COALESCE(EXCLUDED.static_url, remote_emojis_cache.static_url),
    last_seen_at = now(),
    usage_count = remote_emojis_cache.usage_count + 1,
    category = COALESCE(EXCLUDED.category, remote_emojis_cache.category),
    is_animated = COALESCE(EXCLUDED.is_animated, remote_emojis_cache.is_animated)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_remote_emoji(text, text, text, text, text, text, boolean)
IS 'Insert or update a remote emoji, incrementing usage count on conflict.';

GRANT EXECUTE ON FUNCTION public.upsert_remote_emoji(text, text, text, text, text, text, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Function: import_remote_emoji
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_remote_emoji(p_remote_emoji_id uuid, p_new_name text DEFAULT NULL::text, p_server_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
  v_remote remote_emojis_cache%ROWTYPE;
  v_new_id uuid;
  v_name text;
BEGIN
  -- Get the remote emoji
  SELECT * INTO v_remote FROM public.remote_emojis_cache WHERE id = p_remote_emoji_id;
  
  IF v_remote.id IS NULL THEN
    RAISE EXCEPTION 'Remote emoji not found';
  END IF;
  
  IF v_remote.imported_as IS NOT NULL THEN
    RAISE EXCEPTION 'Emoji already imported';
  END IF;
  
  -- Use provided name or original shortcode
  v_name := COALESCE(p_new_name, v_remote.shortcode);
  
  -- Check if name already exists locally (where domain is null = local emoji)
  IF EXISTS (SELECT 1 FROM public.emojis WHERE name = v_name AND domain IS NULL) THEN
    RAISE EXCEPTION 'Emoji name already exists locally: %', v_name;
  END IF;
  
  -- Create the local emoji
  INSERT INTO public.emojis (
    name,
    url,
    server_id,
    scope,
    domain  -- NULL means it's now a local emoji
  ) VALUES (
    v_name,
    v_remote.url,
    p_server_id,
    CASE WHEN p_server_id IS NULL THEN 'instance' ELSE 'server' END,
    NULL  -- Imported as local emoji
  ) RETURNING id INTO v_new_id;
  
  -- Update the remote emoji to mark as imported
  UPDATE public.remote_emojis_cache 
  SET imported_as = v_new_id, imported_at = now()
  WHERE id = p_remote_emoji_id;
  
  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.import_remote_emoji(uuid, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Function: mark_all_notifications_read
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_user_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count integer;
    v_profile_id uuid;
BEGIN
    v_profile_id := get_current_profile_id();
    IF v_profile_id IS NULL OR v_profile_id != p_user_id THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    ALTER TABLE notifications DISABLE TRIGGER trg_broadcast_notification;

    UPDATE notifications
    SET is_read = true, read_at = NOW(), updated_at = NOW()
    WHERE user_id = p_user_id AND is_read = false;

    GET DIAGNOSTICS v_count = ROW_COUNT;

    ALTER TABLE notifications ENABLE TRIGGER trg_broadcast_notification;

    IF v_count > 0 THEN
        BEGIN
            PERFORM realtime.send(
                jsonb_build_object(
                    'type', 'notification:bulk_read',
                    'count', v_count
                ),
                'user_event',
                'user:' || p_user_id::text,
                true
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: mark_notifications_read_by_context
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_notifications_read_by_context(
    p_context_type text,
    p_context_id text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id uuid;
    v_count integer;
BEGIN
    v_user_id := public.get_current_profile_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    WITH updated AS (
        UPDATE notifications
        SET is_read = true, read_at = NOW(), updated_at = NOW()
        WHERE user_id = v_user_id
          AND is_read = false
          AND (
              CASE p_context_type
                  WHEN 'channel' THEN
                      data->>'channel_id' = p_context_id
                      OR data->'location'->>'channel_id' = p_context_id
                  WHEN 'conversation' THEN
                      data->>'conversation_id' = p_context_id
                      OR data->'conversation'->>'id' = p_context_id
                  WHEN 'post' THEN
                      data->>'post_id' = p_context_id
                      OR data->'post'->>'id' = p_context_id
                  WHEN 'server' THEN
                      data->>'server_id' = p_context_id
                      OR data->'location'->>'server_id' = p_context_id
                  ELSE false
              END
          )
        RETURNING id
    )
    SELECT count(*) INTO v_count FROM updated;

    RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: mark_server_as_read
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_server_as_read(p_server_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id uuid;
BEGIN
    v_user_id := public.get_current_profile_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    UPDATE public.unread_counts
    SET unread_messages = 0, unread_mentions = 0,
        last_read_at = NOW(), updated_at = NOW()
    WHERE user_id = v_user_id AND server_id = p_server_id;

    UPDATE notifications
    SET is_read = true, read_at = NOW(), updated_at = NOW()
    WHERE user_id = v_user_id
      AND is_read = false
      AND (
          data->>'server_id' = p_server_id::text
          OR data->'location'->>'server_id' = p_server_id::text
      );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: moderate_user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.moderate_user(p_admin_id uuid, p_target_user_id uuid, p_action text, p_reason text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    target_username TEXT;
    admin_profile_id UUID;
BEGIN
    SELECT id INTO admin_profile_id
    FROM profiles
    WHERE auth_user_id = p_admin_id AND (is_admin = TRUE OR is_moderator = TRUE);

    IF admin_profile_id IS NULL THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;

    SELECT username INTO target_username FROM profiles WHERE id = p_target_user_id;

    IF target_username IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    IF p_action = 'suspend' THEN
        UPDATE profiles
        SET is_suspended = TRUE, suspended_at = NOW(), suspension_reason = p_reason
        WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_suspend'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('reason', p_reason, 'username', target_username)
        );

    ELSIF p_action = 'unsuspend' THEN
        UPDATE profiles
        SET is_suspended = FALSE, suspended_at = NULL, suspension_reason = NULL
        WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_unsuspend'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('username', target_username)
        );

    ELSIF p_action = 'force_sensitive' THEN
        UPDATE profiles SET force_sensitive = TRUE WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_force_sensitive'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('reason', p_reason, 'username', target_username)
        );

    ELSIF p_action = 'unforce_sensitive' THEN
        UPDATE profiles SET force_sensitive = FALSE WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_unforce_sensitive'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('username', target_username)
        );

    ELSIF p_action = 'silence' THEN
        UPDATE profiles
        SET is_silenced = TRUE, silenced_at = NOW(), silenced_reason = p_reason
        WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_silence'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('reason', p_reason, 'username', target_username)
        );

    ELSIF p_action = 'unsilence' THEN
        UPDATE profiles
        SET is_silenced = FALSE, silenced_at = NULL, silenced_reason = NULL
        WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_unsilence'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('username', target_username)
        );

    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;

    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: pin_message
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pin_message(p_message_id uuid, p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_channel_id uuid;
    v_conversation_id uuid;
    v_server_id uuid;
    v_pin_count integer;
    v_max_pins integer := 50; -- Discord-style limit
BEGIN
    -- Get message details
    SELECT channel_id, conversation_id INTO v_channel_id, v_conversation_id
    FROM "public"."messages"
    WHERE id = p_message_id AND NOT is_deleted;
    
    IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
        RAISE EXCEPTION 'Message not found or already deleted';
    END IF;
    
    -- Check if already pinned
    IF EXISTS (SELECT 1 FROM "public"."messages" WHERE id = p_message_id AND is_pinned = true) THEN
        RETURN true; -- Already pinned
    END IF;
    
    -- For channel messages, check permission and pin limit
    IF v_channel_id IS NOT NULL THEN
        SELECT server_id INTO v_server_id
        FROM "public"."channels"
        WHERE id = v_channel_id;
        
        -- Check pin count
        SELECT COUNT(*) INTO v_pin_count
        FROM "public"."messages"
        WHERE channel_id = v_channel_id AND is_pinned = true;
        
        IF v_pin_count >= v_max_pins THEN
            RAISE EXCEPTION 'Maximum pin limit (%) reached for this channel', v_max_pins;
        END IF;
        
        -- Check permission (PIN_MESSAGES or MANAGE_MESSAGES)
        IF NOT (
            "public"."has_permission"(p_user_id, v_server_id, 'PIN_MESSAGES', v_channel_id)
            OR
            "public"."has_permission"(p_user_id, v_server_id, 'MANAGE_MESSAGES', v_channel_id)
        ) THEN
            RAISE EXCEPTION 'Permission denied: cannot pin messages';
        END IF;
    END IF;
    
    -- For DM conversations, check if user is participant
    IF v_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "public"."conversation_participants"
            WHERE conversation_id = v_conversation_id AND user_id = p_user_id
        ) THEN
            RAISE EXCEPTION 'Permission denied: not a participant in this conversation';
        END IF;
        
        -- Check pin count for DM
        SELECT COUNT(*) INTO v_pin_count
        FROM "public"."messages"
        WHERE conversation_id = v_conversation_id AND is_pinned = true;
        
        IF v_pin_count >= v_max_pins THEN
            RAISE EXCEPTION 'Maximum pin limit (%) reached for this conversation', v_max_pins;
        END IF;
    END IF;
    
    -- Pin the message
    UPDATE "public"."messages"
    SET 
        is_pinned = true,
        pinned_at = NOW(),
        pinned_by = p_user_id
    WHERE id = p_message_id;
    
    RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: record_emoji_usage
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_emoji_usage(p_emoji_id uuid, p_user_id uuid, p_server_id uuid, p_context_type text, p_context_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Insert usage record (ignore if duplicate due to unique constraint)
    INSERT INTO emoji_usage (emoji_id, user_id, server_id, context_type, context_id)
    VALUES (p_emoji_id, p_user_id, p_server_id, p_context_type, p_context_id)
    ON CONFLICT (emoji_id, user_id, context_type, context_id) DO NOTHING;
    
    -- Update emoji global usage count and last_used
    UPDATE emojis 
    SET 
        usage_count = (
            SELECT COUNT(DISTINCT (user_id, context_type, context_id))
            FROM emoji_usage 
            WHERE emoji_id = p_emoji_id
        ),
        last_used = now(),
        updated_at = now()
    WHERE id = p_emoji_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: register_recovery_key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_recovery_key(p_user_id uuid, p_verification_code text, p_word_count integer DEFAULT 12) RETURNS public.recovery_key_metadata
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_result public.recovery_key_metadata;
BEGIN
    INSERT INTO public.recovery_key_metadata (
        user_id,
        verification_code,
        word_count,
        created_at
    ) VALUES (
        p_user_id,
        p_verification_code,
        p_word_count,
        NOW()
    )
    ON CONFLICT (user_id) 
    DO UPDATE SET
        verification_code = EXCLUDED.verification_code,
        word_count = EXCLUDED.word_count,
        key_version = recovery_key_metadata.key_version + 1
    RETURNING * INTO v_result;
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: remove_group_icon
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_group_icon(conversation_uuid uuid, user_profile_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Remove icon from conversation metadata
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) - 'icon_url',
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';

  PERFORM public.queue_federation_job(
    'federate-group-update',
    jsonb_build_object(
      'conversation_id', conversation_uuid,
      'updater_id', user_profile_id,
      'update_type', 'icon_removed'
    ),
    5, 5, 3600
  );

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group icon removed successfully'
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: remove_post_emoji_reaction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_deleted_count integer;
BEGIN
    DELETE FROM post_interactions 
    WHERE user_id = p_user_id
      AND post_id = p_post_id 
      AND interaction_type = 'emoji_reaction'
      AND (
          (p_emoji_id IS NOT NULL AND emoji_id = p_emoji_id) OR
          (p_custom_emoji_content IS NOT NULL AND custom_emoji_content = p_custom_emoji_content)
      );
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_deleted_count > 0;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: reset_daily_hashtag_counters
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: reset_user_encryption
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_user_encryption(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_deleted_keys INTEGER := 0;
    v_deleted_prekeys INTEGER := 0;
    v_deleted_sessions INTEGER := 0;
    v_result JSONB;
BEGIN
    -- Only allow users to reset their own encryption
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot reset encryption for another user';
    END IF;
    
    -- Delete all prekeys (both signed and one-time)
    DELETE FROM public.prekeys
    WHERE user_id = p_user_id
    AND device_id = p_device_id;
    GET DIAGNOSTICS v_deleted_prekeys = ROW_COUNT;
    
    -- Delete encryption sessions (where user is either party)
    DELETE FROM public.encryption_sessions
    WHERE local_user_id = p_user_id
    OR remote_user_id = p_user_id;
    GET DIAGNOSTICS v_deleted_sessions = ROW_COUNT;
    
    -- Delete all key pairs (this allows re-initialization)
    DELETE FROM public.user_key_pairs
    WHERE user_id = p_user_id
    AND device_id = p_device_id;
    GET DIAGNOSTICS v_deleted_keys = ROW_COUNT;
    
    -- Log the reset (using 'encryption_disabled' as it's the closest valid event type)
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'encryption_disabled',
        'warning',
        'User encryption keys completely reset',
        jsonb_build_object(
            'device_id', p_device_id,
            'deleted_keys', v_deleted_keys,
            'deleted_prekeys', v_deleted_prekeys,
            'deleted_sessions', v_deleted_sessions,
            'reset_type', 'full_reset',
            'reset_at', NOW()
        )
    );
    
    v_result := jsonb_build_object(
        'success', true,
        'deleted_keys', v_deleted_keys,
        'deleted_prekeys', v_deleted_prekeys,
        'deleted_sessions', v_deleted_sessions,
        'message', 'Encryption has been reset. You can now set up encryption again.'
    );
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: rotate_prekeys
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rotate_prekeys(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_deleted_count INTEGER;
    v_remaining_count INTEGER;
    v_result JSONB;
BEGIN
    -- Only allow users to rotate their own prekeys
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot rotate prekeys for another user';
    END IF;
    
    -- Delete used one-time prekeys older than 30 days
    DELETE FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = true
        AND used_at < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    
    -- Mark expired signed prekeys as inactive
    UPDATE public.prekeys
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{expired}', 'true')
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_signed = true
        AND expires_at IS NOT NULL
        AND expires_at < NOW();
    
    -- Count remaining unused one-time prekeys
    SELECT COUNT(*) INTO v_remaining_count
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false;
    
    v_result := jsonb_build_object(
        'deleted_used_prekeys', v_deleted_count,
        'remaining_unused_prekeys', v_remaining_count,
        'rotation_completed_at', NOW()
    );
    
    -- Log the rotation
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'key_rotated',
        'info',
        'Prekey rotation completed',
        v_result
    );
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: save_recovery_codes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_recovery_codes(p_user_id uuid, p_codes text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_code TEXT;
  v_code_hash TEXT;
  v_caller uuid;
  v_batch_id uuid := gen_random_uuid();
BEGIN
  -- CALLER BINDING: this is SECURITY DEFINER and bypasses RLS, so without this
  -- check ANY authenticated user could wipe/replace another user's MFA recovery
  -- codes by passing their profile id. Bind the write to the caller and ignore
  -- the client-supplied target. (auth.uid() matches profile id for local users;
  -- get_current_profile_id() is the authoritative profile id.)
  v_caller := public.get_current_profile_id();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS DISTINCT FROM v_caller AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Permission denied: can only save your own recovery codes'
      USING ERRCODE = '42501';
  END IF;

  -- Delete any existing recovery codes for the caller
  DELETE FROM public.mfa_recovery_codes WHERE user_id = v_caller;

  -- Insert new recovery codes (batch_id is NOT NULL in the schema)
  FOREACH v_code IN ARRAY p_codes
  LOOP
    -- Use extensions.digest() to explicitly reference the pgcrypto extension
    v_code_hash := encode(extensions.digest(v_code::bytea, 'sha256'), 'hex');
    INSERT INTO public.mfa_recovery_codes (user_id, code_hash, batch_id)
    VALUES (v_caller, v_code_hash, v_batch_id);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: search_federated_users
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_federated_users(p_query text, p_limit integer DEFAULT 10) RETURNS TABLE(user_id uuid, username text, display_name text, domain text, avatar_url text, handle text, is_local boolean)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as user_id,
        p.username,
        p.display_name,
        p.domain,
        p.avatar_url,
        get_user_handle(p.id) as handle,
        p.is_local
    FROM profiles p
    WHERE (
        p.username ILIKE '%' || p_query || '%'
        OR p.display_name ILIKE '%' || p_query || '%'
        OR (p.username || '@' || p.domain) ILIKE '%' || p_query || '%'
    )
    AND p.is_suspended = false  -- Exclude suspended users
    ORDER BY 
        CASE WHEN p.is_local THEN 0 ELSE 1 END,
        p.username
    LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: search_messages
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_messages(p_query text DEFAULT NULL::text, p_channel_id uuid DEFAULT NULL::uuid, p_channel_ids uuid[] DEFAULT NULL::uuid[], p_user_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid, p_server_id uuid DEFAULT NULL::uuid, p_has_media boolean DEFAULT NULL::boolean, p_has_url boolean DEFAULT NULL::boolean, p_from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0) RETURNS TABLE(message_id uuid, relevance real, content_text text, channel_id uuid, conversation_id uuid, user_id uuid, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  current_user_profile_id uuid;
  search_query text;
  tsquery_val tsquery;
BEGIN
  -- Get current user's profile ID (works for both local and remote users)
  current_user_profile_id := get_current_user_profile_id();
  
  -- If no profile found, return empty (user not authenticated or no profile)
  IF current_user_profile_id IS NULL THEN
    RETURN;
  END IF;
  -- Build search query - handle empty query
  IF p_query IS NULL OR trim(p_query) = '' THEN
    search_query := '';
    tsquery_val := NULL;
  ELSE
    search_query := trim(p_query);
    -- Use plainto_tsquery for natural language search
    tsquery_val := plainto_tsquery('english', search_query);
  END IF;

  RETURN QUERY
  SELECT 
    msi.message_id,
    -- Combine ts_rank (full-text) with similarity (fuzzy) for ranking
    CASE 
      WHEN tsquery_val IS NOT NULL THEN
        (ts_rank(msi.content_tsvector, tsquery_val) * 0.7 +
         extensions.similarity(msi.content_text, search_query) * 0.3)::real
      ELSE
        -- If no query, rank by date
        1.0::real
    END as relevance,
    msi.content_text,
    msi.channel_id,
    msi.conversation_id,
    msi.user_id,
    msi.created_at
  FROM message_search_index msi
  WHERE 
    -- Access control: Only show messages user has access to
    (
      -- For conversations: user must be a participant
      (msi.conversation_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM conversation_participants cp
        WHERE cp.conversation_id = msi.conversation_id
          AND cp.user_id = current_user_profile_id
          AND cp.left_at IS NULL
      ))
      OR
      -- For channels: user must be a member of the server
      (msi.channel_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM channels c
        JOIN user_servers us ON c.server_id = us.server_id
        WHERE c.id = msi.channel_id
          AND us.user_id = current_user_profile_id
      ))
    )
    -- Search conditions (only if query provided)
    AND (tsquery_val IS NULL OR 
         msi.content_tsvector @@ tsquery_val OR 
         extensions.similarity(msi.content_text, search_query) > 0.2)
    -- Filters
    AND (p_channel_id IS NULL OR msi.channel_id = p_channel_id)
    AND (p_channel_ids IS NULL OR msi.channel_id = ANY(p_channel_ids))
    AND (p_user_id IS NULL OR msi.user_id = p_user_id)
    AND (p_conversation_id IS NULL OR msi.conversation_id = p_conversation_id)
    AND (p_server_id IS NULL OR msi.server_id = p_server_id)
    AND (p_has_media IS NULL OR msi.has_media = p_has_media)
    AND (p_has_url IS NULL OR msi.has_url = p_has_url)
    AND (p_from_date IS NULL OR msi.created_at >= p_from_date)
    AND (p_to_date IS NULL OR msi.created_at <= p_to_date)
  ORDER BY 
    CASE 
      WHEN tsquery_val IS NOT NULL THEN
        (ts_rank(msi.content_tsvector, tsquery_val) * 0.7 +
         extensions.similarity(msi.content_text, search_query) * 0.3)
      ELSE
        extract(epoch from msi.created_at) / 1000000.0 -- Convert timestamp to sortable number
    END DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: send_notification_to_user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_notification_to_user(p_notification_type character varying, p_to_user_id uuid, p_notification_data jsonb DEFAULT '{}'::jsonb, p_server_id uuid DEFAULT NULL::uuid, p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid, p_from_user_id uuid DEFAULT NULL::uuid, p_priority character varying DEFAULT 'normal'::character varying) RETURNS uuid
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    SELECT (send_notification(
        p_notification_type,
        ARRAY[p_to_user_id],
        p_notification_data,
        p_server_id,
        p_channel_id,
        p_conversation_id,
        p_from_user_id,
        p_priority
    ))[1];
$$;

-- ---------------------------------------------------------------------------
-- Function: unpin_message
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unpin_message(p_message_id uuid, p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_channel_id uuid;
    v_conversation_id uuid;
    v_server_id uuid;
BEGIN
    -- Get message details
    SELECT channel_id, conversation_id INTO v_channel_id, v_conversation_id
    FROM "public"."messages"
    WHERE id = p_message_id;
    
    IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
        RAISE EXCEPTION 'Message not found';
    END IF;
    
    -- Check if not pinned
    IF NOT EXISTS (SELECT 1 FROM "public"."messages" WHERE id = p_message_id AND is_pinned = true) THEN
        RETURN true; -- Already unpinned
    END IF;
    
    -- For channel messages, check permission
    IF v_channel_id IS NOT NULL THEN
        SELECT server_id INTO v_server_id
        FROM "public"."channels"
        WHERE id = v_channel_id;
        
        -- Check permission (PIN_MESSAGES or MANAGE_MESSAGES)
        IF NOT (
            "public"."has_permission"(p_user_id, v_server_id, 'PIN_MESSAGES', v_channel_id)
            OR
            "public"."has_permission"(p_user_id, v_server_id, 'MANAGE_MESSAGES', v_channel_id)
        ) THEN
            RAISE EXCEPTION 'Permission denied: cannot unpin messages';
        END IF;
    END IF;
    
    -- For DM conversations, check if user is participant
    IF v_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "public"."conversation_participants"
            WHERE conversation_id = v_conversation_id AND user_id = p_user_id
        ) THEN
            RAISE EXCEPTION 'Permission denied: not a participant in this conversation';
        END IF;
    END IF;
    
    -- Unpin the message
    UPDATE "public"."messages"
    SET 
        is_pinned = false,
        pinned_at = NULL,
        pinned_by = NULL
    WHERE id = p_message_id;
    
    RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: update_group_icon
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_group_icon(conversation_uuid uuid, user_profile_id uuid, icon_path text) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Update the conversation metadata with the new icon path
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('icon_url', icon_path),
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';

  PERFORM public.queue_federation_job(
    'federate-group-update',
    jsonb_build_object(
      'conversation_id', conversation_uuid,
      'updater_id', user_profile_id,
      'update_type', 'icon',
      'new_value', icon_path
    ),
    5, 5, 3600
  );

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group icon updated successfully'
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: update_group_name
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_group_name(conversation_uuid uuid, user_profile_id uuid, new_name text) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Update the conversation name
  UPDATE conversations 
  SET 
    name = new_name,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';

  PERFORM public.queue_federation_job(
    'federate-group-update',
    jsonb_build_object(
      'conversation_id', conversation_uuid,
      'updater_id', user_profile_id,
      'update_type', 'name',
      'new_value', COALESCE(new_name, '')
    ),
    5, 5, 3600
  );

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group name updated successfully'
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: update_hashtag_trending_scores
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: update_trending_posts
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: user_has_encryption
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_has_encryption(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.user_key_pairs
        WHERE user_id = p_user_id
        AND is_active = true
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: verify_recovery_code
--
-- Authorization: pre-2026-05-23 this function trusted the `p_user_id`
-- argument supplied by the caller (BUGS.md H49), which let any
-- authenticated user atomically burn another user's MFA recovery codes
-- (the function is `SECURITY DEFINER`, so it bypassed the row-level RLS
-- that would otherwise have constrained the SELECT to `auth.uid()`).
-- The hardened version below requires the caller to be verifying their
-- OWN codes - if `p_user_id` doesn't match `auth.uid()`, we raise. This
-- mirrors the security model of `mfa.verify` itself: only the session
-- holder can spend their own recovery codes.
--
-- Note: `auth.uid()` reads from the JWT's `sub` claim and is independent
-- of `SECURITY DEFINER` (definer changes the *role* used for table
-- access, not the request's auth context). It returns NULL for the anon
-- role, which we explicitly reject below.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_recovery_code(p_user_id uuid, p_code text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_code_hash TEXT;
  v_code_id UUID;
BEGIN
  -- Reject calls from the anon role (no JWT → no caller identity to bind).
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: verify_recovery_code requires an authenticated session'
      USING ERRCODE = '42501';
  END IF;

  -- Reject calls where the caller is trying to verify someone *else's*
  -- recovery code. `IS DISTINCT FROM` treats two NULLs as equal, but the
  -- guard above already rejects auth.uid() = NULL, so this only ever
  -- compares two non-null UUIDs.
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: cannot verify recovery codes for another user'
      USING ERRCODE = '42501';
  END IF;

  -- Hash the provided code (using SHA-256)
  -- Use extensions.digest() to explicitly reference the pgcrypto extension
  v_code_hash := encode(extensions.digest(p_code::bytea, 'sha256'), 'hex');
  
  -- Find an unused recovery code matching the hash
  SELECT id INTO v_code_id
  FROM public.mfa_recovery_codes
  WHERE user_id = p_user_id
    AND code_hash = v_code_hash
    AND used_at IS NULL
  LIMIT 1;
  
  IF v_code_id IS NOT NULL THEN
    -- Mark the code as used
    UPDATE public.mfa_recovery_codes
    SET used_at = NOW()
    WHERE id = v_code_id;
    
    RETURN TRUE;
  ELSE
    RETURN FALSE;
  END IF;
END;
$$;

-- =============================================================================
-- STUB FUNCTIONS - Temporary implementations for missing RPC functions
-- =============================================================================
-- These functions are called by the frontend but were never implemented in production.
-- They return empty/default values to prevent errors.
-- TODO: Replace with proper implementations (see TODO_cleanRPC.md)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- DROP existing functions with changed signatures (required before CREATE OR REPLACE)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(text);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_context(uuid);
DROP FUNCTION IF EXISTS public.get_emoji_usage_analytics(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.get_user_emoji_stats(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.get_most_used_emojis(uuid[], integer);

-- ---------------------------------------------------------------------------
-- 1. create_federated_profile - Creates a profile for a remote federated user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_federated_profile(
    p_username text,
    p_display_name text DEFAULT NULL,
    p_domain text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL,
    p_banner_url text DEFAULT NULL,
    p_federated_id text DEFAULT NULL,
    p_bio text DEFAULT NULL,
    p_inbox_url text DEFAULT NULL,
    p_outbox_url text DEFAULT NULL,
    p_followers_url text DEFAULT NULL,
    p_following_url text DEFAULT NULL,
    p_public_key text DEFAULT NULL,
    p_shared_inbox_url text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile_id uuid;
    v_instance_domain text;
BEGIN
    SELECT COALESCE(
        (SELECT trim(both '"' from config_value::text) FROM instance_config WHERE config_key = 'domain'),
        'localhost'
    ) INTO v_instance_domain;

    IF p_domain = v_instance_domain THEN
        RAISE WARNING 'Refusing to create federated profile for local domain: %@%', p_username, p_domain;
        SELECT id INTO v_profile_id
        FROM profiles WHERE username = p_username AND domain = p_domain AND is_local = true;
        RETURN v_profile_id;
    END IF;

    INSERT INTO profiles (
        username, display_name, domain, avatar_url, banner_url,
        federated_id, bio, inbox_url, outbox_url, followers_url,
        following_url, public_key, shared_inbox_url, is_local, last_synced_at
    ) VALUES (
        p_username, COALESCE(p_display_name, p_username), p_domain,
        p_avatar_url, p_banner_url, p_federated_id, p_bio,
        p_inbox_url, p_outbox_url, p_followers_url,
        p_following_url, p_public_key, p_shared_inbox_url, false, NOW()
    )
    ON CONFLICT (username, domain) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
        avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
        banner_url = COALESCE(EXCLUDED.banner_url, profiles.banner_url),
        federated_id = COALESCE(EXCLUDED.federated_id, profiles.federated_id),
        bio = COALESCE(EXCLUDED.bio, profiles.bio),
        inbox_url = COALESCE(EXCLUDED.inbox_url, profiles.inbox_url),
        outbox_url = COALESCE(EXCLUDED.outbox_url, profiles.outbox_url),
        followers_url = COALESCE(EXCLUDED.followers_url, profiles.followers_url),
        following_url = COALESCE(EXCLUDED.following_url, profiles.following_url),
        public_key = COALESCE(EXCLUDED.public_key, profiles.public_key),
        shared_inbox_url = COALESCE(EXCLUDED.shared_inbox_url, profiles.shared_inbox_url),
        last_synced_at = NOW(), updated_at = NOW()
    WHERE profiles.is_local = false
    RETURNING id INTO v_profile_id;

    IF v_profile_id IS NULL THEN
        SELECT id INTO v_profile_id
        FROM profiles WHERE username = p_username AND domain = p_domain;
    END IF;

    RETURN v_profile_id;
END;
$$;

COMMENT ON FUNCTION public.create_federated_profile IS 'Creates or updates a remote federated profile. Refuses to overwrite local users.';

-- ---------------------------------------------------------------------------
-- safe_upsert_remote_profile - Safe upsert with return flags
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.safe_upsert_remote_profile(
    p_username text,
    p_domain text,
    p_federated_id text DEFAULT NULL,
    p_display_name text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL,
    p_banner_url text DEFAULT NULL,
    p_bio text DEFAULT NULL,
    p_public_key text DEFAULT NULL,
    p_inbox_url text DEFAULT NULL,
    p_outbox_url text DEFAULT NULL,
    p_followers_url text DEFAULT NULL,
    p_following_url text DEFAULT NULL,
    p_shared_inbox_url text DEFAULT NULL
) RETURNS TABLE(profile_id uuid, was_created boolean, was_updated boolean, is_local_user boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile_id uuid;
    v_was_created boolean := false;
    v_was_updated boolean := false;
    v_is_local_user boolean := false;
    v_instance_domain text;
BEGIN
    SELECT COALESCE(
        (SELECT trim(both '"' from config_value::text) FROM instance_config WHERE config_key = 'domain'),
        'localhost'
    ) INTO v_instance_domain;

    IF p_domain = v_instance_domain THEN
        SELECT id, true INTO v_profile_id, v_is_local_user
        FROM profiles WHERE username = p_username AND domain = p_domain AND is_local = true;
        RETURN QUERY SELECT v_profile_id, false, false, true;
        RETURN;
    END IF;

    SELECT id, is_local INTO v_profile_id, v_is_local_user
    FROM profiles WHERE username = p_username AND domain = p_domain;

    IF v_profile_id IS NULL THEN
        INSERT INTO profiles (
            username, domain, federated_id, display_name, avatar_url, banner_url,
            bio, public_key, inbox_url, outbox_url, followers_url, following_url,
            shared_inbox_url, is_local, last_synced_at
        ) VALUES (
            p_username, p_domain, p_federated_id, COALESCE(p_display_name, p_username),
            p_avatar_url, p_banner_url, p_bio, p_public_key, p_inbox_url, p_outbox_url,
            p_followers_url, p_following_url, p_shared_inbox_url, false, NOW()
        )
        RETURNING id INTO v_profile_id;
        v_was_created := true;
    ELSIF NOT v_is_local_user THEN
        UPDATE profiles SET
            federated_id = COALESCE(p_federated_id, federated_id),
            display_name = COALESCE(p_display_name, display_name),
            avatar_url = COALESCE(p_avatar_url, avatar_url),
            banner_url = COALESCE(p_banner_url, banner_url),
            bio = COALESCE(p_bio, bio),
            public_key = COALESCE(p_public_key, public_key),
            inbox_url = COALESCE(p_inbox_url, inbox_url),
            outbox_url = COALESCE(p_outbox_url, outbox_url),
            followers_url = COALESCE(p_followers_url, followers_url),
            following_url = COALESCE(p_following_url, following_url),
            shared_inbox_url = COALESCE(p_shared_inbox_url, shared_inbox_url),
            last_synced_at = NOW(), updated_at = NOW()
        WHERE id = v_profile_id;
        v_was_updated := true;
    END IF;

    RETURN QUERY SELECT v_profile_id, v_was_created, v_was_updated, v_is_local_user;
END;
$$;

COMMENT ON FUNCTION public.safe_upsert_remote_profile IS 'Safely upserts a remote profile with local-user protection. Returns status flags.';

-- ---------------------------------------------------------------------------
-- 2. get_activitypub_conversation_context - Get ancestors/descendants of a post
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_context(post_id uuid)
RETURNS TABLE(
    ancestors jsonb,
    descendants jsonb
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        -- Get ancestors (posts this post replies to)
        COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', p.id,
                    'content', p.content,
                    'author_id', p.author_id,
                    'created_at', p.created_at
                ) ORDER BY p.created_at ASC
            )
            FROM posts p
            WHERE p.id = (SELECT in_reply_to FROM posts WHERE id = get_activitypub_conversation_context.post_id)
            ), '[]'::jsonb
        ) as ancestors,
        -- Get descendants (replies to this post)
        COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', p.id,
                    'content', p.content,
                    'author_id', p.author_id,
                    'created_at', p.created_at
                ) ORDER BY p.created_at ASC
            )
            FROM posts p
            WHERE p.in_reply_to = get_activitypub_conversation_context.post_id
            ), '[]'::jsonb
        ) as descendants;
END;
$$;

COMMENT ON FUNCTION public.get_activitypub_conversation_context IS 'Get conversation context (ancestors and descendants) for a post';

-- ---------------------------------------------------------------------------
-- 3. get_activitypub_conversation_thread - Get all posts in a conversation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_thread(in_conversation_root_id text)
RETURNS TABLE(
    id uuid,
    content jsonb,
    author_id uuid,
    created_at timestamptz,
    in_reply_to uuid,
    conversation_root_id uuid
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id,
        p.content,
        p.author_id,
        p.created_at,
        p.in_reply_to,
        p.conversation_root_id
    FROM posts p
    WHERE p.conversation_root_id::text = in_conversation_root_id
    ORDER BY p.created_at ASC;
END;
$$;

COMMENT ON FUNCTION public.get_activitypub_conversation_thread IS 'Get all posts in an ActivityPub conversation thread';

-- ---------------------------------------------------------------------------
-- 4. get_emoji_usage_analytics - Get emoji usage analytics for a server
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_emoji_usage_analytics(
    p_server_id uuid,
    p_user_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 10
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    usage_count bigint,
    last_used timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id as emoji_id,
        e.name::text as emoji_name,
        e.url::text as emoji_url,
        COUNT(eu.id)::bigint as usage_count,
        MAX(eu.used_at) as last_used
    FROM emojis e
    LEFT JOIN emoji_usage eu ON e.id = eu.emoji_id 
        AND (p_user_id IS NULL OR eu.user_id = p_user_id)
    WHERE e.server_id = p_server_id
    GROUP BY e.id, e.name, e.url
    ORDER BY usage_count DESC
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_emoji_usage_analytics IS 'Get emoji usage analytics for a server';

-- ---------------------------------------------------------------------------
-- 5. get_most_used_emojis - Get most frequently used emojis
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_most_used_emojis(
    server_ids uuid[] DEFAULT NULL,
    "limit" integer DEFAULT 100
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    server_id uuid,
    usage_count bigint
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id as emoji_id,
        e.name::text as emoji_name,
        e.url::text as emoji_url,
        e.server_id,
        COALESCE(e.usage_count, 0)::bigint as usage_count
    FROM emojis e
    WHERE (server_ids IS NULL OR e.server_id = ANY(server_ids))
    ORDER BY e.usage_count DESC NULLS LAST
    LIMIT "limit";
END;
$$;

COMMENT ON FUNCTION public.get_most_used_emojis IS 'Get most frequently used emojis across servers';

-- ---------------------------------------------------------------------------
-- 6. get_user_emoji_stats - Get user emoji usage statistics
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_emoji_stats(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 20
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    usage_count bigint,
    last_used timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        eu.emoji_id,
        e.name::text as emoji_name,
        e.url::text as emoji_url,
        COUNT(eu.id)::bigint as usage_count,
        MAX(eu.used_at) as last_used
    FROM emoji_usage eu
    JOIN emojis e ON eu.emoji_id = e.id
    WHERE eu.user_id = p_user_id
        AND (p_server_id IS NULL OR eu.server_id = p_server_id)
    GROUP BY eu.emoji_id, e.name, e.url
    ORDER BY usage_count DESC
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_user_emoji_stats IS 'Get emoji usage statistics for a specific user';

-- ---------------------------------------------------------------------------
-- 7. reset_daily_hashtag_counters - Reset daily hashtag counters
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_daily_hashtag_counters()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Reset daily counters in hashtags table
    UPDATE public.hashtags
    SET 
        daily_uses = 0,
        updated_at = NOW()
    WHERE daily_uses > 0;
    
    RAISE NOTICE 'Daily hashtag counters reset';
EXCEPTION WHEN undefined_column THEN
    -- Column doesn't exist, skip
    RAISE NOTICE 'daily_uses column does not exist, skipping reset';
END;
$$;

COMMENT ON FUNCTION public.reset_daily_hashtag_counters IS 'Reset daily hashtag usage counters (called by scheduled job)';

-- ---------------------------------------------------------------------------
-- 8. update_hashtag_trending_scores - Update trending scores for hashtags
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_hashtag_trending_scores()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    updated_count INTEGER := 0;
BEGIN
    -- Accumulate daily into weekly
    UPDATE public.hashtags
    SET 
        weekly_uses = COALESCE(weekly_uses, 0) + COALESCE(daily_uses, 0),
        updated_at = NOW()
    WHERE daily_uses > 0;

    -- Compute trending_score: weighted combination of daily recency and weekly volume
    UPDATE public.hashtags
    SET 
        trending_score = (COALESCE(daily_uses, 0) * 3.0 + COALESCE(weekly_uses, 0) * 0.5 + COALESCE(total_uses, 0) * 0.05),
        last_trending_update = NOW(),
        updated_at = NOW()
    WHERE COALESCE(daily_uses, 0) > 0 OR COALESCE(weekly_uses, 0) > 0;

    GET DIAGNOSTICS updated_count = ROW_COUNT;

    -- Assign ranks based on score
    WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY trending_score DESC) AS rn
        FROM public.hashtags
        WHERE trending_score > 0
    )
    UPDATE public.hashtags h
    SET trending_rank = ranked.rn
    FROM ranked
    WHERE h.id = ranked.id;

    RAISE NOTICE 'Hashtag trending scores updated: % hashtags', updated_count;
    RETURN updated_count;
EXCEPTION WHEN undefined_column THEN
    RAISE NOTICE 'trending columns do not exist, skipping update';
    RETURN 0;
END;
$$;

COMMENT ON FUNCTION public.update_hashtag_trending_scores IS 'Update trending scores for hashtags based on usage patterns';

-- ---------------------------------------------------------------------------
-- 9. update_trending_posts - Update trending posts rankings
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_trending_posts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now timestamptz := NOW();
    v_period_start timestamptz := date_trunc('day', NOW());
    v_period_end timestamptz := v_period_start + INTERVAL '1 day';
BEGIN
    DELETE FROM public.trending_posts 
    WHERE period_start = v_period_start AND period_type = 'daily';
    
    INSERT INTO public.trending_posts (
        post_id, 
        trending_score, 
        engagement_score, 
        velocity_score,
        period_type,
        period_start, 
        period_end,
        likes_count,
        reblogs_count,
        replies_count
    )
    SELECT 
        p.id,
        (COALESCE(p.favorites_count, 0) + COALESCE(p.reblogs_count, 0) * 2 + COALESCE(p.replies_count, 0) * 1.5) 
        * (1.0 / (EXTRACT(EPOCH FROM (v_now - p.created_at)) / 3600 + 1)) as trending_score,
        (COALESCE(p.favorites_count, 0) + COALESCE(p.reblogs_count, 0) + COALESCE(p.replies_count, 0))::numeric as engagement_score,
        CASE 
            WHEN p.created_at > v_now - INTERVAL '1 hour' THEN 10.0
            WHEN p.created_at > v_now - INTERVAL '6 hours' THEN 5.0
            ELSE 1.0
        END::numeric as velocity_score,
        'daily'::text,
        v_period_start,
        v_period_end,
        COALESCE(p.favorites_count, 0),
        COALESCE(p.reblogs_count, 0),
        COALESCE(p.replies_count, 0)
    FROM posts p
    WHERE p.created_at > v_now - INTERVAL '48 hours'
        AND p.visibility IN ('public', 'unlisted')
        AND (p.is_deleted IS NULL OR p.is_deleted = false)
    ORDER BY trending_score DESC
    LIMIT 100;
    
    RAISE NOTICE 'Trending posts updated';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'trending_posts table does not exist, skipping update';
WHEN undefined_column THEN
    RAISE NOTICE 'Required columns do not exist, skipping update';
END;
$$;

COMMENT ON FUNCTION public.update_trending_posts IS 'Update trending posts rankings based on engagement metrics';

-- ---------------------------------------------------------------------------
-- 10. archive_popular_hashtags - Archive popular hashtags before cleanup
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_popular_hashtags()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    archived_count INTEGER := 0;
BEGIN
    -- Mark hashtags with significant usage as archived (bump peak stats)
    UPDATE public.hashtags
    SET 
        peak_daily_uses = GREATEST(COALESCE(peak_daily_uses, 0), COALESCE(daily_uses, 0)),
        peak_daily_date = CASE 
            WHEN COALESCE(daily_uses, 0) > COALESCE(peak_daily_uses, 0) THEN CURRENT_DATE
            ELSE peak_daily_date
        END,
        updated_at = NOW()
    WHERE daily_uses > 0;

    GET DIAGNOSTICS archived_count = ROW_COUNT;
    RETURN archived_count;
END;
$$;

COMMENT ON FUNCTION public.archive_popular_hashtags IS 'Archive popular hashtag peak stats before daily reset';

-- ---------------------------------------------------------------------------
-- 11. cleanup_inactive_hashtags - Remove hashtags with no recent activity
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_inactive_hashtags()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    cleaned_count INTEGER := 0;
BEGIN
    -- Delete hashtags that have had zero activity for 90+ days and low total usage
    DELETE FROM public.hashtags
    WHERE last_used_at < NOW() - INTERVAL '90 days'
      AND COALESCE(total_uses, 0) < 3;

    GET DIAGNOSTICS cleaned_count = ROW_COUNT;
    RETURN cleaned_count;
END;
$$;

COMMENT ON FUNCTION public.cleanup_inactive_hashtags IS 'Remove rarely-used hashtags with no recent activity';

-- ---------------------------------------------------------------------------
-- 12. run_trending_maintenance - Comprehensive maintenance wrapper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_trending_maintenance()
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
    result JSON;
    hashtags_cleaned INTEGER;
    trending_cleaned INTEGER;
    hashtags_archived INTEGER;
    scores_updated INTEGER;
BEGIN
    hashtags_archived := archive_popular_hashtags();
    hashtags_cleaned := cleanup_inactive_hashtags();
    trending_cleaned := cleanup_old_trending_data();
    scores_updated := update_hashtag_trending_scores();
    PERFORM update_trending_posts();
    
    result := json_build_object(
        'maintenance_completed_at', NOW(),
        'hashtags_archived', hashtags_archived,
        'hashtags_cleaned', hashtags_cleaned,
        'trending_data_cleaned', trending_cleaned,
        'trending_scores_updated', scores_updated,
        'status', 'success'
    );
    
    RAISE NOTICE 'Trending system maintenance completed: %', result;
    RETURN result;
END;
$$;

COMMENT ON FUNCTION public.run_trending_maintenance IS 'Comprehensive maintenance function that runs all cleanup and update operations';

-- ---------------------------------------------------------------------------
-- VERIFICATION
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    RAISE NOTICE '✅ Extended RPC functions created successfully!';
END $$;


-- ---------------------------------------------------------------------------
-- check_key_consistency - Check for users with inconsistent key state
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_key_consistency() 
RETURNS TABLE(user_id uuid, username text, has_public_key boolean, has_private_key boolean)
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as user_id,
        p.username,
        (p.public_key IS NOT NULL) as has_public_key,
        (upk.id IS NOT NULL) as has_private_key
    FROM profiles p
    LEFT JOIN user_private_keys upk ON upk.user_id = p.id
    WHERE p.is_local = true
    AND (
        -- Has public key but no private key (broken)
        (p.public_key IS NOT NULL AND upk.id IS NULL)
        OR
        -- Has private key but no public key (also broken)
        (p.public_key IS NULL AND upk.id IS NOT NULL)
    );
END;
$$;

COMMENT ON FUNCTION public.check_key_consistency() IS 'Check for local users with inconsistent key state (public key without private key or vice versa)';

-- ---------------------------------------------------------------------------
-- get_server_encryption_stats - Aggregated encryption stats for a server
-- Replaces per-user N+1 calls to user_has_encryption
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_server_encryption_stats(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total int;
  v_with_keys int;
BEGIN
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
$$;

COMMENT ON FUNCTION public.get_server_encryption_stats(uuid) IS 'Get aggregated encryption adoption stats for a server in a single query';

-- ---------------------------------------------------------------------------
-- Function: handle_unified_notification_processing
-- Handles notifications for follows, reactions, and ActivityPub emoji reactions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    single_target_id uuid;
    notification_data jsonb;
    msg_channel_id uuid;
    msg_server_id uuid;
    msg_conversation_id uuid;
    msg_channel_name text;
    msg_server_name text;
    post_author_id uuid;
    post_record RECORD;
    emoji_record RECORD;
    emoji_name text;
    emoji_url text;
    reactor_profile RECORD;
    follower_profile RECORD;
BEGIN
    -- Handle follows
    IF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO follower_profile
        FROM profiles
        WHERE id = NEW.follower_id;

        IF follower_profile.id IS NOT NULL THEN
            notification_data := jsonb_build_object(
                'type', 'activitypub_follow',
                'follower_id', NEW.follower_id,
                'follower', notification_actor_json(
                    follower_profile.id,
                    follower_profile.username,
                    follower_profile.display_name,
                    follower_profile.avatar_url,
                    follower_profile.domain,
                    follower_profile.is_local
                )
            );

            PERFORM send_notification_to_user(
                'activitypub_follow',
                NEW.following_id,
                notification_data,
                NULL, NULL, NULL,
                NEW.follower_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'reactions' AND TG_OP = 'INSERT' THEN
        SELECT user_id INTO single_target_id FROM messages WHERE id = NEW.message_id;
        
        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            SELECT m.channel_id, c.server_id, m.conversation_id, c.name, s.name
            INTO msg_channel_id, msg_server_id, msg_conversation_id, msg_channel_name, msg_server_name
            FROM messages m 
            LEFT JOIN channels c ON m.channel_id = c.id
            LEFT JOIN servers s ON c.server_id = s.id
            WHERE m.id = NEW.message_id;
            
            SELECT id, username, display_name, avatar_url, domain, is_local
            INTO reactor_profile
            FROM profiles
            WHERE id = NEW.user_id;
            
            emoji_name := NULL;
            emoji_url := NULL;
            IF NEW.emoji_id IS NOT NULL THEN
                SELECT name, url INTO emoji_record FROM emojis WHERE id = NEW.emoji_id;
                IF FOUND THEN
                    emoji_name := emoji_record.name;
                    emoji_url := emoji_record.url;
                END IF;
            END IF;
            
            notification_data := jsonb_build_object(
                'type', 'reaction',
                'message_id', NEW.message_id,
                'channel_id', msg_channel_id,
                'server_id', msg_server_id,
                'channel_name', msg_channel_name,
                'server_name', msg_server_name,
                'message_preview', extract_message_text((SELECT content FROM messages WHERE id = NEW.message_id)),
                'reaction', jsonb_build_object(
                    'emoji_id', NEW.emoji_id,
                    'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content),
                    'emoji_url', emoji_url,
                    'custom_emoji_content', NEW.custom_emoji_content
                ),
                'sender', CASE WHEN reactor_profile.id IS NOT NULL THEN
                    notification_actor_json(
                        reactor_profile.id,
                        reactor_profile.username,
                        reactor_profile.display_name,
                        reactor_profile.avatar_url,
                        reactor_profile.domain,
                        reactor_profile.is_local
                    )
                ELSE NULL END
            );

            IF msg_conversation_id IS NOT NULL THEN
                notification_data := notification_data || jsonb_build_object(
                    'conversation_id', msg_conversation_id
                );
            END IF;
            
            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                msg_server_id, msg_channel_id, msg_conversation_id,
                NEW.user_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' AND TG_OP = 'INSERT' THEN
        IF NEW.interaction_type IN ('emoji_reaction', 'favorite', 'reblog') THEN
            SELECT author_id INTO post_author_id 
            FROM posts 
            WHERE id = NEW.post_id;
            
            IF post_author_id IS NOT NULL AND post_author_id != NEW.user_id THEN
                SELECT * INTO post_record FROM posts WHERE id = NEW.post_id;
                
                SELECT id, username, display_name, avatar_url, domain, is_local
                INTO reactor_profile
                FROM profiles
                WHERE id = NEW.user_id;
                
                emoji_name := NULL;
                emoji_url := NULL;
                IF NEW.emoji_id IS NOT NULL THEN
                    SELECT name, url INTO emoji_record FROM emojis WHERE id = NEW.emoji_id;
                    IF FOUND THEN
                        emoji_name := emoji_record.name;
                        emoji_url := emoji_record.url;
                    END IF;
                END IF;
                
                notification_data := jsonb_build_object(
                    'type', CASE
                        WHEN NEW.interaction_type = 'favorite' THEN 'activitypub_favorite'
                        WHEN NEW.interaction_type = 'reblog' THEN 'activitypub_reblog'
                        ELSE 'activitypub_reaction'
                    END,
                    'post_id', NEW.post_id,
                    'post', jsonb_build_object(
                        'id', post_record.id,
                        'content_preview', extract_message_text(post_record.content)
                    ),
                    'reaction', jsonb_build_object(
                        'emoji_id', NEW.emoji_id,
                        'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content),
                        'emoji_url', emoji_url,
                        'custom_emoji_content', NEW.custom_emoji_content
                    ),
                    'sender', CASE WHEN reactor_profile.id IS NOT NULL THEN
                        notification_actor_json(
                            reactor_profile.id,
                            reactor_profile.username,
                            reactor_profile.display_name,
                            reactor_profile.avatar_url,
                            reactor_profile.domain,
                            reactor_profile.is_local
                        )
                    ELSE NULL END
                );
                
                PERFORM send_notification_to_user(
                    CASE
                        WHEN NEW.interaction_type = 'favorite' THEN 'activitypub_favorite'
                        WHEN NEW.interaction_type = 'reblog' THEN 'activitypub_reblog'
                        ELSE 'activitypub_reaction'
                    END,
                    post_author_id,
                    notification_data,
                    NULL, NULL, NULL,
                    NEW.user_id,
                    'normal'
                );
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 'Handles notifications for follows (with full profile data), reactions, and ActivityPub emoji reactions. Includes full reactor/sender profile in notification data for proper display.';

-- ---------------------------------------------------------------------------
-- clear_orphaned_public_keys - Clear public keys without matching private keys
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clear_orphaned_public_keys()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    cleared_count INTEGER;
BEGIN
    UPDATE profiles p SET public_key = NULL
    WHERE p.is_local = true AND p.public_key IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM user_private_keys upk WHERE upk.user_id = p.id);
    GET DIAGNOSTICS cleared_count = ROW_COUNT;
    RETURN cleared_count;
END;
$$;

COMMENT ON FUNCTION public.clear_orphaned_public_keys() IS 'Clear public keys from local profiles that have no matching private key.';

-- ---------------------------------------------------------------------------
-- get_voice_channel_participants - Voice channel participants with user info
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_voice_channel_participants(p_channel_id UUID)
RETURNS TABLE (
    user_id UUID, username TEXT, display_name TEXT, avatar_url TEXT,
    is_federated BOOLEAN, federated_domain TEXT, joined_at TIMESTAMPTZ,
    is_muted BOOLEAN, is_deafened BOOLEAN, is_video_enabled BOOLEAN,
    is_screen_sharing BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT vcp.user_id, p.username, p.display_name, p.avatar_url,
        vcp.is_federated, p.domain AS federated_domain, vcp.joined_at,
        vcp.is_muted, vcp.is_deafened, vcp.is_video_enabled, vcp.is_screen_sharing
    FROM public.voice_channel_participants vcp
    JOIN public.profiles p ON p.id = vcp.user_id
    WHERE vcp.channel_id = p_channel_id
    ORDER BY vcp.joined_at ASC;
END;
$$;

-- ---------------------------------------------------------------------------
-- get_next_folder_position - Next available position for a server folder
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_next_folder_position(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql STABLE
AS $$
DECLARE max_position INTEGER;
BEGIN
    SELECT COALESCE(MAX(position), -1) + 1 INTO max_position
    FROM server_folders WHERE user_id = p_user_id;
    RETURN max_position;
END;
$$;

-- ---------------------------------------------------------------------------
-- get_next_server_position - Next available position for a server in a folder
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_next_server_position(p_user_id UUID, p_folder_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql STABLE
AS $$
DECLARE max_position INTEGER;
BEGIN
    IF p_folder_id IS NULL THEN
        SELECT COALESCE(MAX(position), -1) + 1 INTO max_position
        FROM user_servers WHERE user_id = p_user_id AND folder_id IS NULL;
    ELSE
        SELECT COALESCE(MAX(position), -1) + 1 INTO max_position
        FROM user_servers WHERE user_id = p_user_id AND folder_id = p_folder_id;
    END IF;
    RETURN max_position;
END;
$$;

-- ---------------------------------------------------------------------------
-- record_metric - Record a raw performance metric
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_metric(
    p_metric_type text, p_metric_name text, p_value double precision,
    p_unit text DEFAULT 'ms', p_labels jsonb DEFAULT '{}'::jsonb,
    p_source text DEFAULT 'backend'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
    INSERT INTO public.performance_metrics (
        metric_type, metric_name, value, unit, labels, source
    ) VALUES (
        p_metric_type, p_metric_name, p_value, p_unit, p_labels, p_source
    ) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Server Moderation RPCs
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
        RETURN 2147483647;
    END IF;

    SELECT COALESCE(MAX(sr.position), 0) INTO v_max_position
    FROM public.user_roles ur
    JOIN public.server_roles sr ON sr.id = ur.role_id
    WHERE ur.user_id = p_user_id
      AND ur.server_id = p_server_id;

    RETURN v_max_position;
END;
$$;

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

    -- Suppress the "has left the server" trigger - we post "was kicked" below.
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    DELETE FROM public.user_servers
    WHERE user_id = p_user_id AND server_id = p_server_id;

    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_user_id, 'kick', jsonb_build_object(
        'kicked_by', v_caller_id,
        'reason', COALESCE(p_reason, ''),
        'messages_deleted', v_deleted_count
    ));

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

    -- Suppress the "has left the server" trigger - we post "was banned" below.
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
-- Featured Communities RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_server_featured(
    p_server_id uuid,
    p_is_featured boolean,
    p_order integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_caller_id uuid;
    v_is_admin boolean;
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT is_admin INTO v_is_admin
    FROM public.profiles WHERE id = v_caller_id;

    IF NOT COALESCE(v_is_admin, false) THEN
        RAISE EXCEPTION 'Only instance admins can manage featured communities';
    END IF;

    UPDATE public.servers
    SET is_featured = p_is_featured, featured_order = p_order
    WHERE id = p_server_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Admin System Health RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_db_connection_count()
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
        RETURN 0;
    END IF;
    RETURN (SELECT COUNT(*)::integer FROM pg_stat_activity WHERE datname = current_database());
END;
$$;

CREATE OR REPLACE FUNCTION public.get_db_size()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
        RETURN '--';
    END IF;
    RETURN (SELECT pg_size_pretty(pg_database_size(current_database())));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_user_counts(p_user_ids uuid[])
RETURNS TABLE(user_id uuid, post_count bigint, server_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH post_counts AS (
    SELECT author_id, COUNT(*)::bigint AS cnt
    FROM public.posts
    WHERE author_id = ANY(p_user_ids) AND is_deleted = false
    GROUP BY author_id
  ),
  server_counts AS (
    SELECT user_id, COUNT(*)::bigint AS cnt
    FROM public.user_servers
    WHERE user_id = ANY(p_user_ids)
    GROUP BY user_id
  )
  SELECT
    id AS user_id,
    COALESCE(pc.cnt, 0) AS post_count,
    COALESCE(sc.cnt, 0) AS server_count
  FROM unnest(p_user_ids) AS id
  LEFT JOIN post_counts pc ON pc.author_id = id
  LEFT JOIN server_counts sc ON sc.user_id = id;
$$;

CREATE OR REPLACE FUNCTION public.get_server_member_counts(p_server_ids uuid[])
RETURNS TABLE(server_id uuid, member_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH counts AS (
    SELECT server_id, COUNT(*)::bigint AS cnt
    FROM public.user_servers
    WHERE server_id = ANY(p_server_ids)
    GROUP BY server_id
  )
  SELECT id AS server_id, COALESCE(c.cnt, 0) AS member_count
  FROM unnest(p_server_ids) AS id
  LEFT JOIN counts c ON c.server_id = id;
$$;

-- ---------------------------------------------------------------------------
-- Announcements RPC
-- ---------------------------------------------------------------------------
-- Two-arg signature: `p_popup_only` lets callers (the AnnouncementPopup)
-- ask for the strictly popup-eligible subset. When true:
--   * `show_popup = true` is required (admin opt-out for popup display)
--   * `starts_at >= profiles.created_at` is required so brand-new users
--     don't get spammed with the entire historical backlog
--   * the result set is capped at 10 rows to protect long-absent users
-- When false (default), behaviour matches the original one-arg shape so
-- the Settings archive unread set and the sidebar unread count are
-- unaffected. See migration 20260526_announcements_popup_filter.sql.
CREATE OR REPLACE FUNCTION public.get_unread_announcements(
    p_user_id uuid,
    p_popup_only boolean DEFAULT false
)
RETURNS TABLE(
    id uuid,
    title text,
    content text,
    image_url text,
    icon text,
    is_pinned boolean,
    show_popup boolean,
    silence boolean,
    created_at timestamptz,
    author_id uuid,
    author_username text,
    author_display_name text,
    author_avatar_url text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH joined AS (
        SELECT COALESCE(
            (SELECT created_at FROM public.profiles WHERE id = p_user_id),
            'epoch'::timestamptz
        ) AS user_created_at
    )
    SELECT
        a.id, a.title, a.content, a.image_url, a.icon,
        a.is_pinned, a.show_popup, a.silence, a.created_at,
        a.author_id, p.username AS author_username,
        p.display_name AS author_display_name,
        p.avatar_url AS author_avatar_url
    FROM public.instance_announcements a
    LEFT JOIN public.profiles p ON p.id = a.author_id
    LEFT JOIN public.announcement_reads ar
        ON ar.announcement_id = a.id AND ar.user_id = p_user_id
    CROSS JOIN joined j
    WHERE a.is_active = true
      AND a.starts_at <= NOW()
      AND (a.ends_at IS NULL OR a.ends_at > NOW())
      AND ar.id IS NULL
      AND (
          NOT p_popup_only
          OR (
              a.show_popup = true
              AND a.starts_at >= j.user_created_at
          )
      )
    ORDER BY a.is_pinned DESC, a.display_order ASC, a.created_at DESC
    LIMIT CASE WHEN p_popup_only THEN 10 ELSE 1000 END;
$$;

-- ---------------------------------------------------------------------------
-- Federation: insert outbound AP activity (bypasses PostgREST schema cache)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.insert_ap_activity_outbound(
    p_ap_id text,
    p_ap_type text,
    p_actor_id uuid,
    p_actor_ap_id text,
    p_activity_data jsonb,
    p_object_id text DEFAULT NULL,
    p_object_type text DEFAULT NULL,
    p_to_addresses text[] DEFAULT '{}'::text[],
    p_cc_addresses text[] DEFAULT '{}'::text[],
    p_origin_domain text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_activity_id uuid;
    v_caller_profile_id uuid;
BEGIN
    v_caller_profile_id := public.get_current_profile_id();
    IF v_caller_profile_id IS NULL OR v_caller_profile_id != p_actor_id THEN
        RAISE EXCEPTION 'Unauthorized: p_actor_id does not match the authenticated user';
    END IF;

    INSERT INTO ap_activities (
        ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
        activity_data, status, is_local, to_addresses, cc_addresses, origin_domain
    ) VALUES (
        p_ap_id, p_ap_type, p_actor_id, p_actor_ap_id, p_object_id, p_object_type,
        p_activity_data, 'pending', true, p_to_addresses, p_cc_addresses, p_origin_domain
    )
    RETURNING id INTO v_activity_id;

    RETURN v_activity_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Federation: get or create federated group conversation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_or_create_federated_group_conversation(
  p_actor_id uuid,
  p_local_recipient_ids uuid[],
  p_remote_conversation_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversation_id uuid;
  v_participant_id uuid;
  v_all_ids uuid[];
BEGIN
  IF p_local_recipient_ids IS NULL OR array_length(p_local_recipient_ids, 1) < 1 THEN
    RAISE EXCEPTION 'At least 1 local recipient required';
  END IF;

  v_all_ids := ARRAY(SELECT DISTINCT unnest(p_local_recipient_ids || ARRAY[p_actor_id]) ORDER BY 1);

  IF p_remote_conversation_id IS NOT NULL THEN
    SELECT c.id INTO v_conversation_id
    FROM conversations c
    WHERE c.type = 'group'
      AND c.metadata->>'remote_conversation_id' = p_remote_conversation_id
    LIMIT 1;

    IF v_conversation_id IS NOT NULL THEN
      RETURN v_conversation_id;
    END IF;
  END IF;

  SELECT c.id INTO v_conversation_id
  FROM conversations c
  WHERE c.type = 'group'
    AND EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.user_id = p_actor_id AND cp.left_at IS NULL)
    AND (SELECT array_agg(cp.user_id ORDER BY cp.user_id) FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.left_at IS NULL)
      = (SELECT array_agg(uid ORDER BY uid) FROM unnest(v_all_ids) uid)
  LIMIT 1;

  IF v_conversation_id IS NOT NULL THEN
    IF p_remote_conversation_id IS NOT NULL THEN
      UPDATE conversations
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('remote_conversation_id', p_remote_conversation_id)
      WHERE id = v_conversation_id
        AND (metadata IS NULL OR metadata->>'remote_conversation_id' IS NULL);
    END IF;
    RETURN v_conversation_id;
  END IF;

  INSERT INTO conversations (type, name, created_by, metadata)
  VALUES (
    'group',
    NULL,
    p_actor_id,
    CASE
      WHEN p_remote_conversation_id IS NOT NULL
      THEN jsonb_build_object('federated', true, 'remote_conversation_id', p_remote_conversation_id)
      ELSE '{"federated": true}'::jsonb
    END
  )
  RETURNING id INTO v_conversation_id;

  INSERT INTO conversation_participants (conversation_id, user_id, role)
  VALUES (v_conversation_id, p_actor_id, 'admin')
  ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, role = 'admin';

  FOREACH v_participant_id IN ARRAY p_local_recipient_ids
  LOOP
    IF v_participant_id != p_actor_id THEN
      INSERT INTO conversation_participants (conversation_id, user_id, role)
      VALUES (v_conversation_id, v_participant_id, 'member')
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, role = 'member';
    END IF;
  END LOOP;

  RETURN v_conversation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_db_connection_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_db_size() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_user_counts(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_server_member_counts(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_unread_announcements(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.insert_ap_activity_outbound(text, text, uuid, text, jsonb, text, text, text[], text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.insert_ap_activity_outbound(text, text, uuid, text, jsonb, text, text, text[], text[], text) TO service_role;

-- ---------------------------------------------------------------------------
-- Function: check_and_increment_bot_rate_limit
--
-- Atomic per-(bot, bucket) rate-limit check + increment in one statement.
-- Replaces the previous read-modify-write pattern in
-- `bot-gateway/src/auth/BotAuthMiddleware.checkRateLimit()`, which was
-- documented as racy in BUGS.md M37: two concurrent requests could each
-- read `request_count = N`, each pass the `< max_requests` check, then
-- both write `N + 1` - letting through ~2× the allowed burst.
--
-- Behaviour:
--   - First request for a (bot, bucket) pair: INSERT with count=1, return false.
--   - Subsequent request within the window: UPDATE +1 atomically, return
--     true iff the post-increment count > p_limit.
--   - Subsequent request AFTER the window expired: reset count to 1 and
--     extend `resets_at`, return false.
--
-- Returns:
--   `true`  → caller MUST reject the request with HTTP 429.
--   `false` → caller may proceed.
--
-- Concurrency model:
--   INSERT ... ON CONFLICT ... DO UPDATE is atomic at the row level; the
--   UPDATE clause re-reads the conflicting row under an exclusive lock,
--   so the CASE expression sees a consistent snapshot. No race even
--   under thousands of concurrent calls for the same (bot, bucket).
--
-- The signature accepts `p_limit` and `p_window_seconds` so callers can
-- vary per-bucket. These are also persisted on the row (`max_requests`,
-- `window_duration_seconds`) for visibility, but the function uses the
-- parameters as the source of truth on this call - letting callers
-- change a bucket's limit without a separate migration.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_and_increment_bot_rate_limit(
    p_bot_id uuid,
    p_bucket text,
    p_limit integer DEFAULT 100,
    p_window_seconds integer DEFAULT 60
) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    INSERT INTO public.bot_rate_limits (
        bot_id, bucket,
        request_count, window_start, window_duration_seconds, max_requests, resets_at
    )
    VALUES (
        p_bot_id, p_bucket,
        1, NOW(), p_window_seconds, p_limit,
        NOW() + make_interval(secs => p_window_seconds)
    )
    ON CONFLICT (bot_id, bucket) DO UPDATE
        SET
            request_count = CASE
                WHEN public.bot_rate_limits.resets_at < NOW() THEN 1
                ELSE public.bot_rate_limits.request_count + 1
            END,
            window_start = CASE
                WHEN public.bot_rate_limits.resets_at < NOW() THEN NOW()
                ELSE public.bot_rate_limits.window_start
            END,
            window_duration_seconds = p_window_seconds,
            max_requests = p_limit,
            resets_at = CASE
                WHEN public.bot_rate_limits.resets_at < NOW() THEN NOW() + make_interval(secs => p_window_seconds)
                ELSE public.bot_rate_limits.resets_at
            END
    RETURNING request_count INTO v_count;

    RETURN v_count > p_limit;
END;
$$;

COMMENT ON FUNCTION public.check_and_increment_bot_rate_limit(uuid, text, integer, integer) IS
    'Atomic per-(bot, bucket) rate-limit check + increment. Returns true if the caller is rate-limited (HTTP 429), false otherwise. Fixes BUGS.md M37 race condition.';

-- The bot-gateway connects with the service role key, so only service_role
-- needs EXECUTE in normal operation. `authenticated` is granted as well
-- for any future server-side function that wants to call this from an
-- authenticated context.
GRANT EXECUTE ON FUNCTION public.check_and_increment_bot_rate_limit(uuid, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_increment_bot_rate_limit(uuid, text, integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Function: lookup_invite_by_code (ported from
-- 20260520_invites_restrict_select_to_owner_and_rpc.sql - C10)
--
-- Single-code invite lookup for the accept / preview flows. SELECT on
-- public.invites is restricted to the creator and instance admins, so this
-- SECURITY DEFINER RPC is the only public path - one specific code per call,
-- no enumeration.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lookup_invite_by_code(p_code text)
RETURNS TABLE (
    id uuid,
    code text,
    server_id uuid,
    created_by uuid,
    uses integer,
    max_uses integer,
    used boolean,
    temporary boolean,
    expires_at timestamptz,
    created_at timestamptz,
    server_name text,
    server_icon text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT
        i.id,
        i.code,
        i.server_id,
        i.created_by,
        i.uses,
        i.max_uses,
        i.used,
        i.temporary,
        i.expires_at,
        i.created_at,
        s.name AS server_name,
        s.icon AS server_icon
    FROM public.invites i
    LEFT JOIN public.servers s ON s.id = i.server_id
    WHERE i.code = p_code
    LIMIT 1;
$$;

COMMENT ON FUNCTION public.lookup_invite_by_code(text) IS
    'Public-facing invite-code → invite-row lookup. Bypasses RLS so the accept-flow can validate an invite before the user joins. Single-row, no enumeration.';

GRANT EXECUTE ON FUNCTION public.lookup_invite_by_code(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Function: redeem_recovery_code_and_disable_mfa (ported from
-- 20260703_recovery_code_mfa_unenroll_rpc.sql - C11)
--
-- Atomic recovery-code redemption: verifies AND consumes an unused recovery
-- code for the calling user, then removes their MFA factors server-side.
-- Replaces the client-side verify + AAL1 mfa.unenroll flow.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_recovery_code_and_disable_mfa(p_code text)
RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_user_id uuid;
  v_profile_id uuid;
  v_code_hash text;
  v_code_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: requires an authenticated session'
      USING ERRCODE = '42501';
  END IF;

  IF p_code IS NULL OR length(p_code) < 8 THEN
    RETURN false;
  END IF;

  -- mfa_recovery_codes.user_id FKs to profiles(id); save_recovery_codes
  -- writes rows under the PROFILE id, so the lookup must too (Pattern A).
  v_profile_id := public.get_current_profile_id();
  IF v_profile_id IS NULL THEN
    RETURN false;
  END IF;

  v_code_hash := encode(extensions.digest(p_code::bytea, 'sha256'), 'hex');

  UPDATE public.mfa_recovery_codes
  SET used_at = NOW()
  WHERE id = (
    SELECT id FROM public.mfa_recovery_codes
    WHERE user_id = v_profile_id
      AND code_hash = v_code_hash
      AND used_at IS NULL
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id INTO v_code_id;

  IF v_code_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM auth.mfa_factors WHERE user_id = v_user_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_recovery_code_and_disable_mfa(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_recovery_code_and_disable_mfa(text) TO authenticated;


-- ---------------------------------------------------------------------------
-- Function: delete_my_account (ported from 20260703_account_deletion_rpc.sql)
--
-- Self-service account deletion: MFA step-up enforced server-side, profile
-- anonymized to a tombstone (content keeps rendering as "Deleted User"),
-- personal data purged, auth.users row removed last.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_auth_id uuid;
  v_profile_id uuid;
  v_aal text;
  v_has_verified_mfa boolean;
  v_blocking_servers text[];
BEGIN
  v_auth_id := auth.uid();
  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: requires an authenticated session'
      USING ERRCODE = '42501';
  END IF;

  -- MFA step-up gate (server-side, cannot be bypassed by a modified client).
  SELECT EXISTS (
    SELECT 1 FROM auth.mfa_factors
    WHERE user_id = v_auth_id AND status = 'verified'
  ) INTO v_has_verified_mfa;

  IF v_has_verified_mfa THEN
    v_aal := current_setting('request.jwt.claims', true)::jsonb ->> 'aal';
    IF v_aal IS DISTINCT FROM 'aal2' THEN
      RETURN jsonb_build_object('error', 'mfa_required');
    END IF;
  END IF;

  SELECT id INTO v_profile_id
  FROM public.profiles
  WHERE auth_user_id = v_auth_id;

  IF v_profile_id IS NOT NULL THEN
    -- Refuse while the caller owns servers that other people are members of.
    SELECT array_agg(s.name) INTO v_blocking_servers
    FROM public.servers s
    WHERE s.owner = v_profile_id
      AND EXISTS (
        SELECT 1 FROM public.user_servers us
        WHERE us.server_id = s.id
          AND us.user_id <> v_profile_id
      );

    IF v_blocking_servers IS NOT NULL AND array_length(v_blocking_servers, 1) > 0 THEN
      RETURN jsonb_build_object(
        'error', 'transfer_ownership_required',
        'servers', to_jsonb(v_blocking_servers)
      );
    END IF;

    -- Solo servers (caller is the only member) go away with the account.
    DELETE FROM public.servers s
    WHERE s.owner = v_profile_id;

    -- Purge personal data. Content tables (messages, posts, channels,
    -- conversations) are intentionally NOT touched - they keep pointing at
    -- the anonymized profile.
    DELETE FROM public.user_key_pairs        WHERE user_id = v_profile_id;
    DELETE FROM public.megolm_session_shares WHERE sender_user_id = v_profile_id OR recipient_user_id = v_profile_id;
    DELETE FROM public.megolm_key_requests   WHERE requester_user_id = v_profile_id OR sender_user_id = v_profile_id;
    DELETE FROM public.megolm_key_backups    WHERE user_id = v_profile_id;
    DELETE FROM public.recovery_key_metadata WHERE user_id = v_profile_id;
    DELETE FROM public.mfa_recovery_codes    WHERE user_id = v_profile_id;
    DELETE FROM public.follows               WHERE follower_id = v_profile_id OR following_id = v_profile_id;
    DELETE FROM public.timeline_entries      WHERE user_id = v_profile_id;
    DELETE FROM public.unread_counts         WHERE user_id = v_profile_id;
    DELETE FROM public.post_interactions     WHERE user_id = v_profile_id;
    DELETE FROM public.invites               WHERE created_by = v_profile_id;
    DELETE FROM public.user_servers          WHERE user_id = v_profile_id;

    -- Optional tables (deployments differ); ignore when absent.
    BEGIN
      DELETE FROM public.user_devices WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table THEN NULL;
    END;
    BEGIN
      DELETE FROM public.push_subscriptions WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table THEN NULL;
    END;
    BEGIN
      DELETE FROM public.notifications WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table THEN NULL;
    END;
    BEGIN
      DELETE FROM public.user_blocks WHERE blocker_id = v_profile_id OR blocked_user_id = v_profile_id;
    EXCEPTION WHEN undefined_table THEN NULL;
    END;
    BEGIN
      DELETE FROM public.user_private_keys WHERE user_id = v_profile_id;
    EXCEPTION WHEN undefined_table THEN NULL;
    END;

    -- Anonymize. auth_user_id = NULL detaches the row from auth.users BEFORE
    -- the auth delete below, so the CASCADE cannot reach it. The generated
    -- username satisfies profiles_username_check and is unique per domain.
    UPDATE public.profiles SET
      username = 'deleted_' || replace(substr(v_profile_id::text, 1, 13), '-', ''),
      display_name = 'Deleted User',
      avatar_url = '/default_avatar.webp',
      banner_url = NULL,
      bio = NULL,
      color = NULL,
      status = 0,
      custom_status = NULL,
      profile_fields = '[]'::jsonb,
      appearance_settings = NULL,
      public_key = NULL,
      federated_id = NULL,
      inbox_url = NULL,
      outbox_url = NULL,
      followers_url = NULL,
      following_url = NULL,
      featured_url = NULL,
      shared_inbox_url = NULL,
      federation_metadata = '{}'::jsonb,
      is_admin = false,
      is_moderator = false,
      federation_enabled = false,
      federation_discoverable = false,
      followers_count = 0,
      following_count = 0,
      auth_user_id = NULL,
      updated_at = now()
    WHERE id = v_profile_id;
  END IF;

  -- Finally remove the auth user. Cascades auth-side rows (sessions,
  -- identities, mfa_factors) via Supabase's own FKs.
  DELETE FROM auth.users WHERE id = v_auth_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_my_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;
