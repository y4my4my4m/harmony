-- =============================================================================
-- COMPREHENSIVE ACTIVITYPUB FEDERATION MIGRATION
-- Adds complete ActivityPub federation support to Harmony
-- =============================================================================

-- First, let's add missing columns to existing tables
-- Posts table enhancements
ALTER TABLE posts 
ADD COLUMN IF NOT EXISTS edit_history jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS voice_attachments jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS federated_to text[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS federation_status text DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS last_federated_at timestamp with time zone;

-- Profiles table enhancements  
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS federation_metadata jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS supported_activities text[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS last_federation_sync timestamp with time zone;

-- Servers table enhancements (if servers table exists)
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'servers') THEN
        ALTER TABLE servers 
        ADD COLUMN IF NOT EXISTS federation_enabled boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS federation_domain text,
        ADD COLUMN IF NOT EXISTS federation_inbox_url text,
        ADD COLUMN IF NOT EXISTS federation_metadata jsonb DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS supported_activities text[] DEFAULT '{}';
    END IF;
END $$;

-- =============================================================================
-- ENHANCED AP_ACTIVITIES TABLE
-- =============================================================================

-- Drop and recreate ap_activities with comprehensive activity support
DROP TABLE IF EXISTS ap_activities CASCADE;

CREATE TABLE ap_activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    -- ActivityPub fields
    ap_id text UNIQUE NOT NULL,
    ap_type text NOT NULL,
    actor_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
    actor_ap_id text NOT NULL,
    
    -- Activity content
    object_id text,
    object_type text,
    target_id uuid,
    target_type text,
    
    -- Activity data
    activity_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    
    -- Federation status
    status text DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'cancelled')),
    
    -- Audience and visibility
    to_addresses text[] DEFAULT '{}',
    cc_addresses text[] DEFAULT '{}',
    bto_addresses text[] DEFAULT '{}',
    bcc_addresses text[] DEFAULT '{}',
    
    -- Processing metadata
    attempts integer DEFAULT 0,
    last_attempt_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    error_message text,
    
    -- Local/remote tracking
    is_local boolean DEFAULT true,
    source_domain text,
    
    CONSTRAINT ap_activities_valid_type CHECK (
        ap_type IN (
            'Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', 
            'Undo', 'Like', 'Announce', 'Add', 'Remove', 'Invite', 
            'Join', 'Leave', 'VoiceJoin', 'VoiceLeave', 'VoiceUpdate',
            'Block', 'Flag', 'Move', 'Tombstone'
        )
    )
);

-- =============================================================================
-- FEDERATION DELIVERY QUEUE
-- =============================================================================

-- Enhanced delivery queue for background processing
DROP TABLE IF EXISTS federation_delivery_queue CASCADE;

CREATE TABLE federation_delivery_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    -- Activity reference
    activity_id uuid REFERENCES ap_activities(id) ON DELETE CASCADE,
    
    -- Delivery target
    target_domain text NOT NULL,
    target_inbox_url text NOT NULL,
    
    -- Delivery status
    status text DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'cancelled')),
    
    -- Retry logic
    attempts integer DEFAULT 0,
    max_attempts integer DEFAULT 5,
    next_attempt_at timestamp with time zone DEFAULT now(),
    
    -- HTTP details
    http_status_code integer,
    response_body text,
    error_message text,
    
    -- Performance tracking
    delivery_duration_ms integer,
    
    -- Priority system
    priority integer DEFAULT 5 CHECK (priority BETWEEN 1 AND 10)
);

-- =============================================================================
-- VOICE FEDERATION EVENTS
-- =============================================================================

CREATE TABLE voice_federation_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT now(),
    
    -- Voice session info
    session_id text NOT NULL,
    channel_id uuid,
    server_id uuid,
    
    -- User and event
    user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK (event_type IN ('join', 'leave', 'mute', 'unmute', 'deafen', 'undeafen', 'video_on', 'video_off')),
    
    -- Federation data
    ap_activity_id uuid REFERENCES ap_activities(id) ON DELETE SET NULL,
    federated_to text[] DEFAULT '{}',
    
    -- Voice state
    voice_state jsonb DEFAULT '{}'::jsonb,
    
    -- Metadata
    metadata jsonb DEFAULT '{}'::jsonb
);

