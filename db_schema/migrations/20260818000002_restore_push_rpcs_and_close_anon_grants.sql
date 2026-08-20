-- Creates the six push-delivery and session-presence RPCs on instances that never had
-- them, and takes them off the anonymous surface.
--
-- They were applied to production by hand and captured into init/ later, so no migration
-- ever created them: staging answers PGRST202 and push delivery is dead there. Bodies are
-- byte-identical to init/, so CREATE OR REPLACE is a no-op on production.
--
-- All six are SECURITY DEFINER and none checks the caller against the identifier it is
-- handed, while Supabase grants EXECUTE on every public function to anon. The sharpest is
-- get_user_push_subscriptions(p_user_id), which returns endpoint, p256dh and auth for any
-- user - the Web Push credential triple, sufficient to push to that device. The others leak
-- presence, server membership, and let anyone retire a subscription by id.
--
-- REVOKE does not apply to service_role, and every caller is federation-backend on the
-- service role, so nothing breaks.

BEGIN;

-- Mirrored from production.
CREATE OR REPLACE FUNCTION public.get_server_members_by_instance(p_server_id uuid) RETURNS TABLE(instance text, member_ids uuid[], member_ap_ids text[], member_count integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  SELECT 
    COALESCE(p.domain, 'local') as instance,
    array_agg(p.id) as member_ids,
    array_agg(p.federated_id) as member_ap_ids,
    COUNT(*)::INT as member_count
  FROM user_servers us
  JOIN profiles p ON us.user_id = p.id
  WHERE us.server_id = p_server_id
  GROUP BY COALESCE(p.domain, 'local');
$$;

-- Mirrored from production.
CREATE OR REPLACE FUNCTION public.get_user_push_subscriptions(p_user_id uuid) RETURNS TABLE(subscription_id uuid, endpoint text, p256dh text, auth text, push_enabled boolean, push_offline_only boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
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

-- Mirrored from production.
CREATE OR REPLACE FUNCTION public.has_active_session(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_sessions
        WHERE user_id = p_user_id
        AND is_active = true
        AND last_heartbeat > now() - interval '90 seconds'
    );
$$;

-- Mirrored from production.
CREATE OR REPLACE FUNCTION public.is_user_viewing_push_context(p_user_id uuid, p_server_id uuid DEFAULT NULL::uuid, p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
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

-- Mirrored from production.
CREATE OR REPLACE FUNCTION public.record_push_failure(p_subscription_id uuid, p_reason text DEFAULT NULL::text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
    UPDATE public.push_subscriptions
    SET 
        failure_count = failure_count + 1,
        last_failure_at = now(),
        last_failure_reason = p_reason
    WHERE id = p_subscription_id;
$$;

-- Mirrored from production.
CREATE OR REPLACE FUNCTION public.record_push_success(p_subscription_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
    UPDATE public.push_subscriptions
    SET 
        last_successful_push = now(),
        failure_count = 0,
        last_failure_at = NULL,
        last_failure_reason = NULL
    WHERE id = p_subscription_id;
$$;

REVOKE ALL ON FUNCTION public.get_server_members_by_instance(p_server_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_user_push_subscriptions(p_user_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_active_session(p_user_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_user_viewing_push_context(p_user_id uuid, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_push_failure(p_subscription_id uuid, p_reason text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_push_success(p_subscription_id uuid) FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
