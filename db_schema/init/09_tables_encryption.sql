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
    
    -- Sender (who wrapped the key). Needed by the recipient to run ECDH and by
    -- get_unclaimed_session_shares(); the client always populates it.
    sender_user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Recipient. recipient_device_id defaults to 'default' until the per-device
    -- identity model (see user_devices) starts populating it for real.
    recipient_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    recipient_device_id text NOT NULL DEFAULT 'default'::text,
    
    -- Share status. is_claimed mirrors (claimed_at IS NOT NULL) for fast lookup
    -- by get_unclaimed_session_shares() / claim_session_share().
    shared_at timestamp with time zone DEFAULT now(),
    claimed_at timestamp with time zone,
    is_claimed boolean DEFAULT false,
    
    -- The encrypted session key for this recipient
    encrypted_session_key text NOT NULL,
    
    -- What index was shared
    forwarded_count integer DEFAULT 0,
    first_known_index integer DEFAULT 0,
    
    -- Conflict target used by the client upsert (one share per recipient/session).
    UNIQUE(room_id, session_id, recipient_user_id)
);

CREATE INDEX IF NOT EXISTS idx_megolm_session_shares_recipient ON public.megolm_session_shares(recipient_user_id, recipient_device_id);
CREATE INDEX IF NOT EXISTS idx_megolm_session_shares_session ON public.megolm_session_shares(session_id, room_id);
CREATE INDEX IF NOT EXISTS idx_megolm_session_shares_unclaimed ON public.megolm_session_shares(recipient_user_id) WHERE is_claimed = false;

COMMENT ON TABLE public.megolm_session_shares IS 'Tracking of shared Megolm session keys';

-- ---------------------------------------------------------------------------
-- MEGOLM KEY REQUESTS - Requests for missing session keys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.megolm_key_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    -- Request identity (legacy; the client now keys off the PK `id`).
    request_id text,
    
    -- Legacy mirror of requester_user_id kept for backwards compatibility.
    user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Requester
    requester_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    requester_device_id text NOT NULL DEFAULT 'default'::text,
    
    -- The user we are asking to fulfill (original sender / session holder).
    -- broadcast_key_request_event() routes the request to user:{sender_user_id}.
    sender_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    
    -- What key is being requested
    session_id text NOT NULL,
    room_id text NOT NULL,
    
    -- Request status
    status text DEFAULT 'pending'::text,
    
    -- Signed request material (Megolm key-request authorization, see MessageSigner).
    request_signature text,
    request_signing_fingerprint text,
    
    -- Fulfillment payload (ECDH-wrapped session key for the requester).
    encrypted_key text,
    fulfilled_at timestamp with time zone,
    
    -- Response tracking
    responded_by_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    responded_by_device_id text,
    responded_at timestamp with time zone,
    
    CONSTRAINT megolm_key_requests_status_check CHECK (status IN ('pending', 'sent', 'received', 'cancelled', 'ignored', 'fulfilled', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_requester ON public.megolm_key_requests(requester_user_id);
CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_sender ON public.megolm_key_requests(sender_user_id);
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
    
    -- One backup row per user (client upserts onConflict 'user_id').
    user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Backup payload as written by MegolmKeyBackupService: a recovery-key
    -- encrypted JSON blob plus integrity hash and bookkeeping.
    encrypted_data text,
    version integer DEFAULT 1,
    session_count integer DEFAULT 0,
    backup_hash text,
    last_updated timestamp with time zone DEFAULT now(),
    
    -- Legacy / Matrix-compatible columns (nullable; not written by the client).
    backup_version integer,
    auth_data jsonb,
    algorithm text DEFAULT 'm.megolm_backup.v1.curve25519-aes-sha2'::text,
    is_current boolean DEFAULT true,
    key_count integer DEFAULT 0,
    etag text
);

CREATE INDEX IF NOT EXISTS idx_megolm_key_backups_user ON public.megolm_key_backups(user_id);

COMMENT ON TABLE public.megolm_key_backups IS 'Encrypted Megolm key backups (one row per user)';

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
    
    -- Voice/video E2EE mode. Unlike messages there is no per-call "optional":
    -- LiveKit E2EE is room-wide, so a call is either fully encrypted or not.
    --   disabled: voice/video uses transport security only (DTLS-SRTP)
    --   required: media is E2E encrypted; participants who can't do E2EE are refused
    voice_encryption_mode text DEFAULT 'disabled'::text NOT NULL,
    
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    
    -- Additional metadata
    metadata jsonb DEFAULT '{}'::jsonb,
    
    CONSTRAINT server_encryption_settings_encryption_mode_check 
        CHECK (encryption_mode = ANY (ARRAY['disabled'::text, 'optional'::text, 'required'::text, 'required_local_only'::text])),
    CONSTRAINT server_encryption_settings_voice_encryption_mode_check 
        CHECK (voice_encryption_mode = ANY (ARRAY['disabled'::text, 'required'::text]))
);