-- =============================================================================
-- SERVER FEDERATION EVENTS
-- =============================================================================

CREATE TABLE server_federation_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT now(),
    
    -- Server info
    server_id uuid,
    server_domain text NOT NULL,
    
    -- User and event
    user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK (event_type IN ('join', 'leave', 'invite', 'ban', 'unban')),
    
    -- Federation data
    ap_activity_id uuid REFERENCES ap_activities(id) ON DELETE SET NULL,
    federated_to text[] DEFAULT '{}',
    
    -- Event data
    event_data jsonb DEFAULT '{}'::jsonb,
    
    -- Metadata
    metadata jsonb DEFAULT '{}'::jsonb
);

-- =============================================================================
-- ACTOR AND OBJECT CACHING
-- =============================================================================

CREATE TABLE ap_actor_cache (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    -- Actor identification
    ap_id text UNIQUE NOT NULL,
    domain text NOT NULL,
    username text NOT NULL,
    
    -- Cached actor data
    actor_data jsonb NOT NULL,
    
    -- Cache metadata
    last_fetched_at timestamp with time zone DEFAULT now(),
    cache_expires_at timestamp with time zone DEFAULT (now() + interval '1 hour'),
    fetch_attempts integer DEFAULT 0,
    
    -- Status
    is_reachable boolean DEFAULT true,
    last_error text
);

CREATE TABLE ap_object_cache (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    -- Object identification
    ap_id text UNIQUE NOT NULL,
    object_type text NOT NULL,
    
    -- Cached object data
    object_data jsonb NOT NULL,
    
    -- Cache metadata
    last_fetched_at timestamp with time zone DEFAULT now(),
    cache_expires_at timestamp with time zone DEFAULT (now() + interval '1 hour'),
    fetch_attempts integer DEFAULT 0,
    
    -- Status
    is_reachable boolean DEFAULT true,
    last_error text
);

-- =============================================================================
-- INDEXES FOR PERFORMANCE
-- =============================================================================

-- ap_activities indexes
CREATE INDEX IF NOT EXISTS idx_ap_activities_actor_id_new ON ap_activities(actor_id);
CREATE INDEX IF NOT EXISTS idx_ap_activities_ap_id_new ON ap_activities(ap_id);
CREATE INDEX IF NOT EXISTS idx_ap_activities_type_new ON ap_activities(ap_type);
CREATE INDEX IF NOT EXISTS idx_ap_activities_status_new ON ap_activities(status);
CREATE INDEX IF NOT EXISTS idx_ap_activities_created_at_new ON ap_activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ap_activities_target_new ON ap_activities(target_id, target_type) WHERE target_id IS NOT NULL;

-- federation_delivery_queue indexes
CREATE INDEX IF NOT EXISTS idx_delivery_queue_status_new ON federation_delivery_queue(status);
CREATE INDEX IF NOT EXISTS idx_delivery_queue_next_attempt_new ON federation_delivery_queue(next_attempt_at) WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_delivery_queue_activity_id_new ON federation_delivery_queue(activity_id);
CREATE INDEX IF NOT EXISTS idx_delivery_queue_target_domain_new ON federation_delivery_queue(target_domain);

-- voice_federation_events indexes
CREATE INDEX IF NOT EXISTS idx_voice_federation_events_session ON voice_federation_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_federation_events_user ON voice_federation_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_federation_events_channel ON voice_federation_events(channel_id, created_at DESC);

