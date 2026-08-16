-- Enable RLS on Supabase-managed tables (auth, storage, realtime).
-- These tables vary across Supabase versions, so skip any that don't exist.
DO $$
DECLARE
    tbl text;
    tbls text[] := ARRAY[
        'auth.audit_log_entries',
        'auth.flow_state',
        'auth.identities',
        'auth.instances',
        'auth.mfa_amr_claims',
        'auth.mfa_challenges',
        'auth.mfa_factors',
        'auth.one_time_tokens',
        'auth.refresh_tokens',
        'auth.saml_providers',
        'auth.saml_relay_states',
        'auth.schema_migrations',
        'auth.sessions',
        'auth.sso_domains',
        'auth.sso_providers',
        'auth.users',
        'realtime.messages',
        'storage.buckets',
        'storage.buckets_analytics',
        'storage.buckets_vectors',
        'storage.iceberg_namespaces',
        'storage.iceberg_tables',
        'storage.migrations',
        'storage.objects',
        'storage.prefixes',
        'storage.s3_multipart_uploads',
        'storage.s3_multipart_uploads_parts',
        'storage.vector_indexes'
    ];
BEGIN
    FOREACH tbl IN ARRAY tbls LOOP
        BEGIN
            EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
        EXCEPTION
            WHEN undefined_table THEN
                RAISE NOTICE 'Skipping RLS for non-existent table: %', tbl;
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Skipping RLS for table not owned by current role: %', tbl;
        END;
    END LOOP;
END
$$;

-- RLS policies for realtime.messages - required for private broadcast channels.
-- Without these, authenticated users cannot subscribe to or receive private broadcasts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'realtime' AND table_name = 'messages') THEN
    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_receive" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_receive" ON realtime.messages FOR SELECT TO authenticated USING (public.can_subscribe_to_topic(topic))';
    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_send" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_send" ON realtime.messages
      FOR INSERT TO authenticated
      WITH CHECK (
        topic = ''user:'' || public.get_current_profile_id()::text
        OR (
          topic LIKE ''server-presence:%''
          AND EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = substring(topic from 17)::uuid
              AND us.user_id = public.get_current_profile_id()
              AND us.status = ''accepted''
          )
        )
      )';
  END IF;
END
$$;

-- Enable RLS on all Harmony public tables
ALTER TABLE public.activity_processing_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activitypub_processing_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ap_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ap_actor_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ap_object_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_server_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_encryption_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_bridge_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emoji_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emojis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encryption_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encryption_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federated_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federated_voice_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federation_delivery_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federation_delivery_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federation_endpoint_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federation_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gif_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emoji_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_donation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_pending_donations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_funding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_supporter_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_supporters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_webrtc_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_key_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_key_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_room_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_session_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_search_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_metrics_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prekeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_key_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_emojis_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_encryption_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_federation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_membership_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slow_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thread_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timeline_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trending_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trending_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unread_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_key_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_mutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_private_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_timeline_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_view_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_channel_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_federation_events ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- Realtime private broadcast channel setup
-- Required for private: true channels to work (server-structure, server-presence, user events)
-- =========================================================================
GRANT USAGE ON SCHEMA realtime TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'realtime' AND c.relname = 'messages'
  ) THEN
    EXECUTE 'GRANT SELECT, INSERT ON realtime.messages TO authenticated';

    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_receive" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_receive" ON realtime.messages
      FOR SELECT TO authenticated USING (public.can_subscribe_to_topic(topic))';

    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_send" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_send" ON realtime.messages
      FOR INSERT TO authenticated
      WITH CHECK (
        topic = ''user:'' || public.get_current_profile_id()::text
        OR (
          topic LIKE ''server-presence:%''
          AND EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = substring(topic from 17)::uuid
              AND us.user_id = public.get_current_profile_id()
              AND us.status = ''accepted''
          )
        )
      )';
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------
-- Unreachable functions: removed from the client-callable surface.
--
-- Supabase grants EXECUTE on every function in public to anon and
-- authenticated by default, so each of these would otherwise be an
-- unauthenticated HTTP endpoint. No entry point reaches them; see
-- db_schema/UNREACHABLE.tsv and scripts/find-unreachable.sh.
--
-- Mirrors migrations/20260809_revoke_unreachable_functions.sql.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.add_user_prekeys(p_user_id uuid, p_device_id text, p_prekeys jsonb) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.archive_popular_hashtags() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.backfill_timeline_entries() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.check_encryption_policy(p_server_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_expired_statuses() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_expired_voice_calls() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_inactive_hashtags() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_old_notifications() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_old_trending_data() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_stale_user_sessions() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_stale_voice_participants() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_orphaned_public_keys() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_default_notification_preferences(p_user_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_notification_structured(p_user_id uuid, p_type character varying, p_data jsonb) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.create_notification_with_spam_prevention(p_user_id uuid, p_type text, p_source_user_id uuid, p_title text, p_message text, p_data jsonb, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.detect_message_features(content_parts jsonb) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.disable_federation_triggers() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.enable_conversation_encryption(p_conversation_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.enable_federation_triggers() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.end_user_session(p_user_id uuid, p_session_token text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_livekit_token(room_name text, room_type text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_channel_server_id(channel_uuid uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_conversation_encryption_status(p_conversation_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_conversation_participants(conversation_uuid uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_conversation_thread(p_conversation_id text, p_user_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_custom_status(p_user_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_livekit_config() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_next_folder_position(p_user_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_next_server_position(p_user_id uuid, p_folder_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_supporter_badge(p_user_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_timeline(p_user_id uuid, p_limit integer, p_before timestamp without time zone) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_unread_notification_count(p_user_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_unused_prekey(p_user_id uuid, p_device_id text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_user_prekey_bundle(p_user_id uuid, p_device_id text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_voice_channel_participants(p_channel_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.has_muted(target_user_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.is_author_suspended(p_author_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.is_muted_by(target_user_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.record_metric(p_metric_type text, p_metric_name text, p_value double precision, p_unit text, p_labels jsonb, p_source text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_user_encryption(p_user_id uuid, p_device_id text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.rotate_prekeys(p_user_id uuid, p_device_id text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.run_trending_maintenance() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.safe_upsert_remote_profile(p_username text, p_domain text, p_federated_id text, p_display_name text, p_avatar_url text, p_banner_url text, p_bio text, p_public_key text, p_inbox_url text, p_outbox_url text, p_followers_url text, p_following_url text, p_shared_inbox_url text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.server_has_remote_members(p_server_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.update_session_context(p_session_token text, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.update_session_heartbeat(p_session_token text, p_status text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.user_has_encryption(p_user_id uuid) FROM anon, authenticated;
