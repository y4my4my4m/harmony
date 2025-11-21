-- ============================================================================
-- MFA/2FA Security Helper Functions (Safe to Apply)
-- ============================================================================
-- This file ONLY creates helper functions for AAL2 enforcement.
-- It does NOT modify any existing RLS policies.
-- ============================================================================

-- ============================================================================
-- Helper Function: Check if user requires AAL2
-- ============================================================================
CREATE OR REPLACE FUNCTION auth.user_requires_aal2()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM auth.mfa_factors
    WHERE user_id = auth.uid()
      AND status = 'verified'
      AND factor_type = 'totp'
  );
$$;

-- ============================================================================
-- Helper Function: Check if session meets required AAL
-- ============================================================================
CREATE OR REPLACE FUNCTION auth.session_meets_aal_requirement()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT CASE
    WHEN auth.user_requires_aal2() THEN
      (auth.jwt()->>'aal' = 'aal2')
    ELSE
      true
  END;
$$;

-- ============================================================================
-- Testing Commands
-- ============================================================================

-- Check your current AAL level:
-- SELECT auth.jwt()->>'aal' as current_aal;

-- Check if you have 2FA enabled:
-- SELECT auth.user_requires_aal2();

-- Check if your session is valid:
-- SELECT auth.session_meets_aal_requirement();

-- Simulate AAL1 session (for testing):
-- UPDATE auth.sessions SET aal = 'aal1', factor_id = NULL WHERE user_id = auth.uid();

-- ============================================================================
-- Next Steps: Update Your RLS Policies
-- ============================================================================
-- To actually enforce AAL2, you need to update your existing RLS policies.
-- 
-- For EACH policy on sensitive tables (profiles, messages, etc), add:
--   AND auth.session_meets_aal_requirement()
--
-- Example - updating "Users can update own profile.":
--
-- DROP POLICY IF EXISTS "Users can update own profile." ON public.profiles;
-- CREATE POLICY "Users can update own profile."
-- ON public.profiles FOR UPDATE TO authenticated
-- USING (auth.uid() = id AND auth.session_meets_aal_requirement())
-- WITH CHECK (auth.uid() = id AND auth.session_meets_aal_requirement());
--
-- This is safer to do manually so you can review each policy carefully.
-- ============================================================================

