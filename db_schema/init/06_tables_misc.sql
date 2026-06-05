-- =============================================================================
-- Harmony Database Schema - Miscellaneous Tables
-- =============================================================================
-- Bots, notifications, emojis, encryption, reports, etc.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EMOJIS - defined in 04_tables_servers.sql (reactions FK depends on it)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- EMOJI USAGE - Track emoji usage for analytics and suggestions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.emoji_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    emoji_id uuid NOT NULL REFERENCES public.emojis(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    context_type text NOT NULL,
    context_id uuid,
    used_at timestamp with time zone DEFAULT now(),
    
    CONSTRAINT emoji_usage_context_type_check CHECK (context_type IN ('message', 'reaction')),
    CONSTRAINT emoji_usage_unique_per_context UNIQUE (emoji_id, user_id, context_type, context_id)
);

CREATE INDEX IF NOT EXISTS idx_emoji_usage_emoji ON public.emoji_usage(emoji_id);
CREATE INDEX IF NOT EXISTS idx_emoji_usage_user ON public.emoji_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_emoji_usage_server ON public.emoji_usage(server_id);

COMMENT ON TABLE public.emoji_usage IS 'Tracks emoji usage for analytics and frequently used suggestions';

-- ---------------------------------------------------------------------------
-- REMOTE EMOJIS CACHE - For emoji importer feature
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.remote_emojis_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    
    -- Emoji info
    shortcode text NOT NULL,
    origin_domain text NOT NULL,
    full_code text NOT NULL,
    url text NOT NULL,
    static_url text,
    
    -- Tracking
    first_seen_at timestamp with time zone DEFAULT now(),
    last_seen_at timestamp with time zone DEFAULT now(),
    usage_count integer DEFAULT 1,
    
    -- Import tracking
    imported_as uuid REFERENCES public.emojis(id) ON DELETE SET NULL,
    imported_at timestamp with time zone,
    
    -- Metadata
    category text,
    is_animated boolean DEFAULT false,
    
    created_at timestamp with time zone DEFAULT now(),
    
    UNIQUE(shortcode, origin_domain)
);

CREATE INDEX IF NOT EXISTS idx_remote_emojis_cache_domain ON public.remote_emojis_cache(origin_domain);
CREATE INDEX IF NOT EXISTS idx_remote_emojis_cache_usage ON public.remote_emojis_cache(usage_count DESC);
CREATE INDEX IF NOT EXISTS idx_remote_emojis_imported ON public.remote_emojis_cache USING btree (imported_as) WHERE (imported_as IS NULL);

COMMENT ON TABLE public.remote_emojis_cache IS 'Cache of custom emojis encountered from remote instances. Used for the emoji importer feature.';

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS
-- Matches production schema: flat table with JSONB data column.
-- All context (sender, post, server, channel, etc.) is stored in `data`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    type character varying(50) NOT NULL,
    data jsonb DEFAULT '{}'::jsonb,
    is_read boolean DEFAULT false,
    is_clicked boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval),
    read_at timestamp with time zone
);

