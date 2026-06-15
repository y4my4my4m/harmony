-- =============================================================================
-- Performance / security hardening (runs after all tables + functions exist)
-- =============================================================================
-- Addresses Supabase advisor WARN/INFO findings that are safe to apply globally:
--   1. function_search_path_mutable -> pin search_path on every public function
--   2. unindexed_foreign_keys       -> covering indexes for FK columns
-- Both blocks are idempotent and resilient to schema drift.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Pin search_path on every public function lacking one.
-- ---------------------------------------------------------------------------
-- A mutable search_path lets a caller shadow unqualified names. We pin
-- `public, extensions, pg_temp` so unqualified extension calls (pgcrypto, etc.)
-- still resolve. Schema-qualified calls (auth.uid(), realtime.send(), ...) are
-- unaffected. Re-running only touches functions that still lack search_path.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.proname,
               pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          AND NOT EXISTS (
              SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
              WHERE c LIKE 'search_path=%'
          )
    LOOP
        BEGIN
            EXECUTE format(
                'ALTER FUNCTION public.%I(%s) SET search_path = public, extensions, pg_temp',
                r.proname, r.args
            );
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Skipping search_path pin for %(%): %', r.proname, r.args, SQLERRM;
        END;
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2) Covering indexes for foreign keys (unindexed_foreign_keys).
-- ---------------------------------------------------------------------------
-- Each FK column without a covering index forces sequential scans on the
-- referenced-side cascade/lookup. Created idempotently; missing tables/columns
-- (env drift) are skipped rather than aborting.
DO $$
DECLARE
    stmt text;
    stmts text[] := ARRAY[
        'CREATE INDEX IF NOT EXISTS idx_blocked_instances_blocked_by ON public.blocked_instances(blocked_by)',
        'CREATE INDEX IF NOT EXISTS idx_blocked_instances_created_by ON public.blocked_instances(created_by)',
        'CREATE INDEX IF NOT EXISTS idx_bot_audit_log_channel_id ON public.bot_audit_log(channel_id)',
        'CREATE INDEX IF NOT EXISTS idx_bot_audit_log_user_id ON public.bot_audit_log(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_bot_server_permissions_installed_by ON public.bot_server_permissions(installed_by)',
        'CREATE INDEX IF NOT EXISTS idx_bot_webhooks_server_id ON public.bot_webhooks(server_id)',
        'CREATE INDEX IF NOT EXISTS idx_bots_support_server_id ON public.bots(support_server_id)',
        'CREATE INDEX IF NOT EXISTS idx_channel_permission_overrides_role_id ON public.channel_permission_overrides(role_id)',
        'CREATE INDEX IF NOT EXISTS idx_channel_permission_overrides_user_id ON public.channel_permission_overrides(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_conversations_created_by ON public.conversations(created_by)',
        'CREATE INDEX IF NOT EXISTS idx_encryption_audit_log_related_conversation ON public.encryption_audit_log(related_conversation_id)',
        'CREATE INDEX IF NOT EXISTS idx_encryption_audit_log_related_server ON public.encryption_audit_log(related_server_id)',
        'CREATE INDEX IF NOT EXISTS idx_encryption_audit_log_related_user ON public.encryption_audit_log(related_user_id)',
        'CREATE INDEX IF NOT EXISTS idx_federation_delivery_queue_sender_id ON public.federation_delivery_queue(sender_id)',
        'CREATE INDEX IF NOT EXISTS idx_files_owner ON public.files(owner)',
        'CREATE INDEX IF NOT EXISTS idx_instance_announcements_author_id ON public.instance_announcements(author_id)',
        'CREATE INDEX IF NOT EXISTS idx_instance_config_updated_by ON public.instance_config(updated_by)',
        'CREATE INDEX IF NOT EXISTS idx_instance_pending_donations_resolved_by ON public.instance_pending_donations(resolved_by)',
        'CREATE INDEX IF NOT EXISTS idx_instance_pending_donations_resolved_user ON public.instance_pending_donations(resolved_user_id)',
        'CREATE INDEX IF NOT EXISTS idx_instance_supporters_tier_id ON public.instance_supporters(tier_id)',
        'CREATE INDEX IF NOT EXISTS idx_invites_channel_id ON public.invites(channel_id)',
        'CREATE INDEX IF NOT EXISTS idx_invites_created_by ON public.invites(created_by)',
        'CREATE INDEX IF NOT EXISTS idx_invites_server_id ON public.invites(server_id)',
        'CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_responded_by ON public.megolm_key_requests(responded_by_user_id)',
        'CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_user_id ON public.megolm_key_requests(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_megolm_session_shares_sender_user_id ON public.megolm_session_shares(sender_user_id)',
        'CREATE INDEX IF NOT EXISTS idx_message_search_index_server_id ON public.message_search_index(server_id)',
        'CREATE INDEX IF NOT EXISTS idx_messages_pinned_by ON public.messages(pinned_by)',
        'CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON public.messages(reply_to)',
        'CREATE INDEX IF NOT EXISTS idx_notification_channels_channel_id ON public.notification_channels(channel_id)',
        'CREATE INDEX IF NOT EXISTS idx_notification_channels_conversation_id ON public.notification_channels(conversation_id)',
        'CREATE INDEX IF NOT EXISTS idx_notification_channels_server_id ON public.notification_channels(server_id)',
        'CREATE INDEX IF NOT EXISTS idx_notification_rate_limits_source_user ON public.notification_rate_limits(source_user_id)',
        'CREATE INDEX IF NOT EXISTS idx_post_interactions_emoji_id ON public.post_interactions(emoji_id)',
        'CREATE INDEX IF NOT EXISTS idx_prekeys_used_by ON public.prekeys(used_by)',
        'CREATE INDEX IF NOT EXISTS idx_reactions_emoji_id ON public.reactions(emoji_id)',
        'CREATE INDEX IF NOT EXISTS idx_reports_reported_post_id ON public.reports(reported_post_id)',
        'CREATE INDEX IF NOT EXISTS idx_reports_reported_server_id ON public.reports(reported_server_id)',
        'CREATE INDEX IF NOT EXISTS idx_reports_reporter_id ON public.reports(reporter_id)',
        'CREATE INDEX IF NOT EXISTS idx_reports_resolved_by ON public.reports(resolved_by)',
        'CREATE INDEX IF NOT EXISTS idx_server_bans_banned_by ON public.server_bans(banned_by)',
        'CREATE INDEX IF NOT EXISTS idx_server_encryption_settings_updated_by ON public.server_encryption_settings(updated_by)',
        'CREATE INDEX IF NOT EXISTS idx_server_federation_events_ap_activity ON public.server_federation_events(ap_activity_id)',
        'CREATE INDEX IF NOT EXISTS idx_server_membership_events_initiated_by ON public.server_membership_events(initiated_by)',
        'CREATE INDEX IF NOT EXISTS idx_server_membership_events_user_id ON public.server_membership_events(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_server_settings_default_role_id ON public.server_settings(default_role_id)',
        'CREATE INDEX IF NOT EXISTS idx_servers_owner ON public.servers(owner)',
        'CREATE INDEX IF NOT EXISTS idx_threads_created_by ON public.threads(created_by)',
        'CREATE INDEX IF NOT EXISTS idx_timeline_entries_post_id ON public.timeline_entries(post_id)',
        'CREATE INDEX IF NOT EXISTS idx_unread_counts_server_id ON public.unread_counts(server_id)',
        'CREATE INDEX IF NOT EXISTS idx_user_mutes_muted_user_id ON public.user_mutes(muted_user_id)',
        'CREATE INDEX IF NOT EXISTS idx_user_roles_assigned_by ON public.user_roles(assigned_by)',
        'CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON public.user_roles(role_id)',
        'CREATE INDEX IF NOT EXISTS idx_user_sessions_current_channel_id ON public.user_sessions(current_channel_id)',
        'CREATE INDEX IF NOT EXISTS idx_user_sessions_current_conversation_id ON public.user_sessions(current_conversation_id)',
        'CREATE INDEX IF NOT EXISTS idx_user_sessions_current_server_id ON public.user_sessions(current_server_id)',
        'CREATE INDEX IF NOT EXISTS idx_user_view_contexts_channel_id ON public.user_view_contexts(channel_id)',
        'CREATE INDEX IF NOT EXISTS idx_user_view_contexts_conversation_id ON public.user_view_contexts(conversation_id)',
        'CREATE INDEX IF NOT EXISTS idx_user_view_contexts_server_id ON public.user_view_contexts(server_id)',
        'CREATE INDEX IF NOT EXISTS idx_voice_channel_participants_server_id ON public.voice_channel_participants(server_id)',
        'CREATE INDEX IF NOT EXISTS idx_voice_federation_events_ap_activity ON public.voice_federation_events(ap_activity_id)',
        'CREATE INDEX IF NOT EXISTS idx_voice_federation_events_user_id ON public.voice_federation_events(user_id)'
    ];
BEGIN
    FOREACH stmt IN ARRAY stmts LOOP
        BEGIN
            EXECUTE stmt;
        EXCEPTION
            WHEN undefined_table OR undefined_column THEN
                RAISE NOTICE 'Skipping (missing table/column): %', stmt;
        END;
    END LOOP;
END
$$;

DO $$
BEGIN
    RAISE NOTICE 'Performance hardening (search_path + FK indexes) applied';
END $$;
