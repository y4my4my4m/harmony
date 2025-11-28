-- Push Subscriptions Table for Web Push Notifications
-- Stores user push subscription data (endpoint, keys) for native push notifications
-- Compatible with PWA on iOS 16.4+ and Android

-- ============================================================================
-- USER SESSIONS TABLE - Track active sessions for smart push notifications
-- Discord-like behavior: only send push when user is not active on any device
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Session identification
    session_token text NOT NULL UNIQUE,  -- Unique token for this session
    
    -- Device identification (better categorization)
    platform text DEFAULT 'web',         -- 'ios', 'android', 'windows', 'macos', 'linux', 'chromeos', 'web'
    form_factor text DEFAULT 'desktop',  -- 'mobile', 'tablet', 'desktop'
    is_pwa boolean DEFAULT false,        -- true if running as installed PWA
    browser text,                        -- 'chrome', 'firefox', 'safari', 'edge', etc.
    user_agent text,
    
    -- Activity tracking
    last_heartbeat timestamptz DEFAULT now() NOT NULL,
    last_activity timestamptz DEFAULT now() NOT NULL,  -- Mouse/keyboard activity
    
    -- Session status
    is_active boolean DEFAULT true,
    status text DEFAULT 'online',  -- 'online', 'away', 'busy', 'offline'
    
    -- Metadata
    created_at timestamptz DEFAULT now() NOT NULL,
    ip_address text,
    
    -- Context (what the user is looking at)
    current_server_id uuid REFERENCES public.servers(id) ON DELETE SET NULL,
    current_channel_id uuid REFERENCES public.channels(id) ON DELETE SET NULL,
    current_conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id 
    ON public.user_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_user_sessions_active 
    ON public.user_sessions(user_id, is_active, last_heartbeat) 
    WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_user_sessions_heartbeat 
    ON public.user_sessions(last_heartbeat);

-- Cleanup function for stale sessions
CREATE OR REPLACE FUNCTION cleanup_stale_user_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count integer;
BEGIN
    -- Mark sessions as inactive if no heartbeat in 2 minutes
    UPDATE public.user_sessions
    SET is_active = false
    WHERE is_active = true
    AND last_heartbeat < now() - interval '2 minutes';
    
    -- Delete sessions that have been inactive for over 24 hours
    DELETE FROM public.user_sessions
    WHERE last_heartbeat < now() - interval '24 hours';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- Function to check if user has any active sessions
CREATE OR REPLACE FUNCTION has_active_session(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_sessions
        WHERE user_id = p_user_id
        AND is_active = true
        AND last_heartbeat > now() - interval '90 seconds'
    );
$$;

-- Function to check if user is viewing a specific context
-- Returns true if user is actively viewing the channel/conversation
CREATE OR REPLACE FUNCTION is_user_viewing_push_context(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_sessions
        WHERE user_id = p_user_id
        AND is_active = true
        AND last_heartbeat > now() - interval '90 seconds'
        AND (
            (p_conversation_id IS NOT NULL AND current_conversation_id = p_conversation_id)
            OR (p_channel_id IS NOT NULL AND current_channel_id = p_channel_id)
            OR (p_server_id IS NOT NULL AND current_server_id = p_server_id AND p_channel_id IS NULL)
        )
    );
$$;

