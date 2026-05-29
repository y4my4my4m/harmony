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
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    name text NOT NULL,
    color text DEFAULT '#5865f2'::text,
    "position" integer DEFAULT 0 NOT NULL,
    is_expanded boolean DEFAULT true,

    CONSTRAINT server_folders_name_length_check CHECK (char_length(name) <= 64)
);

ALTER TABLE public.server_folders REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_server_folders_user ON public.server_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_server_folders_user_position ON public.server_folders(user_id, "position");

COMMENT ON TABLE public.server_folders IS 'User-created folders for organizing servers in the sidebar';
COMMENT ON COLUMN public.server_folders.color IS 'Hex color code for folder display';
COMMENT ON COLUMN public.server_folders."position" IS 'Sort order position for the folder in the sidebar';

-- ---------------------------------------------------------------------------
-- SERVER SETTINGS - Extended server configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_id uuid NOT NULL UNIQUE REFERENCES public.servers(id) ON DELETE CASCADE,

    -- Default role (set by trigger on server creation)
    default_role_id uuid REFERENCES public.server_roles(id) ON DELETE SET NULL,

    -- Invite permissions
    invite_permissions jsonb DEFAULT '{"who_can_create": "everyone", "default_expiration": 1440, "max_expiration": 0, "allow_temporary": true, "max_uses_limit": 0}'::jsonb,

    -- Moderation settings (single source of truth - client reads/writes this JSONB,
    -- not any standalone column). See `src/services/permissionsService.ts`.
    moderation_settings jsonb DEFAULT '{"auto_mod_enabled": false, "spam_filter": false, "link_filter": false}'::jsonb,

    -- Default notification level for channels in this server. 'mentions' so new
    -- servers don't flood members with notifications for every channel message.
    -- Server owners can flip this to 'all' for high-touch servers. Used by
    -- send_notification() in 13_functions_rpc_extended.sql. See migration
    -- 20260520_default_notification_level_mentions.sql for the policy rationale.
    default_message_notifications text DEFAULT 'mentions'::text,

    -- Channel that receives auto-generated system messages (member-join, kick,
    -- ban announcements). Used by handle_member_join_system_message trigger and
    -- handle_kicked_user / handle_banned_user RPCs. NULL → fall back to
    -- get_default_channel(server_id).
    system_channel_id uuid,

    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),

    CONSTRAINT server_settings_notifications_check
        CHECK (default_message_notifications IN ('all', 'mentions', 'none'))
);

CREATE INDEX IF NOT EXISTS idx_server_settings_server ON public.server_settings(server_id);

COMMENT ON TABLE public.server_settings IS 'Extended server configuration: roles, invites, moderation, default notification level, system channel.';

-- NOTE: previous versions of this table also declared `auto_mod_enabled`,
-- `auto_mod_rules`, `explicit_content_filter`, `verification_gate_enabled`,
-- `verification_gate_rules`, `afk_channel_id`, `afk_timeout`, and
-- `rules_channel_id`. None of those were ever read by any code, trigger, or
-- function - they were an aspirational Discord-feature-parity stub. Removed
-- here and dropped from existing databases by
-- db_schema/migrations/20260520_server_settings_drop_unused_columns.sql.

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

-- Partial unique indexes needed for PostgREST upserts. The composite UNIQUE
-- above does NOT enforce uniqueness for role-only or user-only rows because
-- Postgres treats NULLs as distinct, so `onConflict=channel_id,role_id,user_id`
-- fails with a 400 when one of role_id/user_id is null. These give us a real
-- index per shape that the upsert can match.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cpo_channel_role
    ON public.channel_permission_overrides (channel_id, role_id)
    WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cpo_channel_user
    ON public.channel_permission_overrides (channel_id, user_id)
    WHERE role_id IS NULL;

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

