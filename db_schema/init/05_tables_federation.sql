-- =============================================================================
-- Harmony Database Schema - Federation Tables
-- =============================================================================
-- ActivityPub federation: instances, activities, caches
-- =============================================================================

-- ---------------------------------------------------------------------------
-- FEDERATED INSTANCES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.federated_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    domain text NOT NULL UNIQUE,
    
    -- Instance info
    name text,
    description text,
    software text,
    version text,
    
    -- URLs
    shared_inbox_url text,
    nodeinfo_url text,
    
    -- Status
    is_blocked boolean DEFAULT false,
    is_silenced boolean DEFAULT false,
    
    -- Stats
    user_count integer DEFAULT 0,
    status_count integer DEFAULT 0,
    
    -- Sync
    last_successful_sync timestamp with time zone,
    last_sync_attempt timestamp with time zone,
    consecutive_failures integer DEFAULT 0,
    
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.federated_instances REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_federated_instances_domain ON public.federated_instances(domain);

COMMENT ON TABLE public.federated_instances IS 'Known federated instances';

-- ---------------------------------------------------------------------------
-- BLOCKED INSTANCES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blocked_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    domain text NOT NULL UNIQUE,
    reason text,
    severity text DEFAULT 'suspend'::text,
    created_at timestamp with time zone DEFAULT now(),
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    
    CONSTRAINT blocked_instances_severity_check CHECK (severity IN ('silence', 'suspend'))
);

CREATE INDEX IF NOT EXISTS idx_blocked_instances_domain ON public.blocked_instances(domain);

COMMENT ON TABLE public.blocked_instances IS 'Blocked/defederated instances';

-- ---------------------------------------------------------------------------
-- AP ACTIVITIES - ActivityPub activity log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ap_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    -- Activity type: Create, Update, Delete, Follow, Like, Announce, etc.
    activity_type text NOT NULL,
    
    -- Actor (who performed the action)
    actor_id text NOT NULL,
    
    -- Object (what was acted upon)
    object_id text,
    object_type text,
    
    -- Target (for Add/Remove activities)
    target_id text,
    
    -- Full activity JSON
    activity_json jsonb NOT NULL,
    
    -- Processing status
    status text DEFAULT 'pending'::text,
    processed_at timestamp with time zone,
    error_message text,
    retry_count integer DEFAULT 0,
    
    -- Direction
    is_inbound boolean DEFAULT true,
    
    CONSTRAINT ap_activities_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'rejected'))
);

ALTER TABLE public.ap_activities REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_ap_activities_type ON public.ap_activities(activity_type);
CREATE INDEX IF NOT EXISTS idx_ap_activities_actor ON public.ap_activities(actor_id);
CREATE INDEX IF NOT EXISTS idx_ap_activities_status ON public.ap_activities(status);
CREATE INDEX IF NOT EXISTS idx_ap_activities_created ON public.ap_activities(created_at DESC);

COMMENT ON TABLE public.ap_activities IS 'ActivityPub activity log for federation';

-- ---------------------------------------------------------------------------
-- AP ACTOR CACHE - Cached remote actor data
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ap_actor_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    actor_url text NOT NULL UNIQUE,
    actor_json jsonb NOT NULL,
    
    -- Extracted fields for quick access
    username text,
    domain text,
    display_name text,
    avatar_url text,
    inbox_url text,
    outbox_url text,
    shared_inbox_url text,
    public_key text,
    
    -- Cache metadata
    fetched_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_ap_actor_cache_url ON public.ap_actor_cache(actor_url);
CREATE INDEX IF NOT EXISTS idx_ap_actor_cache_domain ON public.ap_actor_cache(domain);

COMMENT ON TABLE public.ap_actor_cache IS 'Cached remote ActivityPub actors';

-- ---------------------------------------------------------------------------
-- AP OBJECT CACHE - Cached remote objects (posts, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ap_object_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    object_url text NOT NULL UNIQUE,
    object_type text NOT NULL,
    object_json jsonb NOT NULL,
    
    -- Cache metadata
    fetched_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + interval '1 hour')
);

CREATE INDEX IF NOT EXISTS idx_ap_object_cache_url ON public.ap_object_cache(object_url);

COMMENT ON TABLE public.ap_object_cache IS 'Cached remote ActivityPub objects';

