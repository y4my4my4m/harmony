-- =============================================================================
-- LiveKit Token Generation (No Backend Required)
-- =============================================================================
-- Generate LiveKit room tokens directly from Supabase using pgjwt extension.
-- NO VPS OR BACKEND NEEDED for local-only instances with voice.
--
-- Requirements:
-- 1. Enable pgjwt extension (Supabase has this)
-- 2. Configure LiveKit credentials in instance_webrtc_settings
--
-- Usage from frontend:
--   const { data } = await supabase.rpc('generate_livekit_token', {
--     room_name: 'voice-channel-uuid',
--     room_type: 'voice_channel'
--   });
--   // data = { token: 'jwt...', wsUrl: 'wss://...', roomName: '...', identity: '...' }
-- =============================================================================

-- Enable pgjwt extension (depends on pgcrypto)
CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;

-- =============================================================================
-- Get Public LiveKit Config (Safe - No Secrets!)
-- =============================================================================
-- Returns LiveKit configuration WITHOUT the API secret.
-- Safe for all authenticated users to call.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_livekit_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_config jsonb;
    v_mode text;
    v_url text;
    v_public_url text;
    v_allow_federated boolean;
BEGIN
    -- Get config WITHOUT the secret
    SELECT 
        webrtc_mode,
        livekit_url,
        livekit_public_url,
        allow_federated_voice
    INTO v_mode, v_url, v_public_url, v_allow_federated
    FROM instance_webrtc_settings
    LIMIT 1;
    
    -- Return safe config (NO livekit_api_key, NO livekit_api_secret!)
    RETURN jsonb_build_object(
        'mode', COALESCE(v_mode, 'hybrid'),
        'configured', (v_url IS NOT NULL),
        'wsUrl', COALESCE(v_public_url, v_url),
        'allow_federated_voice', COALESCE(v_allow_federated, true)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_livekit_config() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_livekit_config() TO anon;

COMMENT ON FUNCTION public.get_livekit_config() IS 
'Get public LiveKit configuration. NEVER exposes API key or secret. Safe for all users.';

-- =============================================================================
-- Generate LiveKit Token
-- =============================================================================
CREATE OR REPLACE FUNCTION public.generate_livekit_token(
  room_name text,
  room_type text DEFAULT 'voice_channel'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id uuid;
  v_profile_id uuid;
  v_username text;
  v_display_name text;
  v_api_key text;
  v_api_secret text;
  v_livekit_url text;
  v_payload jsonb;
  v_token text;
  v_issued_at bigint;
  v_expires_at bigint;
  v_jti text;
BEGIN
  -- Get current authenticated user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authenticated', 'code', 'AUTH_REQUIRED');
  END IF;

  -- Get user's profile info
  SELECT id, username, display_name 
  INTO v_profile_id, v_username, v_display_name
  FROM profiles
  WHERE auth_user_id = v_user_id;

  IF v_username IS NULL THEN
    v_username := 'user_' || LEFT(v_user_id::text, 8);
  END IF;

  -- Get LiveKit credentials from instance_webrtc_settings
  SELECT 
    livekit_api_key,
    livekit_api_secret,
    COALESCE(livekit_public_url, livekit_url)
  INTO v_api_key, v_api_secret, v_livekit_url
  FROM instance_webrtc_settings
  LIMIT 1;

  IF v_api_key IS NULL OR v_api_secret IS NULL OR v_livekit_url IS NULL THEN
    RETURN jsonb_build_object(
      'error', 'Voice not configured. Admin needs to set LiveKit credentials in Settings.', 
      'code', 'VOICE_NOT_CONFIGURED'
    );
  END IF;

  -- Calculate timestamps (issued now, expires in 24 hours)
  v_issued_at := EXTRACT(EPOCH FROM now())::bigint;
  v_expires_at := v_issued_at + 86400;
  v_jti := gen_random_uuid()::text;

  -- Build LiveKit JWT payload
  -- See: https://docs.livekit.io/realtime/concepts/authentication/
  v_payload := jsonb_build_object(
    'iss', v_api_key,                    -- API Key as issuer
    'sub', v_profile_id::text,           -- Profile ID as subject
    'iat', v_issued_at,                  -- Issued at
    'exp', v_expires_at,                 -- Expires at  
    'nbf', v_issued_at,                  -- Not before
    'jti', v_jti,                        -- Unique token ID
    'name', COALESCE(v_display_name, v_username),  -- Display name
    'video', jsonb_build_object(         -- LiveKit video grant
      'roomJoin', true,
      'room', room_name,
      'canPublish', true,
      'canSubscribe', true,
      'canPublishData', true
    ),
    'metadata', jsonb_build_object(      -- Custom metadata
      'user_id', v_user_id::text,
      'profile_id', v_profile_id::text,
      'room_type', room_type,
      'username', v_username
    )::text
  );

  -- Generate JWT using pgjwt sign function
  v_token := extensions.sign(v_payload::json, v_api_secret, 'HS256');

  IF v_token IS NULL THEN
    RETURN jsonb_build_object('error', 'Failed to generate token', 'code', 'TOKEN_ERROR');
  END IF;

  -- Return token and connection info
  RETURN jsonb_build_object(
    'token', v_token,
    'wsUrl', v_livekit_url,
    'roomName', room_name,
    'identity', v_profile_id::text,
    'name', COALESCE(v_display_name, v_username),
    'expiresAt', v_expires_at
  );
END;
$$;

-- Grant to authenticated users only
GRANT EXECUTE ON FUNCTION public.generate_livekit_token(text, text) TO authenticated;

COMMENT ON FUNCTION public.generate_livekit_token IS 
'Generate a LiveKit room token for voice/video channels.
Works WITHOUT federation-backend - tokens generated directly in database.
Requires LiveKit credentials in instance_webrtc_settings.';

-- =============================================================================
-- Get LiveKit Config (check if voice is available)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_livekit_config()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_webrtc_mode text;
  v_livekit_url text;
  v_api_key text;
  v_api_secret text;
  v_allow_federated boolean;
  v_enabled boolean;
  v_found boolean;
BEGIN
  SELECT 
    webrtc_mode,
    COALESCE(livekit_public_url, livekit_url),
    livekit_api_key,
    livekit_api_secret,
    allow_federated_voice
  INTO v_webrtc_mode, v_livekit_url, v_api_key, v_api_secret, v_allow_federated
  FROM instance_webrtc_settings
  LIMIT 1;

  v_found := FOUND;

  IF NOT v_found THEN
    RETURN jsonb_build_object(
      'enabled', false,
      'mode', 'p2p',
      'wsUrl', null,
      'allowFederatedVoice', false,
      'configured', false
    );
  END IF;

  -- Voice is enabled if all LiveKit credentials are configured
  v_enabled := (
    v_api_key IS NOT NULL AND 
    v_api_secret IS NOT NULL AND
    v_livekit_url IS NOT NULL
  );

  RETURN jsonb_build_object(
    'enabled', v_enabled,
    'mode', COALESCE(v_webrtc_mode, 'hybrid'),
    'wsUrl', CASE WHEN v_enabled THEN v_livekit_url ELSE null END,
    'allowFederatedVoice', COALESCE(v_allow_federated, false),
    'configured', v_found
  );
END;
$$;

-- Public can check if voice is available, authenticated can get more details
GRANT EXECUTE ON FUNCTION public.get_livekit_config() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_livekit_config() TO anon;

COMMENT ON FUNCTION public.get_livekit_config IS 
'Get LiveKit configuration status. Returns whether voice is enabled and configured.';

-- =============================================================================
DO $$
BEGIN
    RAISE NOTICE 'LiveKit token generation functions created (using pgjwt)';
END $$;
