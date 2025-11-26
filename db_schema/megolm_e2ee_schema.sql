-- =====================================================
-- MEGOLM-STYLE E2EE SCHEMA
-- Matrix/Megolm-inspired encryption for Harmony
-- Provides recoverable encryption with server-stored encrypted backups
-- =====================================================

-- =====================================================
-- 1. MEGOLM KEY BACKUPS
-- Server-stored encrypted backup of all session keys
-- Encrypted with user's recovery key - server cannot decrypt
-- =====================================================

CREATE TABLE IF NOT EXISTS public.megolm_key_backups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Encrypted backup data (encrypted with recovery key)
    encrypted_data TEXT NOT NULL,
    
    -- Backup metadata
    version INTEGER DEFAULT 1 NOT NULL,
    session_count INTEGER DEFAULT 0,
    backup_hash TEXT NOT NULL, -- SHA-256 hash for integrity verification
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_updated TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_megolm_backups_user_id ON public.megolm_key_backups(user_id);

COMMENT ON TABLE public.megolm_key_backups IS 'Server-stored encrypted backup of Megolm session keys. Only decryptable with user recovery key.';
COMMENT ON COLUMN public.megolm_key_backups.encrypted_data IS 'AES-256-GCM encrypted backup, key derived from recovery phrase';
COMMENT ON COLUMN public.megolm_key_backups.backup_hash IS 'SHA-256 hash of plaintext for integrity verification after decryption';

-- =====================================================
-- 2. MEGOLM KEY REQUESTS
-- Cross-device key sharing requests
-- When a device is missing a session key, it can request from other devices
-- =====================================================

CREATE TABLE IF NOT EXISTS public.megolm_key_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Request details
    room_id UUID NOT NULL, -- Can be channel_id or conversation_id
    session_id TEXT NOT NULL, -- The Megolm session ID being requested
    
    -- Request status
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'expired', 'cancelled')),
    
    -- Response data (when fulfilled)
    encrypted_key TEXT, -- Session key encrypted for the requesting device
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    fulfilled_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
    
    -- Metadata
    requesting_device_id TEXT DEFAULT 'default'
);

CREATE INDEX idx_megolm_requests_user_id ON public.megolm_key_requests(user_id);
CREATE INDEX idx_megolm_requests_status ON public.megolm_key_requests(user_id, status) WHERE status = 'pending';
CREATE INDEX idx_megolm_requests_room ON public.megolm_key_requests(room_id, session_id);

COMMENT ON TABLE public.megolm_key_requests IS 'Requests for Megolm session keys from other devices';
COMMENT ON COLUMN public.megolm_key_requests.encrypted_key IS 'Session key encrypted for the requesting device public key';

-- =====================================================
-- 3. RECOVERY KEY METADATA
-- Stores metadata about the user's recovery key (NOT the key itself!)
-- Used to verify recovery key setup and provide hints
-- =====================================================

CREATE TABLE IF NOT EXISTS public.recovery_key_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Recovery key info (NEVER store the actual key!)
    key_version INTEGER DEFAULT 1 NOT NULL,
    verification_code TEXT NOT NULL, -- First 6 chars of hash for verification
    word_count INTEGER DEFAULT 12 CHECK (word_count IN (12, 24)),
    
    -- Backup status
    has_server_backup BOOLEAN DEFAULT false,
    last_backup_at TIMESTAMPTZ,
    
    -- Security metadata
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_verified_at TIMESTAMPTZ, -- Last time user verified they still have the key
    
    -- Optional hints (user-provided, e.g., "stored in password manager")
    storage_hint TEXT
);

CREATE INDEX idx_recovery_metadata_user_id ON public.recovery_key_metadata(user_id);

COMMENT ON TABLE public.recovery_key_metadata IS 'Metadata about user recovery keys. NEVER stores actual recovery phrases!';
COMMENT ON COLUMN public.recovery_key_metadata.verification_code IS 'Hash-based code to verify recovery phrase without storing it';

-- =====================================================
-- 4. MEGOLM ROOM SESSIONS (PUBLIC METADATA ONLY)
-- Tracks which rooms have active Megolm sessions
-- Actual session keys are stored locally, encrypted
-- =====================================================

