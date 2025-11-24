-- =====================================================
-- BOT API DATABASE SCHEMA
-- Discord-like Bot System for Harmony
-- =====================================================

-- =====================================================
-- 1. BOTS TABLE
-- Core bot information
-- =====================================================

CREATE TABLE IF NOT EXISTS public.bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Bot identity
    username TEXT UNIQUE NOT NULL,
    discriminator TEXT DEFAULT '0000',
    display_name TEXT,
    avatar_url TEXT DEFAULT '/default_avatar.png',
    banner_url TEXT,
    bio TEXT,
    
    -- Owner
    owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Bot flags
    is_verified BOOLEAN DEFAULT false,
    is_public BOOLEAN DEFAULT true, -- If false, only owner can add to servers
    is_active BOOLEAN DEFAULT true,
    
    -- Bot type
    bot_type TEXT DEFAULT 'bot' CHECK (bot_type IN ('bot', 'bridge', 'integration')),
    
    -- Metadata
    website_url TEXT,
    support_server_id UUID REFERENCES public.servers(id) ON DELETE SET NULL,
    tags TEXT[] DEFAULT '{}',
    
    -- Statistics
    server_count INTEGER DEFAULT 0,
    user_count INTEGER DEFAULT 0,
    command_count BIGINT DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_online_at TIMESTAMPTZ,
    
    -- Settings
    settings JSONB DEFAULT '{}'::jsonb,
    
    CONSTRAINT valid_username CHECK (username ~* '^[a-z0-9_-]+$' AND char_length(username) >= 3 AND char_length(username) <= 32)
);

CREATE INDEX idx_bots_owner_id ON public.bots(owner_id);
CREATE INDEX idx_bots_username ON public.bots(username);
CREATE INDEX idx_bots_is_public ON public.bots(is_public) WHERE is_public = true;
CREATE INDEX idx_bots_created_at ON public.bots(created_at DESC);

COMMENT ON TABLE public.bots IS 'Bot accounts that can be added to servers. Similar to Discord bot system.';
COMMENT ON COLUMN public.bots.bot_type IS 'bot: standard bot, bridge: cross-platform bridge, integration: service integration';

-- =====================================================
-- 2. BOT TOKENS
-- Authentication tokens for bots
-- =====================================================

CREATE TABLE IF NOT EXISTS public.bot_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Token (hashed with bcrypt)
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL, -- First 8 chars for identification
    
    -- Token metadata
    name TEXT, -- User-friendly name for this token
    scopes TEXT[] DEFAULT ARRAY['bot']::TEXT[], -- Permissions scopes
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    
    -- Usage tracking
    last_used_at TIMESTAMPTZ,
    uses_count BIGINT DEFAULT 0,
    
    -- Expiration
    expires_at TIMESTAMPTZ,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    revoked_at TIMESTAMPTZ,
    
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_bot_tokens_bot_id ON public.bot_tokens(bot_id);
CREATE INDEX idx_bot_tokens_token_hash ON public.bot_tokens(token_hash);
CREATE INDEX idx_bot_tokens_prefix ON public.bot_tokens(token_prefix);
CREATE INDEX idx_bot_tokens_active ON public.bot_tokens(is_active) WHERE is_active = true;

COMMENT ON TABLE public.bot_tokens IS 'Authentication tokens for bot API access. Tokens are hashed for security.';
COMMENT ON COLUMN public.bot_tokens.token_hash IS 'Bcrypt hash of the token. Never store tokens in plaintext.';
COMMENT ON COLUMN public.bot_tokens.token_prefix IS 'First 8 characters for easy identification in UI.';

-- =====================================================
-- 3. BOT SERVER PERMISSIONS
-- Per-server bot installations and permissions
-- =====================================================

