-- =====================================================
-- E2EE HELPER FUNCTIONS AND PROCEDURES
-- Signal Protocol Support Functions for Harmony
-- =====================================================

-- =====================================================
-- 1. PREKEY BUNDLE RETRIEVAL
-- Get all necessary public keys for establishing a session
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_user_prekey_bundle(
    p_user_id UUID,
    p_device_id TEXT DEFAULT 'default'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_identity_key TEXT;
    v_signed_prekey JSONB;
    v_one_time_prekey JSONB;
    v_result JSONB;
BEGIN
    -- Get identity public key
    SELECT identity_public_key INTO v_identity_key
    FROM public.user_key_pairs
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_active = true
    ORDER BY key_version DESC
    LIMIT 1;
    
    IF v_identity_key IS NULL THEN
        RAISE EXCEPTION 'No identity key found for user % device %', p_user_id, p_device_id;
    END IF;
    
    -- Get signed prekey
    SELECT jsonb_build_object(
        'id', prekey_id,
        'public_key', public_key,
        'signature', signature
    ) INTO v_signed_prekey
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_signed = true
        AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Get and mark one-time prekey as used
    SELECT jsonb_build_object(
        'id', prekey_id,
        'public_key', public_key
    ) INTO v_one_time_prekey
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false
        AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    
    -- Mark the one-time prekey as used
    IF v_one_time_prekey IS NOT NULL THEN
        UPDATE public.prekeys
        SET 
            is_used = true,
            used_at = NOW(),
            used_by = auth.uid()
        WHERE user_id = p_user_id
            AND device_id = p_device_id
            AND prekey_id = (v_one_time_prekey->>'id')::INTEGER;
    END IF;
    
    -- Build result bundle
    v_result := jsonb_build_object(
        'user_id', p_user_id,
        'device_id', p_device_id,
        'identity_key', v_identity_key,
        'signed_prekey', v_signed_prekey,
        'one_time_prekey', v_one_time_prekey,
        'retrieved_at', NOW()
    );
    
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_user_prekey_bundle IS 'Retrieve a complete prekey bundle for establishing an encrypted session. Atomically marks one-time prekey as used.';

-- =====================================================
-- 2. PREKEY ROTATION
-- Rotate prekeys for a user (generate new prekeys)
-- =====================================================

CREATE OR REPLACE FUNCTION public.rotate_prekeys(
    p_user_id UUID,
    p_device_id TEXT DEFAULT 'default'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_deleted_count INTEGER;
    v_remaining_count INTEGER;
    v_result JSONB;
BEGIN
    -- Only allow users to rotate their own prekeys
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot rotate prekeys for another user';
    END IF;
    
    -- Delete used one-time prekeys older than 30 days
    DELETE FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = true
        AND used_at < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    
    -- Mark expired signed prekeys as inactive
    UPDATE public.prekeys
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{expired}', 'true')
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_signed = true
        AND expires_at IS NOT NULL
        AND expires_at < NOW();
    
    -- Count remaining unused one-time prekeys
    SELECT COUNT(*) INTO v_remaining_count
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false;
    
    v_result := jsonb_build_object(
        'deleted_used_prekeys', v_deleted_count,
        'remaining_unused_prekeys', v_remaining_count,
        'rotation_completed_at', NOW()
    );
    
    -- Log the rotation
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'key_rotated',
        'info',
        'Prekey rotation completed',
        v_result
    );
    
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.rotate_prekeys IS 'Rotate prekeys for a user: clean up used prekeys and expire old signed prekeys.';

-- =====================================================
-- 3. CHECK ENCRYPTION POLICY
-- Check if a server requires E2EE
-- =====================================================

CREATE OR REPLACE FUNCTION public.check_encryption_policy(
    p_server_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_settings public.server_encryption_settings;
    v_result JSONB;
BEGIN
    SELECT * INTO v_settings
    FROM public.server_encryption_settings
    WHERE server_id = p_server_id;
    
    -- If no settings exist, default to optional
    IF v_settings IS NULL THEN
        v_result := jsonb_build_object(
            'encryption_mode', 'optional',
            'allow_federation', true,
            'require_verified_devices', false,
            'is_encrypted', false
        );
    ELSE
        v_result := jsonb_build_object(
            'encryption_mode', v_settings.encryption_mode,
            'allow_federation', v_settings.allow_federation,
            'require_verified_devices', v_settings.require_verified_devices,
            'is_encrypted', v_settings.encryption_mode IN ('required', 'required_local_only')
        );
    END IF;
    
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.check_encryption_policy IS 'Get encryption policy for a server. Returns default values if no policy is set.';

-- =====================================================
-- 4. INITIALIZE USER ENCRYPTION
-- Set up initial encryption for a new user
-- =====================================================

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

COMMENT ON FUNCTION public.initialize_user_encryption IS 'Initialize encryption for a new user. Creates identity key pair.';

-- =====================================================
-- 5. ADD PREKEYS
-- Batch add prekeys for a user
-- =====================================================

CREATE OR REPLACE FUNCTION public.add_user_prekeys(
    p_user_id UUID,
    p_device_id TEXT,
    p_prekeys JSONB -- Array of {prekey_id, public_key, is_signed, signature}
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_prekey JSONB;
    v_inserted_count INTEGER := 0;
BEGIN
    -- Only allow users to add their own prekeys
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot add prekeys for another user';
    END IF;
    
    -- Insert each prekey
    FOR v_prekey IN SELECT * FROM jsonb_array_elements(p_prekeys)
    LOOP
        INSERT INTO public.prekeys (
            user_id,
            device_id,
            prekey_id,
            public_key,
            is_signed,
            signature,
            is_one_time,
            expires_at
        ) VALUES (
            p_user_id,
            p_device_id,
            (v_prekey->>'prekey_id')::INTEGER,
            v_prekey->>'public_key',
            COALESCE((v_prekey->>'is_signed')::BOOLEAN, false),
            v_prekey->>'signature',
            NOT COALESCE((v_prekey->>'is_signed')::BOOLEAN, false),
            CASE 
                WHEN COALESCE((v_prekey->>'is_signed')::BOOLEAN, false) 
                THEN NOW() + INTERVAL '90 days'
                ELSE NULL
            END
        ) ON CONFLICT (user_id, device_id, prekey_id) DO NOTHING;
        
        v_inserted_count := v_inserted_count + 1;
    END LOOP;
    
    RETURN v_inserted_count;
END;
$$;

COMMENT ON FUNCTION public.add_user_prekeys IS 'Batch add prekeys for a user. Accepts array of prekey objects.';

-- =====================================================
-- 6. GET OR CREATE ENCRYPTION SESSION
-- Get existing session or return null to indicate new session needed
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_encryption_session(
    p_local_user_id UUID,
    p_remote_user_id UUID,
    p_local_device_id TEXT DEFAULT 'default',
    p_remote_device_id TEXT DEFAULT 'default'
)
RETURNS public.encryption_sessions
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_session public.encryption_sessions;
BEGIN
    -- Only allow users to get their own sessions
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_local_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot access sessions for another user';
    END IF;
    
    SELECT * INTO v_session
    FROM public.encryption_sessions
    WHERE local_user_id = p_local_user_id
        AND local_device_id = p_local_device_id
        AND remote_user_id = p_remote_user_id
        AND remote_device_id = p_remote_device_id;
    
    -- Update last_used_at if session exists
    IF v_session IS NOT NULL THEN
        UPDATE public.encryption_sessions
        SET last_used_at = NOW()
        WHERE id = v_session.id;
    END IF;
    
    RETURN v_session;
END;
$$;

COMMENT ON FUNCTION public.get_encryption_session IS 'Get existing encryption session between two users.';

-- =====================================================
-- 7. SAVE ENCRYPTION SESSION
-- Save or update an encryption session
-- =====================================================

CREATE OR REPLACE FUNCTION public.save_encryption_session(
    p_local_user_id UUID,
    p_remote_user_id UUID,
    p_session_state TEXT,
    p_local_device_id TEXT DEFAULT 'default',
    p_remote_device_id TEXT DEFAULT 'default'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_session_id UUID;
BEGIN
    -- Only allow users to save their own sessions
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_local_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot save sessions for another user';
    END IF;
    
    INSERT INTO public.encryption_sessions (
        local_user_id,
        local_device_id,
        remote_user_id,
        remote_device_id,
        session_state,
        established_at,
        last_used_at
    ) VALUES (
        p_local_user_id,
        p_local_device_id,
        p_remote_user_id,
        p_remote_device_id,
        p_session_state,
        NOW(),
        NOW()
    )
    ON CONFLICT (local_user_id, local_device_id, remote_user_id, remote_device_id)
    DO UPDATE SET
        session_state = EXCLUDED.session_state,
        last_used_at = NOW()
    RETURNING id INTO v_session_id;
    
    -- Log session establishment/update
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        related_user_id,
        metadata
    ) VALUES (
        p_local_user_id,
        'session_established',
        'info',
        'Encryption session saved',
        p_remote_user_id,
        jsonb_build_object(
            'session_id', v_session_id,
            'local_device', p_local_device_id,
            'remote_device', p_remote_device_id
        )
    );
    
    RETURN v_session_id;
END;
$$;

COMMENT ON FUNCTION public.save_encryption_session IS 'Save or update an encryption session. Creates new session or updates existing.';

-- =====================================================
-- 8. GET LOW PREKEY COUNT USERS
-- Find users who need to generate more prekeys
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_users_needing_prekeys(
    p_threshold INTEGER DEFAULT 10
)
RETURNS TABLE (
    user_id UUID,
    device_id TEXT,
    unused_prekey_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        kp.user_id,
        kp.device_id,
        COUNT(pk.id) as unused_prekey_count
    FROM public.user_key_pairs kp
    LEFT JOIN public.prekeys pk ON 
        pk.user_id = kp.user_id 
        AND pk.device_id = kp.device_id
        AND pk.is_one_time = true
        AND pk.is_used = false
    WHERE kp.is_active = true
    GROUP BY kp.user_id, kp.device_id
    HAVING COUNT(pk.id) < p_threshold
    ORDER BY COUNT(pk.id) ASC;
END;
$$;

COMMENT ON FUNCTION public.get_users_needing_prekeys IS 'Get list of users who have fewer than threshold unused one-time prekeys.';

-- =====================================================
-- 9. CHECK IF USER HAS ENCRYPTION ENABLED
-- Check if a user has encryption keys set up
-- =====================================================

CREATE OR REPLACE FUNCTION public.user_has_encryption(
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.user_key_pairs
        WHERE user_id = p_user_id
        AND is_active = true
    );
END;
$$;

COMMENT ON FUNCTION public.user_has_encryption IS 'Check if a user has encryption keys initialized.';

-- =====================================================
-- 10. GET CONVERSATION ENCRYPTION STATUS
-- Get encryption status for a conversation
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_conversation_encryption_status(
    p_conversation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_settings public.conversation_encryption_settings;
    v_all_users_encrypted BOOLEAN;
    v_participant_ids UUID[];
    v_result JSONB;
BEGIN
    -- Get conversation encryption settings
    SELECT * INTO v_settings
    FROM public.conversation_encryption_settings
    WHERE conversation_id = p_conversation_id;
    
    -- Get all participant IDs
    SELECT ARRAY_AGG(user_id) INTO v_participant_ids
    FROM public.conversation_participants
    WHERE conversation_id = p_conversation_id;
    
    -- Check if all participants have encryption enabled
    SELECT bool_and(public.user_has_encryption(user_id)) INTO v_all_users_encrypted
    FROM unnest(v_participant_ids) as user_id;
    
    v_result := jsonb_build_object(
        'conversation_id', p_conversation_id,
        'encryption_enabled', COALESCE(v_settings.encryption_enabled, false),
        'verified', COALESCE(v_settings.verified, false),
        'all_users_have_keys', COALESCE(v_all_users_encrypted, false),
        'participant_count', COALESCE(array_length(v_participant_ids, 1), 0),
        'can_enable_encryption', COALESCE(v_all_users_encrypted, false)
    );
    
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_conversation_encryption_status IS 'Get encryption status and capabilities for a conversation.';

-- =====================================================
-- 11. ENABLE CONVERSATION ENCRYPTION
-- Enable E2EE for a conversation
-- =====================================================

CREATE OR REPLACE FUNCTION public.enable_conversation_encryption(
    p_conversation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_status JSONB;
    v_result JSONB;
BEGIN
    -- Check if caller is a participant
    IF NOT EXISTS (
        SELECT 1 FROM public.conversation_participants
        JOIN public.profiles ON profiles.id = conversation_participants.user_id
        WHERE conversation_participants.conversation_id = p_conversation_id
        AND profiles.auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Not a participant of this conversation';
    END IF;
    
    -- Get current status
    v_status := public.get_conversation_encryption_status(p_conversation_id);
    
    -- Check if all users have encryption keys
    IF NOT (v_status->>'all_users_have_keys')::BOOLEAN THEN
        RAISE EXCEPTION 'Cannot enable encryption: Not all participants have encryption keys';
    END IF;
    
    -- Enable encryption
    INSERT INTO public.conversation_encryption_settings (
        conversation_id,
        encryption_enabled,
        verified
    ) VALUES (
        p_conversation_id,
        true,
        false
    )
    ON CONFLICT (conversation_id)
    DO UPDATE SET
        encryption_enabled = true,
        updated_at = NOW();
    
    -- Log the action
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        related_conversation_id,
        metadata
    ) VALUES (
        (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid()),
        'encryption_enabled',
        'info',
        'Conversation encryption enabled',
        p_conversation_id,
        v_status
    );
    
    v_result := jsonb_build_object(
        'success', true,
        'conversation_id', p_conversation_id,
        'enabled_at', NOW()
    );
    
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.enable_conversation_encryption IS 'Enable E2EE for a conversation. All participants must have encryption keys.';

-- =====================================================
-- GRANTS
-- =====================================================

GRANT EXECUTE ON FUNCTION public.get_user_prekey_bundle TO authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_prekeys TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_encryption_policy TO authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_user_encryption TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_user_prekeys TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_encryption_session TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_encryption_session TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_encryption TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_conversation_encryption_status TO authenticated;
GRANT EXECUTE ON FUNCTION public.enable_conversation_encryption TO authenticated;

-- =====================================================
-- COMPLETED: E2EE Functions
-- =====================================================

