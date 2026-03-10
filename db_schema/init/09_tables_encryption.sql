-- =============================================================================
-- Harmony Database Schema - Encryption Tables
-- =============================================================================
-- End-to-end encryption: Megolm sessions, key backups, recovery
-- =============================================================================

-- ---------------------------------------------------------------------------
-- USER PRIVATE KEYS - Federation key pairs (service_role access only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_private_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    private_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_private_keys_user ON public.user_private_keys(user_id);

COMMENT ON TABLE public.user_private_keys IS 'Federation private keys - accessible only via service_role';

-- ---------------------------------------------------------------------------
-- MEGOLM ROOM SESSIONS - E2E encrypted room sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.megolm_room_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    -- Session identity
    session_id text NOT NULL,
    room_id text NOT NULL,  -- conversation_id or channel_id
    room_type text NOT NULL, -- 'conversation' or 'channel'
    
    -- Creator
    creator_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    creator_device_id text NOT NULL,
    
    -- Session key (encrypted)
    encrypted_session_key text NOT NULL,
    
    -- Key rotation
    message_index integer DEFAULT 0,
    max_message_index integer DEFAULT 100,
    
    -- Status
    is_active boolean DEFAULT true,
    rotated_at timestamp with time zone,
    
    -- Sharing
    shared_with_count integer DEFAULT 0,
    
    UNIQUE(session_id, room_id),
    CONSTRAINT megolm_room_sessions_type_check CHECK (room_type IN ('conversation', 'channel'))
);

ALTER TABLE public.megolm_room_sessions REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_megolm_room_sessions_room ON public.megolm_room_sessions(room_id, room_type);
CREATE INDEX IF NOT EXISTS idx_megolm_room_sessions_session ON public.megolm_room_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_megolm_room_sessions_creator ON public.megolm_room_sessions(creator_user_id);

COMMENT ON TABLE public.megolm_room_sessions IS 'Megolm E2E encryption sessions for rooms';

-- ---------------------------------------------------------------------------
-- MEGOLM SESSION SHARES - Track who has which session keys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.megolm_session_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    session_id text NOT NULL,
    room_id text NOT NULL,
    
    -- Recipient
    recipient_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    recipient_device_id text NOT NULL,
    
    -- Share status
    shared_at timestamp with time zone DEFAULT now(),
    claimed_at timestamp with time zone,
    
    -- The encrypted session key for this recipient
    encrypted_session_key text NOT NULL,
    
    -- What index was shared
    forwarded_count integer DEFAULT 0,
    first_known_index integer DEFAULT 0,
    
    UNIQUE(session_id, room_id, recipient_user_id, recipient_device_id)
);

CREATE INDEX IF NOT EXISTS idx_megolm_session_shares_recipient ON public.megolm_session_shares(recipient_user_id, recipient_device_id);
CREATE INDEX IF NOT EXISTS idx_megolm_session_shares_session ON public.megolm_session_shares(session_id, room_id);

COMMENT ON TABLE public.megolm_session_shares IS 'Tracking of shared Megolm session keys';

-- ---------------------------------------------------------------------------
-- MEGOLM KEY REQUESTS - Requests for missing session keys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.megolm_key_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    -- Request identity
    request_id text NOT NULL,
    
    -- Requester
    requester_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    requester_device_id text NOT NULL,
    
    -- What key is being requested
    session_id text NOT NULL,
    room_id text NOT NULL,
    
    -- Request status
    status text DEFAULT 'pending'::text,
    
    -- Response tracking
    responded_by_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    responded_by_device_id text,
    responded_at timestamp with time zone,
    
    UNIQUE(request_id, requester_user_id, requester_device_id),
    CONSTRAINT megolm_key_requests_status_check CHECK (status IN ('pending', 'sent', 'received', 'cancelled', 'ignored'))
);

CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_requester ON public.megolm_key_requests(requester_user_id);
CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_session ON public.megolm_key_requests(session_id, room_id);
CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_status ON public.megolm_key_requests(status) WHERE status = 'pending';

COMMENT ON TABLE public.megolm_key_requests IS 'Requests for missing Megolm session keys';

-- ---------------------------------------------------------------------------
-- MEGOLM KEY BACKUPS - Encrypted key backups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.megolm_key_backups (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Backup identity
    backup_version integer NOT NULL,
    
    -- Backup encryption (encrypted with recovery key)
    auth_data jsonb NOT NULL,
    algorithm text DEFAULT 'm.megolm_backup.v1.curve25519-aes-sha2'::text,
    
    -- Status
    is_current boolean DEFAULT true,
    key_count integer DEFAULT 0,
    
    -- Etag for sync
    etag text,
    
    UNIQUE(user_id, backup_version)
);