CREATE TABLE IF NOT EXISTS public.bot_server_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    server_id UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    
    -- Installation metadata
    installed_by UUID NOT NULL REFERENCES public.profiles(id),
    installed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    -- Permissions (Discord-like permission flags)
    -- Message Permissions
    read_messages BOOLEAN DEFAULT true,
    send_messages BOOLEAN DEFAULT true,
    send_tts_messages BOOLEAN DEFAULT false,
    manage_messages BOOLEAN DEFAULT false,
    embed_links BOOLEAN DEFAULT true,
    attach_files BOOLEAN DEFAULT true,
    read_message_history BOOLEAN DEFAULT true,
    mention_everyone BOOLEAN DEFAULT false,
    use_external_emojis BOOLEAN DEFAULT true,
    add_reactions BOOLEAN DEFAULT true,
    
    -- Channel Permissions
    view_channels BOOLEAN DEFAULT true,
    manage_channels BOOLEAN DEFAULT false,
    manage_webhooks BOOLEAN DEFAULT false,
    create_instant_invite BOOLEAN DEFAULT false,
    
    -- Voice Permissions
    connect_voice BOOLEAN DEFAULT false,
    speak BOOLEAN DEFAULT false,
    mute_members BOOLEAN DEFAULT false,
    deafen_members BOOLEAN DEFAULT false,
    move_members BOOLEAN DEFAULT false,
    
    -- Server Permissions
    change_nickname BOOLEAN DEFAULT false,
    manage_nicknames BOOLEAN DEFAULT false,
    manage_roles BOOLEAN DEFAULT false,
    kick_members BOOLEAN DEFAULT false,
    ban_members BOOLEAN DEFAULT false,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    
    -- Channel restrictions (null = all channels, else specific channels)
    allowed_channel_ids UUID[],
    
    metadata JSONB DEFAULT '{}'::jsonb,
    
    UNIQUE(bot_id, server_id)
);

CREATE INDEX idx_bot_server_permissions_bot_id ON public.bot_server_permissions(bot_id);
CREATE INDEX idx_bot_server_permissions_server_id ON public.bot_server_permissions(server_id);
CREATE INDEX idx_bot_server_permissions_active ON public.bot_server_permissions(is_active) WHERE is_active = true;

COMMENT ON TABLE public.bot_server_permissions IS 'Bot permissions per server. Controls what actions a bot can perform in each server.';

-- =====================================================
-- 4. BOT RATE LIMITS
-- Track API usage and enforce rate limits
-- =====================================================

CREATE TABLE IF NOT EXISTS public.bot_rate_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Rate limit bucket (e.g., "messages", "channels", "members")
    bucket TEXT NOT NULL,
    
    -- Tracking
    request_count INTEGER DEFAULT 0,
    window_start TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    window_duration_seconds INTEGER DEFAULT 60,
    
    -- Limits
    max_requests INTEGER DEFAULT 100,
    
    -- Reset
    resets_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 minute',
    
    metadata JSONB DEFAULT '{}'::jsonb,
    
    UNIQUE(bot_id, bucket)
);

CREATE INDEX idx_bot_rate_limits_bot_id ON public.bot_rate_limits(bot_id);
CREATE INDEX idx_bot_rate_limits_resets_at ON public.bot_rate_limits(resets_at);

COMMENT ON TABLE public.bot_rate_limits IS 'Rate limiting data for bot API requests. Sliding window rate limits per bucket.';

-- =====================================================
-- 5. BOT WEBHOOKS
-- Optional webhook URLs for event delivery
-- =====================================================

CREATE TABLE IF NOT EXISTS public.bot_webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Webhook URL
    url TEXT NOT NULL,
    secret TEXT, -- For signature verification
    
    -- Event subscriptions
    events TEXT[] DEFAULT ARRAY['*']::TEXT[], -- Which events to receive
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    is_verified BOOLEAN DEFAULT false,
    
    -- Retry config
    max_retries INTEGER DEFAULT 3,
    retry_delay_seconds INTEGER DEFAULT 60,
    
    -- Health tracking
    failed_deliveries INTEGER DEFAULT 0,
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    last_error TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    metadata JSONB DEFAULT '{}'::jsonb,
    
    CONSTRAINT valid_webhook_url CHECK (url ~* '^https?://')
);

CREATE INDEX idx_bot_webhooks_bot_id ON public.bot_webhooks(bot_id);
CREATE INDEX idx_bot_webhooks_active ON public.bot_webhooks(is_active) WHERE is_active = true;

COMMENT ON TABLE public.bot_webhooks IS 'Webhook endpoints for delivering events to bots (alternative to WebSocket).';

-- =====================================================
-- 6. BOT COMMANDS (Optional - for discovery/help)
-- =====================================================

CREATE TABLE IF NOT EXISTS public.bot_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Command definition
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    
    -- Parameters
    options JSONB DEFAULT '[]'::jsonb, -- Array of command options
    
    -- Permissions required
    default_permission BOOLEAN DEFAULT true,
    required_permissions TEXT[],
    
    -- Usage
    dm_enabled BOOLEAN DEFAULT true,
    server_enabled BOOLEAN DEFAULT true,
    
    -- Display
    display_order INTEGER DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(bot_id, name)
);

