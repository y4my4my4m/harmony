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
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    domain text NOT NULL UNIQUE CHECK (domain = lower(domain)),
    
    -- Instance info
    software text,
    version text,
    description text,
    admin_contact text,
    
    -- Status
    is_blocked boolean DEFAULT false,
    is_trusted boolean DEFAULT false,
    last_seen_at timestamp with time zone DEFAULT now(),
    
    -- Stats
    user_count integer DEFAULT 0,
    status_count integer DEFAULT 0,
    connection_count integer DEFAULT 0,
    
    -- Metadata
    metadata jsonb DEFAULT '{}'::jsonb
);

ALTER TABLE public.federated_instances REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_federated_instances_domain ON public.federated_instances(domain);

GRANT SELECT ON public.federated_instances TO authenticated;
GRANT ALL ON public.federated_instances TO service_role;

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

GRANT SELECT ON public.blocked_instances TO authenticated;
GRANT ALL ON public.blocked_instances TO service_role;

COMMENT ON TABLE public.blocked_instances IS 'Blocked/defederated instances';

-- ---------------------------------------------------------------------------
-- AP ACTIVITIES - ActivityPub activity log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ap_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),

    ap_id text NOT NULL,
    ap_type text NOT NULL,

    actor_id uuid,
    actor_ap_id text NOT NULL,

    object_id text,
    object_type text,
    target_id uuid,
    target_type text,

    activity_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text,

    to_addresses text[] DEFAULT '{}'::text[],
    cc_addresses text[] DEFAULT '{}'::text[],
    bto_addresses text[] DEFAULT '{}'::text[],
    bcc_addresses text[] DEFAULT '{}'::text[],

    attempts integer DEFAULT 0,
    last_attempt_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    error_message text,

    is_local boolean DEFAULT true,
    source_domain text,
    origin_domain text,

    CONSTRAINT ap_activities_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'received', 'processed')),
    CONSTRAINT ap_activities_valid_type CHECK (ap_type IN (
        'Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', 'Undo',
        'Like', 'EmojiReaction', 'Announce', 'Add', 'Remove', 'Invite',
        'Join', 'Leave', 'Block', 'Flag', 'Move', 'Tombstone',
        'VoiceJoin', 'VoiceLeave', 'VoiceUpdate',
        'harmony:VoiceCallInvite', 'harmony:VoiceCallAccept',
        'harmony:VoiceCallReject', 'harmony:VoiceCallEnd',
        'harmony:VoiceChannelJoin', 'harmony:VoiceChannelLeave',
        'harmony:VoiceChannelJoinAccept', 'harmony:VoiceChannelJoinReject'
    ))
);

ALTER TABLE public.ap_activities REPLICA IDENTITY FULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_activities_ap_id ON public.ap_activities(ap_id);
CREATE INDEX IF NOT EXISTS idx_ap_activities_type ON public.ap_activities(ap_type);
CREATE INDEX IF NOT EXISTS idx_ap_activities_actor ON public.ap_activities(actor_ap_id);
CREATE INDEX IF NOT EXISTS idx_ap_activities_status ON public.ap_activities(status);
CREATE INDEX IF NOT EXISTS idx_ap_activities_created ON public.ap_activities(created_at DESC);

GRANT SELECT ON public.ap_activities TO authenticated;
GRANT ALL ON public.ap_activities TO service_role;

COMMENT ON TABLE public.ap_activities IS 'ActivityPub activity log for federation';

-- ---------------------------------------------------------------------------
-- AP ACTOR CACHE - Cached remote actor data
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ap_actor_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ap_id text NOT NULL UNIQUE,
    domain text NOT NULL,
    username text NOT NULL,
    actor_data jsonb NOT NULL,
    last_fetched_at timestamp with time zone DEFAULT now(),
    cache_expires_at timestamp with time zone DEFAULT (now() + interval '1 hour'),
    fetch_attempts integer DEFAULT 0,
    is_reachable boolean DEFAULT true,
    last_error text
);

CREATE INDEX IF NOT EXISTS idx_ap_actor_cache_ap_id ON public.ap_actor_cache(ap_id);
CREATE INDEX IF NOT EXISTS idx_ap_actor_cache_domain ON public.ap_actor_cache(domain);

GRANT SELECT ON public.ap_actor_cache TO authenticated;
GRANT ALL ON public.ap_actor_cache TO service_role;

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

GRANT SELECT ON public.ap_object_cache TO authenticated;
GRANT ALL ON public.ap_object_cache TO service_role;

