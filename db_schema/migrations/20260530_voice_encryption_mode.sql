BEGIN;

-- Voice/video E2EE policy, mirroring the message encryption_mode column.
--
-- Unlike messages, voice/video has no per-call "optional": LiveKit E2EE is
-- room-wide (everyone shares one key or media garbles), so a channel is either
-- fully encrypted or not. Hence only two modes:
--   disabled: transport security only (DTLS-SRTP) -- backward-compatible default
--   required: media is E2E encrypted (server-blind); non-capable participants
--             (no encryption set up, or federated/old clients) are refused.

ALTER TABLE public.server_encryption_settings
    ADD COLUMN IF NOT EXISTS voice_encryption_mode text DEFAULT 'disabled'::text NOT NULL;

-- Idempotent constraint (re)creation.
ALTER TABLE public.server_encryption_settings
    DROP CONSTRAINT IF EXISTS server_encryption_settings_voice_encryption_mode_check;
ALTER TABLE public.server_encryption_settings
    ADD CONSTRAINT server_encryption_settings_voice_encryption_mode_check
        CHECK (voice_encryption_mode = ANY (ARRAY['disabled'::text, 'required'::text]));

COMMENT ON COLUMN public.server_encryption_settings.voice_encryption_mode IS 'disabled: voice/video transport-secured only (DTLS-SRTP). required: voice/video media is E2E encrypted (server-blind); non-capable participants are refused.';

NOTIFY pgrst, 'reload schema';

COMMIT;