CREATE INDEX idx_bot_commands_bot_id ON public.bot_commands(bot_id);

COMMENT ON TABLE public.bot_commands IS 'Bot command definitions for discovery and auto-complete.';

-- =====================================================
-- 7. BOT AUDIT LOG
-- Track bot actions for security and debugging
-- =====================================================

CREATE TABLE IF NOT EXISTS public.bot_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Action details
    action_type TEXT NOT NULL CHECK (action_type IN (
        'message_sent',
        'message_deleted',
        'message_edited',
        'member_kicked',
        'member_banned',
        'role_assigned',
        'channel_created',
        'channel_deleted',
        'webhook_created',
        'permission_changed',
        'error',
        'rate_limited'
    )),
    
    -- Context
    server_id UUID REFERENCES public.servers(id) ON DELETE SET NULL,
    channel_id UUID REFERENCES public.channels(id) ON DELETE SET NULL,
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    
    -- Details
    description TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Result
    success BOOLEAN DEFAULT true,
    error_message TEXT,
    
    -- Timestamp
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    -- IP and endpoint
    ip_address INET,
    endpoint TEXT
);

CREATE INDEX idx_bot_audit_log_bot_id ON public.bot_audit_log(bot_id);
CREATE INDEX idx_bot_audit_log_action_type ON public.bot_audit_log(action_type);
CREATE INDEX idx_bot_audit_log_created_at ON public.bot_audit_log(created_at DESC);
CREATE INDEX idx_bot_audit_log_server_id ON public.bot_audit_log(server_id) WHERE server_id IS NOT NULL;

COMMENT ON TABLE public.bot_audit_log IS 'Audit trail of all bot actions for security monitoring and debugging.';

-- =====================================================
-- 8. BOT PRESENCE (Optional - for status tracking)
-- =====================================================

CREATE TABLE IF NOT EXISTS public.bot_presence (
    bot_id UUID PRIMARY KEY REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Connection status
    status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'idle', 'dnd', 'offline')),
    custom_status TEXT,
    
    -- Activity
    activity_type TEXT CHECK (activity_type IN ('playing', 'streaming', 'listening', 'watching', 'competing')),
    activity_name TEXT,
    activity_url TEXT,
    
    -- Connection info
    connected_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    gateway_session_id TEXT,
    
    -- Latency tracking
    latency_ms INTEGER,
    
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.bot_presence IS 'Real-time presence and activity status for bots.';

-- =====================================================
-- 9. ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS
ALTER TABLE public.bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_server_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_presence ENABLE ROW LEVEL SECURITY;

