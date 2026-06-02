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
    EXECUTE 'CREATE POLICY "authenticated_users_can_receive" ON realtime.messages FOR SELECT TO authenticated USING (true)';
    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_send" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_send" ON realtime.messages FOR INSERT TO authenticated WITH CHECK (true)';
  END IF;
END
$$;

-- Enable RLS on all Harmony public tables
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
ALTER TABLE public.emoji_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emojis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encryption_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encryption_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federated_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federated_voice_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federation_delivery_queue ENABLE ROW LEVEL SECURITY;
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
GRANT USAGE ON SCHEMA realtime TO anon;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'realtime' AND c.relname = 'messages'
  ) THEN
    EXECUTE 'GRANT SELECT, INSERT ON realtime.messages TO authenticated';
    EXECUTE 'GRANT SELECT ON realtime.messages TO anon';

    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_receive" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_receive" ON realtime.messages
      FOR SELECT TO authenticated USING (true)';

    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_send" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_send" ON realtime.messages
      FOR INSERT TO authenticated WITH CHECK (true)';
  END IF;
END;
$$;
