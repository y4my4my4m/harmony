-- =====================================================
-- END-TO-END ENCRYPTION (E2EE) SCHEMA
-- Signal Protocol Implementation for Harmony
-- =====================================================

-- =====================================================
-- 1. USER KEY PAIRS
-- Store Signal Protocol identity keys per user
-- Designed for per-user keys with future per-device migration support
-- =====================================================

CREATE TABLE IF NOT EXISTS public.user_key_pairs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id TEXT DEFAULT 'default', -- For future per-device support
    
    -- Signal Protocol Keys (stored as base64)
    identity_public_key TEXT NOT NULL,
    identity_private_key_encrypted TEXT NOT NULL, -- Encrypted with user's password-derived key
    
    -- Key versioning
    key_version INTEGER DEFAULT 1 NOT NULL,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_used_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ, -- Optional key expiration
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb,
    
    UNIQUE(user_id, device_id, key_version),
    CONSTRAINT valid_device_id CHECK (char_length(device_id) <= 255)
);

CREATE INDEX idx_user_key_pairs_user_id ON public.user_key_pairs(user_id);
CREATE INDEX idx_user_key_pairs_active ON public.user_key_pairs(user_id, is_active) WHERE is_active = true;

COMMENT ON TABLE public.user_key_pairs IS 'Signal Protocol identity key pairs per user. Supports future per-device migration.';
COMMENT ON COLUMN public.user_key_pairs.device_id IS 'Device identifier. Default "default" for per-user keys, unique device ID for per-device keys.';
COMMENT ON COLUMN public.user_key_pairs.identity_private_key_encrypted IS 'Private key encrypted with user password-derived key. NEVER sent to client in plaintext.';

-- =====================================================
-- 2. PREKEYS
-- Signal Protocol prekey bundles for asynchronous key exchange
-- =====================================================

CREATE TABLE IF NOT EXISTS public.prekeys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id TEXT DEFAULT 'default',
    
    -- Prekey data
    prekey_id INTEGER NOT NULL,
    public_key TEXT NOT NULL, -- Base64 encoded public key
    
    -- Signed prekey specific fields
    is_signed BOOLEAN DEFAULT false,
    signature TEXT, -- Signature if this is a signed prekey
    
    -- One-time prekey specific
    is_one_time BOOLEAN DEFAULT true,
    is_used BOOLEAN DEFAULT false,
    used_at TIMESTAMPTZ,
    used_by UUID REFERENCES auth.users(id), -- Who used this one-time prekey
    
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    expires_at TIMESTAMPTZ,
    
    UNIQUE(user_id, device_id, prekey_id),
    CONSTRAINT valid_prekey_id CHECK (prekey_id >= 0)
);

CREATE INDEX idx_prekeys_user_device ON public.prekeys(user_id, device_id);
CREATE INDEX idx_prekeys_unused ON public.prekeys(user_id, device_id, is_used) WHERE is_used = false AND is_one_time = true;
CREATE INDEX idx_prekeys_signed ON public.prekeys(user_id, device_id, is_signed) WHERE is_signed = true;

COMMENT ON TABLE public.prekeys IS 'Signal Protocol prekeys for asynchronous message encryption. Includes signed prekeys and one-time prekeys.';
COMMENT ON COLUMN public.prekeys.is_one_time IS 'One-time prekeys are used once and marked as used. Signed prekeys can be reused.';

-- =====================================================
-- 3. ENCRYPTION SESSIONS
-- Signal Protocol session state between users
-- =====================================================

CREATE TABLE IF NOT EXISTS public.encryption_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Session participants
    local_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    local_device_id TEXT DEFAULT 'default',
    remote_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    remote_device_id TEXT DEFAULT 'default',
    
    -- Session state (stored as base64 serialized session)
    session_state TEXT NOT NULL,
    
    -- Session metadata
    established_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_used_at TIMESTAMPTZ DEFAULT NOW(),
    message_count INTEGER DEFAULT 0, -- Number of messages encrypted with this session
    
    -- For session rotation
    needs_refresh BOOLEAN DEFAULT false,
    
    metadata JSONB DEFAULT '{}'::jsonb,
    
    UNIQUE(local_user_id, local_device_id, remote_user_id, remote_device_id)
);

CREATE INDEX idx_encryption_sessions_local ON public.encryption_sessions(local_user_id, local_device_id);
CREATE INDEX idx_encryption_sessions_remote ON public.encryption_sessions(remote_user_id, remote_device_id);
CREATE INDEX idx_encryption_sessions_needs_refresh ON public.encryption_sessions(needs_refresh) WHERE needs_refresh = true;

COMMENT ON TABLE public.encryption_sessions IS 'Signal Protocol session state for message encryption between users.';
COMMENT ON COLUMN public.encryption_sessions.session_state IS 'Serialized Signal Protocol session state. Stored encrypted.';
COMMENT ON COLUMN public.encryption_sessions.message_count IS 'Track message count for automatic session rotation.';