-- Bots Policies
CREATE POLICY "Public bots are viewable by everyone"
    ON public.bots FOR SELECT
    USING (
        is_public = true 
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = bots.owner_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

CREATE POLICY "Bot owners can manage their bots"
    ON public.bots FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = bots.owner_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Bot Tokens Policies (very restricted)
CREATE POLICY "Bot owners can manage tokens"
    ON public.bot_tokens FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.bots
            JOIN public.profiles ON profiles.id = bots.owner_id
            WHERE bots.id = bot_tokens.bot_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Bot Server Permissions Policies
CREATE POLICY "Server members can view bot permissions"
    ON public.bot_server_permissions FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_servers
            JOIN public.profiles ON profiles.id = user_servers.user_id
            WHERE user_servers.server_id = bot_server_permissions.server_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

CREATE POLICY "Server owners can manage bot permissions"
    ON public.bot_server_permissions FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.servers
            JOIN public.profiles ON profiles.id = servers.owner
            WHERE servers.id = bot_server_permissions.server_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Bot Commands are publicly viewable
CREATE POLICY "Bot commands are public"
    ON public.bot_commands FOR SELECT
    USING (true);

CREATE POLICY "Bot owners can manage commands"
    ON public.bot_commands FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.bots
            JOIN public.profiles ON profiles.id = bots.owner_id
            WHERE bots.id = bot_commands.bot_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Bot Audit Log
CREATE POLICY "Bot owners can view audit logs"
    ON public.bot_audit_log FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.bots
            JOIN public.profiles ON profiles.id = bots.owner_id
            WHERE bots.id = bot_audit_log.bot_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Bot Presence is publicly viewable
CREATE POLICY "Bot presence is public"
    ON public.bot_presence FOR SELECT
    USING (true);

-- =====================================================
-- 10. HELPER FUNCTIONS
-- =====================================================

-- Function to verify bot token
CREATE OR REPLACE FUNCTION public.verify_bot_token(
    p_token_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_bot_token public.bot_tokens;
    v_bot public.bots;
    v_result JSONB;
BEGIN
    -- Find active token
    SELECT * INTO v_bot_token
    FROM public.bot_tokens
    WHERE token_hash = p_token_hash
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW());
    
    IF v_bot_token IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Invalid or expired token');
    END IF;
    
    -- Get bot details
    SELECT * INTO v_bot
    FROM public.bots
    WHERE id = v_bot_token.bot_id
        AND is_active = true;
    
    IF v_bot IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Bot not found or inactive');
    END IF;
    
    -- Update last used
    UPDATE public.bot_tokens
    SET last_used_at = NOW(),
        uses_count = uses_count + 1
    WHERE id = v_bot_token.id;
    
    -- Return bot info
    v_result := jsonb_build_object(
        'valid', true,
        'bot_id', v_bot.id,
        'username', v_bot.username,
        'scopes', v_bot_token.scopes
    );
    
    RETURN v_result;
END;
$$;

-- Function to check bot permissions in a server
CREATE OR REPLACE FUNCTION public.check_bot_permission(
    p_bot_id UUID,
    p_server_id UUID,
    p_permission TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_has_permission BOOLEAN;
BEGIN
    EXECUTE format('
        SELECT %I FROM public.bot_server_permissions
        WHERE bot_id = $1 
        AND server_id = $2 
        AND is_active = true
    ', p_permission)
    INTO v_has_permission
    USING p_bot_id, p_server_id;
    
    RETURN COALESCE(v_has_permission, false);
END;
$$;

-- Function to add bot to server
CREATE OR REPLACE FUNCTION public.add_bot_to_server(
    p_bot_id UUID,
    p_server_id UUID,
    p_installed_by UUID,
    p_permissions JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_permission_id UUID;
BEGIN
    -- Check if user is server owner or admin
    IF NOT EXISTS (
        SELECT 1 FROM public.servers
        JOIN public.profiles ON profiles.id = servers.owner
        WHERE servers.id = p_server_id
        AND profiles.auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Only server owners can add bots';
    END IF;
    
    -- Check if bot is public or owned by installer
    IF NOT EXISTS (
        SELECT 1 FROM public.bots
        JOIN public.profiles ON profiles.id = bots.owner_id
        WHERE bots.id = p_bot_id
        AND (bots.is_public = true OR profiles.auth_user_id = auth.uid())
    ) THEN
        RAISE EXCEPTION 'Bot not found or not accessible';
    END IF;
    
    -- Insert permissions
    INSERT INTO public.bot_server_permissions (
        bot_id,
        server_id,
        installed_by
    ) VALUES (
        p_bot_id,
        p_server_id,
        p_installed_by
    )
    ON CONFLICT (bot_id, server_id)
    DO UPDATE SET is_active = true
    RETURNING id INTO v_permission_id;
    
    -- Update bot server count
    UPDATE public.bots
    SET server_count = (
        SELECT COUNT(*) FROM public.bot_server_permissions
        WHERE bot_id = p_bot_id AND is_active = true
    )
    WHERE id = p_bot_id;
    
    RETURN v_permission_id;
END;
$$;

-- =====================================================
-- 11. TRIGGERS
-- =====================================================

-- Update bot updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_bot_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER update_bots_timestamp
    BEFORE UPDATE ON public.bots
    FOR EACH ROW
    EXECUTE FUNCTION public.update_bot_timestamp();

CREATE TRIGGER update_bot_webhooks_timestamp
    BEFORE UPDATE ON public.bot_webhooks
    FOR EACH ROW
    EXECUTE FUNCTION public.update_bot_timestamp();

-- =====================================================
-- 12. GRANTS
-- =====================================================

GRANT SELECT ON public.bots TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.bot_tokens TO authenticated;
GRANT SELECT ON public.bot_server_permissions TO authenticated;
GRANT INSERT, UPDATE ON public.bot_server_permissions TO authenticated;
GRANT SELECT ON public.bot_commands TO authenticated;
GRANT SELECT ON public.bot_presence TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_bot_token TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_bot_permission TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_bot_to_server TO authenticated;

-- =====================================================
-- COMPLETED: Bot API Database Schema
-- =====================================================

