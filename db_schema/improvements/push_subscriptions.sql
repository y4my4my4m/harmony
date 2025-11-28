-- Push Subscriptions Table for Web Push Notifications
-- Stores user push subscription data (endpoint, keys) for native push notifications
-- Compatible with PWA on iOS 16.4+ and Android

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
    LEFT JOIN public.notification_preferences np ON np.user_id = p_user_id
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