-- =====================================================
-- 4. SERVER ENCRYPTION SETTINGS
-- Per-server E2EE enforcement policies
-- =====================================================

CREATE TABLE IF NOT EXISTS public.server_encryption_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL UNIQUE REFERENCES public.servers(id) ON DELETE CASCADE,
    
    -- Encryption policy
    encryption_mode TEXT DEFAULT 'optional' CHECK (encryption_mode IN ('disabled', 'optional', 'required', 'required_local_only')),
    
    -- Policy details
    allow_federation BOOLEAN DEFAULT true, -- If false and encryption_mode='required', blocks federation
    require_verified_devices BOOLEAN DEFAULT false, -- Future: require device verification
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID REFERENCES auth.users(id),
    
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_server_encryption_server_id ON public.server_encryption_settings(server_id);

COMMENT ON TABLE public.server_encryption_settings IS 'Per-server E2EE enforcement policies. Server owners control encryption requirements.';
COMMENT ON COLUMN public.server_encryption_settings.encryption_mode IS 'disabled: No E2EE. optional: User choice. required: All messages encrypted. required_local_only: E2EE required, federation disabled.';

-- =====================================================
-- 5. MESSAGE SCHEMA UPDATES
-- Add encryption fields to existing messages table
-- =====================================================

ALTER TABLE public.messages 
    ADD COLUMN IF NOT EXISTS encrypted BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS encryption_metadata JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_encrypted ON public.messages(encrypted) WHERE encrypted = true;

COMMENT ON COLUMN public.messages.encrypted IS 'Whether this message is end-to-end encrypted.';
COMMENT ON COLUMN public.messages.encryption_metadata IS 'Encryption details: algorithm_version, sender_key_id, recipient_key_ids, etc.';

-- =====================================================
-- 6. CONVERSATION ENCRYPTION SETTINGS
-- Track E2EE status per conversation (DMs/Groups)
-- =====================================================

CREATE TABLE IF NOT EXISTS public.conversation_encryption_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL UNIQUE REFERENCES public.conversations(id) ON DELETE CASCADE,
    
    -- Encryption status
    encryption_enabled BOOLEAN DEFAULT false,
    verified BOOLEAN DEFAULT false, -- All participants have verified keys
    
    -- Key rotation
    last_key_rotation TIMESTAMPTZ,
    next_rotation_due TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_conversation_encryption_conversation_id ON public.conversation_encryption_settings(conversation_id);

COMMENT ON TABLE public.conversation_encryption_settings IS 'E2EE settings per conversation. Tracks encryption status and key rotation.';

-- =====================================================
-- 7. ENCRYPTION AUDIT LOG
-- Track encryption-related events for security auditing
-- =====================================================

CREATE TABLE IF NOT EXISTS public.encryption_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    
    event_type TEXT NOT NULL CHECK (event_type IN (
        'key_generated',
        'key_rotated',
        'key_verified',
        'session_established',
        'session_refreshed',
        'encryption_enabled',
        'encryption_disabled',
        'decryption_failed',
        'suspicious_activity'
    )),
    
    -- Event details
    severity TEXT DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
    description TEXT,
    
    -- Related entities
    related_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    related_conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    related_server_id UUID REFERENCES public.servers(id) ON DELETE SET NULL,
    
    -- Technical details
    metadata JSONB DEFAULT '{}'::jsonb,
    
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    -- IP and user agent for security tracking
    ip_address INET,
    user_agent TEXT
);

CREATE INDEX idx_encryption_audit_user_id ON public.encryption_audit_log(user_id);
CREATE INDEX idx_encryption_audit_event_type ON public.encryption_audit_log(event_type);
CREATE INDEX idx_encryption_audit_created_at ON public.encryption_audit_log(created_at DESC);
CREATE INDEX idx_encryption_audit_severity ON public.encryption_audit_log(severity) WHERE severity IN ('error', 'critical');

COMMENT ON TABLE public.encryption_audit_log IS 'Audit trail for all encryption-related events. Used for security monitoring and debugging.';

-- =====================================================
-- 8. ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE public.user_key_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prekeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encryption_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_encryption_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_encryption_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encryption_audit_log ENABLE ROW LEVEL SECURITY;

-- User Key Pairs Policies
CREATE POLICY "Users can view their own key pairs"
    ON public.user_key_pairs FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own key pairs"
    ON public.user_key_pairs FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own key pairs"
    ON public.user_key_pairs FOR UPDATE
    USING (auth.uid() = user_id);

-- Prekeys Policies
CREATE POLICY "Users can view their own prekeys"
    ON public.prekeys FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own prekeys"
    ON public.prekeys FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own prekeys"
    ON public.prekeys FOR UPDATE
    USING (auth.uid() = user_id);

-- Allow others to fetch public prekeys for key exchange
CREATE POLICY "Users can view others' unused public prekeys"
    ON public.prekeys FOR SELECT
    USING (is_used = false);

