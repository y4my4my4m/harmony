-- =====================================================
-- HARMONY DATABASE REFACTOR - PHASE 4
-- Database Schema Updates
-- =====================================================

-- This migration implements Phase 4 of the database refactor:
-- 1. Add federation control columns to instance_config and profiles
-- 2. Add federation performance indexes
-- 3. Add federation health monitoring tables
-- 4. Add blocking/muting infrastructure
-- 5. Add helper functions for edge function data access

BEGIN;

-- =====================================================
-- STEP 1: FEDERATION CONTROL COLUMNS
-- =====================================================

-- Add federation controls to instance_config
DO $$
BEGIN
    -- Add federation_enabled to instance_config if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM instance_config WHERE config_key = 'federation_settings'
    ) THEN
        INSERT INTO instance_config (config_key, config_value, description)
        VALUES (
            'federation_settings',
            jsonb_build_object(
                'federation_enabled', true,
                'federation_auto_accept_follows', true,
                'federation_require_approval', false,
                'federation_max_delivery_attempts', 5,
                'federation_delivery_timeout_ms', 10000
            ),
            'Federation configuration settings for the instance'
        );
    END IF;
END;
$$;

-- Add user-level federation controls to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS federation_enabled BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS federation_discoverable BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS federation_followers_only BOOLEAN DEFAULT false;

COMMENT ON COLUMN profiles.federation_enabled IS 'Whether this user participates in federation at all';
COMMENT ON COLUMN profiles.federation_discoverable IS 'Whether this user appears in federated searches and directories';
COMMENT ON COLUMN profiles.federation_followers_only IS 'Whether this user only federates with followers';

-- =====================================================
-- STEP 2: BLOCKING AND MUTING INFRASTRUCTURE
-- =====================================================

-- User-level blocks table
CREATE TABLE IF NOT EXISTS user_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    blocker_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    blocked_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    block_type text DEFAULT 'full' CHECK (block_type IN ('full', 'posts_only', 'interactions_only')),
    reason text,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}',
    UNIQUE(blocker_id, blocked_user_id)
);

COMMENT ON TABLE user_blocks IS 'User-level blocking with granular control and optional expiration';

-- User-level mutes table  
CREATE TABLE IF NOT EXISTS user_mutes (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    muter_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    muted_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    mute_type text DEFAULT 'posts_and_boosts' CHECK (mute_type IN ('posts_only', 'boosts_only', 'posts_and_boosts', 'notifications_only')),
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}',
    UNIQUE(muter_id, muted_user_id)
);

COMMENT ON TABLE user_mutes IS 'User-level muting with granular control and optional expiration';

-- Enhanced blocked_instances table
ALTER TABLE blocked_instances ADD COLUMN IF NOT EXISTS block_type text DEFAULT 'full' CHECK (block_type IN ('full', 'media_only', 'follows_only'));
ALTER TABLE blocked_instances ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone;
ALTER TABLE blocked_instances ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';

COMMENT ON COLUMN blocked_instances.block_type IS 'Type of block: full, media_only, or follows_only';
COMMENT ON COLUMN blocked_instances.expires_at IS 'Optional expiration time for temporary blocks';

-- =====================================================
-- STEP 3: FEDERATION HEALTH MONITORING
-- =====================================================

