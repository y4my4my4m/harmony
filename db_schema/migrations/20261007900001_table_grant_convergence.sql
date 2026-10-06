-- Table and sequence privileges of a fresh install, on every instance.
--
-- Supabase grants anon, authenticated and service_role every privilege on new objects in
-- schema public through default privileges for postgres and supabase_admin; the migrations
-- assume them and revoke where a table is narrower. Production has no default privileges
-- in public, so every table it gained without an explicit GRANT is closed to the API roles:
-- 38 tables unreadable by service_role, among them server_bans (every voice token for a
-- non-owner refused: "ban lookup failed"), user_blocks (federated calls refused as blocked),
-- bot_webhooks, bot_commands, discord_bridge_pairings and follow_relationships.
--
-- Default privileges are restated, then each relation of a fresh install at 20261007800001
-- gets that install's privileges. Grants only: production and staging hold none beyond a
-- fresh install. Relations a fresh install lacks are left alone. On production every listed
-- table has row level security with a fresh install's policies, and every listed view is
-- security_invoker.
--
-- megolm_room_sessions and megolm_key_requests: production carries a pre-baseline layout of
-- megolm_room_sessions and other policies on both, so anon and authenticated gain nothing
-- there until those converge; service_role gets a fresh install's privileges.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
    owner_role text;
BEGIN
    -- ALTER DEFAULT PRIVILEGES FOR ROLE needs membership in that role; an installer running
    -- as postgres leaves supabase_admin's defaults, which a Supabase image sets, as they are.
    FOREACH owner_role IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = owner_role)
           AND pg_has_role(current_user, owner_role, 'MEMBER') THEN
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role', owner_role);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role', owner_role);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role', owner_role);
        END IF;
    END LOOP;
END;
$$;

