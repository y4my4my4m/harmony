-- =============================================================================
-- Federated Voice Calls Table
-- =============================================================================
-- Stores incoming federated voice/video call invitations from remote instances
-- Used for cross-instance DM voice/video calls

CREATE TABLE IF NOT EXISTS public.federated_voice_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- ActivityPub reference
  ap_id TEXT UNIQUE NOT NULL,
  
  -- Caller info
  caller_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  caller_federated_id TEXT NOT NULL,
  
  -- Recipient info (local user)
  recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  
  -- Call details
  call_type TEXT NOT NULL CHECK (call_type IN ('voice', 'video')),
  conversation_id TEXT, -- Optional reference to DM conversation
  
  -- LiveKit connection info (from caller's instance)
  livekit_url TEXT NOT NULL,
  room_name TEXT NOT NULL,
  
  -- Status tracking
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'ended', 'expired', 'missed')),
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '60 seconds'),
  
  -- Indexes for common queries
  CONSTRAINT fk_recipient_local CHECK (recipient_id IS NOT NULL)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_recipient 
  ON public.federated_voice_calls(recipient_id) 
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_caller 
  ON public.federated_voice_calls(caller_id);

CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_status 
  ON public.federated_voice_calls(status);

CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_expires 
  ON public.federated_voice_calls(expires_at) 
  WHERE status = 'pending';

-- RLS Policies
ALTER TABLE public.federated_voice_calls ENABLE ROW LEVEL SECURITY;

-- Users can view calls they are involved in
CREATE POLICY "Users can view their own calls"
  ON public.federated_voice_calls FOR SELECT
  USING (
    auth.uid() = recipient_id 
    OR auth.uid() = caller_id
  );

-- Only the system can insert (via service role from federation backend)
CREATE POLICY "System can insert calls"
  ON public.federated_voice_calls FOR INSERT
  WITH CHECK (true); -- Controlled by service role

-- Users can update calls they are the recipient of (to accept/reject)
CREATE POLICY "Recipients can update call status"
  ON public.federated_voice_calls FOR UPDATE
  USING (auth.uid() = recipient_id)
  WITH CHECK (auth.uid() = recipient_id);

-- Cleanup function for expired calls
CREATE OR REPLACE FUNCTION cleanup_expired_voice_calls()
RETURNS void AS $$
BEGIN
  UPDATE public.federated_voice_calls
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Optional: Create a scheduled job to cleanup expired calls
-- This can be called periodically by the backend or via pg_cron
COMMENT ON TABLE public.federated_voice_calls IS 'Stores federated voice/video call invitations from remote Harmony instances';

-- =============================================================================
-- Instance WebRTC Settings Table  
-- =============================================================================
-- Stores instance-level WebRTC configuration

CREATE TABLE IF NOT EXISTS public.instance_webrtc_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- WebRTC mode: 'sfu' (LiveKit only), 'p2p' (peer-to-peer only), 'hybrid' (SFU with P2P fallback)
  webrtc_mode TEXT NOT NULL DEFAULT 'hybrid' CHECK (webrtc_mode IN ('sfu', 'p2p', 'hybrid')),
  
  -- LiveKit server URL (public-facing)
  livekit_url TEXT,
  
  -- Allow federated voice/video
  allow_federated_voice BOOLEAN NOT NULL DEFAULT true,
  
  -- Stage mode settings
  max_stage_speakers INT NOT NULL DEFAULT 10,
  max_stage_listeners INT NOT NULL DEFAULT 100000,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one row should exist (singleton pattern)
CREATE UNIQUE INDEX IF NOT EXISTS idx_instance_webrtc_settings_singleton 
  ON public.instance_webrtc_settings((true));

-- Insert default settings if none exist
INSERT INTO public.instance_webrtc_settings (webrtc_mode, allow_federated_voice)
VALUES ('hybrid', true)
ON CONFLICT DO NOTHING;

-- RLS Policies
ALTER TABLE public.instance_webrtc_settings ENABLE ROW LEVEL SECURITY;

-- Everyone can read settings
CREATE POLICY "Anyone can read webrtc settings"
  ON public.instance_webrtc_settings FOR SELECT
  USING (true);

-- Only admins can update
CREATE POLICY "Admins can update webrtc settings"
  ON public.instance_webrtc_settings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND is_admin = true
    )
  );

COMMENT ON TABLE public.instance_webrtc_settings IS 'Instance-level WebRTC configuration for voice/video calls';

