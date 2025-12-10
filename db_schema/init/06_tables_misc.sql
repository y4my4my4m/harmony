-- =============================================================================
-- Harmony Database Schema - Miscellaneous Tables
-- =============================================================================
-- Bots, notifications, emojis, encryption, reports, etc.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EMOJIS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.emojis (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    name text NOT NULL,
    url text NOT NULL,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    
    -- Global emoji (available everywhere)
    is_global boolean DEFAULT false,
    
    -- Animated
    is_animated boolean DEFAULT false,
    
    -- Federation
    remote_url text,
    domain text,
    
    created_at timestamp with time zone DEFAULT now(),
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    
    UNIQUE(server_id, name)
);

CREATE INDEX IF NOT EXISTS idx_emojis_server ON public.emojis(server_id);
CREATE INDEX IF NOT EXISTS idx_emojis_name ON public.emojis(lower(name));

COMMENT ON TABLE public.emojis IS 'Custom emoji library';

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Type: follow, mention, reply, reblog, favorite, poll, etc.
    type text NOT NULL,
    
    -- What triggered the notification
    actor_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE,
    message_id uuid REFERENCES public.messages(id) ON DELETE CASCADE,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    
    -- State
    read boolean DEFAULT false,
    read_at timestamp with time zone,
    
    -- Extra data
    metadata jsonb DEFAULT '{}'::jsonb
);

ALTER TABLE public.notifications REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON public.notifications(user_id, read) WHERE read = false;
CREATE INDEX IF NOT EXISTS idx_notifications_created ON public.notifications(created_at DESC);

COMMENT ON TABLE public.notifications IS 'User notifications';

-- ---------------------------------------------------------------------------
-- NOTIFICATION PREFERENCES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    
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
    
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.notification_preferences REPLICA IDENTITY FULL;

COMMENT ON TABLE public.notification_preferences IS 'User notification preferences';

-- ---------------------------------------------------------------------------
-- PUSH SUBSCRIPTIONS (Web Push)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    
    device_name text,
    
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone,
    
    UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions(user_id);

COMMENT ON TABLE public.push_subscriptions IS 'Web Push notification subscriptions';

-- ---------------------------------------------------------------------------
-- UNREAD COUNTS (denormalized for performance)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unread_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    notifications_count integer DEFAULT 0,
    mentions_count integer DEFAULT 0,
    dms_count integer DEFAULT 0,
    
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.unread_counts REPLICA IDENTITY FULL;

COMMENT ON TABLE public.unread_counts IS 'Denormalized unread counts for fast UI updates';

-- ---------------------------------------------------------------------------
-- REPORTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    reporter_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reported_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reported_post_id uuid REFERENCES public.posts(id) ON DELETE SET NULL,
    reported_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
    
    reason text NOT NULL,
    comment text,
    
    -- Status
    status text DEFAULT 'pending'::text,
    resolved_at timestamp with time zone,
    resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    resolution_notes text,
    
    -- Source
    source text DEFAULT 'local'::text,
    
    CONSTRAINT reports_status_check CHECK (status IN ('pending', 'reviewing', 'resolved', 'rejected'))
);

ALTER TABLE public.reports REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_reports_status ON public.reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON public.reports(reported_user_id);

COMMENT ON TABLE public.reports IS 'User and content reports';

-- ---------------------------------------------------------------------------
-- BOTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bots (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    name text NOT NULL,
    description text,
    avatar_url text,
    
    owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Public bots can be added by anyone
    is_public boolean DEFAULT false,
    is_verified boolean DEFAULT false,
    
    -- Stats
    server_count integer DEFAULT 0,
    
    -- Tags for discovery
    tags text[] DEFAULT '{}'::text[]
);

CREATE INDEX IF NOT EXISTS idx_bots_owner ON public.bots(owner_id);
CREATE INDEX IF NOT EXISTS idx_bots_public ON public.bots(is_public) WHERE is_public = true;

COMMENT ON TABLE public.bots IS 'Bot definitions';

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
    created_at timestamp with time zone DEFAULT now(),
    
    UNIQUE(user_id, gif_url)
);

CREATE INDEX IF NOT EXISTS idx_gif_favorites_user ON public.gif_favorites(user_id);

COMMENT ON TABLE public.gif_favorites IS 'User favorite GIFs';

-- ---------------------------------------------------------------------------
-- ADMIN AUDIT LOG
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    admin_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    action text NOT NULL,
    target_type text,
    target_id uuid,
    
    details jsonb DEFAULT '{}'::jsonb,
    ip_address inet
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin ON public.admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON public.admin_audit_log(created_at DESC);

COMMENT ON TABLE public.admin_audit_log IS 'Admin action audit log';

-- ---------------------------------------------------------------------------
-- ENCRYPTION - User Key Pairs (E2E encryption)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_key_pairs (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    device_id text NOT NULL,
    
    -- Keys
    identity_key text NOT NULL,
    signed_prekey text NOT NULL,
    signed_prekey_signature text NOT NULL,
    
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_key_pairs_user ON public.user_key_pairs(user_id);

COMMENT ON TABLE public.user_key_pairs IS 'User encryption key pairs for E2E encryption';

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

DO $$
BEGIN
    RAISE NOTICE 'Miscellaneous tables created successfully';
END $$;

