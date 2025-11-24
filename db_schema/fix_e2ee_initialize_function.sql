-- Fix initialize_user_encryption function to return proper JSONB

CREATE OR REPLACE FUNCTION public.initialize_user_encryption(
    p_user_id UUID,
    p_identity_public_key TEXT,
    p_identity_private_key_encrypted TEXT,
    p_device_id TEXT DEFAULT 'default'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_key_pair_id UUID;
BEGIN
    -- Only allow users to initialize their own encryption
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot initialize encryption for another user';
    END IF;
    
    -- Check if user already has keys
    IF EXISTS (
        SELECT 1 FROM public.user_key_pairs
        WHERE user_id = p_user_id AND device_id = p_device_id
    ) THEN
        RAISE EXCEPTION 'User already has encryption keys initialized';
    END IF;
    
    -- Insert identity key pair
    INSERT INTO public.user_key_pairs (
        user_id,
        device_id,
        identity_public_key,
        identity_private_key_encrypted,
        key_version,
        is_active
    ) VALUES (
        p_user_id,
        p_device_id,
        p_identity_public_key,
        p_identity_private_key_encrypted,
        1,
        true
    ) RETURNING id INTO v_key_pair_id;
    
    -- Log initialization
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'key_generated',
        'info',
        'User encryption initialized',
        jsonb_build_object(
            'device_id', p_device_id,
            'key_pair_id', v_key_pair_id
        )
    );
    
    RETURN jsonb_build_object(
        'success', true,
        'key_pair_id', v_key_pair_id,
        'device_id', p_device_id
    );
END;
$$;

COMMENT ON FUNCTION public.initialize_user_encryption IS 'Initialize encryption for a new user. Creates identity key pair. Returns JSONB with success status and key_pair_id.';

