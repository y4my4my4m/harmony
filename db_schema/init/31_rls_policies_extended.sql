-- =============================================================================
-- Harmony Database Schema - Extended RLS Policies
-- =============================================================================
-- RLS policies for additional tables: trending, bots, encryption
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper: Check if user is admin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- ---------------------------------------------------------------------------
-- Helper: Check if user is instance moderator
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_current_user_moderator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT is_moderator FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- ---------------------------------------------------------------------------
-- Helper: Check if user is admin OR moderator
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_current_user_admin_or_mod()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT (is_admin OR is_moderator) FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- ---------------------------------------------------------------------------
-- Helper: Check if current user can manage messages in a given channel
-- Checks server ownership, server admin role, and MANAGE_MESSAGES (bit 21)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_current_user_manage_messages_in_channel(p_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile_id uuid;
    v_server_id uuid;
    v_is_owner boolean;
    v_has_perm boolean;
BEGIN
    v_profile_id := public.get_current_profile_id();
    IF v_profile_id IS NULL THEN RETURN false; END IF;

    SELECT server_id INTO v_server_id FROM public.channels WHERE id = p_channel_id;
    IF v_server_id IS NULL THEN RETURN false; END IF;

    SELECT (owner = v_profile_id) INTO v_is_owner FROM public.servers WHERE id = v_server_id;
    IF v_is_owner THEN RETURN true; END IF;

    -- Check if user has a role with ADMINISTRATOR (bit 0) or MANAGE_MESSAGES (bit 21)
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.server_roles sr ON sr.id = ur.role_id
        WHERE ur.user_id = v_profile_id
          AND sr.server_id = v_server_id
          AND (
              sr.is_admin = true
              OR (sr.permissions & (1::bigint << 0)) != 0
              OR (sr.permissions & (1::bigint << 21)) != 0
          )
    ) INTO v_has_perm;

    RETURN v_has_perm;
END;
$$;

-- ---------------------------------------------------------------------------
-- TRENDING POSTS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.trending_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trending_posts_select_all" ON public.trending_posts
    FOR SELECT USING (true);

-- Only system/admin can modify trending data
CREATE POLICY "trending_posts_admin_modify" ON public.trending_posts
    FOR ALL USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- TRENDING USERS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.trending_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trending_users_select_all" ON public.trending_users
    FOR SELECT USING (true);

CREATE POLICY "trending_users_admin_modify" ON public.trending_users
    FOR ALL USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- TRENDING REFRESH QUEUE RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.trending_refresh_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trending_refresh_queue_admin_only" ON public.trending_refresh_queue
    FOR ALL USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- SERVER FOLDERS RLS (user-owned)
-- ---------------------------------------------------------------------------
ALTER TABLE public.server_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "server_folders_select_own" ON public.server_folders
    FOR SELECT USING (user_id = public.get_current_profile_id());

CREATE POLICY "server_folders_insert_own" ON public.server_folders
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

CREATE POLICY "server_folders_update_own" ON public.server_folders
    FOR UPDATE USING (user_id = public.get_current_profile_id());

CREATE POLICY "server_folders_delete_own" ON public.server_folders
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- SERVER SETTINGS RLS (server owner/admin)
-- ---------------------------------------------------------------------------
ALTER TABLE public.server_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "server_settings_select_member" ON public.server_settings
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = server_settings.server_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    );

CREATE POLICY "server_settings_modify_owner" ON public.server_settings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = server_settings.server_id
            AND s.owner = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- CHANNEL PERMISSION OVERRIDES RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.channel_permission_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "channel_permission_overrides_select" ON public.channel_permission_overrides
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.user_servers us ON us.server_id = c.server_id
            WHERE c.id = channel_permission_overrides.channel_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    );

-- Server owners, instance staff (is_admin / is_moderator), and members with
-- MANAGE_CHANNELS, MANAGE_ROLES, or ADMINISTRATOR can manage overrides.
-- See migrations/20260524_channel_overrides_fix.sql for the reasoning.
DROP POLICY IF EXISTS "channel_permission_overrides_modify_owner"
    ON public.channel_permission_overrides;
DROP POLICY IF EXISTS "channel_permission_overrides_modify"
    ON public.channel_permission_overrides;