-- Function to update or create a session heartbeat
CREATE OR REPLACE FUNCTION upsert_user_session(
    p_user_id uuid,
    p_session_token text,
    p_platform text DEFAULT 'web',
    p_form_factor text DEFAULT 'desktop',
    p_is_pwa boolean DEFAULT false,
    p_browser text DEFAULT NULL,
    p_user_agent text DEFAULT NULL,
    p_status text DEFAULT 'online',
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_session_id uuid;
BEGIN
    INSERT INTO public.user_sessions (
        user_id, session_token, platform, form_factor, is_pwa, browser, user_agent, status,
        current_server_id, current_channel_id, current_conversation_id,
        last_heartbeat, last_activity, is_active
    )
    VALUES (
        p_user_id, p_session_token, p_platform, p_form_factor, p_is_pwa, p_browser, p_user_agent, p_status,
        p_server_id, p_channel_id, p_conversation_id,
        now(), now(), true
    )
    ON CONFLICT (session_token) DO UPDATE SET
        last_heartbeat = now(),
        status = EXCLUDED.status,
        current_server_id = EXCLUDED.current_server_id,
        current_channel_id = EXCLUDED.current_channel_id,
        current_conversation_id = EXCLUDED.current_conversation_id,
        is_active = true
    RETURNING id INTO v_session_id;
    
    RETURN v_session_id;
END;
$$;

-- Function to end a session (logout/close tab)
CREATE OR REPLACE FUNCTION end_user_session(p_session_token text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
    UPDATE public.user_sessions
    SET is_active = false, last_heartbeat = now()
    WHERE session_token = p_session_token;
$$;

-- RLS Policies for user_sessions
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

-- Drop existing policies first (idempotent)
DROP POLICY IF EXISTS "Users can view own sessions" ON public.user_sessions;
DROP POLICY IF EXISTS "Users can insert own sessions" ON public.user_sessions;
DROP POLICY IF EXISTS "Users can update own sessions" ON public.user_sessions;
DROP POLICY IF EXISTS "Users can delete own sessions" ON public.user_sessions;
DROP POLICY IF EXISTS "Service role can manage all sessions" ON public.user_sessions;

-- Users can view their own sessions
CREATE POLICY "Users can view own sessions"
    ON public.user_sessions
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own sessions
CREATE POLICY "Users can insert own sessions"
    ON public.user_sessions
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own sessions
CREATE POLICY "Users can update own sessions"
    ON public.user_sessions
    FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can delete their own sessions
CREATE POLICY "Users can delete own sessions"
    ON public.user_sessions
    FOR DELETE
    USING (auth.uid() = user_id);

-- Service role can manage all sessions
CREATE POLICY "Service role can manage all sessions"
    ON public.user_sessions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.user_sessions IS 'Tracks active user sessions for smart push notifications. If user has an active session, push notifications are suppressed (Discord-like behavior).';

-- Grant permissions for user_sessions
GRANT ALL ON public.user_sessions TO authenticated;
GRANT ALL ON public.user_sessions TO service_role;

-- ============================================================================
-- PUSH SUBSCRIPTIONS TABLE
-- ============================================================================

-- Create push_subscriptions table
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Web Push subscription data (from browser's PushSubscription object)
    endpoint text NOT NULL,
    p256dh text NOT NULL,  -- Public key for encryption
    auth text NOT NULL,    -- Authentication secret
    
    -- Metadata
    user_agent text,       -- Browser/device info for debugging
    device_name text,      -- User-friendly device name (optional)
    
    -- Timestamps
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    last_successful_push timestamptz,
    
    -- Failure tracking for cleanup
    failure_count integer DEFAULT 0,
    last_failure_at timestamptz,
    last_failure_reason text,
    
    -- Ensure unique subscription per user/endpoint combination
    -- A user can have multiple devices, but each device has unique endpoint
    CONSTRAINT push_subscriptions_user_endpoint_unique UNIQUE (user_id, endpoint)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id 
    ON public.push_subscriptions(user_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint 
    ON public.push_subscriptions(endpoint);

-- Index for cleanup queries (find stale subscriptions)
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_failure 
    ON public.push_subscriptions(failure_count, last_failure_at) 
    WHERE failure_count > 0;

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_push_subscription_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS push_subscriptions_update_timestamp ON public.push_subscriptions;
CREATE TRIGGER push_subscriptions_update_timestamp
    BEFORE UPDATE ON public.push_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_push_subscription_timestamp();

-- Comments for documentation
COMMENT ON TABLE public.push_subscriptions IS 'Stores Web Push notification subscriptions for each user device. Used for native push notifications on iOS (16.4+) and Android PWAs.';
COMMENT ON COLUMN public.push_subscriptions.endpoint IS 'The unique push service URL for this subscription';
COMMENT ON COLUMN public.push_subscriptions.p256dh IS 'The P-256 public key for encrypting push messages';
COMMENT ON COLUMN public.push_subscriptions.auth IS 'The authentication secret for the subscription';
COMMENT ON COLUMN public.push_subscriptions.failure_count IS 'Number of consecutive push failures. Used to detect and cleanup stale subscriptions';

-- RLS Policies
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Drop existing policies first (idempotent)
DROP POLICY IF EXISTS "Users can view own push subscriptions" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Users can insert own push subscriptions" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Users can update own push subscriptions" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Users can delete own push subscriptions" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Service role can manage all push subscriptions" ON public.push_subscriptions;

-- Users can view their own subscriptions
CREATE POLICY "Users can view own push subscriptions"
    ON public.push_subscriptions
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own subscriptions
CREATE POLICY "Users can insert own push subscriptions"
    ON public.push_subscriptions
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own subscriptions
CREATE POLICY "Users can update own push subscriptions"
    ON public.push_subscriptions
    FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can delete their own subscriptions
CREATE POLICY "Users can delete own push subscriptions"
    ON public.push_subscriptions
    FOR DELETE
    USING (auth.uid() = user_id);

-- Service role can manage all subscriptions (for backend push sending)
CREATE POLICY "Service role can manage all push subscriptions"
    ON public.push_subscriptions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Function to cleanup stale subscriptions (run periodically)
CREATE OR REPLACE FUNCTION cleanup_stale_push_subscriptions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count integer;
BEGIN
    -- Delete subscriptions that have failed more than 5 times
    -- and haven't had a successful push in over 30 days
    DELETE FROM public.push_subscriptions
    WHERE failure_count >= 5
    AND (
        last_successful_push IS NULL 
        OR last_successful_push < now() - interval '30 days'
    );
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_stale_push_subscriptions IS 'Removes push subscriptions that have repeatedly failed. Should be run periodically via cron.';

-- Grant permissions for push_subscriptions
GRANT ALL ON public.push_subscriptions TO authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;

-- Function to get user's push subscriptions with preferences check
CREATE OR REPLACE FUNCTION get_user_push_subscriptions(p_user_id uuid)
RETURNS TABLE (
    subscription_id uuid,
    endpoint text,
    p256dh text,
    auth text,
    push_enabled boolean,
    push_offline_only boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ps.id as subscription_id,
        ps.endpoint,
        ps.p256dh,
        ps.auth,
        COALESCE(np.push_notifications, true) as push_enabled,
        COALESCE(np.push_offline_only, true) as push_offline_only
    FROM public.push_subscriptions ps
    LEFT JOIN public.notification_preferences np ON np.user_id = ps.user_id
    WHERE ps.user_id = p_user_id
    AND ps.failure_count < 5;  -- Skip subscriptions that have failed too many times
END;
$$;

COMMENT ON FUNCTION get_user_push_subscriptions IS 'Gets all active push subscriptions for a user along with their notification preferences';

-- Function to record push success
CREATE OR REPLACE FUNCTION record_push_success(p_subscription_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
    UPDATE public.push_subscriptions
    SET 
        last_successful_push = now(),
        failure_count = 0,
        last_failure_at = NULL,
        last_failure_reason = NULL
    WHERE id = p_subscription_id;
$$;

-- Function to record push failure
CREATE OR REPLACE FUNCTION record_push_failure(
    p_subscription_id uuid, 
    p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
    UPDATE public.push_subscriptions
    SET 
        failure_count = failure_count + 1,
        last_failure_at = now(),
        last_failure_reason = p_reason
    WHERE id = p_subscription_id;
$$;

-- Function to delete subscription by endpoint (called when browser returns 410 Gone)
CREATE OR REPLACE FUNCTION delete_push_subscription_by_endpoint(p_endpoint text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
    DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint;
$$;

-- ============================================================================
-- GRANT EXECUTE PERMISSIONS FOR ALL FUNCTIONS
-- Required for frontend (authenticated) and backend (service_role) to call these
-- ============================================================================

-- User session functions
GRANT EXECUTE ON FUNCTION public.cleanup_stale_user_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_user_sessions() TO service_role;

GRANT EXECUTE ON FUNCTION public.has_active_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_active_session(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.is_user_viewing_push_context(uuid, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_viewing_push_context(uuid, uuid, uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.upsert_user_session(uuid, text, text, text, boolean, text, text, text, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_user_session(uuid, text, text, text, boolean, text, text, text, uuid, uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.end_user_session(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_user_session(text) TO service_role;

-- Push subscription functions
GRANT EXECUTE ON FUNCTION public.update_push_subscription_timestamp() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_push_subscription_timestamp() TO service_role;

GRANT EXECUTE ON FUNCTION public.cleanup_stale_push_subscriptions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_push_subscriptions() TO service_role;

GRANT EXECUTE ON FUNCTION public.get_user_push_subscriptions(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_push_subscriptions(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.record_push_success(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_push_success(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.record_push_failure(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_push_failure(uuid, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.delete_push_subscription_by_endpoint(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_push_subscription_by_endpoint(text) TO service_role;

-- ============================================================================
-- GRANTS FOR FEDERATION BACKEND (DM Federation)
-- The backend needs to read conversation_participants and profiles for DM federation
-- ============================================================================

-- Grant service_role access to conversation_participants (for DM federation)
GRANT SELECT ON public.conversation_participants TO service_role;

-- Grant service_role access to conversations (for DM federation)  
GRANT SELECT ON public.conversations TO service_role;

-- Grant service_role access to federated_instances (for inbox URL lookup)
GRANT SELECT ON public.federated_instances TO service_role;