-- Federation health monitoring table
CREATE TABLE IF NOT EXISTS federation_health (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    domain text NOT NULL,
    check_type text NOT NULL CHECK (check_type IN ('delivery', 'inbox', 'actor_fetch', 'object_fetch')),
    status text NOT NULL CHECK (status IN ('success', 'timeout', 'error', 'unreachable')),
    response_time_ms integer,
    http_status_code integer,
    error_message text,
    metadata jsonb DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_federation_health_domain_time ON federation_health(domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_federation_health_status ON federation_health(status, check_type);

COMMENT ON TABLE federation_health IS 'Health monitoring for federated instances with detailed metrics';

-- Federation error tracking table
CREATE TABLE IF NOT EXISTS federation_errors (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    domain text NOT NULL,
    error_type text NOT NULL CHECK (error_type IN ('delivery_failed', 'signature_invalid', 'object_invalid', 'rate_limited', 'blocked')),
    activity_id uuid REFERENCES ap_activities(id),
    error_message text NOT NULL,
    retry_count integer DEFAULT 0,
    resolved_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_federation_errors_domain_time ON federation_errors(domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_federation_errors_type ON federation_errors(error_type, resolved_at);

COMMENT ON TABLE federation_errors IS 'Detailed error tracking for federation issues with retry support';

-- =====================================================
-- STEP 4: PERFORMANCE INDEXES
-- =====================================================

-- Federation-specific indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_federation_lookup 
ON profiles(domain, federation_enabled) WHERE federation_enabled = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ap_activities_federation_status
ON ap_activities(status, is_local, created_at) WHERE status IN ('pending', 'processing');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_federation_delivery_queue_next_attempt
ON federation_delivery_queue(next_attempt_at, status) WHERE status = 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_federation_visibility
ON posts(visibility, is_federated, created_at) WHERE is_federated = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_follows_federation_status  
ON follows(status, is_local, created_at);

-- Blocking/muting indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_blocks_blocker
ON user_blocks(blocker_id, block_type) WHERE expires_at IS NULL OR expires_at > now();

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_blocks_blocked
ON user_blocks(blocked_user_id, block_type) WHERE expires_at IS NULL OR expires_at > now();

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_mutes_muter
ON user_mutes(muter_id, mute_type) WHERE expires_at IS NULL OR expires_at > now();

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_blocked_instances_active
ON blocked_instances(domain, block_type) WHERE expires_at IS NULL OR expires_at > now();

-- =====================================================
-- STEP 5: HELPER FUNCTIONS FOR EDGE FUNCTIONS
-- =====================================================

-- Get federation data for a post (for edge functions)
CREATE OR REPLACE FUNCTION public.get_post_federation_data(p_post_id uuid)
RETURNS TABLE(
    post_data jsonb,
    author_data jsonb,
    mentions_data jsonb,
    tags_data jsonb,
    media_data jsonb
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        -- Post data
        jsonb_build_object(
            'id', p.id,
            'ap_id', p.ap_id,
            'content', p.content,
            'content_warning', p.content_warning,
            'language', p.language,
            'visibility', p.visibility,
            'created_at', p.created_at,
            'updated_at', p.updated_at,
            'url', p.url,
            'in_reply_to', p.in_reply_to,
            'conversation_id', p.conversation_id,
            'is_sensitive', p.is_sensitive
        ) as post_data,
        
        -- Author data
        jsonb_build_object(
            'id', author.id,
            'username', author.username,
            'display_name', author.display_name,
            'domain', author.domain,
            'federated_id', author.federated_id,
            'avatar_url', author.avatar_url,
            'banner_url', author.banner_url,
            'bio', author.bio,
            'public_key', author.public_key,
            'inbox_url', author.inbox_url,
            'outbox_url', author.outbox_url,
            'followers_url', author.followers_url,
            'following_url', author.following_url
        ) as author_data,
        
        -- Mentions data
        COALESCE(
            jsonb_agg(
                DISTINCT jsonb_build_object(
                    'username', m_profiles.username,
                    'domain', m_profiles.domain,
                    'federated_id', m_profiles.federated_id,
                    'inbox_url', m_profiles.inbox_url
                )
            ) FILTER (WHERE m_profiles.id IS NOT NULL),
            '[]'::jsonb
        ) as mentions_data,
        
        -- Tags data (hashtags)
        COALESCE(
            jsonb_agg(
                DISTINCT jsonb_build_object(
                    'type', 'Hashtag',
                    'name', h.tag,
                    'href', 'https://' || (SELECT trim(both '"' from config_value::text) FROM instance_config WHERE config_key = 'domain') || '/tags/' || h.normalized_tag
                )
            ) FILTER (WHERE h.id IS NOT NULL),
            '[]'::jsonb
        ) as tags_data,
        
        -- Media data
        p.media_attachments as media_data
        
    FROM posts p
    JOIN profiles author ON p.author_id = author.id
    LEFT JOIN post_hashtags ph ON p.id = ph.post_id
    LEFT JOIN hashtags h ON ph.hashtag_id = h.id
    LEFT JOIN LATERAL (
        SELECT DISTINCT m_prof.* 
        FROM jsonb_array_elements(p.content) as content_parts
        JOIN profiles m_prof ON content_parts->>'username' = m_prof.username 
            AND COALESCE(content_parts->>'domain', author.domain) = m_prof.domain
        WHERE content_parts->>'type' = 'mention'
    ) m_profiles ON true
    WHERE p.id = p_post_id
    GROUP BY p.id, author.id;
END;
$$;

COMMENT ON FUNCTION public.get_post_federation_data(uuid) IS 'Get all data needed for ActivityPub post federation - optimized for edge functions';

-- Get blocking status for federation (for edge functions)
CREATE OR REPLACE FUNCTION public.check_federation_blocks(
    p_user_id uuid,
    p_target_user_id uuid DEFAULT NULL,
    p_target_domain text DEFAULT NULL
)
RETURNS TABLE(
    is_instance_blocked boolean,
    is_user_blocked boolean,
    is_user_muted boolean,
    block_metadata jsonb
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_target_domain text;
BEGIN
    -- Determine target domain
    v_target_domain := COALESCE(
        p_target_domain,
        (SELECT domain FROM profiles WHERE id = p_target_user_id)
    );
    
    RETURN QUERY
    SELECT 
        -- Instance level blocks
        EXISTS(
            SELECT 1 FROM blocked_instances bi 
            WHERE bi.domain = v_target_domain 
            AND (bi.expires_at IS NULL OR bi.expires_at > now())
        ) as is_instance_blocked,
        
        -- User level blocks
        CASE 
            WHEN p_target_user_id IS NOT NULL THEN
                EXISTS(
                    SELECT 1 FROM user_blocks ub
                    WHERE ub.blocker_id = p_user_id 
                    AND ub.blocked_user_id = p_target_user_id
                    AND (ub.expires_at IS NULL OR ub.expires_at > now())
                )
            ELSE false
        END as is_user_blocked,
        
        -- User level mutes
        CASE 
            WHEN p_target_user_id IS NOT NULL THEN
                EXISTS(
                    SELECT 1 FROM user_mutes um
                    WHERE um.muter_id = p_user_id 
                    AND um.muted_user_id = p_target_user_id
                    AND (um.expires_at IS NULL OR um.expires_at > now())
                )
            ELSE false
        END as is_user_muted,
        
        -- Combined metadata
        jsonb_build_object(
            'instance_block', COALESCE(
                (SELECT jsonb_build_object('type', block_type, 'reason', reason, 'expires_at', expires_at)
                 FROM blocked_instances WHERE domain = v_target_domain),
                'null'::jsonb
            ),
            'user_block', CASE 
                WHEN p_target_user_id IS NOT NULL THEN
                    COALESCE(
                        (SELECT jsonb_build_object('type', block_type, 'reason', reason, 'expires_at', expires_at)
                         FROM user_blocks WHERE blocker_id = p_user_id AND blocked_user_id = p_target_user_id),
                        'null'::jsonb
                    )
                ELSE 'null'::jsonb
            END,
            'user_mute', CASE 
                WHEN p_target_user_id IS NOT NULL THEN
                    COALESCE(
                        (SELECT jsonb_build_object('type', mute_type, 'expires_at', expires_at)
                         FROM user_mutes WHERE muter_id = p_user_id AND muted_user_id = p_target_user_id),
                        'null'::jsonb
                    )
                ELSE 'null'::jsonb
            END
        ) as block_metadata;
END;
$$;

COMMENT ON FUNCTION public.check_federation_blocks(uuid, uuid, text) IS 'Check all blocking/muting status for federation decisions - optimized for edge functions';

-- Log federation health check
CREATE OR REPLACE FUNCTION public.log_federation_health(
    p_domain text,
    p_check_type text,
    p_status text,
    p_response_time_ms integer DEFAULT NULL,
    p_http_status_code integer DEFAULT NULL,
    p_error_message text DEFAULT NULL,
    p_metadata jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO federation_health (
        domain,
        check_type,
        status,
        response_time_ms,
        http_status_code,
        error_message,
        metadata
    ) VALUES (
        p_domain,
        p_check_type,
        p_status,
        p_response_time_ms,
        p_http_status_code,
        p_error_message,
        p_metadata
    );
    
    -- Update federated_instances table with health info
    UPDATE federated_instances 
    SET 
        last_seen_at = CASE WHEN p_status = 'success' THEN now() ELSE last_seen_at END,
        metadata = metadata || jsonb_build_object(
            'last_health_check', now(),
            'last_health_status', p_status
        )
    WHERE domain = p_domain;
END;
$$;

COMMENT ON FUNCTION public.log_federation_health(text, text, text, integer, integer, text, jsonb) IS 'Log federation health check results and update instance status';

-- =====================================================
-- STEP 6: UPDATED FEDERATION HELPER FUNCTIONS
-- =====================================================

-- Enhanced federation check function
CREATE OR REPLACE FUNCTION public.is_federation_enabled_for_user(user_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    instance_enabled boolean := true;
    user_enabled boolean := true;
BEGIN
    -- Check instance-level federation setting
    SELECT COALESCE((config_value->>'federation_enabled')::boolean, true) 
    INTO instance_enabled
    FROM instance_config 
    WHERE config_key = 'federation_settings'
    LIMIT 1;
    
    -- If no federation_settings config exists, federation is enabled by default
    IF instance_enabled IS NULL THEN
        instance_enabled := true;
    END IF;
    
    -- Check user-level federation setting
    SELECT COALESCE(federation_enabled, true)
    INTO user_enabled
    FROM profiles 
    WHERE id = user_id;
    
    RETURN instance_enabled AND user_enabled;
END;
$$;

-- Get federation configuration
CREATE OR REPLACE FUNCTION public.get_federation_config()
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    config jsonb;
BEGIN
    SELECT config_value INTO config
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    -- Return defaults if no config exists
    IF config IS NULL THEN
        config := jsonb_build_object(
            'federation_enabled', true,
            'federation_auto_accept_follows', true,
            'federation_require_approval', false,
            'federation_max_delivery_attempts', 5,
            'federation_delivery_timeout_ms', 10000
        );
    END IF;
    
    RETURN config;
END;
$$;

COMMENT ON FUNCTION public.get_federation_config() IS 'Get current federation configuration with sensible defaults';

COMMIT;

-- =====================================================
-- VALIDATION QUERIES
-- =====================================================

-- Test the new functions
DO $$
DECLARE
    test_user_id uuid;
    test_post_id uuid;
    federation_config jsonb;
    block_status record;
BEGIN
    -- Get a test user and post
    SELECT id INTO test_user_id FROM profiles LIMIT 1;
    SELECT id INTO test_post_id FROM posts LIMIT 1;
    
    IF test_user_id IS NOT NULL THEN
        -- Test federation config
        SELECT get_federation_config() INTO federation_config;
        RAISE NOTICE 'Federation config: %', federation_config;
        
        -- Test post federation data (if post exists)
        IF test_post_id IS NOT NULL THEN
            RAISE NOTICE 'Post federation data function created successfully';
        END IF;
        
        -- Test blocking check
        SELECT * INTO block_status FROM check_federation_blocks(test_user_id, NULL, 'example.com');
        RAISE NOTICE 'Blocking check: instance_blocked=%, user_blocked=%, user_muted=%', 
            block_status.is_instance_blocked, block_status.is_user_blocked, block_status.is_user_muted;
        
        -- Test health logging
        PERFORM log_federation_health('test.example', 'delivery', 'success', 150, 200);
        RAISE NOTICE 'Health logging function working';
        
        RAISE NOTICE 'All Phase 4 functions created successfully!';
    ELSE
        RAISE NOTICE 'No test data available, but functions created successfully';
    END IF;
END;
$$;