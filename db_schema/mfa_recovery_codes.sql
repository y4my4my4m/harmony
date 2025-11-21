-- Create table for storing MFA recovery codes
CREATE TABLE IF NOT EXISTS public.mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, -- Store hashed version for security
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_code_per_user UNIQUE (user_id, code_hash)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user_id ON public.mfa_recovery_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_unused ON public.mfa_recovery_codes(user_id) WHERE used_at IS NULL;

-- Enable RLS
ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only read their own unused recovery codes
CREATE POLICY "Users can view their own unused recovery codes"
  ON public.mfa_recovery_codes
  FOR SELECT
  USING (auth.uid() = user_id AND used_at IS NULL);

-- Policy: Users can update their own recovery codes to mark as used
CREATE POLICY "Users can mark their own recovery codes as used"
  ON public.mfa_recovery_codes
  FOR UPDATE
  USING (auth.uid() = user_id AND used_at IS NULL)
  WITH CHECK (auth.uid() = user_id);

-- Policy: System can insert recovery codes for users
CREATE POLICY "Service role can insert recovery codes"
  ON public.mfa_recovery_codes
  FOR INSERT
  WITH CHECK (true);

-- Policy: Users can delete their own recovery codes when disabling 2FA
CREATE POLICY "Users can delete their own recovery codes"
  ON public.mfa_recovery_codes
  FOR DELETE
  USING (auth.uid() = user_id);

-- Function to verify and use a recovery code
CREATE OR REPLACE FUNCTION public.verify_recovery_code(
  p_user_id UUID,
  p_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code_hash TEXT;
  v_code_id UUID;
BEGIN
  -- Hash the provided code (using SHA-256)
  v_code_hash := encode(digest(p_code, 'sha256'), 'hex');
  
  -- Find an unused recovery code matching the hash
  SELECT id INTO v_code_id
  FROM public.mfa_recovery_codes
  WHERE user_id = p_user_id
    AND code_hash = v_code_hash
    AND used_at IS NULL
  LIMIT 1;
  
  IF v_code_id IS NOT NULL THEN
    -- Mark the code as used
    UPDATE public.mfa_recovery_codes
    SET used_at = NOW()
    WHERE id = v_code_id;
    
    RETURN TRUE;
  ELSE
    RETURN FALSE;
  END IF;
END;
$$;

-- Function to save recovery codes (called when 2FA is enabled)
CREATE OR REPLACE FUNCTION public.save_recovery_codes(
  p_user_id UUID,
  p_codes TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code TEXT;
  v_code_hash TEXT;
BEGIN
  -- Delete any existing recovery codes for this user
  DELETE FROM public.mfa_recovery_codes WHERE user_id = p_user_id;
  
  -- Insert new recovery codes
  FOREACH v_code IN ARRAY p_codes
  LOOP
    v_code_hash := encode(digest(v_code, 'sha256'), 'hex');
    INSERT INTO public.mfa_recovery_codes (user_id, code_hash)
    VALUES (p_user_id, v_code_hash);
  END LOOP;
END;
$$;

-- Function to count unused recovery codes
CREATE OR REPLACE FUNCTION public.count_unused_recovery_codes(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.mfa_recovery_codes
  WHERE user_id = p_user_id
    AND used_at IS NULL;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.verify_recovery_code(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_recovery_codes(UUID, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_unused_recovery_codes(UUID) TO authenticated;