-- Encryption Sessions Policies
CREATE POLICY "Users can view their own sessions"
    ON public.encryption_sessions FOR SELECT
    USING (auth.uid() = local_user_id OR auth.uid() = remote_user_id);

CREATE POLICY "Users can manage their own sessions"
    ON public.encryption_sessions FOR ALL
    USING (auth.uid() = local_user_id);

-- Server Encryption Settings Policies
CREATE POLICY "Everyone can view server encryption settings"
    ON public.server_encryption_settings FOR SELECT
    USING (true);

CREATE POLICY "Server owners can manage encryption settings"
    ON public.server_encryption_settings FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE servers.id = server_encryption_settings.server_id
            AND servers.owner_id = auth.uid()
        )
    );

-- Conversation Encryption Settings Policies
CREATE POLICY "Conversation participants can view encryption settings"
    ON public.conversation_encryption_settings FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.conversation_participants
            WHERE conversation_participants.conversation_id = conversation_encryption_settings.conversation_id
            AND conversation_participants.user_id = auth.uid()
        )
    );

CREATE POLICY "Conversation participants can update encryption settings"
    ON public.conversation_encryption_settings FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.conversation_participants
            WHERE conversation_participants.conversation_id = conversation_encryption_settings.conversation_id
            AND conversation_participants.user_id = auth.uid()
        )
    );

-- Encryption Audit Log Policies
CREATE POLICY "Users can view their own audit logs"
    ON public.encryption_audit_log FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "System can insert audit logs"
    ON public.encryption_audit_log FOR INSERT
    WITH CHECK (true);

-- Admins can view all audit logs
CREATE POLICY "Admins can view all audit logs"
    ON public.encryption_audit_log FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.is_admin = true
        )
    );

-- =====================================================
-- 9. HELPER FUNCTIONS
-- =====================================================

-- Function to mark a one-time prekey as used
CREATE OR REPLACE FUNCTION public.use_one_time_prekey(
    p_user_id UUID,
    p_device_id TEXT,
    p_prekey_id INTEGER,
    p_used_by UUID
)
RETURNS public.prekeys
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_prekey public.prekeys;
BEGIN
    UPDATE public.prekeys
    SET 
        is_used = true,
        used_at = NOW(),
        used_by = p_used_by
    WHERE 
        user_id = p_user_id
        AND device_id = p_device_id
        AND prekey_id = p_prekey_id
        AND is_one_time = true
        AND is_used = false
    RETURNING * INTO v_prekey;
    
    RETURN v_prekey;
END;
$$;

-- Function to get an unused one-time prekey
CREATE OR REPLACE FUNCTION public.get_unused_prekey(
    p_user_id UUID,
    p_device_id TEXT DEFAULT 'default'
)
RETURNS public.prekeys
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_prekey public.prekeys;
BEGIN
    SELECT * INTO v_prekey
    FROM public.prekeys
    WHERE 
        user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false
        AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    
    RETURN v_prekey;
END;
$$;

-- Function to increment session message count
CREATE OR REPLACE FUNCTION public.increment_session_message_count(
    p_session_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.encryption_sessions
    SET 
        message_count = message_count + 1,
        last_used_at = NOW(),
        -- Mark for refresh after 1000 messages
        needs_refresh = CASE 
            WHEN message_count + 1 >= 1000 THEN true
            ELSE needs_refresh
        END
    WHERE id = p_session_id;
END;
$$;

-- =====================================================
-- 10. TRIGGERS
-- =====================================================

-- Auto-update timestamp triggers
CREATE OR REPLACE FUNCTION public.update_encryption_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER update_server_encryption_settings_timestamp
    BEFORE UPDATE ON public.server_encryption_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.update_encryption_timestamp();

CREATE TRIGGER update_conversation_encryption_settings_timestamp
    BEFORE UPDATE ON public.conversation_encryption_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.update_encryption_timestamp();

-- Audit log trigger for key generation
CREATE OR REPLACE FUNCTION public.log_key_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        NEW.user_id,
        'key_generated',
        'info',
        'New identity key pair generated',
        jsonb_build_object(
            'device_id', NEW.device_id,
            'key_version', NEW.key_version
        )
    );
    
    RETURN NEW;
END;
$$;

CREATE TRIGGER audit_key_generation
    AFTER INSERT ON public.user_key_pairs
    FOR EACH ROW
    EXECUTE FUNCTION public.log_key_generation();

-- =====================================================
-- 11. GRANTS
-- =====================================================

-- Grant necessary permissions to authenticated users
GRANT SELECT, INSERT, UPDATE ON public.user_key_pairs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.prekeys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.encryption_sessions TO authenticated;
GRANT SELECT ON public.server_encryption_settings TO authenticated;
GRANT INSERT, UPDATE ON public.server_encryption_settings TO authenticated;
GRANT SELECT, UPDATE ON public.conversation_encryption_settings TO authenticated;
GRANT SELECT, INSERT ON public.encryption_audit_log TO authenticated;

-- Grant sequence usage
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- =====================================================
-- COMPLETED: E2EE Database Schema
-- =====================================================