-- relation, anon, authenticated, service_role; '' grants nothing.
CREATE TEMP TABLE fresh_grants (rel text, anon text, authenticated text, service_role text) ON COMMIT DROP;
INSERT INTO fresh_grants VALUES
    ('account_data_exports',              '', '', 'ALL'),
    ('account_security_attempts',         '', '', 'ALL'),
    ('active_statuses_view',              'ALL', 'ALL', 'ALL'),
    ('active_threads_view',               'ALL', 'ALL', 'ALL'),
    ('activity_processing_logs',          'ALL', 'ALL', 'ALL'),
    ('activitypub_processing_stats',      'ALL', 'ALL', 'ALL'),
    ('admin_audit_log',                   'ALL', 'ALL', 'ALL'),
    ('announcement_reads',                'ALL', 'ALL', 'ALL'),
    ('ap_activities',                     'ALL', 'ALL', 'ALL'),
    ('ap_actor_cache',                    'ALL', 'ALL', 'ALL'),
    ('ap_object_cache',                   'ALL', 'ALL', 'ALL'),
    ('automod_events',                    '', '', 'ALL'),
    ('automod_recent_activity',           '', '', 'ALL'),
    ('blocked_instances',                 'ALL', 'ALL', 'ALL'),
    ('bot_audit_log',                     'ALL', 'ALL', 'ALL'),
    ('bot_commands',                      'ALL', 'ALL', 'ALL'),
    ('bot_presence',                      'ALL', 'ALL', 'ALL'),
    ('bot_rate_limits',                   'ALL', 'ALL', 'ALL'),
    ('bot_server_permissions',            'ALL', 'ALL', 'ALL'),
    ('bot_tokens',                        'ALL', 'ALL', 'ALL'),
    ('bot_webhooks',                      'ALL', 'ALL', 'ALL'),
    ('bots',                              'ALL', 'ALL', 'ALL'),
    ('channel_categories',                'ALL', 'ALL', 'ALL'),
    ('channel_encryption_settings',       '', 'SELECT', 'ALL'),
    ('channel_permission_overrides',      'ALL', 'ALL', 'ALL'),
    ('channels',                          'ALL', 'ALL', 'ALL'),
    ('conversation_encryption_settings',  'ALL', 'ALL', 'ALL'),
    ('conversation_participants',         'ALL', 'ALL', 'ALL'),
    ('conversations',                     'ALL', 'ALL', 'ALL'),
    ('deleted_actors',                    '', '', 'ALL'),
    ('device_approval_requests',          'ALL', 'ALL', 'ALL'),
    ('device_view_contexts',              '', '', 'ALL'),
    ('discord_bridge_pairings',           'ALL', 'ALL', 'ALL'),
    ('emoji_favorites',                   'ALL', 'ALL', 'ALL'),
    ('emoji_usage',                       'ALL', 'ALL', 'ALL'),
    ('emojis',                            'ALL', 'ALL', 'ALL'),
    ('encryption_audit_log',              'ALL', 'ALL', 'ALL'),
    ('encryption_sessions',               'ALL', 'ALL', 'ALL'),
    ('federated_instances',               'ALL', 'ALL', 'ALL'),
    ('federated_voice_calls',             '', 'SELECT', 'ALL'),
    ('federation_delivery_queue',         'ALL', 'ALL', 'ALL'),
    ('federation_delivery_stats',         'ALL', 'ALL', 'ALL'),
    ('federation_endpoint_health',        'ALL', 'ALL', 'ALL'),
    ('federation_health',                 'ALL', 'ALL', 'ALL'),
    ('federation_health_metrics',         'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER', 'ALL', 'ALL'),
    ('federation_stats',                  'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER', 'ALL', 'ALL'),
    ('files',                             'ALL', 'ALL', 'ALL'),
    ('follow_relationships',              'ALL', 'ALL', 'ALL'),
    ('follows',                           'ALL', 'ALL', 'ALL'),
    ('gif_favorites',                     'ALL', 'ALL', 'ALL'),
    ('hashtags',                          'ALL', 'ALL', 'ALL'),
    ('instance_actor_keys',               '', '', 'ALL'),
    ('instance_announcements',            'ALL', 'ALL', 'ALL'),
    ('instance_config',                   'ALL', 'ALL', 'ALL'),
    ('instance_donation_history',         'ALL', 'ALL', 'ALL'),
    ('instance_funding',                  '', 'DELETE, TRUNCATE, REFERENCES, TRIGGER', 'ALL'),
    ('instance_health',                   'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER', 'ALL', 'ALL'),
    ('instance_pending_donations',        'ALL', 'ALL', 'ALL'),
    ('instance_supporter_tiers',          'ALL', 'ALL', 'ALL'),
    ('instance_supporters',               '', '', 'ALL'),
    ('instance_webrtc_settings',          'ALL', 'ALL', 'ALL'),
    ('invites',                           'ALL', 'ALL', 'ALL'),
    ('megolm_key_backups',                'ALL', 'ALL', 'ALL'),
    ('megolm_key_requests',               '', '', 'ALL'),
    ('megolm_room_sessions',              '', '', 'ALL'),
    ('megolm_session_shares',             'ALL', 'ALL', 'ALL'),
    ('message_heads',                     '', 'SELECT', 'ALL'),
    ('message_search_index',              'ALL', 'ALL', 'ALL'),
    ('messages',                          'ALL', 'ALL', 'ALL'),
    ('metrics_summary_view',              'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER', 'ALL', 'ALL'),
    ('mfa_recovery_codes',                '', '', ''),
    ('notification_channels',             'ALL', 'ALL', 'ALL'),
    ('notification_preferences',          'ALL', 'ALL', 'ALL'),
    ('notification_rate_limits',          'ALL', 'ALL', 'ALL'),
    ('notifications',                     'ALL', 'ALL', 'ALL'),
    ('performance_metrics',               'ALL', 'ALL', 'ALL'),
    ('performance_metrics_hourly',        'ALL', 'ALL', 'ALL'),
    ('pinned_messages_view',              'ALL', 'ALL', 'ALL'),
    ('post_hashtags',                     'ALL', 'ALL', 'ALL'),
    ('post_interactions',                 'ALL', 'ALL', 'ALL'),
    ('posts',                             'ALL', 'ALL', 'ALL'),
    ('prekeys',                           'ALL', 'ALL', 'ALL'),
    ('presence_devices',                  '', '', 'ALL'),
    ('profiles',                          'ALL', 'ALL', 'ALL'),
    ('push_subscriptions',                'ALL', 'ALL', 'ALL'),
    ('reactions',                         'ALL', 'ALL', 'ALL'),
    ('recovery_key_metadata',             'ALL', 'ALL', 'ALL'),
    ('remote_emojis_cache',               'ALL', 'ALL', 'ALL'),
    ('reports',                           '', '', 'ALL'),
    ('room_epoch_state',                  'ALL', 'ALL', 'ALL'),
    ('server_automod_rules',              '', '', 'ALL'),
    ('server_automod_settings',           '', '', 'ALL'),
    ('server_bans',                       'ALL', 'ALL', 'ALL'),
    ('server_encryption_settings',        'ALL', 'ALL', 'ALL'),
    ('server_federation_events',          'ALL', 'ALL', 'ALL'),
    ('server_first_messages',             '', '', 'ALL'),
    ('server_folders',                    'ALL', 'ALL', 'ALL'),
    ('server_member_timeouts',            '', '', 'ALL'),
    ('server_membership_events',          'ALL', 'ALL', 'ALL'),
    ('server_roles',                      'ALL', 'ALL', 'ALL'),
    ('server_settings',                   'ALL', 'ALL', 'ALL'),
    ('server_welcome_screens',            '', '', 'ALL'),
    ('servers',                           'ALL', 'ALL', 'ALL'),
    ('slow_queries',                      'ALL', 'ALL', 'ALL'),
    ('slow_queries_summary',              'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER', 'ALL', 'ALL'),
    ('suspicious_activity',               '', '', 'ALL'),
    ('thread_members',                    'ALL', 'ALL', 'ALL'),
    ('threads',                           'ALL', 'ALL', 'ALL'),
    ('timeline_entries',                  'ALL', 'ALL', 'ALL'),
    ('timeline_posts',                    'ALL', 'ALL', 'ALL'),
    ('trending_posts',                    'ALL', 'ALL', 'ALL'),
    ('trending_refresh_queue',            'ALL', 'ALL', 'ALL'),
    ('trending_users',                    'ALL', 'ALL', 'ALL'),
    ('unread_counts',                     '', 'SELECT', 'ALL'),
    ('user_blocks',                       'ALL', 'ALL', 'ALL'),
    ('user_bookmarks',                    'ALL', 'ALL', 'ALL'),
    ('user_devices',                      'ALL', 'ALL', 'ALL'),
    ('user_key_pairs',                    'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER', 'ALL'),
    ('user_list_members',                 'ALL', 'ALL', 'ALL'),
    ('user_lists',                        'ALL', 'ALL', 'ALL'),
    ('user_mutes',                        'ALL', 'ALL', 'ALL'),
    ('user_presence',                     '', '', 'ALL'),
    ('user_private_keys',                 'ALL', 'ALL', 'ALL'),
    ('user_roles',                        'ALL', 'ALL', 'ALL'),
    ('user_servers',                      'ALL', 'ALL', 'ALL'),
    ('user_sessions',                     'ALL', 'ALL', 'ALL'),
    ('user_timeline_cache',               'ALL', 'ALL', 'ALL'),
    ('user_view_contexts',                'ALL', 'ALL', 'ALL'),
    ('visible_posts',                     'ALL', 'ALL', 'ALL'),
    ('voice_channel_participants',        'ALL', 'ALL', 'ALL'),
    ('voice_federation_events',           'ALL', 'ALL', 'ALL');

DO $$
DECLARE
    g record;
    grantee text;
    privs text;
BEGIN
    FOR g IN SELECT * FROM fresh_grants LOOP
        CONTINUE WHEN to_regclass(format('public.%I', g.rel)) IS NULL;
        FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
            privs := CASE grantee WHEN 'anon' THEN g.anon
                                  WHEN 'authenticated' THEN g.authenticated
                                  ELSE g.service_role END;
            CONTINUE WHEN privs = '';
            EXECUTE format('GRANT %s ON public.%I TO %I', privs, g.rel, grantee);
        END LOOP;
    END LOOP;
END;
$$;

DO $$
DECLARE
    seq text;
BEGIN
    FOREACH seq IN ARRAY ARRAY['account_security_attempts_id_seq', 'activity_processing_logs_id_seq'] LOOP
        CONTINUE WHEN to_regclass(format('public.%I', seq)) IS NULL;
        EXECUTE format('GRANT ALL ON SEQUENCE public.%I TO anon, authenticated, service_role', seq);
    END LOOP;
END;
$$;

COMMIT;
