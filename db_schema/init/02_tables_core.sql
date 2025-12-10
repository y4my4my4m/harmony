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
    username text UNIQUE,
    display_name text,
    avatar_url text DEFAULT '/default_avatar.png'::text,
    bio text,
    color character varying,
    status smallint DEFAULT 0,
    
    -- Federation fields
    domain text NOT NULL,
    federated_id text,
    public_key text,
    private_key text,
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
    is_suspended boolean DEFAULT false,
    suspended_at timestamp with time zone,
    suspension_reason text,
    
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
    
    -- Federation settings
    federation_enabled boolean DEFAULT true,
    federation_discoverable boolean DEFAULT true,
    federation_followers_only boolean DEFAULT false,
    manually_approves_followers boolean DEFAULT false,

    CONSTRAINT profiles_username_check CHECK (username ~* '^[a-zA-Z0-9_]+$')
);

-- Link profiles to auth.users
ALTER TABLE public.profiles 
    ADD CONSTRAINT profiles_auth_user_id_fkey 
    FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- Full replica identity for realtime
ALTER TABLE public.profiles REPLICA IDENTITY FULL;

-- Unique federated_id for federation
CREATE UNIQUE INDEX IF NOT EXISTS profiles_federated_id_key 
    ON public.profiles(federated_id) WHERE federated_id IS NOT NULL;

-- Index for username lookups
CREATE INDEX IF NOT EXISTS idx_profiles_username ON public.profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_domain ON public.profiles(domain);
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

-- Insert default instance config
INSERT INTO public.instance_config (config_key, config_value, description)
VALUES 
    ('domain', '"localhost"', 'Instance domain name'),
    ('name', '"Harmony"', 'Instance display name'),
    ('description', '"A federated social platform"', 'Instance description'),
    ('federation_settings', '{"enabled": true, "open_registration": true}', 'Federation configuration'),
    ('features', '{"voice_enabled": true, "video_enabled": true, "e2e_encryption": true}', 'Feature flags')
ON CONFLICT (config_key) DO NOTHING;

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
    device_id text NOT NULL,
    device_name text,
    device_type text,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now(),
    last_seen_at timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT true,
    push_token text,
    
    UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON public.user_sessions(user_id);

COMMENT ON TABLE public.user_sessions IS 'User login sessions and devices';

DO $$
BEGIN
    RAISE NOTICE 'Core tables created successfully';
END $$;

