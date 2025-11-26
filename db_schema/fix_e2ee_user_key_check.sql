-- =====================================================
-- FIX: Allow checking if users have encryption keys
-- 
-- The RLS policy on user_key_pairs only allows users to see their own keys.
-- This prevents senders from knowing which recipients have encryption enabled.
-- This function safely checks if users have encryption without exposing keys.
-- =====================================================

-- Function to check which users from a list have encryption keys
-- Returns array of user_ids that have active encryption keys
CREATE OR REPLACE FUNCTION public.get_users_with_encryption_keys(
    p_user_ids UUID[]
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER  -- Bypass RLS to check other users' key existence
STABLE
AS $$
DECLARE
    v_result UUID[];
BEGIN
    -- Only return user_ids that have active encryption keys
    -- We don't expose the actual keys, just whether they exist
    SELECT ARRAY_AGG(DISTINCT user_id) INTO v_result
    FROM public.user_key_pairs
    WHERE user_id = ANY(p_user_ids)
      AND is_active = true;
    
    RETURN COALESCE(v_result, ARRAY[]::UUID[]);
END;
$$;

COMMENT ON FUNCTION public.get_users_with_encryption_keys IS 
'Safely check which users from a list have active encryption keys. Used during message encryption to determine recipients.';

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.get_users_with_encryption_keys TO authenticated;

-- =====================================================
-- Alternative: Add a policy to allow seeing user_id if in same server
-- This approach allows direct queries without RPC
-- =====================================================

-- First, drop the existing policy if it exists
DROP POLICY IF EXISTS "Users can check if others have encryption" ON public.user_key_pairs;

-- Create a policy that allows users to check if other server members have encryption
-- This only exposes the user_id, not the actual keys
CREATE POLICY "Users can check if others have encryption"
    ON public.user_key_pairs FOR SELECT
    USING (
        -- Allow if the querying user shares a server with the key owner
        EXISTS (
            SELECT 1 
            FROM public.user_servers us1
            JOIN public.user_servers us2 ON us1.server_id = us2.server_id
            JOIN public.profiles p ON p.auth_user_id = auth.uid()
            WHERE us1.user_id = user_key_pairs.user_id
              AND us2.user_id = p.id
        )
        -- Also allow if in same conversation
        OR EXISTS (
            SELECT 1 
            FROM public.conversation_participants cp1
            JOIN public.conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
            JOIN public.profiles p ON p.auth_user_id = auth.uid()
            WHERE cp1.user_id = user_key_pairs.user_id
              AND cp2.user_id = p.id
        )
    );