CREATE POLICY "channel_permission_overrides_modify" ON public.channel_permission_overrides
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            LEFT JOIN public.profiles p ON p.id = public.get_current_profile_id()
            WHERE c.id = channel_permission_overrides.channel_id
              AND (
                    s.owner = public.get_current_profile_id()
                    OR COALESCE(p.is_admin, false)
                    OR COALESCE(p.is_moderator, false)
                    OR EXISTS (
                        SELECT 1 FROM public.user_roles ur
                        JOIN public.server_roles sr ON sr.id = ur.role_id
                        WHERE ur.user_id = public.get_current_profile_id()
                          AND ur.server_id = s.id
                          AND (
                                (sr.permissions::bigint & (1::bigint << 0)) <> 0
                             OR (sr.permissions::bigint & (1::bigint << 2)) <> 0
                             OR (sr.permissions::bigint & (1::bigint << 3)) <> 0
                          )
                    )
              )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            LEFT JOIN public.profiles p ON p.id = public.get_current_profile_id()
            WHERE c.id = channel_permission_overrides.channel_id
              AND (
                    s.owner = public.get_current_profile_id()
                    OR COALESCE(p.is_admin, false)
                    OR COALESCE(p.is_moderator, false)
                    OR EXISTS (
                        SELECT 1 FROM public.user_roles ur
                        JOIN public.server_roles sr ON sr.id = ur.role_id
                        WHERE ur.user_id = public.get_current_profile_id()
                          AND ur.server_id = s.id
                          AND (
                                (sr.permissions::bigint & (1::bigint << 0)) <> 0
                             OR (sr.permissions::bigint & (1::bigint << 2)) <> 0
                             OR (sr.permissions::bigint & (1::bigint << 3)) <> 0
                          )
                    )
              )
        )
    );

-- ---------------------------------------------------------------------------
-- USER MUTES RLS (own mutes only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_mutes ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS user_mutes_select_own ON public.user_mutes;
DROP POLICY IF EXISTS user_mutes_insert_own on public.user_mutes;
DROP POLICY IF EXISTS user_mutes_update_own on public.user_mutes;
DROP POLICY IF EXISTS user_mutes_delete_own on public.user_mutes;

CREATE POLICY "user_mutes_select_own" ON public.user_mutes
    FOR SELECT USING (muter_id = public.get_current_profile_id());

CREATE POLICY "user_mutes_insert_own" ON public.user_mutes
    FOR INSERT WITH CHECK (muter_id = public.get_current_profile_id());

CREATE POLICY "user_mutes_update_own" ON public.user_mutes
    FOR UPDATE USING (muter_id = public.get_current_profile_id());

CREATE POLICY "user_mutes_delete_own" ON public.user_mutes
    FOR DELETE USING (muter_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- BOT TABLES RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.bot_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_audit_log ENABLE ROW LEVEL SECURITY;

-- Bot commands: public read, owner modify
CREATE POLICY "bot_commands_select_all" ON public.bot_commands
    FOR SELECT USING (true);

CREATE POLICY "bot_commands_modify_owner" ON public.bot_commands
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.bots b
            WHERE b.id = bot_commands.bot_id
            AND b.owner_id = public.get_current_profile_id()
        )
    );

-- Bot webhooks: owner only
CREATE POLICY "bot_webhooks_owner_only" ON public.bot_webhooks
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.bots b
            WHERE b.id = bot_webhooks.bot_id
            AND b.owner_id = public.get_current_profile_id()
        )
    );

-- Bot presence: public read, owner modify
CREATE POLICY "bot_presence_select_all" ON public.bot_presence
    FOR SELECT USING (true);

CREATE POLICY "bot_presence_modify_owner" ON public.bot_presence
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.bots b
            WHERE b.id = bot_presence.bot_id
            AND b.owner_id = public.get_current_profile_id()
        )
    );

-- Bot rate limits: owner only
CREATE POLICY "bot_rate_limits_owner_only" ON public.bot_rate_limits
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.bots b
            WHERE b.id = bot_rate_limits.bot_id
            AND b.owner_id = public.get_current_profile_id()
        )
    );

-- Bot audit log: owner read, system write
CREATE POLICY "bot_audit_log_select_owner" ON public.bot_audit_log
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.bots b
            WHERE b.id = bot_audit_log.bot_id
            AND b.owner_id = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    );

-- ---------------------------------------------------------------------------
-- ENCRYPTION TABLES RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_private_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_room_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_session_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_key_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_key_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_key_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_encryption_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_encryption_settings ENABLE ROW LEVEL SECURITY;

-- User private keys: service_role only (federation backend uses service_role key)
DROP POLICY IF EXISTS "user_private_keys_own_only" ON public.user_private_keys;
DROP POLICY IF EXISTS "Service role only access" ON public.user_private_keys;
CREATE POLICY "Service role only access" ON public.user_private_keys
    USING (auth.role() = 'service_role');

-- Megolm room sessions: creator or shared with
CREATE POLICY "megolm_room_sessions_select" ON public.megolm_room_sessions
    FOR SELECT USING (
        creator_user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.megolm_session_shares
            WHERE session_id = megolm_room_sessions.session_id
            AND room_id = megolm_room_sessions.room_id
            AND recipient_user_id = public.get_current_profile_id()
        )
    );

CREATE POLICY "megolm_room_sessions_insert_own" ON public.megolm_room_sessions
    FOR INSERT WITH CHECK (creator_user_id = public.get_current_profile_id());

CREATE POLICY "megolm_room_sessions_update_own" ON public.megolm_room_sessions
    FOR UPDATE USING (creator_user_id = public.get_current_profile_id());

-- Megolm session shares: sender (the one who wrapped the key) or recipient.
-- The client tracks the outbound session locally and never writes a
-- megolm_room_sessions row, so authorization keys off sender_user_id rather
-- than the (frequently absent) room-session creator.
CREATE POLICY "megolm_session_shares_select" ON public.megolm_session_shares
    FOR SELECT USING (
        recipient_user_id = public.get_current_profile_id()
        OR sender_user_id = public.get_current_profile_id()
    );

