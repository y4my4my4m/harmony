-- =============================================================================
-- Migration: Add update_federation_settings RPC
-- =============================================================================
-- Creates update_federation_settings function for federation config (missing from
-- deployments that predate init/90_federation_functions.sql).
-- =============================================================================

BEGIN;

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
    IF current_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM profiles p
        WHERE p.auth_user_id = current_auth_uid 
        AND p.is_admin = true
    ) INTO v_is_admin;
    
    IF NOT v_is_admin THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required';
    END IF;
    
    SELECT COALESCE(config_value::jsonb, '{}'::jsonb) INTO current_settings
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    IF current_settings IS NULL THEN
        current_settings := '{}'::jsonb;
    END IF;
    
    new_settings := current_settings;
    
    IF p_federation_enabled IS NOT NULL THEN
        new_settings := new_settings || jsonb_build_object('federation_enabled', p_federation_enabled);
    END IF;
    
    IF p_inbound_enabled IS NOT NULL THEN
        new_settings := new_settings || jsonb_build_object('enable_inbound_federation', p_inbound_enabled);
        INSERT INTO instance_config (config_key, config_value, updated_at)
        VALUES ('enable_inbound_federation', to_jsonb(p_inbound_enabled), now())
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = now();
    END IF;
    
    IF p_outbound_enabled IS NOT NULL THEN
        new_settings := new_settings || jsonb_build_object('enable_outbound_federation', p_outbound_enabled);
        INSERT INTO instance_config (config_key, config_value, updated_at)
        VALUES ('enable_outbound_federation', to_jsonb(p_outbound_enabled), now())
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = now();
    END IF;
    
    IF p_auto_accept_follows IS NOT NULL THEN
        new_settings := new_settings || jsonb_build_object('federation_auto_accept_follows', p_auto_accept_follows);
    END IF;
    
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

NOTIFY pgrst, 'reload schema';

COMMIT;