-- ---------------------------------------------------------------------------
-- FEDERATION DELIVERY QUEUE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.federation_delivery_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    -- Target inbox
    inbox_url text NOT NULL,
    
    -- Activity to deliver
    activity_json jsonb NOT NULL,
    
    -- Sender (for HTTP signature)
    sender_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Status
    status text DEFAULT 'pending'::text,
    attempts integer DEFAULT 0,
    max_attempts integer DEFAULT 5,
    
    -- Timing
    scheduled_at timestamp with time zone DEFAULT now(),
    last_attempt_at timestamp with time zone,
    completed_at timestamp with time zone,
    
    -- Error tracking
    last_error text,
    
    CONSTRAINT federation_delivery_queue_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead'))
);

CREATE INDEX IF NOT EXISTS idx_federation_delivery_queue_status ON public.federation_delivery_queue(status);
CREATE INDEX IF NOT EXISTS idx_federation_delivery_queue_scheduled ON public.federation_delivery_queue(scheduled_at) WHERE status = 'pending';

COMMENT ON TABLE public.federation_delivery_queue IS 'Queue for outgoing federation deliveries';

-- ---------------------------------------------------------------------------
-- FEDERATION ENDPOINT HEALTH
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.federation_endpoint_health (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    endpoint_url text NOT NULL UNIQUE,
    
    -- Health stats
    success_count integer DEFAULT 0,
    failure_count integer DEFAULT 0,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    last_error text,
    
    -- Backoff
    next_retry_at timestamp with time zone DEFAULT now(),
    backoff_level integer DEFAULT 0,
    
    -- Status
    is_dead boolean DEFAULT false,
    
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_federation_endpoint_health_url ON public.federation_endpoint_health(endpoint_url);
CREATE INDEX IF NOT EXISTS idx_federation_endpoint_health_dead ON public.federation_endpoint_health(is_dead) WHERE is_dead = true;

COMMENT ON TABLE public.federation_endpoint_health IS 'Health tracking for federation endpoints';

-- ---------------------------------------------------------------------------
-- SERVER FEDERATION EVENTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_federation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.server_federation_events REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_server_federation_events_server ON public.server_federation_events(server_id);

COMMENT ON TABLE public.server_federation_events IS 'Federation events for servers';

-- ---------------------------------------------------------------------------
-- SERVER MEMBERSHIP EVENTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_membership_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.server_membership_events REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_server_membership_events_server ON public.server_membership_events(server_id);

COMMENT ON TABLE public.server_membership_events IS 'Server membership change events';

-- ---------------------------------------------------------------------------
-- VOICE FEDERATION EVENTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.voice_federation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.voice_federation_events REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_voice_federation_events_channel ON public.voice_federation_events(channel_id);

COMMENT ON TABLE public.voice_federation_events IS 'Voice channel federation events';

-- ---------------------------------------------------------------------------
-- FEDERATED VOICE CALLS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.federated_voice_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    
    -- Call state
    started_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone,
    
    -- Participants from different instances
    participants jsonb DEFAULT '[]'::jsonb,
    
    -- SFU info for routing
    sfu_url text,
    room_id text
);

CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_channel ON public.federated_voice_calls(channel_id);

COMMENT ON TABLE public.federated_voice_calls IS 'Federated voice call sessions';

-- ---------------------------------------------------------------------------
-- ACTIVITY PROCESSING LOGS - Track ActivityPub activity processing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activity_processing_logs (
    id serial PRIMARY KEY,
    activity_id uuid NOT NULL,
    ap_id text NOT NULL,
    ap_type text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_activity_processing_logs_activity ON public.activity_processing_logs(activity_id);
CREATE INDEX IF NOT EXISTS idx_activity_processing_logs_status ON public.activity_processing_logs(status);

COMMENT ON TABLE public.activity_processing_logs IS 'Tracks processing of ActivityPub activities';

-- ---------------------------------------------------------------------------
-- ACTIVITYPUB PROCESSING STATS - Daily statistics
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activitypub_processing_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    date date NOT NULL UNIQUE,
    total_activities integer DEFAULT 0,
    processed_activities integer DEFAULT 0,
    failed_activities integer DEFAULT 0,
    permanently_failed_activities integer DEFAULT 0,
    avg_processing_time_ms numeric DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);

COMMENT ON TABLE public.activitypub_processing_stats IS 'Daily ActivityPub processing statistics';

-- ---------------------------------------------------------------------------
-- FEDERATION DELIVERY STATS - Delivery statistics per period
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.federation_delivery_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    total_deliveries integer DEFAULT 0,
    successful_deliveries integer DEFAULT 0,
    failed_deliveries integer DEFAULT 0,
    avg_delivery_time_ms numeric,
    created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_federation_delivery_stats_period ON public.federation_delivery_stats(period_start, period_end);

COMMENT ON TABLE public.federation_delivery_stats IS 'Statistics on federation delivery success rates';

DO $$
BEGIN
    RAISE NOTICE 'Federation tables created successfully';
END $$;

