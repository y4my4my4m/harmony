-- =============================================================================
-- Harmony Database Schema - Core Tables
-- =============================================================================
-- Foundational tables that other tables depend on
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PROFILES - Core user table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    username text,
    display_name text,
    avatar_url text DEFAULT '/default_avatar.webp'::text,
    bio text,
    color character varying,
    status smallint DEFAULT 0,
    
    -- Federation fields
    -- Domain of the user's instance
    -- For local users: set from instance_config 'domain' during profile creation
    -- For federated users: the remote instance domain
    -- Default 'localhost' is for development; production instances MUST configure this
    domain text DEFAULT 'localhost'::text NOT NULL,
    federated_id text,
    public_key text,
    -- Note: private_key is stored in user_private_keys table, NOT here
    inbox_url text,
    outbox_url text,
    followers_url text,
    following_url text,
    featured_url text,
    shared_inbox_url text,
    is_local boolean DEFAULT true,
    last_synced_at timestamp with time zone,
    federation_metadata jsonb DEFAULT '{}'::jsonb,
    supported_activities text[] DEFAULT '{}'::text[],
    last_federation_sync timestamp with time zone,
    
    -- Admin & moderation
    is_admin boolean DEFAULT false,
    is_moderator boolean DEFAULT false,
    is_suspended boolean DEFAULT false,
    suspended_at timestamp with time zone,
    suspension_reason text,
    force_sensitive boolean DEFAULT false,
    is_silenced boolean DEFAULT false,
    silenced_at timestamp with time zone,
    silenced_reason text,
    
    -- Denormalized counts (maintained by triggers)
    followers_count integer DEFAULT 0,
    following_count integer DEFAULT 0,
    posts_count integer DEFAULT 0,
    
    -- Auth reference
    auth_user_id uuid UNIQUE,
    
    -- Profile customization
    banner_url text,
    appearance_settings jsonb,
    locale text DEFAULT 'en'::text,
    profile_fields jsonb DEFAULT '[]'::jsonb,
    custom_status jsonb,
    last_status_update timestamp with time zone DEFAULT now(),

    -- Denormalized activity counters (kept up to date by triggers; see
    -- 40_triggers.sql -> tg_profile_message_counter / tg_profile_voice_counter
    -- and migrations/20260524_bot_grants_and_activity_counters.sql).
    message_count bigint NOT NULL DEFAULT 0,
    voice_minutes bigint NOT NULL DEFAULT 0,

    -- Federation settings
    federation_enabled boolean DEFAULT true,
    federation_discoverable boolean DEFAULT true,
    federation_followers_only boolean DEFAULT false,
    manually_approves_followers boolean DEFAULT false,

    CONSTRAINT profiles_username_check CHECK (username ~* '^[a-zA-Z0-9_]+$'),
    -- `display_name` is optional (some federated profiles may legitimately
    -- omit it), but if present it must contain at least one non-whitespace
    -- character. A blank display name makes the user appear as
    -- `Unknown User` everywhere via the `getUserDisplayName` fallback,
    -- which is confusing UX and a passive impersonation surface.
    CONSTRAINT profiles_display_name_not_blank CHECK (
        display_name IS NULL OR length(btrim(display_name)) > 0
    ),
    CONSTRAINT profiles_username_domain_key UNIQUE (username, domain)
);

-- Link profiles to auth.users
ALTER TABLE public.profiles 
    ADD CONSTRAINT profiles_auth_user_id_fkey 
    FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- Full replica identity for realtime
ALTER TABLE public.profiles REPLICA IDENTITY FULL;

-- Unique constraint on federated_id for federation (ON CONFLICT upserts)
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_federated_id_unique UNIQUE (federated_id);

-- Index for username lookups
CREATE INDEX IF NOT EXISTS idx_profiles_username ON public.profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_domain ON public.profiles(domain);
CREATE INDEX IF NOT EXISTS idx_profiles_username_domain ON public.profiles(username, domain);
CREATE INDEX IF NOT EXISTS idx_profiles_is_local ON public.profiles(is_local);

COMMENT ON TABLE public.profiles IS 'User profiles - both local and federated users';
COMMENT ON COLUMN public.profiles.domain IS 'Instance domain (e.g., harmony.example.com)';
COMMENT ON COLUMN public.profiles.federated_id IS 'Full ActivityPub actor URL';
COMMENT ON COLUMN public.profiles.is_local IS 'True if user is from this instance';

-- ---------------------------------------------------------------------------
-- INSTANCE CONFIG - Server-wide configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    config_key text NOT NULL UNIQUE,
    config_value jsonb NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- Note: Default instance config is seeded in 98_seed_data.sql

COMMENT ON TABLE public.instance_config IS 'Server-wide configuration settings';

-- ---------------------------------------------------------------------------
-- OAUTH PROVIDERS - For OAuth login providers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.oauth_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    provider_name text NOT NULL UNIQUE,
    client_id text NOT NULL,
    client_secret text,
    enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    settings jsonb DEFAULT '{}'::jsonb
);

COMMENT ON TABLE public.oauth_providers IS 'OAuth provider configurations';

-- ---------------------------------------------------------------------------
-- SESSIONS / DEVICES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    session_token text NOT NULL,
    
    -- Device/browser info
    platform text DEFAULT 'web'::text,
    form_factor text DEFAULT 'desktop'::text,
    is_pwa boolean DEFAULT false,
    browser text,
    user_agent text,
    ip_address text,
    
    -- Activity tracking
    last_heartbeat timestamp with time zone DEFAULT now() NOT NULL,
    last_activity timestamp with time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true,
    status text DEFAULT 'online'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    -- Current context (for smart notifications)
    -- Note: No FK constraints to avoid circular dependencies
    current_server_id uuid,
    current_channel_id uuid,
    current_conversation_id uuid,
    
    UNIQUE(user_id, session_token)
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON public.user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active ON public.user_sessions(is_active) WHERE is_active = true;

COMMENT ON TABLE public.user_sessions IS 'Tracks active user sessions for smart push notifications. If user has an active session, push notifications are suppressed (Discord-like behavior).';

DO $$
BEGIN
    RAISE NOTICE 'Core tables created successfully';
END $$;

