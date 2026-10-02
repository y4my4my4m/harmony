-- Internal functions do not run as their owner for clients, on every instance.
--
-- The baseline revokes EXECUTE on these from PUBLIC, anon and authenticated. Instances
-- older than the baseline never ran it: their copies carry Supabase's default grants, and
-- some are SECURITY DEFINER where the repository's are not, so PostgREST runs them as
-- their owner for the anon key. Production had 25 such functions, staging 28, among them:
--
--   disable_federation_triggers,      switch the federation triggers on posts, follows and
--   enable_federation_triggers        interactions off and on; no caller check
--   create_notification_structured    skips its caller check when auth.uid() is null, so
--                                     anon writes a notification to any user
--   record_metric                     inserts any row into performance_metrics
--   get_user_prekey_bundle,           read and consume another user's one-time prekeys
--   get_unused_prekey
--   cleanup_stale_user_sessions       definer on production, invoker in the repository
--   get_voice_channel_participants,   read voice presence, mutes and custom status of
--   has_muted, is_muted_by,           any user or channel
--   get_custom_status
--
-- The names are every function scripts/generate-surface.sh reports as granted to
-- service_role alone. Each overload that is SECURITY DEFINER here is converged; an invoker
-- runs with the caller's privileges and keeps its grants. No policy, view or column
-- default on production or staging calls a converged function, and the one
-- client-reachable invoker that does, run_trending_maintenance (archive_popular_hashtags),
-- has no caller.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.prosecdef
           AND p.proname IN (
               'add_server_owner_membership', 'add_user_prekeys',
               'aggregate_hourly_metrics', 'antispam_check_local_author', 'antispam_int',
               'antispam_post_guard', 'antispam_settings',
               'apply_domain_limit_on_profile_insert', 'apply_server_encryption_floor',
               'archive_popular_hashtags', 'assert_security_attempt_budget',
               'automod_apply_raid_lockdown', 'automod_canonical_actions',
               'automod_canonical_config', 'automod_compile_rule',
               'automod_foreign_invite', 'automod_install_preset', 'automod_int',
               'automod_keyword_regex', 'automod_link_hosts', 'automod_member_joined',
               'automod_message_guard', 'automod_message_text', 'automod_normalize',
               'automod_post_alert', 'automod_preset_terms', 'automod_purge',
               'automod_recompile_server', 'automod_record_match',
               'automod_regex_compiles', 'automod_require', 'automod_rules_changed',
               'automod_server_created', 'automod_settings_changed',
               'automod_singular_request', 'automod_state', 'automod_text_array',
               'backfill_timeline_entries', 'broadcast_bot_installation_change',
               'broadcast_bot_presence_change', 'broadcast_channel_encryption_change',
               'broadcast_notification_delete', 'broadcast_unread_count_event',
               'broadcast_user_event', 'bump_room_epoch', 'bump_server_channel_epochs',
               'can_manage_group_icon', 'can_view_channel', 'channel_is_restricted',
               'channel_viewer_ids', 'check_and_increment_bot_rate_limit',
               'check_encryption_policy', 'check_key_consistency', 'claim_ap_activity',
               'cleanup_dead_endpoint_users', 'cleanup_expired_statuses',
               'cleanup_expired_voice_calls', 'cleanup_inactive_hashtags',
               'cleanup_old_metrics', 'cleanup_old_notifications',
               'cleanup_old_trending_data', 'cleanup_stale_push_subscriptions',
               'cleanup_stale_user_sessions', 'cleanup_stale_voice_participants',
               'clear_orphaned_public_keys', 'complete_ap_activity', 'consume_invite',
               'content_has_system_part', 'create_default_notification_preferences',
               'create_default_server_structure', 'create_federated_emoji',
               'create_federated_report', 'create_notification_structured',
               'create_notification_with_spam_prevention', 'current_jwt_claims',
               'delete_push_subscription_by_endpoint', 'derive_display_name_emojis',
               'detect_message_features', 'disable_federation_triggers',
               'enable_conversation_encryption', 'enable_federation_triggers',
               'end_user_session', 'enforce_channel_category_scope',
               'enforce_channel_message_encryption', 'enforce_message_reply_scope',
               'enforce_server_rules_acceptance', 'federation_channel_recipients',
               'federation_group_access', 'fetch_link_preview', 'generate_livekit_token',
               'get_channel_server_id', 'get_conversation_encryption_status',
               'get_conversation_participants', 'get_conversation_thread',
               'get_custom_status', 'get_livekit_config', 'get_next_folder_position',
               'get_next_server_position', 'get_or_create_dm_conversation',
               'get_or_create_federated_group_conversation',
               'get_server_members_by_instance', 'get_supporter_badge', 'get_timeline',
               'get_unread_notification_count', 'get_unused_prekey',
               'get_user_cycle_donation_total', 'get_user_prekey_bundle',
               'get_user_push_subscriptions', 'get_voice_channel_participants',
               'guard_category_client_write', 'guard_channel_client_write',
               'guard_follow_client_write', 'guard_invite_client_write',
               'guard_message_client_write', 'guard_post_client_write',
               'guard_profile_client_write', 'guard_server_client_write',
               'guard_system_message_removal', 'guard_user_server_client_write',
               'guard_user_server_welcome_columns', 'handle_newcomer_first_message',
               'handle_new_dm_unread', 'handle_new_message_unread',
               'handle_remote_user_suspension', 'handle_role_mention_notifications',
               'has_active_session', 'hash_recovery_code', 'has_muted',
               'increment_unread_mentions', 'index_message', 'index_message_row',
               'is_author_suspended', 'is_muted_by', 'issue_bot_token',
               'is_user_viewing_context', 'is_user_viewing_push_context',
               'keep_welcome_managed_server_rules', 'log_admin_action',
               'lookup_invite_by_code', 'message_search_flags', 'mfa_enabled_for',
               'normalize_recovery_code', 'on_auth_mfa_factor_changed',
               'on_auth_password_changed', 'on_auth_session_created',
               'on_auth_session_deleted', 'profile_handle', 'protect_profile_deleted_at',
               'purge_stale_invites', 'queue_federation_job', 'queue_push_dismissal',
               'queue_push_dismissal_on_delete', 'queue_push_dismissal_on_read',
               'record_metric', 'record_push_failure', 'record_push_success',
               'record_security_attempt', 'record_security_notice', 'record_slow_query',
               'recovery_code_owner', 'redact_encrypted_notification_preview',
               'refuse_banned_membership', 'refuse_client_system_parts',
               'refuse_message_to_deleted_recipient', 'report_content_snapshot',
               'reset_daily_hashtag_counters', 'reset_unread_on_join',
               'reset_user_encryption', 'rotate_prekeys', 'run_trending_maintenance',
               'safe_upsert_remote_profile', 'seed_channel_encryption_on_insert',
               'seed_channel_encryption_settings', 'send_notification',
               'send_notification_to_user', 'server_has_remote_members',
               'server_newcomer_alerts_state', 'session_step_up_fresh',
               'skip_share_outside_room', 'sync_unread_mute', 'touch_federated_instance',
               'track_unread_mute', 'trigger_queue_report_federation',
               'trigger_queue_thread_federation', 'unread_change_payload',
               'update_endpoint_health', 'update_federation_health',
               'update_message_content_silent', 'update_message_embeds',
               'update_post_embeds', 'update_session_context', 'update_session_heartbeat',
               'upsert_ap_activity', 'upsert_remote_emoji', 'user_has_encryption')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
