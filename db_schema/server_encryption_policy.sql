-- =====================================================
-- SERVER ENCRYPTION POLICY - HELPER FUNCTION
-- Adds get_server_encryption_policy function
-- Run AFTER repair_server_encryption_settings.sql
-- =====================================================

-- NOTE: Table should already exist from repair_server_encryption_settings.sql
-- This file only adds/updates the helper function

-- =====================================================
-- DROP EXISTING FUNCTION (if exists with different signature)
-- =====================================================

-- Drop any existing version of the function
DROP FUNCTION IF EXISTS public.get_server_encryption_policy(UUID);

-- =====================================================
-- CREATE HELPER FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_server_encryption_policy(
  p_server_id UUID
)
RETURNS TABLE (
  encryption_mode TEXT,
  allow_federation BOOLEAN,
  require_verified_devices BOOLEAN,
  force_key_setup BOOLEAN,
  encrypt_attachments BOOLEAN,
  is_encrypted BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(ses.encryption_mode, 'optional') as encryption_mode,
    COALESCE(ses.allow_federation, true) as allow_federation,
    COALESCE(ses.require_verified_devices, false) as require_verified_devices,
    COALESCE(ses.force_key_setup, false) as force_key_setup,
    COALESCE(ses.encrypt_attachments, true) as encrypt_attachments,
    COALESCE(ses.encryption_mode, 'optional') IN ('required', 'required_local_only') as is_encrypted
  FROM public.server_encryption_settings ses
  WHERE ses.server_id = p_server_id
  UNION ALL
  SELECT 
    'optional' as encryption_mode,
    true as allow_federation,
    false as require_verified_devices,
    false as force_key_setup,
    true as encrypt_attachments,
    false as is_encrypted
  WHERE NOT EXISTS (
    SELECT 1 FROM public.server_encryption_settings
    WHERE server_id = p_server_id
  )
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.get_server_encryption_policy IS 
  'Get complete encryption policy for a server. Returns defaults if not set. Includes all policy columns (original + new).';

GRANT EXECUTE ON FUNCTION public.get_server_encryption_policy TO authenticated;

-- =====================================================
-- VERIFY FUNCTION
-- =====================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc 
    WHERE proname = 'get_server_encryption_policy'
  ) THEN
    RAISE NOTICE '✅ Helper function created successfully';
    RAISE NOTICE '   Function: get_server_encryption_policy(uuid)';
    RAISE NOTICE '   Returns: encryption_mode, allow_federation, require_verified_devices, force_key_setup, encrypt_attachments, is_encrypted';
  ELSE
    RAISE EXCEPTION '❌ Failed to create helper function';
  END IF;
END
$$;

-- =====================================================
-- FUNCTION COMPLETE
-- =====================================================
-- This function provides a convenient way to get server encryption policy
-- with sensible defaults if no policy has been set.
-- 
-- Usage in code:
-- const { data: policy } = await supabase
--   .rpc('get_server_encryption_policy', { p_server_id: serverId })
-- 
-- Returns all policy fields including the new ones:
-- - force_key_setup
-- - encrypt_attachments
-- =====================================================