-- Sender must be the caller AND both sender and recipient must belong to the
-- room. Without the membership checks, a malicious member could wrap a room's
-- session key to an arbitrary recipient outside the room, leaking all messages
-- in that Megolm session.
CREATE POLICY "megolm_session_shares_insert" ON public.megolm_session_shares
    FOR INSERT WITH CHECK (
        sender_user_id = public.get_current_profile_id()
        -- room_id::text: is_room_member takes (text, uuid). Cast is a no-op on
        -- text columns and keeps the policy resolvable if room_id is ever uuid.
        AND public.is_room_member(room_id::text, sender_user_id)
        AND public.is_room_member(room_id::text, recipient_user_id)
    );

CREATE POLICY "megolm_session_shares_update" ON public.megolm_session_shares
    FOR UPDATE USING (
        sender_user_id = public.get_current_profile_id()
        OR recipient_user_id = public.get_current_profile_id()
    );

-- Megolm key requests: own requests
CREATE POLICY "megolm_key_requests_own" ON public.megolm_key_requests
    FOR ALL USING (requester_user_id = public.get_current_profile_id());

-- Also allow viewing requests addressed to me (I'm the designated fulfiller),
-- or requests for sessions I created.
CREATE POLICY "megolm_key_requests_select_for_response" ON public.megolm_key_requests
    FOR SELECT USING (
        sender_user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.megolm_room_sessions mrs
            WHERE mrs.session_id = megolm_key_requests.session_id
            AND mrs.room_id = megolm_key_requests.room_id
            AND mrs.creator_user_id = public.get_current_profile_id()
        )
    );

-- Allow the designated fulfiller (sender_user_id) to mark a request fulfilled.
-- Without this the auto-fulfill UPDATE in MegolmKeyBackupService silently fails
-- RLS, so requesters never receive the key. Restricted to the addressed user.
CREATE POLICY "megolm_key_requests_fulfill" ON public.megolm_key_requests
    FOR UPDATE USING (sender_user_id = public.get_current_profile_id())
    WITH CHECK (sender_user_id = public.get_current_profile_id());

-- Megolm key backups: own only
CREATE POLICY "megolm_key_backups_own_only" ON public.megolm_key_backups
    FOR ALL USING (user_id = public.get_current_profile_id());

-- User devices: the OWNER reads their own device rows in full (device-management
-- UI); only the owner may write. Other users get NO direct row access - a
-- blanket authenticated SELECT leaked every account's device label / platform /
-- last_seen_at / trust_state to all clients. Cross-user lookups need only the
-- PUBLIC signing-key material and go through the SECURITY DEFINER
-- get_device_signing_key() RPC below.
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_devices_select" ON public.user_devices;
DROP POLICY IF EXISTS "user_devices_select_own" ON public.user_devices;
CREATE POLICY "user_devices_select_own" ON public.user_devices
    FOR SELECT USING (user_id = public.get_current_profile_id());
CREATE POLICY "user_devices_insert_own" ON public.user_devices
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());
CREATE POLICY "user_devices_update_own" ON public.user_devices
    FOR UPDATE USING (user_id = public.get_current_profile_id());
CREATE POLICY "user_devices_delete_own" ON public.user_devices
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- Narrow cross-user read for v3 signature verification: returns ONLY a device's
-- public signing key + revoked flag, never the rest of the device row.
CREATE OR REPLACE FUNCTION public.get_device_signing_key(p_user_id uuid, p_device_id text)
RETURNS TABLE (device_signing_public_key text, revoked_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT ud.device_signing_public_key, ud.revoked_at
    FROM public.user_devices ud
    WHERE ud.user_id = p_user_id AND ud.device_id = p_device_id
    LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_device_signing_key(uuid, text) TO authenticated;

-- Device approval requests: account-scoped. A device may SELECT its account's
-- requests and INSERT its own (raising a "new login" prompt), but it may NOT
-- directly UPDATE a request to 'approved'. Approval/denial flow exclusively
-- through the SECURITY DEFINER RPCs approve_device_request / deny_device_request,
-- which verify the approver is an established device. This closes the
-- self-approval hole where any account session could approve its own login.
ALTER TABLE public.device_approval_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "device_approval_requests_own" ON public.device_approval_requests;
CREATE POLICY "device_approval_requests_select_own" ON public.device_approval_requests
    FOR SELECT USING (user_id = public.get_current_profile_id());
CREATE POLICY "device_approval_requests_insert_own" ON public.device_approval_requests
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

-- Room epoch state: readable by any authenticated client (needed to tag the
-- correct epoch on send/decrypt). Writes happen only via SECURITY DEFINER
-- triggers / RPCs, so no write policy is granted here.
ALTER TABLE public.room_epoch_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "room_epoch_state_select" ON public.room_epoch_state
    FOR SELECT USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

-- Recovery key metadata: own only
CREATE POLICY "recovery_key_metadata_own_only" ON public.recovery_key_metadata
    FOR ALL USING (user_id = public.get_current_profile_id());

-- MFA recovery codes: own only
CREATE POLICY "mfa_recovery_codes_own_only" ON public.mfa_recovery_codes
    FOR ALL USING (user_id = public.get_current_profile_id());

-- Conversation encryption settings: participants only
CREATE POLICY "conversation_encryption_settings_select" ON public.conversation_encryption_settings
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = conversation_encryption_settings.conversation_id
            AND cp.user_id = public.get_current_profile_id()
        )
    );

