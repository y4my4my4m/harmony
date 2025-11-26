-- =====================================================
-- RESET USER ENCRYPTION
-- Safely delete all encryption keys for a user to allow re-initialization
-- =====================================================

-- Function to completely reset a user's encryption keys
CREATE OR REPLACE FUNCTION public.reset_user_encryption(
    p_user_id UUID,
    p_device_id TEXT DEFAULT 'default'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_deleted_keys INTEGER := 0;
    v_deleted_prekeys INTEGER := 0;
    v_deleted_sessions INTEGER := 0;
    v_result JSONB;
BEGIN
    -- Only allow users to reset their own encryption
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot reset encryption for another user';
    END IF;
    
    -- Delete all prekeys (both signed and one-time)
    DELETE FROM public.prekeys
    WHERE user_id = p_user_id
    AND device_id = p_device_id;
    GET DIAGNOSTICS v_deleted_prekeys = ROW_COUNT;
    
    -- Delete encryption sessions (where user is either party)
    DELETE FROM public.encryption_sessions
    WHERE local_user_id = p_user_id
    OR remote_user_id = p_user_id;
    GET DIAGNOSTICS v_deleted_sessions = ROW_COUNT;
    
    -- Delete all key pairs (this allows re-initialization)
    DELETE FROM public.user_key_pairs
    WHERE user_id = p_user_id
    AND device_id = p_device_id;
    GET DIAGNOSTICS v_deleted_keys = ROW_COUNT;
    
    -- Log the reset (using 'encryption_disabled' as it's the closest valid event type)
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'encryption_disabled',
        'warning',
        'User encryption keys completely reset',
        jsonb_build_object(
            'device_id', p_device_id,
            'deleted_keys', v_deleted_keys,
            'deleted_prekeys', v_deleted_prekeys,
            'deleted_sessions', v_deleted_sessions,
            'reset_type', 'full_reset',
            'reset_at', NOW()
        )
    );
    
    v_result := jsonb_build_object(
        'success', true,
        'deleted_keys', v_deleted_keys,
        'deleted_prekeys', v_deleted_prekeys,
        'deleted_sessions', v_deleted_sessions,
        'message', 'Encryption has been reset. You can now set up encryption again.'
    );
    
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.reset_user_encryption IS 'Completely reset a user''s encryption keys. Deletes all key pairs, prekeys, and sessions. Allows re-initialization.';

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.reset_user_encryption TO authenticated;

