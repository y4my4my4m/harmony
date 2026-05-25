BEGIN;

-- =============================================================================
-- Fix 1: insert_ap_activity_outbound - prevent actor impersonation
-- The function was SECURITY DEFINER with no check that p_actor_id matches the caller.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.insert_ap_activity_outbound(
    p_ap_id text,
    p_ap_type text,
    p_actor_id uuid,
    p_actor_ap_id text,
    p_activity_data jsonb,
    p_object_id text DEFAULT NULL,
    p_object_type text DEFAULT NULL,
    p_to_addresses text[] DEFAULT '{}'::text[],
    p_cc_addresses text[] DEFAULT '{}'::text[],
    p_origin_domain text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_activity_id uuid;
    v_caller_profile_id uuid;
BEGIN
    -- Verify the caller owns this actor_id (prevent impersonation)
    v_caller_profile_id := public.get_current_profile_id();
    IF v_caller_profile_id IS NULL OR v_caller_profile_id != p_actor_id THEN
        RAISE EXCEPTION 'Unauthorized: p_actor_id does not match the authenticated user';
    END IF;

    INSERT INTO ap_activities (
        ap_id,
        ap_type,
        actor_id,
        actor_ap_id,
        object_id,
        object_type,
        activity_data,
        status,
        is_local,
        to_addresses,
        cc_addresses,
        origin_domain
    ) VALUES (
        p_ap_id,
        p_ap_type,
        p_actor_id,
        p_actor_ap_id,
        p_object_id,
        p_object_type,
        p_activity_data,
        'pending',
        true,
        p_to_addresses,
        p_cc_addresses,
        p_origin_domain
    )
    RETURNING id INTO v_activity_id;

    RETURN v_activity_id;
END;
$$;

-- =============================================================================
-- Fix 2: federation_endpoint_health - restrict permissive FOR ALL policy
-- The old federation_endpoint_health_manage (FOR ALL, auth.uid() IS NOT NULL)
-- was a permissive policy that OR'd with the admin DELETE policy, letting any
-- authenticated user DELETE endpoint health records.
-- Replace with service_role-only FOR ALL + authenticated INSERT-only.
-- =============================================================================
DROP POLICY IF EXISTS "federation_endpoint_health_manage" ON public.federation_endpoint_health;
CREATE POLICY "federation_endpoint_health_manage" ON public.federation_endpoint_health
    FOR ALL TO service_role
    USING (true);

DROP POLICY IF EXISTS "federation_endpoint_health_insert_update" ON public.federation_endpoint_health;
CREATE POLICY "federation_endpoint_health_insert_update" ON public.federation_endpoint_health
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);

-- =============================================================================
-- Fix 3: upsert_remote_emoji - change p_is_animated default from false to NULL
-- With DEFAULT false, COALESCE(EXCLUDED.is_animated, ...) never fell through,
-- silently resetting animated emojis to false on every upsert.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.upsert_remote_emoji(
    p_shortcode text,
    p_origin_domain text,
    p_full_code text,
    p_url text,
    p_static_url text DEFAULT NULL,
    p_category text DEFAULT NULL,
    p_is_animated boolean DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.remote_emojis_cache (
    shortcode, origin_domain, full_code, url, static_url, category, is_animated
  ) VALUES (
    p_shortcode, p_origin_domain, p_full_code, p_url, p_static_url, p_category, p_is_animated
  )
  ON CONFLICT (shortcode, origin_domain) DO UPDATE SET
    url = EXCLUDED.url,
    static_url = COALESCE(EXCLUDED.static_url, remote_emojis_cache.static_url),
    last_seen_at = now(),
    usage_count = remote_emojis_cache.usage_count + 1,
    category = COALESCE(EXCLUDED.category, remote_emojis_cache.category),
    is_animated = COALESCE(EXCLUDED.is_animated, remote_emojis_cache.is_animated)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