CREATE POLICY "conversation_encryption_settings_modify" ON public.conversation_encryption_settings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = conversation_encryption_settings.conversation_id
            AND cp.user_id = public.get_current_profile_id()
            AND cp.left_at IS NULL
        )
    );

-- Server encryption settings: server owner/admin
CREATE POLICY "server_encryption_settings_select" ON public.server_encryption_settings
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = server_encryption_settings.server_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    );

CREATE POLICY "server_encryption_settings_modify" ON public.server_encryption_settings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = server_encryption_settings.server_id
            AND s.owner = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- PERFORMANCE/MONITORING TABLES RLS (Admin only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.slow_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federation_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_metrics_hourly ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "slow_queries_admin_only" ON public.slow_queries;
CREATE POLICY "slow_queries_admin_only" ON public.slow_queries
    FOR ALL USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "federation_health_select_all" ON public.federation_health;
CREATE POLICY "federation_health_select_all" ON public.federation_health
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "federation_health_modify_admin" ON public.federation_health;
CREATE POLICY "federation_health_modify_admin" ON public.federation_health
    FOR ALL USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "performance_metrics_hourly_select_all" ON public.performance_metrics_hourly;
CREATE POLICY "performance_metrics_hourly_select_all" ON public.performance_metrics_hourly
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "performance_metrics_hourly_modify_admin" ON public.performance_metrics_hourly;
CREATE POLICY "performance_metrics_hourly_modify_admin" ON public.performance_metrics_hourly
    FOR ALL USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- REMOTE EMOJIS CACHE RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.remote_emojis_cache ENABLE ROW LEVEL SECURITY;

-- Anyone can view cached remote emojis
CREATE POLICY "remote_emojis_cache_select_all" ON public.remote_emojis_cache
    FOR SELECT USING (true);

-- Only system/admin can modify
CREATE POLICY "remote_emojis_cache_admin_modify" ON public.remote_emojis_cache
    FOR ALL USING (public.is_current_user_admin());

-- Service role (federation backend) can manage remote emojis
CREATE POLICY "Service role can manage remote emojis" ON public.remote_emojis_cache
    USING (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- NOTIFICATION RATE LIMITS RLS (Admin Only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.notification_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_rate_limits_admin_only" ON public.notification_rate_limits
    FOR ALL USING (public.is_current_user_admin())
    WITH CHECK (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- USER VIEW CONTEXTS RLS (Own User Only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_view_contexts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_view_contexts_own_user" ON public.user_view_contexts
    FOR ALL USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- MESSAGE SEARCH INDEX RLS (Based on Channel/Conversation Access)
-- ---------------------------------------------------------------------------
ALTER TABLE public.message_search_index ENABLE ROW LEVEL SECURITY;

-- Users can search messages in channels they have access to
CREATE POLICY "message_search_index_channel_access" ON public.message_search_index
    FOR SELECT USING (
        channel_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.user_servers us ON us.server_id = c.server_id
            WHERE c.id = message_search_index.channel_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    );

-- Users can search messages in conversations they are part of
CREATE POLICY "message_search_index_conversation_access" ON public.message_search_index
    FOR SELECT USING (
        conversation_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = message_search_index.conversation_id
            AND cp.user_id = public.get_current_profile_id()
            AND cp.left_at IS NULL
        )
    );

-- ---------------------------------------------------------------------------
-- ENCRYPTION SESSIONS RLS (Own User Only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.encryption_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "encryption_sessions_own_user" ON public.encryption_sessions
    FOR ALL USING (
        local_user_id = public.get_current_profile_id()
        OR remote_user_id = public.get_current_profile_id()
    )
    WITH CHECK (local_user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- ENCRYPTION AUDIT LOG RLS (Own User + Admin)
-- ---------------------------------------------------------------------------
ALTER TABLE public.encryption_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "encryption_audit_log_own_or_admin" ON public.encryption_audit_log
    FOR SELECT USING (
        user_id = public.get_current_profile_id()
        OR public.is_current_user_admin()
    );

-- Only system can insert (via SECURITY DEFINER functions)
CREATE POLICY "encryption_audit_log_insert_system" ON public.encryption_audit_log
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- USER LISTS RLS
-- Note: Using DROP IF EXISTS for robustness (handles reruns, migration conflicts)
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_lists ENABLE ROW LEVEL SECURITY;

-- Users can view their own lists
DROP POLICY IF EXISTS "user_lists_own_select" ON public.user_lists;
CREATE POLICY "user_lists_own_select" ON public.user_lists
    FOR SELECT USING (user_id = public.get_current_profile_id());

-- Users can view public lists from others
DROP POLICY IF EXISTS "user_lists_public_select" ON public.user_lists;
CREATE POLICY "user_lists_public_select" ON public.user_lists
    FOR SELECT USING (is_public = true);

-- Users can only create their own lists
DROP POLICY IF EXISTS "user_lists_insert" ON public.user_lists;
CREATE POLICY "user_lists_insert" ON public.user_lists
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

-- Users can only update their own lists
DROP POLICY IF EXISTS "user_lists_update" ON public.user_lists;
CREATE POLICY "user_lists_update" ON public.user_lists
    FOR UPDATE USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id());

-- Users can only delete their own lists
DROP POLICY IF EXISTS "user_lists_delete" ON public.user_lists;
CREATE POLICY "user_lists_delete" ON public.user_lists
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- USER LIST MEMBERS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_list_members ENABLE ROW LEVEL SECURITY;

-- Users can view members of their own lists
DROP POLICY IF EXISTS "user_list_members_own_list" ON public.user_list_members;
CREATE POLICY "user_list_members_own_list" ON public.user_list_members
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.user_id = public.get_current_profile_id()
        )
    );

-- Users can view members of public lists
DROP POLICY IF EXISTS "user_list_members_public_list" ON public.user_list_members;
CREATE POLICY "user_list_members_public_list" ON public.user_list_members
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.is_public = true
        )
    );

-- Users can add members to their own lists
DROP POLICY IF EXISTS "user_list_members_insert" ON public.user_list_members;
CREATE POLICY "user_list_members_insert" ON public.user_list_members
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.user_id = public.get_current_profile_id()
        )
    );