ALTER TABLE public.notifications REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON public.notifications(user_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_notifications_created ON public.notifications(created_at DESC);

COMMENT ON TABLE public.notifications IS 'User notifications';
COMMENT ON COLUMN public.notifications.is_read IS 'Boolean field indicating if notification has been read';
COMMENT ON COLUMN public.notifications.read_at IS 'Timestamp when notification was marked as read';

-- ---------------------------------------------------------------------------
-- NOTIFICATION PREFERENCES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,

    -- Desktop/sound notifications
    desktop_notifications boolean DEFAULT true,
    desktop_mentions boolean DEFAULT true,
    desktop_replies boolean DEFAULT true,
    desktop_dms boolean DEFAULT true,
    desktop_reactions boolean DEFAULT true,
    desktop_chat_messages boolean DEFAULT true,
    sound_mentions boolean DEFAULT true,
    sound_dms boolean DEFAULT true,
    sound_reactions boolean DEFAULT true,
    sound_replies boolean DEFAULT true,
    sound_chat_messages boolean DEFAULT true,
    sound_voice_activity boolean DEFAULT true,

    -- Do Not Disturb
    dnd_enabled boolean DEFAULT false,
    dnd_start_time time DEFAULT '22:00'::time,
    dnd_end_time time DEFAULT '08:00'::time,

    -- Email notifications
    email_follows boolean DEFAULT true,
    email_mentions boolean DEFAULT true,
    email_replies boolean DEFAULT true,
    email_reblogs boolean DEFAULT true,
    email_favorites boolean DEFAULT true,

    -- Push notifications
    push_follows boolean DEFAULT true,
    push_mentions boolean DEFAULT true,
    push_replies boolean DEFAULT true,
    push_reblogs boolean DEFAULT true,
    push_favorites boolean DEFAULT true,
    push_dms boolean DEFAULT true,

    -- ActivityPub notifications
    activitypub_notifications boolean DEFAULT true,
    activitypub_desktop_notifications boolean DEFAULT true,
    activitypub_follows boolean DEFAULT true,
    activitypub_follow_requests boolean DEFAULT true,
    activitypub_favorites boolean DEFAULT true,
    activitypub_reblogs boolean DEFAULT true,
    activitypub_mentions boolean DEFAULT true,
    activitypub_replies boolean DEFAULT true,
    activitypub_desktop_follows boolean DEFAULT true,
    activitypub_desktop_favorites boolean DEFAULT true,
    activitypub_desktop_reblogs boolean DEFAULT true,
    activitypub_desktop_mentions boolean DEFAULT true,
    activitypub_desktop_replies boolean DEFAULT true,

    -- ActivityPub sound notifications
    activitypub_sound_notifications boolean DEFAULT true,
    activitypub_sound_follows boolean DEFAULT true,
    activitypub_sound_favorites boolean DEFAULT true,
    activitypub_sound_reblogs boolean DEFAULT true,
    activitypub_sound_mentions boolean DEFAULT true,
    activitypub_sound_replies boolean DEFAULT true,

    -- Sound master toggle
    sound_notifications boolean DEFAULT true,

    -- Push/email master toggles
    push_notifications boolean DEFAULT true,
    push_offline_only boolean DEFAULT true,
    email_notifications boolean DEFAULT false,
    email_digest boolean DEFAULT false,
    email_digest_frequency character varying(20) DEFAULT 'weekly',

    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.notification_preferences REPLICA IDENTITY FULL;

COMMENT ON TABLE public.notification_preferences IS 'User notification preferences';

-- ---------------------------------------------------------------------------
-- NOTIFICATION CHANNELS - Per-channel/server muting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    channel_id uuid REFERENCES public.channels(id) ON DELETE CASCADE,
    conversation_id uuid,
    
    muted boolean DEFAULT false,
    muted_until timestamp with time zone,
    -- 'mentions' by default: new channels notify only on @mentions until the
    -- user explicitly chooses 'all' or 'none' in the channel kebab menu.
    -- See db_schema/migrations/20260520_default_notification_level_mentions.sql.
    notification_level varchar(20) DEFAULT 'mentions'::varchar,
    
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_channels_user ON public.notification_channels(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_channels_server ON public.notification_channels(server_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_user_channel
  ON public.notification_channels (user_id, channel_id)
  WHERE channel_id IS NOT NULL AND conversation_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_user_conversation
  ON public.notification_channels (user_id, conversation_id)
  WHERE conversation_id IS NOT NULL AND channel_id IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_channels TO authenticated;

COMMENT ON TABLE public.notification_channels IS 'Channel/server/conversation specific notification muting settings';

-- ---------------------------------------------------------------------------
-- PUSH SUBSCRIPTIONS (Web Push)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    
    -- Device info
    user_agent text,
    device_name text,
    
    -- Timestamps
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    
    -- Push delivery tracking
    last_successful_push timestamp with time zone,
    failure_count integer DEFAULT 0,
    last_failure_at timestamp with time zone,
    last_failure_reason text
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON public.push_subscriptions(endpoint);

COMMENT ON TABLE public.push_subscriptions IS 'Stores Web Push notification subscriptions for each user device. Used for native push notifications on iOS (16.4+) and Android PWAs.';
COMMENT ON COLUMN public.push_subscriptions.endpoint IS 'The unique push service URL for this subscription';

-- ---------------------------------------------------------------------------
-- UNREAD COUNTS (denormalized for performance)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unread_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    channel_id uuid REFERENCES public.channels(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
    
    unread_messages integer DEFAULT 0,
    unread_mentions integer DEFAULT 0,
    last_read_message_id uuid,
    last_read_at timestamp with time zone DEFAULT now(),
    
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.unread_counts REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_unread_counts_user ON public.unread_counts(user_id);
CREATE INDEX IF NOT EXISTS idx_unread_counts_channel ON public.unread_counts(channel_id);
CREATE INDEX IF NOT EXISTS idx_unread_counts_conversation ON public.unread_counts(conversation_id);

COMMENT ON TABLE public.unread_counts IS 'Per-channel/conversation unread message tracking';

-- ---------------------------------------------------------------------------
-- REPORTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    reporter_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reported_user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    reported_post_id uuid REFERENCES public.posts(id) ON DELETE SET NULL,
    reported_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
    reported_server_id uuid REFERENCES public.servers(id) ON DELETE SET NULL,
    
    reason text NOT NULL,
    comment text,
    report_type text NOT NULL DEFAULT 'user',
    
    -- Status
    status text DEFAULT 'pending'::text,
    resolved_at timestamp with time zone,
    resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    resolution_note text,
    
    -- Source / Federation
    source text DEFAULT 'local'::text,
    source_instance text,
    ap_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    federation_status text DEFAULT 'pending'::text,
    
    CONSTRAINT reports_status_check CHECK (status IN ('pending', 'investigating', 'resolved', 'dismissed')),
    CONSTRAINT reports_report_type_check CHECK (report_type IN ('user', 'post', 'message', 'server')),
    CONSTRAINT reports_source_check CHECK (source IN ('local', 'federation')),
    CONSTRAINT reports_federation_status_check CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped')),
    CONSTRAINT reports_reason_length_check CHECK (char_length(reason) <= 200),
    CONSTRAINT reports_comment_length_check CHECK (comment IS NULL OR char_length(comment) <= 1000)
);

ALTER TABLE public.reports REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_reports_status ON public.reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON public.reports(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_report_type ON public.reports(report_type);
CREATE INDEX IF NOT EXISTS idx_reports_reported_message ON public.reports(reported_message_id);

COMMENT ON TABLE public.reports IS 'User and content reports';

-- ---------------------------------------------------------------------------
-- BOTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bots (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    username text NOT NULL,
    discriminator text DEFAULT '0000'::text,
    display_name text,
    avatar_url text DEFAULT '/default_avatar.webp'::text,
    banner_url text,
    bio text,
    
    owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    is_verified boolean DEFAULT false,
    is_public boolean DEFAULT true,
    is_active boolean DEFAULT true,
    
    bot_type text DEFAULT 'bot'::text,
    website_url text,
    support_server_id uuid,
    
    -- Tags for discovery
    tags text[] DEFAULT '{}'::text[],
    
    -- Stats
    server_count integer DEFAULT 0,
    user_count integer DEFAULT 0,
    command_count bigint DEFAULT 0,
    
    last_online_at timestamp with time zone,
    settings jsonb DEFAULT '{}'::jsonb,
    
    CONSTRAINT bots_bot_type_check CHECK (bot_type IN ('bot', 'bridge', 'integration')),
    CONSTRAINT valid_username CHECK (username ~* '^[a-z0-9_-]+$' AND char_length(username) >= 3 AND char_length(username) <= 32),
    CONSTRAINT bots_display_name_length_check CHECK (display_name IS NULL OR char_length(display_name) <= 100),
    CONSTRAINT bots_bio_length_check CHECK (bio IS NULL OR char_length(bio) <= 500),
    CONSTRAINT bots_website_url_length_check CHECK (website_url IS NULL OR char_length(website_url) <= 512)
);

CREATE INDEX IF NOT EXISTS idx_bots_owner ON public.bots(owner_id);
CREATE INDEX IF NOT EXISTS idx_bots_public ON public.bots(is_public) WHERE is_public = true;

COMMENT ON TABLE public.bots IS 'Bot definitions';

-- Owners interactively manage their own bots (RLS narrows to owner-only).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bots TO authenticated;

-- ---------------------------------------------------------------------------
-- BOT TOKENS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    
    token_hash text NOT NULL,
    token_prefix text NOT NULL,
    
    name text,
    scopes text[] DEFAULT '{}'::text[],
    
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_bot_tokens_bot ON public.bot_tokens(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_tokens_prefix ON public.bot_tokens(token_prefix);

COMMENT ON TABLE public.bot_tokens IS 'Bot API tokens';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_tokens TO authenticated;

-- ---------------------------------------------------------------------------
-- BOT SERVER PERMISSIONS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_server_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    
    installed_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    installed_at timestamp with time zone DEFAULT now(),
    
    is_active boolean DEFAULT true,
    
    -- Permissions
    read_messages boolean DEFAULT true,
    send_messages boolean DEFAULT true,
    manage_messages boolean DEFAULT false,
    embed_links boolean DEFAULT true,
    attach_files boolean DEFAULT true,
    mention_everyone boolean DEFAULT false,
    add_reactions boolean DEFAULT true,
    manage_channels boolean DEFAULT false,
    kick_members boolean DEFAULT false,
    ban_members boolean DEFAULT false,
    
    UNIQUE(bot_id, server_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_server_permissions_bot ON public.bot_server_permissions(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_server_permissions_server ON public.bot_server_permissions(server_id);

COMMENT ON TABLE public.bot_server_permissions IS 'Bot permissions per server';

-- ---------------------------------------------------------------------------
-- FILES (Attachments)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.files (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    filename text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    
    storage_path text NOT NULL,
    public_url text,
    
    -- For images
    width integer,
    height integer,
    blurhash text,
    
    -- Metadata
    metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_files_owner ON public.files(owner_id);

COMMENT ON TABLE public.files IS 'Uploaded file metadata';

-- ---------------------------------------------------------------------------
-- GIF FAVORITES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gif_favorites (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    gif_url text NOT NULL,
    preview_url text,
    title text,
    -- 'gif' | 'sticker' — keeps the GIF and sticker favorite lists separate.
    media_type text NOT NULL DEFAULT 'gif',
    created_at timestamp with time zone DEFAULT now(),
    
    UNIQUE(user_id, gif_url)
);

CREATE INDEX IF NOT EXISTS idx_gif_favorites_user ON public.gif_favorites(user_id);

COMMENT ON TABLE public.gif_favorites IS 'User favorite GIFs and stickers';

-- ---------------------------------------------------------------------------
-- EMOJI FAVORITES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.emoji_favorites (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    emoji_id text NOT NULL,
    emoji_name text NOT NULL,
    emoji_url text,
    emoji_server_id uuid,
    created_at timestamp with time zone DEFAULT now(),

    UNIQUE(user_id, emoji_id)
);

CREATE INDEX IF NOT EXISTS idx_emoji_favorites_user ON public.emoji_favorites(user_id);

GRANT SELECT, INSERT, DELETE ON public.emoji_favorites TO authenticated;

COMMENT ON TABLE public.emoji_favorites IS 'User favorite emojis (unicode and custom)';

-- ---------------------------------------------------------------------------
-- ADMIN AUDIT LOG
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,

    admin_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    action_type text NOT NULL,
    target_type text,
    target_id text,

    action_details jsonb DEFAULT '{}'::jsonb,
    ip_address inet,
    user_agent text
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin ON public.admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON public.admin_audit_log(created_at DESC);

COMMENT ON TABLE public.admin_audit_log IS 'Admin action audit log';

-- ---------------------------------------------------------------------------
-- ENCRYPTION - User Key Pairs (Megolm-style E2E encryption)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_key_pairs (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    device_id text DEFAULT 'default'::text,
    
    -- ECDH P-256 identity keys (session key exchange)
    identity_public_key text NOT NULL,
    identity_private_key_encrypted text NOT NULL,

    -- ECDSA P-256 signing keys (per-message sender binding, Megolm v2).
    -- Nullable for legacy rows; client mints them lazily on next unlock.
    -- See db_schema/migrations/20260520_user_key_pairs_signing_keys.sql for rationale.
    identity_signing_public_key text,
    identity_signing_private_key_encrypted text,
    
    -- Versioning & status
    key_version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true,
    
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    
    CONSTRAINT valid_device_id CHECK (char_length(device_id) <= 255)
);

CREATE INDEX IF NOT EXISTS idx_user_key_pairs_user ON public.user_key_pairs(user_id);
CREATE INDEX IF NOT EXISTS idx_user_key_pairs_active ON public.user_key_pairs(user_id, is_active) WHERE is_active = true;

COMMENT ON TABLE public.user_key_pairs IS 'Per-user encryption identity keys. ECDH P-256 for session exchange, ECDSA P-256 for per-message sender signatures (Megolm v2 binding). Supports future per-device migration.';

-- ---------------------------------------------------------------------------
-- PREKEYS (One-time prekeys for Signal protocol)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.prekeys (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    device_id text NOT NULL,
    prekey_id integer NOT NULL,
    public_key text NOT NULL,
    
    is_signed boolean DEFAULT false,
    signature text,
    is_one_time boolean DEFAULT true,
    
    created_at timestamp with time zone DEFAULT now(),
    used_at timestamp with time zone,
    expires_at timestamp with time zone,
    
    UNIQUE(user_id, device_id, prekey_id)
);

CREATE INDEX IF NOT EXISTS idx_prekeys_user_device ON public.prekeys(user_id, device_id);
CREATE INDEX IF NOT EXISTS idx_prekeys_available ON public.prekeys(user_id, device_id) WHERE used_at IS NULL;

COMMENT ON TABLE public.prekeys IS 'One-time prekeys for E2E encryption key exchange';

-- ---------------------------------------------------------------------------
-- INSTANCE WEBRTC SETTINGS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_webrtc_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    
    webrtc_mode text DEFAULT 'hybrid'::text,
    
    -- LiveKit configuration
    livekit_url text,                -- WebSocket URL (wss://...)
    livekit_public_url text,         -- Public URL if different
    livekit_api_key text,            -- API Key (APIxxxx)
    livekit_api_secret text,         -- API Secret (SENSITIVE - never expose!)
    
    -- TURN servers (for P2P fallback)
    turn_servers jsonb DEFAULT '[]'::jsonb,
    
    -- Federation
    allow_federated_voice boolean DEFAULT true,
    
    -- Stage/voice limits
    max_stage_listeners integer DEFAULT 100000 NOT NULL,
    
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    CONSTRAINT instance_webrtc_settings_mode_check CHECK (webrtc_mode IN ('sfu', 'p2p', 'hybrid'))
);

-- Ensure only one row
CREATE UNIQUE INDEX IF NOT EXISTS idx_instance_webrtc_settings_singleton ON public.instance_webrtc_settings((TRUE));

COMMENT ON TABLE public.instance_webrtc_settings IS 'Instance WebRTC configuration';

-- Insert default settings
INSERT INTO public.instance_webrtc_settings (webrtc_mode, allow_federated_voice)
VALUES ('hybrid', true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- PERFORMANCE METRICS (optional)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.performance_metrics (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    timestamp timestamp with time zone DEFAULT now() NOT NULL,
    
    metric_type text NOT NULL,
    metric_name text NOT NULL,
    value double precision NOT NULL,
    
    labels jsonb DEFAULT '{}'::jsonb,
    source text
);

CREATE INDEX IF NOT EXISTS idx_performance_metrics_timestamp ON public.performance_metrics(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_type ON public.performance_metrics(metric_type, metric_name);

-- Partitioning hint: Consider partitioning by timestamp for large deployments
COMMENT ON TABLE public.performance_metrics IS 'Optional performance metrics storage';

-- ---------------------------------------------------------------------------
-- NOTIFICATION RATE LIMITS - For spam prevention
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_rate_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    notification_type text NOT NULL,
    source_user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    notification_count integer DEFAULT 1,
    last_notification_at timestamp with time zone DEFAULT now(),
    suppressed_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),

    UNIQUE(user_id, notification_type, source_user_id)
);
COMMENT ON TABLE public.notification_rate_limits IS 'Rate limiting for notifications to prevent spam';

CREATE INDEX IF NOT EXISTS idx_notification_rate_limits_user ON public.notification_rate_limits(user_id);

-- ---------------------------------------------------------------------------
-- USER VIEW CONTEXTS - Track where users are viewing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_view_contexts (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    view_type text NOT NULL,
    server_id uuid REFERENCES public.servers(id) ON DELETE SET NULL,
    channel_id uuid REFERENCES public.channels(id) ON DELETE SET NULL,
    conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
    last_active_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.user_view_contexts IS 'Track where users are currently viewing (for presence)';

CREATE INDEX IF NOT EXISTS idx_user_view_contexts_user ON public.user_view_contexts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_view_contexts_channel ON public.user_view_contexts(channel_id) WHERE channel_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- MESSAGE SEARCH INDEX - Full-text search for messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.message_search_index (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    message_id uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
    content_text text,
    content_tsvector tsvector,
    channel_id uuid REFERENCES public.channels(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
    user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    has_media boolean DEFAULT false,
    has_url boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.message_search_index IS 'Full-text search index for messages';

CREATE INDEX IF NOT EXISTS idx_message_search_tsvector ON public.message_search_index USING gin(content_tsvector);
CREATE INDEX IF NOT EXISTS idx_message_search_channel ON public.message_search_index(channel_id);
CREATE INDEX IF NOT EXISTS idx_message_search_conversation ON public.message_search_index(conversation_id);
CREATE INDEX IF NOT EXISTS idx_message_search_user ON public.message_search_index(user_id);

-- ---------------------------------------------------------------------------
-- INSTANCE FUNDING
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_funding (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    enabled boolean DEFAULT false,
    goal_amount numeric(10,2),
    goal_currency text DEFAULT 'USD',
    current_amount numeric(10,2) DEFAULT 0,
    funding_period text DEFAULT 'monthly',
    goal_description text,
    funding_links jsonb DEFAULT '[]'::jsonb,
    show_progress_bar boolean DEFAULT true,
    show_in_context_bar boolean DEFAULT false,
    context_bar_style text DEFAULT 'mini-progress',
    thank_you_message text,
    -- Ko-fi webhook integration (Gold-tier feature). Verification token comes
    -- from Ko-fi Settings → API → Webhook URL. When set, the federation
    -- backend accepts POSTs at /webhooks/kofi for automated donation tracking.
    kofi_webhook_token text,
    kofi_auto_assign_tier boolean DEFAULT true,
    updated_at timestamptz DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- INSTANCE SUPPORTER TIERS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_supporter_tiers (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    min_amount numeric(10,2) NOT NULL,
    badge_icon text,
    badge_color text,
    perks text,
    display_order integer DEFAULT 0,
    -- When true, active supporters on this tier get the ad-free Klipy GIF key.
    removes_ads boolean NOT NULL DEFAULT false,
    created_at timestamptz DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- INSTANCE SUPPORTERS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_supporters (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    tier_id uuid REFERENCES public.instance_supporter_tiers(id) ON DELETE SET NULL,
    amount numeric(10,2),
    started_at timestamptz DEFAULT now(),
    expires_at timestamptz,
    is_active boolean DEFAULT true,
    external_id text,
    platform text,
    CONSTRAINT unique_supporter_user UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_supporters_user ON public.instance_supporters(user_id);
CREATE INDEX IF NOT EXISTS idx_supporters_active ON public.instance_supporters(is_active);

-- ---------------------------------------------------------------------------
-- INSTANCE DONATION HISTORY
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_donation_history (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    supporter_id uuid NOT NULL REFERENCES public.instance_supporters(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount numeric(10,2) NOT NULL,
    currency text DEFAULT 'USD',
    platform text,
    external_reference text,
    note text,
    donated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_donation_history_user ON public.instance_donation_history(user_id);
CREATE INDEX IF NOT EXISTS idx_donation_history_supporter ON public.instance_donation_history(supporter_id);
CREATE INDEX IF NOT EXISTS idx_donation_history_date ON public.instance_donation_history(donated_at);
-- Dedup webhook retries: NULL external_reference (manual entries) always
-- allowed; non-null values must be unique per platform.
CREATE UNIQUE INDEX IF NOT EXISTS idx_donation_history_external_unique
    ON public.instance_donation_history (platform, external_reference)
    WHERE external_reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- INSTANCE PENDING DONATIONS
-- ---------------------------------------------------------------------------
-- Donations received via webhook that could not be auto-matched to a profile.
-- Admins review these manually and either link to an existing user (which
-- promotes them to instance_donation_history) or dismiss.
CREATE TABLE IF NOT EXISTS public.instance_pending_donations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    received_at timestamptz DEFAULT now(),
    platform text NOT NULL,
    external_reference text,
    amount numeric(10, 2) NOT NULL,
    currency text DEFAULT 'USD',
    donor_name text,
    donor_email text,
    donor_message text,
    raw_payload jsonb NOT NULL,
    resolved_at timestamptz,
    resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    resolved_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    CONSTRAINT instance_pending_donations_external_unique
        UNIQUE (platform, external_reference)
);

CREATE INDEX IF NOT EXISTS idx_pending_donations_unresolved
    ON public.instance_pending_donations (received_at DESC)
    WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- FUNDING TABLE GRANTS
-- ---------------------------------------------------------------------------
-- authenticated: admin UI + per-user supporter/donation queries (RLS gates access)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_funding TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_supporter_tiers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_supporters TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_donation_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_pending_donations TO authenticated;

-- service_role: federation backend webhook ingestion. Bypasses RLS but still
-- needs explicit table grants.
GRANT SELECT ON public.instance_funding TO service_role;
GRANT SELECT ON public.instance_supporter_tiers TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.instance_supporters TO service_role;
GRANT SELECT, INSERT ON public.instance_donation_history TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_pending_donations TO service_role;
-- profiles read access for handle matching (no writes - webhook never mutates profiles)
GRANT SELECT ON public.profiles TO service_role;

-- ---------------------------------------------------------------------------
-- INSTANCE ANNOUNCEMENTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_announcements (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    title text NOT NULL,
    content text NOT NULL,
    image_url text,
    icon text DEFAULT 'info',
    is_active boolean DEFAULT true,
    starts_at timestamptz DEFAULT now(),
    ends_at timestamptz,
    is_pinned boolean DEFAULT false,
    show_popup boolean DEFAULT true,
    silence boolean DEFAULT false,
    author_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    display_order integer DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_announcements_active
    ON public.instance_announcements(is_active, starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- ANNOUNCEMENT READS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.announcement_reads (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    announcement_id uuid NOT NULL REFERENCES public.instance_announcements(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    read_at timestamptz DEFAULT now(),
    CONSTRAINT unique_announcement_read UNIQUE (announcement_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_reads_user
    ON public.announcement_reads(user_id);

GRANT SELECT ON public.instance_announcements TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.instance_announcements TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.announcement_reads TO authenticated;

DO $$
BEGIN
    RAISE NOTICE 'Miscellaneous tables created successfully';
END $$;

