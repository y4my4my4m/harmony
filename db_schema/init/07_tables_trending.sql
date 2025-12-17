-- =============================================================================
-- Harmony Database Schema - Trending & Discovery Tables
-- =============================================================================
-- Tables for trending content, hashtag analytics, and content discovery
-- =============================================================================

-- ---------------------------------------------------------------------------
-- TRENDING POSTS - Cached trending post calculations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trending_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    
    -- Scores
    trending_score numeric DEFAULT 0.0 NOT NULL,
    engagement_score numeric DEFAULT 0.0 NOT NULL,
    velocity_score numeric DEFAULT 0.0 NOT NULL,
    
    -- Period tracking
    period_type text DEFAULT 'daily'::text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    
    -- Engagement metrics
    likes_count integer DEFAULT 0,
    reblogs_count integer DEFAULT 0,
    replies_count integer DEFAULT 0,
    total_engagement integer GENERATED ALWAYS AS ((likes_count + reblogs_count + replies_count)) STORED,
    
    -- Ranking
    trending_rank integer,
    
    CONSTRAINT trending_posts_period_type_check CHECK (period_type IN ('hourly', 'daily', 'weekly'))
);

ALTER TABLE public.trending_posts REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_trending_posts_period ON public.trending_posts(period_type, period_start);
CREATE INDEX IF NOT EXISTS idx_trending_posts_score ON public.trending_posts(trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_trending_posts_post_id ON public.trending_posts(post_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_posts_unique ON public.trending_posts(post_id, period_type, period_start);

COMMENT ON TABLE public.trending_posts IS 'Cached trending posts data for performance';

-- ---------------------------------------------------------------------------
-- TRENDING USERS - Cached trending user calculations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trending_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Scores
    trending_score numeric DEFAULT 0.0 NOT NULL,
    followers_growth numeric DEFAULT 0.0,
    engagement_rate numeric DEFAULT 0.0,
    
    -- Period tracking
    period_type text DEFAULT 'daily'::text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    
    -- Metrics
    new_followers integer DEFAULT 0,
    posts_count integer DEFAULT 0,
    total_engagement integer DEFAULT 0,
    
    -- Ranking
    trending_rank integer,
    
    CONSTRAINT trending_users_period_type_check CHECK (period_type IN ('hourly', 'daily', 'weekly'))
);

ALTER TABLE public.trending_users REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_trending_users_period ON public.trending_users(period_type, period_start);
CREATE INDEX IF NOT EXISTS idx_trending_users_score ON public.trending_users(trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_trending_users_user_id ON public.trending_users(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_users_unique ON public.trending_users(user_id, period_type, period_start);

COMMENT ON TABLE public.trending_users IS 'Cached trending users data for performance';

-- ---------------------------------------------------------------------------
-- TRENDING REFRESH QUEUE - Background refresh tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trending_refresh_queue (
    refresh_type text NOT NULL PRIMARY KEY,
    priority text DEFAULT 'normal'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_processed_at timestamp with time zone,
    processing_started_at timestamp with time zone,
    is_processing boolean DEFAULT false,
    
    CONSTRAINT trending_refresh_queue_priority_check CHECK (priority IN ('low', 'normal', 'high'))
);

COMMENT ON TABLE public.trending_refresh_queue IS 'Queue for background trending data refresh';

-- ---------------------------------------------------------------------------
-- SERVER FOLDERS - Organize servers into folders (like Discord)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    name text NOT NULL,
    color text,
    icon text,
    "order" integer DEFAULT 0,
    
    -- Folder can contain server IDs
    server_ids uuid[] DEFAULT '{}'::uuid[],
    
    -- Collapsed state
    is_collapsed boolean DEFAULT false
);

ALTER TABLE public.server_folders REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_server_folders_user ON public.server_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_server_folders_order ON public.server_folders(user_id, "order");

COMMENT ON TABLE public.server_folders IS 'User-defined folders to organize servers';

-- ---------------------------------------------------------------------------
-- SERVER SETTINGS - Extended server configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_id uuid NOT NULL UNIQUE REFERENCES public.servers(id) ON DELETE CASCADE,
    
    -- Moderation settings
    auto_mod_enabled boolean DEFAULT false,
    auto_mod_rules jsonb DEFAULT '{}'::jsonb,
    
    -- Content settings
    default_message_notifications text DEFAULT 'all'::text,
    explicit_content_filter text DEFAULT 'disabled'::text,
    
    -- Member verification
    verification_gate_enabled boolean DEFAULT false,
    verification_gate_rules jsonb DEFAULT '{}'::jsonb,
    
    -- Misc settings
    afk_channel_id uuid,
    afk_timeout integer DEFAULT 300,
    system_channel_id uuid,
    rules_channel_id uuid,
    
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    CONSTRAINT server_settings_notifications_check CHECK (default_message_notifications IN ('all', 'mentions', 'none')),
    CONSTRAINT server_settings_filter_check CHECK (explicit_content_filter IN ('disabled', 'members_without_roles', 'all_members'))
);

CREATE INDEX IF NOT EXISTS idx_server_settings_server ON public.server_settings(server_id);

COMMENT ON TABLE public.server_settings IS 'Extended server settings and configuration';

-- ---------------------------------------------------------------------------
-- CHANNEL PERMISSION OVERRIDES - Per-channel role/user permission overrides
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.channel_permission_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    
    -- Target can be either a role or a user
    target_type text NOT NULL,
    role_id uuid REFERENCES public.server_roles(id) ON DELETE CASCADE,
    user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Permission bit masks
    allow_permissions bigint DEFAULT 0,
    deny_permissions bigint DEFAULT 0,
    
    CONSTRAINT channel_permission_overrides_type_check CHECK (target_type IN ('role', 'user')),
    CONSTRAINT channel_permission_overrides_target_check CHECK (
        (target_type = 'role' AND role_id IS NOT NULL AND user_id IS NULL) OR
        (target_type = 'user' AND user_id IS NOT NULL AND role_id IS NULL)
    ),
    UNIQUE(channel_id, role_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_permission_overrides_channel ON public.channel_permission_overrides(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_permission_overrides_role ON public.channel_permission_overrides(role_id);
CREATE INDEX IF NOT EXISTS idx_channel_permission_overrides_user ON public.channel_permission_overrides(user_id);

COMMENT ON TABLE public.channel_permission_overrides IS 'Channel-specific permission overrides for roles and users';

-- ---------------------------------------------------------------------------
-- USER MUTES - Muted users (softer than blocks)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_mutes (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    muter_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    muted_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Optional expiration
    expires_at timestamp with time zone,
    
    -- Mute options
    hide_notifications boolean DEFAULT true,
    hide_from_timeline boolean DEFAULT true,
    
    -- Federation
    is_federated boolean DEFAULT false,
    ap_id text,
    federation_status text DEFAULT 'pending'::text,
    
    UNIQUE(muter_id, muted_user_id),
    CONSTRAINT user_mutes_no_self_mute CHECK (muter_id != muted_user_id)
);

ALTER TABLE public.user_mutes REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_user_mutes_muter ON public.user_mutes(muter_id);
CREATE INDEX IF NOT EXISTS idx_user_mutes_muted ON public.user_mutes(muted_user_id);

COMMENT ON TABLE public.user_mutes IS 'User mute relationships (hide without blocking)';

-- ---------------------------------------------------------------------------
-- USER TIMELINE CACHE - Cached timeline data for fast retrieval
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_timeline_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    timeline_type text NOT NULL,
    posts_data jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_updated timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    
    CONSTRAINT user_timeline_cache_timeline_type_check CHECK (timeline_type IN ('home', 'local', 'public'))
);

CREATE INDEX IF NOT EXISTS idx_user_timeline_cache_user ON public.user_timeline_cache(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_timeline_cache_user_type ON public.user_timeline_cache(user_id, timeline_type);

COMMENT ON TABLE public.user_timeline_cache IS 'Pre-computed timeline cache for instant feed loading';

-- ---------------------------------------------------------------------------
-- ADD FOREIGN KEY for user_servers.folder_id (now that server_folders exists)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'user_servers_folder_id_fkey'
        AND table_name = 'user_servers'
    ) THEN
        ALTER TABLE public.user_servers 
            ADD CONSTRAINT user_servers_folder_id_fkey 
            FOREIGN KEY (folder_id) REFERENCES public.server_folders(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    RAISE NOTICE 'Trending & discovery tables created successfully';
END $$;