-- Users can remove members from their own lists
DROP POLICY IF EXISTS "user_list_members_delete" ON public.user_list_members;
CREATE POLICY "user_list_members_delete" ON public.user_list_members
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.user_id = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- REPORTS RLS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can create reports" ON public.reports;
CREATE POLICY "Users can create reports" ON public.reports
    FOR INSERT TO authenticated
    WITH CHECK (reporter_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can view own reports" ON public.reports;
CREATE POLICY "Users can view own reports" ON public.reports
    FOR SELECT TO authenticated
    USING (reporter_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Admins can view all reports" ON public.reports;
CREATE POLICY "Admins can view all reports" ON public.reports
    FOR SELECT TO authenticated
    USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "Admins can update reports" ON public.reports;
CREATE POLICY "Admins can update reports" ON public.reports
    FOR UPDATE TO authenticated
    USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- INSTANCE FUNDING RLS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "funding_select_all" ON public.instance_funding;
CREATE POLICY "funding_select_all" ON public.instance_funding
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "funding_modify_admin" ON public.instance_funding;
CREATE POLICY "funding_modify_admin" ON public.instance_funding
    FOR ALL TO authenticated USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "tiers_select_all" ON public.instance_supporter_tiers;
CREATE POLICY "tiers_select_all" ON public.instance_supporter_tiers
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "tiers_modify_admin" ON public.instance_supporter_tiers;
CREATE POLICY "tiers_modify_admin" ON public.instance_supporter_tiers
    FOR ALL TO authenticated USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "supporters_select_all" ON public.instance_supporters;
CREATE POLICY "supporters_select_all" ON public.instance_supporters
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "supporters_modify_admin" ON public.instance_supporters;
CREATE POLICY "supporters_modify_admin" ON public.instance_supporters
    FOR ALL TO authenticated USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "donation_history_select_admin" ON public.instance_donation_history;
CREATE POLICY "donation_history_select_admin" ON public.instance_donation_history
    FOR SELECT TO authenticated USING (
        public.is_current_user_admin()
        OR user_id = public.get_current_profile_id()
    );

DROP POLICY IF EXISTS "donation_history_modify_admin" ON public.instance_donation_history;
CREATE POLICY "donation_history_modify_admin" ON public.instance_donation_history
    FOR ALL TO authenticated USING (public.is_current_user_admin());

-- Pending donations: admin-only (webhooks insert via service_role bypass).
DROP POLICY IF EXISTS "pending_donations_admin_all" ON public.instance_pending_donations;
CREATE POLICY "pending_donations_admin_all" ON public.instance_pending_donations
    FOR ALL TO authenticated USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- AP ACTIVITIES (ActivityPub activity log)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "System can manage ActivityPub activities" ON public.ap_activities;
CREATE POLICY "System can manage ActivityPub activities" ON public.ap_activities
    TO service_role USING (true);

DROP POLICY IF EXISTS "Users can view their own activities" ON public.ap_activities;
CREATE POLICY "Users can view their own activities" ON public.ap_activities
    FOR SELECT USING (actor_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can create their own activities" ON public.ap_activities;
CREATE POLICY "Users can create their own activities" ON public.ap_activities
    FOR INSERT WITH CHECK (actor_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can update their own activities" ON public.ap_activities;
CREATE POLICY "Users can update their own activities" ON public.ap_activities
    FOR UPDATE USING (actor_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- AP ACTOR CACHE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can manage actor cache" ON public.ap_actor_cache;
CREATE POLICY "Service role can manage actor cache" ON public.ap_actor_cache
    USING (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- AP OBJECT CACHE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can manage object cache" ON public.ap_object_cache;
CREATE POLICY "Service role can manage object cache" ON public.ap_object_cache
    USING (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- ADMIN AUDIT LOG
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admin audit log admin access" ON public.admin_audit_log;
CREATE POLICY "Admin audit log admin access" ON public.admin_audit_log
    TO authenticated USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- BLOCKED INSTANCES
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Blocked instances admin access" ON public.blocked_instances;
CREATE POLICY "Blocked instances admin access" ON public.blocked_instances
    TO authenticated USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- BOTS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public bots are viewable by everyone" ON public.bots;
CREATE POLICY "Public bots are viewable by everyone" ON public.bots
    FOR SELECT USING (
        is_public = true OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = bots.owner_id AND profiles.auth_user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Bot owners can manage bots" ON public.bots;
CREATE POLICY "Bot owners can manage bots" ON public.bots
    USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = bots.owner_id AND profiles.auth_user_id = auth.uid())
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = bots.owner_id AND profiles.auth_user_id = auth.uid())
    );

-- ---------------------------------------------------------------------------
-- BOT TOKENS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Bot owners can manage tokens" ON public.bot_tokens;
CREATE POLICY "Bot owners can manage tokens" ON public.bot_tokens
    USING (
        EXISTS (
            SELECT 1 FROM public.bots
            JOIN public.profiles ON profiles.id = bots.owner_id
            WHERE bots.id = bot_tokens.bot_id AND profiles.auth_user_id = auth.uid()
        )
    );

-- ---------------------------------------------------------------------------
-- BOT SERVER PERMISSIONS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Server members can view bot permissions" ON public.bot_server_permissions;
CREATE POLICY "Server members can view bot permissions" ON public.bot_server_permissions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_servers
            JOIN public.profiles ON profiles.id = user_servers.user_id
            WHERE user_servers.server_id = bot_server_permissions.server_id AND profiles.auth_user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Server owners can manage bot permissions" ON public.bot_server_permissions;
CREATE POLICY "Server owners can manage bot permissions" ON public.bot_server_permissions
    USING (
        EXISTS (
            SELECT 1 FROM public.servers
            JOIN public.profiles ON profiles.id = servers.owner
            WHERE servers.id = bot_server_permissions.server_id AND profiles.auth_user_id = auth.uid()
        )
    );

-- ---------------------------------------------------------------------------
-- EMOJI USAGE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "emoji_usage_access_policy" ON public.emoji_usage;
CREATE POLICY "emoji_usage_access_policy" ON public.emoji_usage
    TO authenticated USING (
        server_id IN (SELECT us.server_id FROM public.user_servers us WHERE us.user_id = public.get_current_profile_id())
    );

-- ---------------------------------------------------------------------------
-- FEDERATION DELIVERY QUEUE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can manage delivery queue" ON public.federation_delivery_queue;
CREATE POLICY "Service role can manage delivery queue" ON public.federation_delivery_queue
    USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage federation queue" ON public.federation_delivery_queue;
CREATE POLICY "Service role can manage federation queue" ON public.federation_delivery_queue
    TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view federation delivery queue" ON public.federation_delivery_queue;
CREATE POLICY "Users can view federation delivery queue" ON public.federation_delivery_queue
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admins can delete federation deliveries" ON public.federation_delivery_queue;
CREATE POLICY "Admins can delete federation deliveries" ON public.federation_delivery_queue
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = public.get_current_profile_id()
            AND is_admin = true
        )
    );

-- ---------------------------------------------------------------------------
-- FEDERATED VOICE CALLS (schema varies: init vs production)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'federated_voice_calls' AND column_name = 'caller_id'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "System can insert calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "System can insert calls" ON public.federated_voice_calls FOR INSERT WITH CHECK (true)';

        EXECUTE 'DROP POLICY IF EXISTS "Recipients can update call status" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Recipients can update call status" ON public.federated_voice_calls FOR UPDATE USING (public.get_current_profile_id() = recipient_id) WITH CHECK (public.get_current_profile_id() = recipient_id)';

        EXECUTE 'DROP POLICY IF EXISTS "Update own calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Update own calls" ON public.federated_voice_calls FOR UPDATE USING (caller_id = public.get_current_profile_id() OR recipient_id = public.get_current_profile_id())';

        EXECUTE 'DROP POLICY IF EXISTS "Service role full access on calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Service role full access on calls" ON public.federated_voice_calls TO service_role USING (true) WITH CHECK (true)';
    ELSE
        RAISE NOTICE 'federated_voice_calls: caller_id column not found, skipping user-level policies';
        EXECUTE 'DROP POLICY IF EXISTS "Service role full access on calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Service role full access on calls" ON public.federated_voice_calls TO service_role USING (true) WITH CHECK (true)';
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'federated_voice_calls table does not exist, skipping';
END $$;

-- ---------------------------------------------------------------------------
-- GIF FAVORITES
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own gif favorites" ON public.gif_favorites;
CREATE POLICY "Users can view own gif favorites" ON public.gif_favorites
    FOR SELECT USING (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can insert own gif favorites" ON public.gif_favorites;
CREATE POLICY "Users can insert own gif favorites" ON public.gif_favorites
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can delete own gif favorites" ON public.gif_favorites;
CREATE POLICY "Users can delete own gif favorites" ON public.gif_favorites
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- EMOJI FAVORITES
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own emoji favorites" ON public.emoji_favorites;
CREATE POLICY "Users can view own emoji favorites" ON public.emoji_favorites
    FOR SELECT USING (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can insert own emoji favorites" ON public.emoji_favorites;
CREATE POLICY "Users can insert own emoji favorites" ON public.emoji_favorites
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can delete own emoji favorites" ON public.emoji_favorites;
CREATE POLICY "Users can delete own emoji favorites" ON public.emoji_favorites
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- PERFORMANCE METRICS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can read metrics" ON public.performance_metrics;
CREATE POLICY "Admins can read metrics" ON public.performance_metrics
    FOR SELECT USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- POST HASHTAGS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view post hashtags" ON public.post_hashtags;
CREATE POLICY "Anyone can view post hashtags" ON public.post_hashtags
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Only system can modify post hashtags" ON public.post_hashtags;
CREATE POLICY "Only system can modify post hashtags" ON public.post_hashtags
    USING (false) WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- PREKEYS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert their own prekeys" ON public.prekeys;
CREATE POLICY "Users can insert their own prekeys" ON public.prekeys
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = prekeys.user_id AND profiles.auth_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can update their own prekeys" ON public.prekeys;
CREATE POLICY "Users can update their own prekeys" ON public.prekeys
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = prekeys.user_id AND profiles.auth_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can view others' unused public prekeys" ON public.prekeys;
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'prekeys' AND column_name = 'is_used'
    ) THEN
        EXECUTE 'CREATE POLICY "Users can view others'' unused public prekeys" ON public.prekeys FOR SELECT USING (is_used = false)';
    ELSE
        EXECUTE 'CREATE POLICY "Users can view others'' unused public prekeys" ON public.prekeys FOR SELECT USING (used_at IS NULL)';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PUSH SUBSCRIPTIONS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can manage all push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Service role can manage all push subscriptions" ON public.push_subscriptions
    TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- SERVER FEDERATION EVENTS (init schema has no user_id column)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'server_federation_events' AND column_name = 'user_id'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "Users can create their own server events" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Users can create their own server events" ON public.server_federation_events FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())';

        EXECUTE 'DROP POLICY IF EXISTS "Users can view server events they''re involved in" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Users can view server events they''re involved in" ON public.server_federation_events FOR SELECT USING (user_id = public.get_current_profile_id())';
    ELSE
        EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can manage server events" ON public.server_federation_events';
        -- Writes go through SECURITY DEFINER paths / the federation worker
        -- (service_role). The old USING(true) WITH CHECK(true) policy let any
        -- authenticated user read/modify the entire federation event queue.
        EXECUTE 'DROP POLICY IF EXISTS "Service role can manage server events" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Service role can manage server events" ON public.server_federation_events TO service_role USING (true) WITH CHECK (true)';
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'server_federation_events table does not exist, skipping';
END $$;

-- ---------------------------------------------------------------------------
-- SERVER MEMBERSHIP EVENTS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Members can view server membership events" ON public.server_membership_events;
CREATE POLICY "Members can view server membership events" ON public.server_membership_events
    FOR SELECT TO authenticated USING (
        server_id IN (SELECT us.server_id FROM public.user_servers us WHERE us.user_id = public.get_current_profile_id())
    );

DROP POLICY IF EXISTS "System can insert membership events" ON public.server_membership_events;
CREATE POLICY "System can insert membership events" ON public.server_membership_events
    FOR INSERT TO authenticated WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- TIMELINE ENTRIES
-- ---------------------------------------------------------------------------
-- Timeline rows are written exclusively by SECURITY DEFINER fan-out triggers
-- (create_comprehensive_timeline_entries / broadcast_home_feed_entry), which
-- bypass RLS. Clients may only READ their OWN timeline; the previous
-- USING(true) WITH CHECK(true) let any user read/insert/delete anyone's feed.
DROP POLICY IF EXISTS "System can manage all timeline entries" ON public.timeline_entries;
DROP POLICY IF EXISTS "timeline_entries_select_own" ON public.timeline_entries;
CREATE POLICY "timeline_entries_select_own" ON public.timeline_entries
    FOR SELECT USING (user_id = public.get_current_profile_id());
DROP POLICY IF EXISTS "timeline_entries_service_write" ON public.timeline_entries;
CREATE POLICY "timeline_entries_service_write" ON public.timeline_entries
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- UNREAD COUNTS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "System can manage unread counts" ON public.unread_counts;
CREATE POLICY "System can manage unread counts" ON public.unread_counts
    WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- USER KEY PAIRS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert their own key pairs" ON public.user_key_pairs;
CREATE POLICY "Users can insert their own key pairs" ON public.user_key_pairs
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = user_key_pairs.user_id AND profiles.auth_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can update their own key pairs" ON public.user_key_pairs;
CREATE POLICY "Users can update their own key pairs" ON public.user_key_pairs
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = user_key_pairs.user_id AND profiles.auth_user_id = auth.uid())
    );

-- RLS is row-level, not column-level: a row-wide public SELECT would expose
-- every user's `identity_private_key_encrypted` / signing private columns to
-- all authenticated clients via PostgREST. We split SELECT into:
--   (a) owner can read their FULL row (private columns included)
--   (b) everyone authenticated can read rows, BUT a column-level GRANT below
--       restricts the projection to PUBLIC columns only.
-- The owner fetches their own encrypted private columns through the
-- SECURITY DEFINER RPC get_my_key_pair() (defined below), not via direct SELECT.
DROP POLICY IF EXISTS "Users can view others' public keys for encryption" ON public.user_key_pairs;

DROP POLICY IF EXISTS "Users can view own key pair (full row)" ON public.user_key_pairs;
CREATE POLICY "Users can view own key pair (full row)" ON public.user_key_pairs
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = user_key_pairs.user_id
              AND profiles.auth_user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can view active public key columns" ON public.user_key_pairs;
CREATE POLICY "Users can view active public key columns" ON public.user_key_pairs
    FOR SELECT USING (is_active = true);

-- Replace the broad row GRANT with a PUBLIC-COLUMNS-ONLY grant.
REVOKE SELECT ON public.user_key_pairs FROM authenticated;
REVOKE SELECT ON public.user_key_pairs FROM anon;
GRANT SELECT (
    id, user_id, device_id, identity_public_key, identity_signing_public_key,
    key_version, is_active, created_at, last_used_at, expires_at, metadata
) ON public.user_key_pairs TO authenticated;

-- Owner-only access to the encrypted PRIVATE columns (used during local unlock).
CREATE OR REPLACE FUNCTION public.get_my_key_pair()
RETURNS TABLE (
    id uuid, user_id uuid, device_id text,
    identity_public_key text, identity_private_key_encrypted text,
    identity_signing_public_key text, identity_signing_private_key_encrypted text,
    key_version integer, is_active boolean, created_at timestamptz,
    last_used_at timestamptz, expires_at timestamptz, metadata jsonb
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT ukp.id, ukp.user_id, ukp.device_id,
           ukp.identity_public_key, ukp.identity_private_key_encrypted,
           ukp.identity_signing_public_key, ukp.identity_signing_private_key_encrypted,
           ukp.key_version, ukp.is_active, ukp.created_at,
           ukp.last_used_at, ukp.expires_at, ukp.metadata
    FROM public.user_key_pairs ukp
    JOIN public.profiles p ON p.id = ukp.user_id
    WHERE p.auth_user_id = auth.uid()
      AND ukp.is_active = true
    ORDER BY ukp.created_at DESC
    LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_key_pair() TO authenticated;

-- ---------------------------------------------------------------------------
-- USER SESSIONS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can manage all sessions" ON public.user_sessions;
CREATE POLICY "Service role can manage all sessions" ON public.user_sessions
    TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view own sessions" ON public.user_sessions;
CREATE POLICY "Users can view own sessions" ON public.user_sessions
    FOR SELECT USING (public.get_current_profile_id() = user_id);

DROP POLICY IF EXISTS "Users can insert own sessions" ON public.user_sessions;
CREATE POLICY "Users can insert own sessions" ON public.user_sessions
    FOR INSERT WITH CHECK (public.get_current_profile_id() = user_id);

DROP POLICY IF EXISTS "Users can update own sessions" ON public.user_sessions;
CREATE POLICY "Users can update own sessions" ON public.user_sessions
    FOR UPDATE USING (public.get_current_profile_id() = user_id);

DROP POLICY IF EXISTS "Users can delete own sessions" ON public.user_sessions;
CREATE POLICY "Users can delete own sessions" ON public.user_sessions
    FOR DELETE USING (public.get_current_profile_id() = user_id);

-- ---------------------------------------------------------------------------
-- USER TIMELINE CACHE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can access own timeline cache" ON public.user_timeline_cache;
CREATE POLICY "Users can access own timeline cache" ON public.user_timeline_cache
    USING (public.get_current_profile_id() = user_id);

-- ---------------------------------------------------------------------------
-- VOICE FEDERATION EVENTS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can create their own voice events" ON public.voice_federation_events;
CREATE POLICY "Users can create their own voice events" ON public.voice_federation_events
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can view voice events they're involved in" ON public.voice_federation_events;
CREATE POLICY "Users can view voice events they're involved in" ON public.voice_federation_events
    FOR SELECT USING (user_id = public.get_current_profile_id());

DO $$
BEGIN
    RAISE NOTICE 'Extended RLS policies created successfully';
END $$;