COMMENT ON TABLE public.ap_object_cache IS 'Cached remote ActivityPub objects';

-- ---------------------------------------------------------------------------
-- FEDERATION DELIVERY QUEUE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.federation_delivery_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),

    -- Target inbox
    target_inbox_url text NOT NULL,
    target_domain text NOT NULL,

    -- Activity to deliver
    activity_data jsonb,

    -- Sender (for HTTP signature)
    sender_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    actor_username text,
    actor_domain text,

    -- Status
    status text DEFAULT 'pending'::text,
    attempts integer DEFAULT 0,
    max_attempts integer DEFAULT 5,

    -- Timing
    next_attempt_at timestamp with time zone DEFAULT now(),
    last_attempt_at timestamp with time zone,
    delivered_at timestamp with time zone,

    -- Error tracking
    error_message text,
    http_status_code integer,
    response_body text,
    delivery_duration_ms integer,

    -- Priority (1=highest, 10=lowest)
    priority integer DEFAULT 5,

    CONSTRAINT federation_delivery_queue_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead', 'delivered', 'cancelled')),
    CONSTRAINT federation_delivery_queue_priority_check CHECK (priority >= 1 AND priority <= 10)
);

CREATE INDEX IF NOT EXISTS idx_federation_delivery_queue_status ON public.federation_delivery_queue(status);
CREATE INDEX IF NOT EXISTS idx_fdq_next_attempt ON public.federation_delivery_queue(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_fdq_target_domain ON public.federation_delivery_queue(target_domain);

COMMENT ON TABLE public.federation_delivery_queue IS 'Queue for outgoing federation deliveries';

GRANT SELECT, DELETE ON public.federation_delivery_queue TO authenticated;
GRANT ALL ON public.federation_delivery_queue TO service_role;

-- ---------------------------------------------------------------------------
-- FEDERATION ENDPOINT HEALTH
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.federation_endpoint_health (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    endpoint_url text NOT NULL UNIQUE,
    domain text NOT NULL,
    is_dead boolean DEFAULT false,
    first_failure_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    consecutive_failures integer DEFAULT 0,
    total_failures integer DEFAULT 0,
    total_successes integer DEFAULT 0,
    last_http_status integer,
    last_error_message text
);

CREATE INDEX IF NOT EXISTS idx_federation_endpoint_health_url ON public.federation_endpoint_health(endpoint_url);
CREATE INDEX IF NOT EXISTS idx_federation_endpoint_health_domain ON public.federation_endpoint_health(domain);
CREATE INDEX IF NOT EXISTS idx_federation_endpoint_health_dead ON public.federation_endpoint_health(is_dead) WHERE is_dead = true;

COMMENT ON TABLE public.federation_endpoint_health IS 'Tracks health of federation endpoints. Dead after 24-48h of consistent failures.';

GRANT SELECT, DELETE ON public.federation_endpoint_health TO authenticated;
GRANT ALL ON public.federation_endpoint_health TO service_role;

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

GRANT SELECT ON public.server_federation_events TO authenticated;
GRANT ALL ON public.server_federation_events TO service_role;

COMMENT ON TABLE public.server_federation_events IS 'Federation events for servers';

-- ---------------------------------------------------------------------------
-- SERVER MEMBERSHIP EVENTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_membership_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.server_membership_events REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_server_membership_events_server ON public.server_membership_events(server_id);

GRANT SELECT ON public.server_membership_events TO authenticated;
GRANT ALL ON public.server_membership_events TO service_role;

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

GRANT SELECT ON public.voice_federation_events TO authenticated;
GRANT ALL ON public.voice_federation_events TO service_role;

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

GRANT SELECT ON public.federated_voice_calls TO authenticated;
GRANT ALL ON public.federated_voice_calls TO service_role;

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

GRANT SELECT ON public.activity_processing_logs TO authenticated;
GRANT ALL ON public.activity_processing_logs TO service_role;

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

GRANT SELECT ON public.activitypub_processing_stats TO authenticated;
GRANT ALL ON public.activitypub_processing_stats TO service_role;

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

GRANT SELECT ON public.federation_delivery_stats TO authenticated;
GRANT ALL ON public.federation_delivery_stats TO service_role;

COMMENT ON TABLE public.federation_delivery_stats IS 'Statistics on federation delivery success rates';

DO $$
BEGIN
    RAISE NOTICE 'Federation tables created successfully';
END $$;