CREATE INDEX IF NOT EXISTS idx_server_encryption_server ON public.server_encryption_settings(server_id);

COMMENT ON TABLE public.server_encryption_settings IS 'Per-server E2EE enforcement policies. Server owners control encryption requirements.';
COMMENT ON COLUMN public.server_encryption_settings.encryption_mode IS 'disabled: No E2EE. optional: User choice. required: All messages encrypted. required_local_only: E2EE required, federation disabled.';
COMMENT ON COLUMN public.server_encryption_settings.voice_encryption_mode IS 'disabled: voice/video transport-secured only (DTLS-SRTP). required: voice/video media is E2E encrypted (server-blind); non-capable participants are refused.';

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

-- ---------------------------------------------------------------------------
-- USER DEVICES - Per-device encryption identity (Phase 3 device-aware model)
-- ---------------------------------------------------------------------------
-- Each browser profile / install / app gets its own device row with its own
-- ECDH (session-key exchange) and ECDSA (message signing) PUBLIC keys. Private
-- keys never leave the device (IndexedDB, non-extractable). trust_state maps to
-- the internal trust levels surfaced to users only as "approve this login" and
-- "unlock message history":
--   untrusted (L0) - logged in, gets no keys
--   account   (L1) - receives NEW room keys automatically after login
--   recovery  (L2) - unlocked history via the recovery phrase
--   verified  (L3) - approved from another trusted device (full key sync)
--   revoked        - explicitly removed; must not receive any keys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    device_id text NOT NULL,

    -- Public key material (private parts stay on the device).
    device_ecdh_public_key text,
    device_signing_public_key text,

    -- Trust + presentation.
    trust_state text NOT NULL DEFAULT 'account',
    platform text,          -- 'web' | 'desktop' | 'mobile'
    label text,             -- human label e.g. "Chrome on Windows"

    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now(),
    revoked_at timestamp with time zone,

    UNIQUE(user_id, device_id),
    CONSTRAINT user_devices_trust_check
        CHECK (trust_state IN ('untrusted', 'account', 'recovery', 'verified', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user ON public.user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_active
    ON public.user_devices(user_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.user_devices IS 'Per-device encryption identities and trust state (account-friendly, device-aware E2EE).';

-- ---------------------------------------------------------------------------
-- DEVICE APPROVAL REQUESTS - "New login on X - was this you?"
-- ---------------------------------------------------------------------------
-- A freshly logged-in device asks the user's existing trusted devices to
-- approve it (which pushes encrypted key sync). This is the Discord-style
-- new-login prompt, scoped to a single account (requester == approver user).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.device_approval_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

    requesting_device_id text NOT NULL,
    requesting_label text,
    requesting_ecdh_public_key text,

    status text NOT NULL DEFAULT 'pending',  -- pending | approved | denied | expired

    -- When approved, the approver wraps the account key-sync bundle for the
    -- requesting device's ECDH public key.
    approved_by_device_id text,
    encrypted_sync_bundle text,

    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + interval '15 minutes'),

    CONSTRAINT device_approval_requests_status_check
        CHECK (status IN ('pending', 'approved', 'denied', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_device_approval_user ON public.device_approval_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_device_approval_pending
    ON public.device_approval_requests(user_id) WHERE status = 'pending';

COMMENT ON TABLE public.device_approval_requests IS 'New-device approval requests for cross-device key sync (account-scoped).';

-- ---------------------------------------------------------------------------
-- ROOM EPOCH STATE - Membership epochs for backward/forward secrecy at joins
-- ---------------------------------------------------------------------------
-- Each room (channel or conversation) has a monotonically increasing epoch.
-- Membership changes (join/leave) and explicit rotations bump the epoch, which
-- forces a new Megolm session. Messages and session shares carry the epoch they
-- belong to, so a removed member cannot read messages from later epochs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_epoch_state (
    room_id text NOT NULL PRIMARY KEY,
    current_epoch integer NOT NULL DEFAULT 1,
    member_set_hash text,
    reason text,            -- created | member_join | member_leave | device_change | manual_rotate
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.room_epoch_state IS 'Current membership epoch per room; bumped on membership changes to rotate Megolm sessions.';

DO $$
BEGIN
    RAISE NOTICE 'Encryption tables created successfully';
END $$;

