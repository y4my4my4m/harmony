-- =============================================================================
-- Federation Helper Functions
-- =============================================================================
-- Functions that check and manage federation settings at instance and user level.
-- These are used by the frontend and by federation triggers.
-- =============================================================================

-- =============================================================================
-- Get Public Federation Settings
-- =============================================================================
-- Returns safe, public federation settings (no sensitive data).
-- Accessible to all users including anonymous.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_public_federation_settings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    federation_settings jsonb;
    inbound_enabled boolean;
    outbound_enabled boolean;
BEGIN
    -- Get federation settings from instance_config
    SELECT config_value::jsonb INTO federation_settings
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    -- Also check individual inbound/outbound settings
    SELECT 
        COALESCE((config_value::text)::boolean, true)
    INTO inbound_enabled
    FROM instance_config 
    WHERE config_key = 'enable_inbound_federation';
    
    SELECT 
        COALESCE((config_value::text)::boolean, true)
    INTO outbound_enabled
    FROM instance_config 
    WHERE config_key = 'enable_outbound_federation';
    
    -- Return safe subset of federation settings
    IF federation_settings IS NULL THEN
        RETURN jsonb_build_object(
            'federation_enabled', true,
            'enable_inbound_federation', COALESCE(inbound_enabled, true),
            'enable_outbound_federation', COALESCE(outbound_enabled, true),
            'federation_auto_accept_follows', true
        );
    END IF;
    
    -- Merge with individual settings (individual takes precedence)
    RETURN jsonb_build_object(
        'federation_enabled', COALESCE((federation_settings->>'federation_enabled')::boolean, true),
        'enable_inbound_federation', COALESCE(
            inbound_enabled, 
            (federation_settings->>'enable_inbound_federation')::boolean, 
            true
        ),
        'enable_outbound_federation', COALESCE(
            outbound_enabled,
            (federation_settings->>'enable_outbound_federation')::boolean, 
            true
        ),
        'federation_auto_accept_follows', COALESCE(
            (federation_settings->>'federation_auto_accept_follows')::boolean, 
            true
        )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_federation_settings() TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_federation_settings() TO authenticated;

COMMENT ON FUNCTION public.get_public_federation_settings() IS 
'Get public federation settings accessible to all users. Returns safe subset only.';


-- =============================================================================
-- Check if Federation is Enabled for User
-- =============================================================================
-- Combines instance-level and user-level federation settings.
-- Returns true only if BOTH instance AND user have federation enabled.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.is_federation_enabled_for_user(user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
    instance_enabled boolean := true;
    user_enabled boolean := true;
    federation_settings jsonb;
BEGIN
    -- Check instance-level federation setting
    SELECT config_value::jsonb INTO federation_settings
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    IF federation_settings IS NOT NULL THEN
        instance_enabled := COALESCE((federation_settings->>'federation_enabled')::boolean, true);
    END IF;
    
    -- If instance federation disabled, return false immediately
    IF NOT instance_enabled THEN
        RETURN false;
    END IF;
    
    -- Check user-level federation setting
    SELECT COALESCE(federation_enabled, true)
    INTO user_enabled
    FROM profiles 
    WHERE id = user_id;
    
    RETURN COALESCE(user_enabled, true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_federation_enabled_for_user(uuid) TO authenticated;

COMMENT ON FUNCTION public.is_federation_enabled_for_user(uuid) IS 
'Checks if federation is enabled for a specific user. 
Returns true only if both instance-level AND user-level federation are enabled.';


-- =============================================================================
-- Set Instance Config (Admin Only)
-- =============================================================================
-- Upsert configuration values in instance_config table.
-- Requires admin role. Uses auth.uid() to verify the caller is an admin.
-- SECURITY: Always verifies admin status - never bypasses the check.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_instance_config(
    p_key text,
    p_value jsonb,
    p_user_id uuid DEFAULT NULL,  -- Deprecated: kept for backwards compatibility, ignored
    p_description text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_admin boolean := false;
    v_caller_profile_id uuid;
BEGIN
    -- SECURITY: Always get the actual caller from auth.uid(), never trust passed parameter
    -- Get the profile ID for the current authenticated user
    SELECT id INTO v_caller_profile_id
    FROM profiles 
    WHERE auth_user_id = auth.uid();
    
    -- If no profile found, user is not authenticated properly
    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Must be authenticated with a valid profile';
    END IF;
    
    -- Check if the authenticated user is an admin
    SELECT is_admin INTO v_is_admin
    FROM profiles 
    WHERE id = v_caller_profile_id;
    
    IF NOT COALESCE(v_is_admin, false) THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required';
    END IF;
    
    -- Upsert the config value
    INSERT INTO instance_config (config_key, config_value, description, updated_at)
    VALUES (p_key, p_value, COALESCE(p_description, ''), now())
    ON CONFLICT (config_key) DO UPDATE
    SET config_value = EXCLUDED.config_value,
        description = COALESCE(EXCLUDED.description, instance_config.description),
        updated_at = now();
    
    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_instance_config(text, jsonb, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.set_instance_config(text, jsonb, uuid, text) IS 
'Set or update instance configuration. Admin role required. Always uses auth.uid() for authorization.';


-- =============================================================================
-- Batch Set Instance Config (Admin Only)
-- =============================================================================
-- Set multiple config key/value pairs in a single RPC call.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.batch_set_instance_config(
    p_keys text[],
    p_values jsonb[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_admin boolean := false;
    v_caller_profile_id uuid;
    i integer;
BEGIN
    SELECT id INTO v_caller_profile_id
    FROM profiles
    WHERE auth_user_id = auth.uid();

    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Must be authenticated with a valid profile';
    END IF;

    SELECT is_admin INTO v_is_admin
    FROM profiles
    WHERE id = v_caller_profile_id;

    IF NOT COALESCE(v_is_admin, false) THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required';
    END IF;

    IF array_length(p_keys, 1) != array_length(p_values, 1) THEN
        RAISE EXCEPTION 'Keys and values arrays must have the same length';
    END IF;

    FOR i IN 1..array_length(p_keys, 1) LOOP
        INSERT INTO instance_config (config_key, config_value, updated_at)
        VALUES (p_keys[i], p_values[i], now())
        ON CONFLICT (config_key) DO UPDATE
        SET config_value = EXCLUDED.config_value,
            updated_at = now();
    END LOOP;

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.batch_set_instance_config(text[], jsonb[]) TO authenticated;


-- =============================================================================
-- Update Federation Settings
-- =============================================================================
-- Convenience function to update federation-specific settings.
-- Validates and stores in the correct format.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.update_federation_settings(
    p_user_id uuid,
    p_federation_enabled boolean DEFAULT NULL,
    p_inbound_enabled boolean DEFAULT NULL,
    p_outbound_enabled boolean DEFAULT NULL,
    p_auto_accept_follows boolean DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    current_auth_uid uuid := auth.uid();
    v_is_admin boolean := false;
    current_settings jsonb;
    new_settings jsonb;
BEGIN
    -- SECURITY: Ensure user is authenticated
    IF current_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    -- SECURITY: Check if the AUTHENTICATED user (not the passed p_user_id) is admin
    SELECT EXISTS(
        SELECT 1 FROM profiles p
        WHERE p.auth_user_id = current_auth_uid 
        AND p.is_admin = true
    ) INTO v_is_admin;
    
    IF NOT v_is_admin THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required';
    END IF;
    
    -- Get current settings
    SELECT COALESCE(config_value::jsonb, '{}'::jsonb) INTO current_settings
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    IF current_settings IS NULL THEN
        current_settings := '{}'::jsonb;
    END IF;
    
    -- Build new settings (only update provided values)
    new_settings := current_settings;
    
    IF p_federation_enabled IS NOT NULL THEN
        new_settings := new_settings || jsonb_build_object('federation_enabled', p_federation_enabled);
    END IF;
    
    IF p_inbound_enabled IS NOT NULL THEN
        new_settings := new_settings || jsonb_build_object('enable_inbound_federation', p_inbound_enabled);
        -- Also update individual key for backwards compatibility
        INSERT INTO instance_config (config_key, config_value, updated_at)
        VALUES ('enable_inbound_federation', to_jsonb(p_inbound_enabled), now())
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = now();
    END IF;
    
    IF p_outbound_enabled IS NOT NULL THEN
        new_settings := new_settings || jsonb_build_object('enable_outbound_federation', p_outbound_enabled);
        -- Also update individual key
        INSERT INTO instance_config (config_key, config_value, updated_at)
        VALUES ('enable_outbound_federation', to_jsonb(p_outbound_enabled), now())
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = now();
    END IF;
    
    IF p_auto_accept_follows IS NOT NULL THEN
        new_settings := new_settings || jsonb_build_object('federation_auto_accept_follows', p_auto_accept_follows);
    END IF;
    
    -- Save merged settings
    INSERT INTO instance_config (config_key, config_value, description, updated_at)
    VALUES ('federation_settings', new_settings, 'Federation configuration settings', now())
    ON CONFLICT (config_key) DO UPDATE
    SET config_value = EXCLUDED.config_value, updated_at = now();
    
    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_federation_settings(uuid, boolean, boolean, boolean, boolean) TO authenticated;

COMMENT ON FUNCTION public.update_federation_settings IS 
'Update federation settings. Admin role required. Pass NULL to keep current value.';


-- =============================================================================
-- Upsert AP Activity
-- =============================================================================
-- Idempotent insert/update for ActivityPub activities.
-- Called by the federation backend's inbox handler.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.upsert_ap_activity(
    p_ap_id text,
    p_ap_type text,
    p_actor_ap_id text,
    p_activity_data jsonb,
    p_origin_domain text DEFAULT NULL,
    p_to_addresses text[] DEFAULT '{}'::text[],
    p_cc_addresses text[] DEFAULT '{}'::text[],
    p_bto_addresses text[] DEFAULT '{}'::text[],
    p_bcc_addresses text[] DEFAULT '{}'::text[],
    p_is_local boolean DEFAULT false
)
RETURNS TABLE(activity_id uuid, was_updated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_activity_id UUID;
    v_was_updated BOOLEAN := FALSE;
    v_existing_status TEXT;
BEGIN
    SELECT id, status INTO v_activity_id, v_existing_status
    FROM ap_activities
    WHERE ap_id = p_ap_id;

    IF v_activity_id IS NOT NULL THEN
        CASE v_existing_status
            WHEN 'completed', 'processed' THEN
                v_was_updated := FALSE;
            WHEN 'failed', 'pending' THEN
                UPDATE ap_activities
                SET
                    activity_data = p_activity_data,
                    status = 'received',
                    to_addresses = p_to_addresses,
                    cc_addresses = p_cc_addresses,
                    bto_addresses = p_bto_addresses,
                    bcc_addresses = p_bcc_addresses,
                    updated_at = NOW(),
                    error_message = NULL,
                    next_attempt_at = NULL,
                    attempts = 0
                WHERE ap_id = p_ap_id;
                v_was_updated := TRUE;
            WHEN 'processing', 'received' THEN
                UPDATE ap_activities
                SET
                    activity_data = p_activity_data,
                    to_addresses = p_to_addresses,
                    cc_addresses = p_cc_addresses,
                    bto_addresses = p_bto_addresses,
                    bcc_addresses = p_bcc_addresses,
                    updated_at = NOW()
                WHERE ap_id = p_ap_id;
                v_was_updated := TRUE;
        END CASE;
    ELSE
        INSERT INTO ap_activities (
            ap_id, ap_type, actor_ap_id, activity_data,
            origin_domain, status, is_local,
            to_addresses, cc_addresses, bto_addresses, bcc_addresses
        ) VALUES (
            p_ap_id, p_ap_type, p_actor_ap_id, p_activity_data,
            p_origin_domain, 'received', p_is_local,
            p_to_addresses, p_cc_addresses, p_bto_addresses, p_bcc_addresses
        )
        RETURNING id INTO v_activity_id;
        v_was_updated := FALSE;
    END IF;

    RETURN QUERY SELECT v_activity_id, v_was_updated;
END;
$$;

COMMENT ON FUNCTION public.upsert_ap_activity IS
'Idempotent insert/update for ActivityPub activities. Returns activity_id and whether it was updated.';


-- =============================================================================
-- update_endpoint_health - Track federation endpoint delivery health
-- =============================================================================
CREATE OR REPLACE FUNCTION public.update_endpoint_health(
    p_endpoint_url text,
    p_domain text,
    p_success boolean,
    p_http_status integer DEFAULT NULL,
    p_error_message text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_health_record RECORD;
    v_is_permanent_error boolean;
BEGIN
    v_is_permanent_error := p_http_status IN (404, 410);

    SELECT * INTO v_health_record
    FROM federation_endpoint_health WHERE endpoint_url = p_endpoint_url FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO federation_endpoint_health (
            endpoint_url, domain, is_dead, first_failure_at,
            last_success_at, last_failure_at, consecutive_failures,
            total_failures, total_successes, last_http_status, last_error_message
        ) VALUES (
            p_endpoint_url, p_domain, false,
            CASE WHEN NOT p_success THEN NOW() ELSE NULL END,
            CASE WHEN p_success THEN NOW() ELSE NULL END,
            CASE WHEN NOT p_success THEN NOW() ELSE NULL END,
            CASE WHEN NOT p_success THEN 1 ELSE 0 END,
            CASE WHEN NOT p_success THEN 1 ELSE 0 END,
            CASE WHEN p_success THEN 1 ELSE 0 END,
            p_http_status, p_error_message
        );
        RETURN;
    END IF;

    IF p_success THEN
        UPDATE federation_endpoint_health SET
            is_dead = false, last_success_at = NOW(), consecutive_failures = 0,
            total_successes = total_successes + 1, last_http_status = p_http_status,
            last_error_message = NULL, first_failure_at = NULL, updated_at = NOW()
        WHERE endpoint_url = p_endpoint_url;
    ELSE
        UPDATE federation_endpoint_health SET
            last_failure_at = NOW(), consecutive_failures = consecutive_failures + 1,
            total_failures = total_failures + 1, last_http_status = p_http_status,
            last_error_message = p_error_message,
            first_failure_at = COALESCE(first_failure_at, NOW()), updated_at = NOW()
        WHERE endpoint_url = p_endpoint_url
        RETURNING * INTO v_health_record;

        IF v_health_record.first_failure_at IS NOT NULL THEN
            IF (v_is_permanent_error AND NOW() - v_health_record.first_failure_at >= INTERVAL '24 hours')
                OR (NOW() - v_health_record.first_failure_at >= INTERVAL '48 hours') THEN
                UPDATE federation_endpoint_health SET is_dead = true, updated_at = NOW()
                WHERE endpoint_url = p_endpoint_url;
            END IF;
        END IF;
    END IF;
END;
$$;

COMMENT ON FUNCTION public.update_endpoint_health IS
'Tracks endpoint delivery health. Marks endpoints dead after 24h (permanent errors) or 48h (any error).';

-- =============================================================================
-- enable/disable_federation_triggers - Bulk toggle for all federation triggers
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads ENABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers ENABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_group_participant_left;
    RAISE NOTICE 'All federation triggers enabled';
END;
$$;

CREATE OR REPLACE FUNCTION public.disable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads DISABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers DISABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_group_participant_left;
    RAISE NOTICE 'All federation triggers disabled';
END;
$$;

-- =============================================================================
-- Federated instance connection counts (known remote actors per domain)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_federated_instance_connection_counts(p_domains text[])
RETURNS TABLE(domain text, connection_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH normalized AS (
    SELECT lower(btrim(d)) AS domain
    FROM unnest(p_domains) AS d
    WHERE d IS NOT NULL AND btrim(d) <> ''
  ),
  profile_counts AS (
    SELECT lower(p.domain) AS domain, COUNT(*)::bigint AS cnt
    FROM public.profiles p
    INNER JOIN normalized n ON lower(p.domain) = n.domain
    WHERE p.is_local = false
      AND p.domain IS NOT NULL
      AND p.domain <> ''
    GROUP BY lower(p.domain)
  ),
  actor_counts AS (
    SELECT lower(a.domain) AS domain, COUNT(*)::bigint AS cnt
    FROM public.ap_actor_cache a
    INNER JOIN normalized n ON lower(a.domain) = n.domain
    WHERE a.domain IS NOT NULL
      AND a.domain <> ''
    GROUP BY lower(a.domain)
  )
  SELECT
    n.domain,
    GREATEST(COALESCE(pc.cnt, 0), COALESCE(ac.cnt, 0)) AS connection_count
  FROM normalized n
  LEFT JOIN profile_counts pc ON pc.domain = n.domain
  LEFT JOIN actor_counts ac ON ac.domain = n.domain;
$$;

COMMENT ON FUNCTION public.get_federated_instance_connection_counts(text[])
IS 'Count known remote actors per instance domain (max of profiles and ap_actor_cache).';

GRANT EXECUTE ON FUNCTION public.get_federated_instance_connection_counts(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_federated_instance_connection_counts(text[]) TO service_role;

-- =============================================================================
DO $$
BEGIN
    RAISE NOTICE 'Federation helper functions created successfully';
END $$;

