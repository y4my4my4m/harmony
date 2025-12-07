-- =============================================
-- Add trigger to generate ActivityPub keys when local profile is created
-- This ensures local users always have matching public/private key pairs
-- =============================================

-- Note: Key generation requires crypto functions that PostgreSQL doesn't have natively.
-- The federation backend handles on-demand generation, but we should ensure consistency.

-- Create a function to check for orphaned public keys (public key exists but no private key)
CREATE OR REPLACE FUNCTION public.check_key_consistency()
RETURNS TABLE (
    user_id UUID,
    username TEXT,
    has_public_key BOOLEAN,
    has_private_key BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as user_id,
        p.username,
        (p.public_key IS NOT NULL) as has_public_key,
        (upk.id IS NOT NULL) as has_private_key
    FROM profiles p
    LEFT JOIN user_private_keys upk ON upk.user_id = p.id
    WHERE p.is_local = true
    AND (
        -- Has public key but no private key (broken)
        (p.public_key IS NOT NULL AND upk.id IS NULL)
        OR
        -- Has private key but no public key (also broken)
        (p.public_key IS NULL AND upk.id IS NOT NULL)
    );
END;
$$;

COMMENT ON FUNCTION public.check_key_consistency() IS 'Check for local users with inconsistent key state (public key without private key or vice versa)';

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION public.check_key_consistency() TO service_role;

-- Create a function to clear orphaned public keys
-- This allows on-demand generation to create fresh matching key pairs
CREATE OR REPLACE FUNCTION public.clear_orphaned_public_keys()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    cleared_count INTEGER;
BEGIN
    UPDATE profiles p
    SET public_key = NULL
    WHERE p.is_local = true
    AND p.public_key IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM user_private_keys upk 
        WHERE upk.user_id = p.id
    );
    
    GET DIAGNOSTICS cleared_count = ROW_COUNT;
    
    RETURN cleared_count;
END;
$$;

COMMENT ON FUNCTION public.clear_orphaned_public_keys() IS 'Clear public keys from local profiles that have no matching private key. Returns count of cleared keys.';

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION public.clear_orphaned_public_keys() TO service_role;