-- server_federation_events indexes
CREATE INDEX IF NOT EXISTS idx_server_federation_events_server ON server_federation_events(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_server_federation_events_user ON server_federation_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_server_federation_events_domain ON server_federation_events(server_domain, created_at DESC);

-- ap_actor_cache indexes
CREATE INDEX IF NOT EXISTS idx_ap_actor_cache_domain ON ap_actor_cache(domain);
CREATE INDEX IF NOT EXISTS idx_ap_actor_cache_username ON ap_actor_cache(username, domain);
CREATE INDEX IF NOT EXISTS idx_ap_actor_cache_expires ON ap_actor_cache(cache_expires_at);

-- ap_object_cache indexes
CREATE INDEX IF NOT EXISTS idx_ap_object_cache_type ON ap_object_cache(object_type);
CREATE INDEX IF NOT EXISTS idx_ap_object_cache_expires ON ap_object_cache(cache_expires_at);

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

-- Enable RLS on new tables
ALTER TABLE ap_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE federation_delivery_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_federation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE server_federation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_actor_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_object_cache ENABLE ROW LEVEL SECURITY;

-- RLS policies for ap_activities
CREATE POLICY "Users can view their own activities" ON ap_activities
    FOR SELECT USING (actor_id = auth.uid());

CREATE POLICY "Users can create their own activities" ON ap_activities
    FOR INSERT WITH CHECK (actor_id = auth.uid());

CREATE POLICY "Users can update their own activities" ON ap_activities
    FOR UPDATE USING (actor_id = auth.uid());

-- RLS policies for federation_delivery_queue (admin only)
CREATE POLICY "Service role can manage delivery queue" ON federation_delivery_queue
    FOR ALL USING (auth.role() = 'service_role');

-- RLS policies for voice_federation_events
CREATE POLICY "Users can view voice events they're involved in" ON voice_federation_events
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can create their own voice events" ON voice_federation_events
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- RLS policies for server_federation_events
CREATE POLICY "Users can view server events they're involved in" ON server_federation_events
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can create their own server events" ON server_federation_events
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- RLS policies for caching tables (service role only)
CREATE POLICY "Service role can manage actor cache" ON ap_actor_cache
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage object cache" ON ap_object_cache
    FOR ALL USING (auth.role() = 'service_role');

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Queue activity for federation
CREATE OR REPLACE FUNCTION queue_activity_for_federation(
    p_activity_id uuid,
    p_target_domains text[]
) RETURNS void AS $$
DECLARE
    domain text;
    inbox_url text;
BEGIN
    FOREACH domain IN ARRAY p_target_domains LOOP
        -- Get inbox URL for domain (simplified - in production, you'd fetch this)
        inbox_url := 'https://' || domain || '/inbox';
        
        INSERT INTO federation_delivery_queue (
            activity_id,
            target_domain,
            target_inbox_url,
            next_attempt_at
        ) VALUES (
            p_activity_id,
            domain,
            inbox_url,
            now()
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Mark instance as unreachable
CREATE OR REPLACE FUNCTION mark_instance_unreachable(p_domain text) RETURNS void AS $$
BEGIN
    UPDATE federated_instances 
    SET 
        is_blocked = true,
        last_seen_at = now(),
        metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{unreachable_since}',
            to_jsonb(now())
        )
    WHERE domain = p_domain;
END;
$$ LANGUAGE plpgsql;

-- Mark instance as reachable
CREATE OR REPLACE FUNCTION mark_instance_reachable(p_domain text) RETURNS void AS $$
BEGIN
    UPDATE federated_instances 
    SET 
        is_blocked = false,
        last_seen_at = now(),
        metadata = metadata - 'unreachable_since'
    WHERE domain = p_domain;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- UPDATE TRIGGERS
-- =============================================================================

-- Update timestamps
CREATE TRIGGER update_ap_activities_updated_at
    BEFORE UPDATE ON ap_activities
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_federation_delivery_queue_updated_at
    BEFORE UPDATE ON federation_delivery_queue
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ap_actor_cache_updated_at
    BEFORE UPDATE ON ap_actor_cache
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ap_object_cache_updated_at
    BEFORE UPDATE ON ap_object_cache
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- MONITORING VIEWS
-- =============================================================================

-- Federation statistics view
CREATE VIEW federation_stats AS
SELECT 
    COUNT(*) as total_activities,
    COUNT(*) FILTER (WHERE status = 'delivered') as delivered_activities,
    COUNT(*) FILTER (WHERE status = 'failed') as failed_activities,
    COUNT(*) FILTER (WHERE status = 'pending') as pending_activities,
    COUNT(DISTINCT actor_id) as active_users,
    COUNT(DISTINCT target_id) as target_objects,
    ap_type,
    DATE_TRUNC('hour', created_at) as hour
FROM ap_activities 
GROUP BY ap_type, DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;

-- Delivery queue statistics
CREATE VIEW delivery_queue_stats AS
SELECT 
    COUNT(*) as total_deliveries,
    COUNT(*) FILTER (WHERE status = 'delivered') as successful_deliveries,
    COUNT(*) FILTER (WHERE status = 'failed') as failed_deliveries,
    COUNT(*) FILTER (WHERE status = 'pending') as pending_deliveries,
    AVG(delivery_duration_ms) as avg_delivery_time_ms,
    target_domain,
    DATE_TRUNC('hour', created_at) as hour
FROM federation_delivery_queue 
GROUP BY target_domain, DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;

-- Instance health view
CREATE VIEW instance_health AS
SELECT 
    domain,
    is_blocked,
    is_trusted,
    last_seen_at,
    user_count,
    status_count,
    connection_count,
    CASE 
        WHEN last_seen_at > now() - interval '1 hour' THEN 'healthy'
        WHEN last_seen_at > now() - interval '24 hours' THEN 'stale'
        ELSE 'unreachable'
    END as health_status
FROM federated_instances
ORDER BY last_seen_at DESC;

-- =============================================================================
-- REALTIME SUBSCRIPTIONS
-- =============================================================================

-- Enable realtime for new tables
ALTER PUBLICATION supabase_realtime ADD TABLE ap_activities;
ALTER PUBLICATION supabase_realtime ADD TABLE voice_federation_events;
ALTER PUBLICATION supabase_realtime ADD TABLE server_federation_events;

-- Create notification for new activities
CREATE OR REPLACE FUNCTION notify_new_activity() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        'new_activity',
        json_build_object(
            'id', NEW.id,
            'type', NEW.ap_type,
            'actor_id', NEW.actor_id,
            'created_at', NEW.created_at
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_new_activity_trigger
    AFTER INSERT ON ap_activities
    FOR EACH ROW EXECUTE FUNCTION notify_new_activity();

-- =============================================================================
-- COMPLETION MESSAGE
-- =============================================================================

DO $$
BEGIN
    RAISE NOTICE '🎉 COMPREHENSIVE ACTIVITYPUB FEDERATION MIGRATION COMPLETED!';
    RAISE NOTICE '📊 Tables created: ap_activities, federation_delivery_queue, voice_federation_events, server_federation_events, ap_actor_cache, ap_object_cache';
    RAISE NOTICE '🔧 Enhanced existing tables: posts, profiles, servers (if exists)';
    RAISE NOTICE '🚀 Your Harmony instance now supports:';
    RAISE NOTICE '   • Complete ActivityPub activity types (Create, Update, Delete, Follow, etc.)';
    RAISE NOTICE '   • Voice chat federation (world first!)';
    RAISE NOTICE '   • Server federation (Discord-like server joining)';
    RAISE NOTICE '   • Background delivery queue for reliable federation';
    RAISE NOTICE '   • Actor and object caching for performance';
    RAISE NOTICE '   • Comprehensive monitoring and health tracking';
    RAISE NOTICE '';
    RAISE NOTICE '🔥 NEXT STEPS:';
    RAISE NOTICE '   1. Deploy your Edge Functions (WebFinger, Actor, NodeInfo, Inbox)';
    RAISE NOTICE '   2. Test federation with Mastodon instances';
    RAISE NOTICE '   3. Build UI components for reactions, post editing, voice federation';
    RAISE NOTICE '   4. Launch the world''s first federated Discord-like platform!';
    RAISE NOTICE '';
    RAISE NOTICE '🌟 Welcome to the future of federated communication!';
END $$; 