CREATE TABLE IF NOT EXISTS public.megolm_room_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL, -- Can be channel_id or conversation_id
    room_type TEXT NOT NULL CHECK (room_type IN ('channel', 'conversation')),
    
    -- Current session info (public metadata only)
    current_session_id TEXT NOT NULL,
    sender_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Session metadata
    message_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    rotated_at TIMESTAMPTZ,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    
    UNIQUE(room_id, sender_user_id, current_session_id)
);

CREATE INDEX idx_megolm_room_sessions_room ON public.megolm_room_sessions(room_id);
CREATE INDEX idx_megolm_room_sessions_sender ON public.megolm_room_sessions(sender_user_id);
CREATE INDEX idx_megolm_room_sessions_active ON public.megolm_room_sessions(room_id, is_active) WHERE is_active = true;

COMMENT ON TABLE public.megolm_room_sessions IS 'Tracks Megolm sessions per room. Actual keys stored locally on client.';
COMMENT ON COLUMN public.megolm_room_sessions.current_session_id IS 'Public session ID - does not reveal key material';

-- =====================================================
-- 5. MEGOLM SESSION KEY SHARE
-- Encrypted session keys shared between users in a room
-- Used to distribute outbound session keys to new members
-- =====================================================

CREATE TABLE IF NOT EXISTS public.megolm_session_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Session info
    room_id UUID NOT NULL,
    session_id TEXT NOT NULL,
    
    -- Sender and recipient
    sender_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    recipient_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Encrypted session key (encrypted with recipient's identity key)
    encrypted_session_key TEXT NOT NULL,
    first_known_index INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    claimed_at TIMESTAMPTZ,
    
    -- Status
    is_claimed BOOLEAN DEFAULT false,
    
    UNIQUE(room_id, session_id, recipient_user_id)
);

CREATE INDEX idx_megolm_shares_recipient ON public.megolm_session_shares(recipient_user_id, is_claimed) WHERE is_claimed = false;
CREATE INDEX idx_megolm_shares_room ON public.megolm_session_shares(room_id, session_id);

COMMENT ON TABLE public.megolm_session_shares IS 'Encrypted Megolm session keys shared between users';
COMMENT ON COLUMN public.megolm_session_shares.encrypted_session_key IS 'Session key encrypted with recipient identity key';

-- =====================================================
-- 6. UPDATE MESSAGES TABLE
-- Add Megolm-specific encryption metadata
-- =====================================================

-- Add new column for Megolm session info (if not exists from previous schema)
ALTER TABLE public.messages 
    ADD COLUMN IF NOT EXISTS megolm_session_id TEXT,
    ADD COLUMN IF NOT EXISTS megolm_message_index INTEGER;

CREATE INDEX IF NOT EXISTS idx_messages_megolm_session ON public.messages(megolm_session_id) WHERE encrypted = true;

COMMENT ON COLUMN public.messages.megolm_session_id IS 'Megolm session ID for encrypted messages';
COMMENT ON COLUMN public.messages.megolm_message_index IS 'Message index in Megolm ratchet (for forward secrecy)';

-- =====================================================
-- 7. ROW LEVEL SECURITY POLICIES
-- =====================================================

-- Enable RLS on all new tables
ALTER TABLE public.megolm_key_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_key_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_key_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_room_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_session_shares ENABLE ROW LEVEL SECURITY;

-- Megolm Key Backups - users can only access their own
CREATE POLICY "Users can manage their own backups"
    ON public.megolm_key_backups FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_key_backups.user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Megolm Key Requests - users can manage their own requests
CREATE POLICY "Users can manage their own key requests"
    ON public.megolm_key_requests FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_key_requests.user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Recovery Key Metadata - users can only access their own
CREATE POLICY "Users can manage their own recovery metadata"
    ON public.recovery_key_metadata FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = recovery_key_metadata.user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Megolm Room Sessions - room participants can view
CREATE POLICY "Room participants can view session metadata"
    ON public.megolm_room_sessions FOR SELECT
    USING (
        -- Channel members can view (using user_servers table)
        EXISTS (
            SELECT 1 FROM public.user_servers us
            JOIN public.profiles p ON p.id = us.user_id
            JOIN public.channels c ON c.id = megolm_room_sessions.room_id
            WHERE c.server_id = us.server_id
            AND p.auth_user_id = auth.uid()
        )
        OR
        -- Conversation participants can view
        EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            JOIN public.profiles p ON p.id = cp.user_id
            WHERE cp.conversation_id = megolm_room_sessions.room_id
            AND p.auth_user_id = auth.uid()
        )
    );

