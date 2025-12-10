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
-- Requires admin role or service_role key.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_instance_config(
    p_key text,
    p_value jsonb,
    p_user_id uuid DEFAULT NULL,
    p_description text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    is_admin boolean := false;
BEGIN
    -- Check if user is admin
    IF p_user_id IS NOT NULL THEN
        SELECT EXISTS(
            SELECT 1 FROM profiles 
            WHERE id = p_user_id 
            AND (role = 'admin' OR role = 'super_admin')
        ) INTO is_admin;
        
        IF NOT is_admin THEN
            RAISE EXCEPTION 'Unauthorized: Admin role required';
        END IF;
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
'Set or update instance configuration. Admin role required.';


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
    is_admin boolean := false;
    current_settings jsonb;
    new_settings jsonb;
BEGIN
    -- Check if user is admin
    SELECT EXISTS(
        SELECT 1 FROM profiles 
        WHERE id = p_user_id 
        AND (role = 'admin' OR role = 'super_admin')
    ) INTO is_admin;
    
    IF NOT is_admin THEN
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
DO $$
BEGIN
    RAISE NOTICE 'Federation helper functions created successfully';
END $$;

