-- Migration 025: Fix instance config access for public federation settings
-- 
-- ISSUE: Frontend getting 406 errors when trying to access instance_config
--        Only admin access is allowed but some configs need to be public
-- FIX: Create public functions for accessing non-sensitive config values

BEGIN;

-- =====================================================
-- STEP 1: Create public function for federation settings
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_public_federation_settings()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    federation_settings jsonb;
BEGIN
    -- Get federation settings from instance_config
    SELECT config_value INTO federation_settings
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    -- Return safe subset of federation settings (no sensitive data)
    IF federation_settings IS NULL THEN
        RETURN jsonb_build_object(
            'federation_enabled', true,
            'federation_auto_accept_follows', true
        );
    END IF;
    
    -- Return only public federation settings
    RETURN jsonb_build_object(
        'federation_enabled', COALESCE((federation_settings->>'federation_enabled')::boolean, true),
        'federation_auto_accept_follows', COALESCE((federation_settings->>'federation_auto_accept_follows')::boolean, true)
    );
END;
$$;

COMMENT ON FUNCTION public.get_public_federation_settings() IS 'Get public federation settings accessible to all users';

-- =====================================================
-- STEP 2: Create public function for instance domain
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_instance_domain()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    domain_value text;
BEGIN
    -- Get domain from instance_config
    SELECT trim(both '"' from config_value::text) INTO domain_value
    FROM instance_config 
    WHERE config_key = 'domain';
    
    -- Return domain or fallback
    RETURN COALESCE(domain_value, 'localhost');
END;
$$;

COMMENT ON FUNCTION public.get_instance_domain() IS 'Get instance domain accessible to all users';

-- =====================================================
-- STEP 3: Create public function for basic instance info
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_public_instance_info()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    instance_name text;
    instance_description text;
    domain_value text;
    open_registration boolean;
    approval_required boolean;
BEGIN
    -- Get various config values
    SELECT trim(both '"' from config_value::text) INTO instance_name
    FROM instance_config WHERE config_key = 'instance_name';
    
    SELECT trim(both '"' from config_value::text) INTO instance_description
    FROM instance_config WHERE config_key = 'instance_description';
    
    SELECT trim(both '"' from config_value::text) INTO domain_value
    FROM instance_config WHERE config_key = 'domain';
    
    SELECT (config_value)::boolean INTO open_registration
    FROM instance_config WHERE config_key = 'open_registration';
    
    SELECT (config_value)::boolean INTO approval_required
    FROM instance_config WHERE config_key = 'approval_required';
    
    -- Return public instance information
    RETURN jsonb_build_object(
        'name', COALESCE(instance_name, 'Harmony Instance'),
        'description', COALESCE(instance_description, 'A federated social platform'),
        'domain', COALESCE(domain_value, 'localhost'),
        'open_registration', COALESCE(open_registration, true),
        'approval_required', COALESCE(approval_required, false)
    );
END;
$$;

COMMENT ON FUNCTION public.get_public_instance_info() IS 'Get public instance information accessible to all users';

-- =====================================================
-- STEP 4: Grant execute permissions to public
-- =====================================================

GRANT EXECUTE ON FUNCTION public.get_public_federation_settings() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_instance_domain() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_instance_info() TO anon, authenticated;

-- =====================================================
-- STEP 5: Create RLS policy for public read access to specific configs
-- =====================================================

-- Alternative approach: Allow public read access to specific config keys
-- This is more direct but less secure than the function approach above

DROP POLICY IF EXISTS "Public can read federation settings" ON instance_config;
CREATE POLICY "Public can read federation settings" ON instance_config
FOR SELECT 
USING (config_key IN ('federation_settings', 'domain', 'instance_name', 'instance_description', 'open_registration', 'approval_required'));

COMMIT; 