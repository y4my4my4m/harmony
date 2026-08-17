-- =============================================================================
-- insert_ap_activity_outbound - RPC for frontend federation activity inserts
-- =============================================================================
-- The frontend FederationActivityService inserts into ap_activities for outbound
-- activities (reactions, posts, etc.). Direct .insert() can fail with PGRST204
-- "Could not find the 'activity_data' column" when PostgREST's schema cache
-- is stale. Using an RPC bypasses table schema validation.
-- Inserts with status='pending' so the federation delivery pipeline picks it up.
-- =============================================================================

BEGIN;

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

GRANT EXECUTE ON FUNCTION public.insert_ap_activity_outbound(text, text, uuid, text, jsonb, text, text, text[], text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.insert_ap_activity_outbound(text, text, uuid, text, jsonb, text, text, text[], text[], text) TO service_role;

COMMENT ON FUNCTION public.insert_ap_activity_outbound IS
'Insert outbound ActivityPub activities (status=pending). Used by FederationActivityService to bypass PostgREST schema cache issues.';

-- Reload PostgREST schema cache so future direct inserts work if schema was fixed
NOTIFY pgrst, 'reload schema';

COMMIT;
