-- =============================================================================
-- Harmony Database Schema - Extended Bot Tables
-- =============================================================================
-- Additional bot functionality: commands, webhooks, presence, rate limits
-- =============================================================================

-- ---------------------------------------------------------------------------
-- BOT COMMANDS - Registered bot commands
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Command definition
    name text NOT NULL,
    description text,
    usage text,
    
    -- Command type: slash, prefix, context_menu
    command_type text DEFAULT 'prefix'::text,
    
    -- Options/arguments schema
    options jsonb DEFAULT '[]'::jsonb,
    
    -- Permissions required to use
    required_permissions bigint DEFAULT 0,
    
    -- Cooldown in seconds
    cooldown_seconds integer DEFAULT 0,
    
    -- Guild vs global
    is_guild_command boolean DEFAULT true,
    enabled_guild_ids uuid[] DEFAULT '{}'::uuid[],
    
    -- Usage stats
    usage_count integer DEFAULT 0,
    last_used_at timestamp with time zone,
    
    UNIQUE(bot_id, name),
    CONSTRAINT bot_commands_type_check CHECK (command_type IN ('prefix', 'slash', 'context_menu'))
);

ALTER TABLE public.bot_commands REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_bot_commands_bot ON public.bot_commands(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_commands_name ON public.bot_commands(name);

COMMENT ON TABLE public.bot_commands IS 'Registered bot commands for discovery';

-- ---------------------------------------------------------------------------
-- BOT WEBHOOKS - Webhook endpoints for bots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Webhook details
    name text NOT NULL,
    url text NOT NULL,
    secret text,
    
    -- Target channel
    channel_id uuid REFERENCES public.channels(id) ON DELETE SET NULL,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    
    -- Event subscriptions
    events text[] DEFAULT '{}'::text[],
    
    -- State
    is_active boolean DEFAULT true,
    
    -- Stats
    last_triggered_at timestamp with time zone,
    trigger_count integer DEFAULT 0,
    failure_count integer DEFAULT 0,
    last_error text,
    
    UNIQUE(bot_id, channel_id, name)
);

CREATE INDEX IF NOT EXISTS idx_bot_webhooks_bot ON public.bot_webhooks(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_webhooks_channel ON public.bot_webhooks(channel_id);

COMMENT ON TABLE public.bot_webhooks IS 'Bot webhook configurations';

-- ---------------------------------------------------------------------------
-- BOT PRESENCE - Bot online/offline status tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_presence (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    
    bot_id uuid NOT NULL UNIQUE REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Status: online, idle, dnd, offline
    status text DEFAULT 'offline'::text,
    
    -- Custom status message
    activity_type text,  -- playing, listening, watching, streaming, competing
    activity_name text,
    activity_url text,
    
    -- Connection info
    connected_at timestamp with time zone,
    last_heartbeat_at timestamp with time zone,
    
    -- Shard info for distributed bots
    shard_id integer,
    total_shards integer,
    
    -- Version info
    gateway_version text,
    
    CONSTRAINT bot_presence_status_check CHECK (status IN ('online', 'idle', 'dnd', 'offline'))
);

ALTER TABLE public.bot_presence REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_bot_presence_status ON public.bot_presence(status);

COMMENT ON TABLE public.bot_presence IS 'Bot online presence and status';

-- ---------------------------------------------------------------------------
-- BOT RATE LIMITS - Sliding-window rate-limit tracking for bot API requests.
--
-- BUGS.md B1 (code review of PH1, 2026-05-20):
-- Init previously declared a `limit_max`/`remaining`/`violations`/
-- `last_violation_at` shape, but production (`latest_dev_backup.sql:18834`)
-- and the gateway code (`bot-gateway/src/auth/BotAuthMiddleware.ts:80-119`)
-- have always used `request_count`/`window_start`/`window_duration_seconds`/
-- `max_requests`/`resets_at`/`metadata`. A fresh install from the old init
-- would create a table whose columns the gateway can't read, the catch in
-- `checkRateLimit` would swallow every failure, and rate-limiting would be
-- silently fail-open on every fresh deployment.
--
-- The shape below mirrors prod verbatim. Deployed environments are not
-- affected by this rewrite (they already have the prod shape); the
-- accompanying migration (`db_schema/migrations/20260520_perf_indexes_and_
-- bot_rate_limits_column.sql`) is state-aware enough to reconcile either
-- the new-shape init or any partial drift.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_rate_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    
    bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Rate limit bucket (e.g., 'messages', 'reactions', 'channel:123')
    bucket text NOT NULL,
    
    -- Sliding-window tracking (matches BotAuthMiddleware.checkRateLimit).
    request_count integer DEFAULT 0,
    window_start timestamp with time zone DEFAULT now() NOT NULL,
    window_duration_seconds integer DEFAULT 60,
    max_requests integer DEFAULT 100,
    resets_at timestamp with time zone DEFAULT (now() + '00:01:00'::interval),
    
    metadata jsonb DEFAULT '{}'::jsonb,
    
    UNIQUE(bot_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_bot_rate_limits_bot ON public.bot_rate_limits(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_rate_limits_resets_at ON public.bot_rate_limits(resets_at);

COMMENT ON TABLE public.bot_rate_limits IS 'Rate limiting data for bot API requests. Sliding window rate limits per bucket.';

-- ---------------------------------------------------------------------------
-- BOT AUDIT LOG - Bot action audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    
    -- Action details
    action_type text NOT NULL,
    target_type text,
    target_id text,
    
    -- Context
    server_id uuid REFERENCES public.servers(id) ON DELETE SET NULL,
    channel_id uuid REFERENCES public.channels(id) ON DELETE SET NULL,
    
    -- Request details
    request_data jsonb DEFAULT '{}'::jsonb,
    response_data jsonb DEFAULT '{}'::jsonb,
    
    -- Status
    success boolean DEFAULT true,
    error_message text,
    
    -- Timing
    duration_ms integer
);

CREATE INDEX IF NOT EXISTS idx_bot_audit_log_bot ON public.bot_audit_log(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_audit_log_created ON public.bot_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_audit_log_server ON public.bot_audit_log(server_id);

COMMENT ON TABLE public.bot_audit_log IS 'Audit log for bot actions';

DO $$
BEGIN
    RAISE NOTICE 'Extended bot tables created successfully';
END $$;

