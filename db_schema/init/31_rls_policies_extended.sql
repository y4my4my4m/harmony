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
AS $$
    SELECT COALESCE(
        (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
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

CREATE POLICY "channel_permission_overrides_modify_owner" ON public.channel_permission_overrides
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            WHERE c.id = channel_permission_overrides.channel_id
            AND s.owner = public.get_current_profile_id()
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

-- User private keys: own only (NEVER expose to others!)
CREATE POLICY "user_private_keys_own_only" ON public.user_private_keys
    FOR ALL USING (user_id = public.get_current_profile_id());

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

-- Megolm session shares: sender or recipient
CREATE POLICY "megolm_session_shares_select" ON public.megolm_session_shares
    FOR SELECT USING (
        recipient_user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.megolm_room_sessions mrs
            WHERE mrs.session_id = megolm_session_shares.session_id
            AND mrs.room_id = megolm_session_shares.room_id
            AND mrs.creator_user_id = public.get_current_profile_id()
        )
    );

CREATE POLICY "megolm_session_shares_insert" ON public.megolm_session_shares
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.megolm_room_sessions mrs
            WHERE mrs.session_id = megolm_session_shares.session_id
            AND mrs.room_id = megolm_session_shares.room_id
            AND mrs.creator_user_id = public.get_current_profile_id()
        )
    );

-- Megolm key requests: own requests
CREATE POLICY "megolm_key_requests_own" ON public.megolm_key_requests
    FOR ALL USING (requester_user_id = public.get_current_profile_id());

-- Also allow viewing requests for sessions you own (to respond)
CREATE POLICY "megolm_key_requests_select_for_response" ON public.megolm_key_requests
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.megolm_room_sessions mrs
            WHERE mrs.session_id = megolm_key_requests.session_id
            AND mrs.room_id = megolm_key_requests.room_id
            AND mrs.creator_user_id = public.get_current_profile_id()
        )
    );

-- Megolm key backups: own only
CREATE POLICY "megolm_key_backups_own_only" ON public.megolm_key_backups
    FOR ALL USING (user_id = public.get_current_profile_id());

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
            SELECT 1 FROM public.conversations c
            WHERE c.id = conversation_encryption_settings.conversation_id
            AND c.created_by = public.get_current_profile_id()
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

CREATE POLICY "slow_queries_admin_only" ON public.slow_queries
    FOR ALL USING (public.is_current_user_admin());

CREATE POLICY "federation_health_select_all" ON public.federation_health
    FOR SELECT USING (true);

CREATE POLICY "federation_health_modify_admin" ON public.federation_health
    FOR ALL USING (public.is_current_user_admin());

CREATE POLICY "performance_metrics_hourly_select_all" ON public.performance_metrics_hourly
    FOR SELECT USING (true);

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

DO $$
BEGIN
    RAISE NOTICE 'Extended RLS policies created successfully';
END $$;