CREATE INDEX IF NOT EXISTS idx_megolm_key_backups_user ON public.megolm_key_backups(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_megolm_key_backups_current ON public.megolm_key_backups(user_id) WHERE is_current = true;

COMMENT ON TABLE public.megolm_key_backups IS 'Encrypted Megolm key backups';

-- ---------------------------------------------------------------------------
-- RECOVERY KEY METADATA - Recovery key info (not the key itself!)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recovery_key_metadata (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Key version and verification
    key_version integer DEFAULT 1 NOT NULL,
    verification_code text NOT NULL,
    word_count integer DEFAULT 12,
    
    -- Backup status
    has_server_backup boolean DEFAULT false,
    last_backup_at timestamp with time zone,
    
    -- Timestamps
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_verified_at timestamp with time zone,
    
    -- Storage hint for user
    storage_hint text,
    
    CONSTRAINT recovery_key_metadata_word_count_check CHECK (word_count = ANY (ARRAY[12, 24]))
);

CREATE INDEX IF NOT EXISTS idx_recovery_key_metadata_user ON public.recovery_key_metadata(user_id);

COMMENT ON TABLE public.recovery_key_metadata IS 'Recovery key metadata (NOT the key itself)';

-- ---------------------------------------------------------------------------
-- MFA RECOVERY CODES - One-time MFA recovery codes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mfa_recovery_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Code hash (never store plain codes!)
    code_hash text NOT NULL,
    
    -- Usage tracking
    used_at timestamp with time zone,
    is_used boolean DEFAULT false,
    
    -- Generation batch
    batch_id uuid NOT NULL,
    
    created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user ON public.mfa_recovery_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_available ON public.mfa_recovery_codes(user_id, is_used) WHERE is_used = false;

COMMENT ON TABLE public.mfa_recovery_codes IS 'One-time MFA recovery codes (hashed)';

-- ---------------------------------------------------------------------------
-- CONVERSATION ENCRYPTION SETTINGS - Per-conversation encryption config
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_encryption_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    conversation_id uuid NOT NULL UNIQUE REFERENCES public.conversations(id) ON DELETE CASCADE,
    
    -- Encryption enabled?
    encryption_enabled boolean DEFAULT false,
    encryption_algorithm text DEFAULT 'm.megolm.v1.aes-sha2'::text,
    
    -- Key rotation policy
    rotation_period_ms bigint DEFAULT 604800000, -- 7 days
    rotation_message_count integer DEFAULT 100,
    
    -- Last rotation
    last_rotation_at timestamp with time zone,
    current_session_id text,
    
    -- History visibility for new members
    history_visibility text DEFAULT 'shared'::text,
    
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    CONSTRAINT conversation_encryption_visibility_check CHECK (history_visibility IN ('shared', 'invited', 'joined'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_encryption_conv ON public.conversation_encryption_settings(conversation_id);

COMMENT ON TABLE public.conversation_encryption_settings IS 'Per-conversation encryption settings';

-- ---------------------------------------------------------------------------
-- SERVER ENCRYPTION SETTINGS - Per-server E2EE enforcement policies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_encryption_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_id uuid NOT NULL UNIQUE REFERENCES public.servers(id) ON DELETE CASCADE,
    
    -- Encryption mode: disabled, optional, required, required_local_only
    encryption_mode text DEFAULT 'optional'::text,
    
    -- Federation settings
    allow_federation boolean DEFAULT true,
    
    -- Device verification requirements
    require_verified_devices boolean DEFAULT false,
    
    -- Force key setup for new users
    force_key_setup boolean DEFAULT false NOT NULL,
    
    -- Encrypt file attachments
    encrypt_attachments boolean DEFAULT true NOT NULL,
    
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    
    -- Additional metadata
    metadata jsonb DEFAULT '{}'::jsonb,
    
    CONSTRAINT server_encryption_settings_encryption_mode_check 
        CHECK (encryption_mode = ANY (ARRAY['disabled'::text, 'optional'::text, 'required'::text, 'required_local_only'::text]))
);

CREATE INDEX IF NOT EXISTS idx_server_encryption_server ON public.server_encryption_settings(server_id);

COMMENT ON TABLE public.server_encryption_settings IS 'Per-server E2EE enforcement policies. Server owners control encryption requirements.';
COMMENT ON COLUMN public.server_encryption_settings.encryption_mode IS 'disabled: No E2EE. optional: User choice. required: All messages encrypted. required_local_only: E2EE required, federation disabled.';

-- ---------------------------------------------------------------------------
-- ENCRYPTION SESSIONS - Signal Protocol session state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.encryption_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    local_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    local_device_id text DEFAULT 'default'::text,
    remote_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    remote_device_id text DEFAULT 'default'::text,
    session_state text NOT NULL, -- Serialized Signal Protocol session state (encrypted)
    established_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now(),
    message_count integer DEFAULT 0, -- For automatic session rotation
    needs_refresh boolean DEFAULT false,
    metadata jsonb DEFAULT '{}'::jsonb,

    UNIQUE(local_user_id, local_device_id, remote_user_id, remote_device_id)
);
COMMENT ON TABLE public.encryption_sessions IS 'Signal Protocol session state for message encryption between users.';

CREATE INDEX IF NOT EXISTS idx_encryption_sessions_local ON public.encryption_sessions(local_user_id, local_device_id);
CREATE INDEX IF NOT EXISTS idx_encryption_sessions_remote ON public.encryption_sessions(remote_user_id, remote_device_id);

-- ---------------------------------------------------------------------------
-- ENCRYPTION AUDIT LOG - Security event logging
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.encryption_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    event_type text NOT NULL, -- 'key_generated', 'session_established', 'key_rotation', 'key_verification'
    severity text DEFAULT 'info'::text, -- 'info', 'warning', 'error', 'critical'
    description text,
    metadata jsonb DEFAULT '{}'::jsonb,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,

    CONSTRAINT encryption_audit_log_severity_check CHECK (severity IN ('info', 'warning', 'error', 'critical'))
);
COMMENT ON TABLE public.encryption_audit_log IS 'Audit log for encryption-related security events';

CREATE INDEX IF NOT EXISTS idx_encryption_audit_user ON public.encryption_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_encryption_audit_type ON public.encryption_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_encryption_audit_created ON public.encryption_audit_log(created_at DESC);

DO $$
BEGIN
    RAISE NOTICE 'Encryption tables created successfully';
END $$;