-- Users can create/update their own session metadata
CREATE POLICY "Users can manage their own sessions"
    ON public.megolm_room_sessions FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_room_sessions.sender_user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Megolm Session Shares - recipients can view and claim their shares
CREATE POLICY "Recipients can view their session shares"
    ON public.megolm_session_shares FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_session_shares.recipient_user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

CREATE POLICY "Recipients can claim their session shares"
    ON public.megolm_session_shares FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_session_shares.recipient_user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- Senders can create session shares
CREATE POLICY "Senders can create session shares"
    ON public.megolm_session_shares FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = megolm_session_shares.sender_user_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- =====================================================
-- 8. HELPER FUNCTIONS
-- =====================================================

-- Function to check if user has recovery key set up
CREATE OR REPLACE FUNCTION public.user_has_recovery_key(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.recovery_key_metadata
        WHERE user_id = p_user_id
    );
END;
$$;

-- Function to get unclaimed session shares for a user
CREATE OR REPLACE FUNCTION public.get_unclaimed_session_shares(p_user_id UUID)
RETURNS TABLE (
    share_id UUID,
    room_id UUID,
    session_id TEXT,
    sender_user_id UUID,
    encrypted_session_key TEXT,
    first_known_index INTEGER,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        s.id as share_id,
        s.room_id,
        s.session_id,
        s.sender_user_id,
        s.encrypted_session_key,
        s.first_known_index,
        s.created_at
    FROM public.megolm_session_shares s
    WHERE s.recipient_user_id = p_user_id
    AND s.is_claimed = false
    ORDER BY s.created_at DESC;
END;
$$;

-- Function to claim a session share
CREATE OR REPLACE FUNCTION public.claim_session_share(p_share_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.megolm_session_shares
    SET 
        is_claimed = true,
        claimed_at = NOW()
    WHERE id = p_share_id
    AND recipient_user_id = p_user_id
    AND is_claimed = false;
    
    RETURN FOUND;
END;
$$;

-- Function to clean up expired key requests
CREATE OR REPLACE FUNCTION public.cleanup_expired_key_requests()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    WITH deleted AS (
        DELETE FROM public.megolm_key_requests
        WHERE expires_at < NOW()
        AND status = 'pending'
        RETURNING id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;
    
    RETURN deleted_count;
END;
$$;

-- Function to register/update recovery key metadata
CREATE OR REPLACE FUNCTION public.register_recovery_key(
    p_user_id UUID,
    p_verification_code TEXT,
    p_word_count INTEGER DEFAULT 12
)
RETURNS public.recovery_key_metadata
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result public.recovery_key_metadata;
BEGIN
    INSERT INTO public.recovery_key_metadata (
        user_id,
        verification_code,
        word_count,
        created_at
    ) VALUES (
        p_user_id,
        p_verification_code,
        p_word_count,
        NOW()
    )
    ON CONFLICT (user_id) 
    DO UPDATE SET
        verification_code = EXCLUDED.verification_code,
        word_count = EXCLUDED.word_count,
        key_version = recovery_key_metadata.key_version + 1
    RETURNING * INTO v_result;
    
    RETURN v_result;
END;
$$;

-- =====================================================
-- 9. GRANTS
-- =====================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON public.megolm_key_backups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.megolm_key_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.recovery_key_metadata TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.megolm_room_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.megolm_session_shares TO authenticated;

-- Grant function execution
GRANT EXECUTE ON FUNCTION public.user_has_recovery_key TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_unclaimed_session_shares TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_session_share TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_recovery_key TO authenticated;

-- =====================================================
-- 10. TRIGGERS
-- =====================================================

-- Auto-update timestamp on backup changes
CREATE OR REPLACE FUNCTION public.update_megolm_backup_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.last_updated = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER update_megolm_backup_timestamp
    BEFORE UPDATE ON public.megolm_key_backups
    FOR EACH ROW
    EXECUTE FUNCTION public.update_megolm_backup_timestamp();

-- =====================================================
-- COMPLETED: Megolm E2EE Database Schema
-- =====================================================

