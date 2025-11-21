-- ============================================================================
-- MFA/2FA Row Level Security (RLS) Policies with AAL2 Enforcement
-- ============================================================================
-- This file adds security policies that enforce AAL2 (password + 2FA) for
-- users who have enrolled in Multi-Factor Authentication.
--
-- Key Concept:
-- - Users WITHOUT 2FA enrolled: Can access with AAL1 (password only)
-- - Users WITH 2FA enrolled: MUST have AAL2 (password + 2FA verified)
--
-- This prevents attackers who steal passwords from accessing MFA-protected accounts
-- ============================================================================

-- ============================================================================
-- Helper Function: Check if user requires AAL2
-- ============================================================================
-- This function checks if the current user has MFA/2FA enabled
-- If they do, they MUST be authenticated at AAL2 level

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
-- Returns true if:
-- - User has no 2FA enabled (AAL1 is sufficient), OR
-- - User has 2FA enabled AND current session is AAL2

CREATE OR REPLACE FUNCTION auth.session_meets_aal_requirement()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT CASE
    -- If user has 2FA enabled, require AAL2
    WHEN auth.user_requires_aal2() THEN
      (auth.jwt()->>'aal' = 'aal2')
    -- If no 2FA, AAL1 is fine
    ELSE
      true
  END;
$$;

-- ============================================================================
-- Apply AAL2 Enforcement to Critical Tables
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PROFILES table - User account data
-- ----------------------------------------------------------------------------

-- Drop existing policies if they exist (idempotent)
DROP POLICY IF EXISTS "Users can read own profile with proper AAL" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile with proper AAL" ON public.profiles;

-- Read own profile (requires AAL2 if 2FA enabled)
CREATE POLICY "Users can read own profile with proper AAL"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  auth.uid() = id 
  AND auth.session_meets_aal_requirement()
);

-- Update own profile (requires AAL2 if 2FA enabled)
CREATE POLICY "Users can update own profile with proper AAL"
ON public.profiles
FOR UPDATE
TO authenticated
USING (
  auth.uid() = id 
  AND auth.session_meets_aal_requirement()
)
WITH CHECK (
  auth.uid() = id
  AND auth.session_meets_aal_requirement()
);

-- ----------------------------------------------------------------------------
-- MESSAGES table - User messages
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can read messages with proper AAL" ON public.messages;
DROP POLICY IF EXISTS "Users can insert messages with proper AAL" ON public.messages;
DROP POLICY IF EXISTS "Users can update own messages with proper AAL" ON public.messages;
DROP POLICY IF EXISTS "Users can delete own messages with proper AAL" ON public.messages;

-- Read messages (user must be member of channel/DM and have proper AAL)
CREATE POLICY "Users can read messages with proper AAL"
ON public.messages
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    -- Can read messages in channels they're a member of
    EXISTS (
      SELECT 1 FROM public.channel_members
      WHERE channel_id = messages.channel_id
        AND user_id = auth.uid()
    )
    OR
    -- Can read direct messages they're part of
    EXISTS (
      SELECT 1 FROM public.dm_participants
      WHERE conversation_id = messages.conversation_id
        AND user_id = auth.uid()
    )
  )
);

-- Insert messages (must have proper AAL)
CREATE POLICY "Users can insert messages with proper AAL"
ON public.messages
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = author_id
  AND auth.session_meets_aal_requirement()
);

-- Update own messages (must have proper AAL)
CREATE POLICY "Users can update own messages with proper AAL"
ON public.messages
FOR UPDATE
TO authenticated
USING (
  auth.uid() = author_id
  AND auth.session_meets_aal_requirement()
)
WITH CHECK (
  auth.uid() = author_id
  AND auth.session_meets_aal_requirement()
);

-- Delete own messages (must have proper AAL)
CREATE POLICY "Users can delete own messages with proper AAL"
ON public.messages
FOR DELETE
TO authenticated
USING (
  auth.uid() = author_id
  AND auth.session_meets_aal_requirement()
);

-- ----------------------------------------------------------------------------
-- DM_CONVERSATIONS table - Direct message conversations
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can read own DM conversations with proper AAL" ON public.dm_conversations;
DROP POLICY IF EXISTS "Users can create DM conversations with proper AAL" ON public.dm_conversations;

-- Read DM conversations (must be participant and have proper AAL)
CREATE POLICY "Users can read own DM conversations with proper AAL"
ON public.dm_conversations
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND EXISTS (
    SELECT 1 FROM public.dm_participants
    WHERE conversation_id = dm_conversations.id
      AND user_id = auth.uid()
  )
);

-- Create DM conversations (must have proper AAL)
CREATE POLICY "Users can create DM conversations with proper AAL"
ON public.dm_conversations
FOR INSERT
TO authenticated
WITH CHECK (
  auth.session_meets_aal_requirement()
);

-- ----------------------------------------------------------------------------
-- SERVER_MEMBERS table - Server membership
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can read server members with proper AAL" ON public.server_members;

-- Read server members (must be member of server and have proper AAL)
CREATE POLICY "Users can read server members with proper AAL"
ON public.server_members
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND EXISTS (
    SELECT 1 FROM public.server_members sm
    WHERE sm.server_id = server_members.server_id
      AND sm.user_id = auth.uid()
  )
);

-- ============================================================================
-- Add AAL2 enforcement comments for documentation
-- ============================================================================

COMMENT ON FUNCTION auth.user_requires_aal2() IS 
  'Returns true if the current user has MFA/2FA enrolled and requires AAL2 authentication';

COMMENT ON FUNCTION auth.session_meets_aal_requirement() IS 
  'Returns true if session meets AAL requirements: AAL2 for 2FA users, AAL1 otherwise';

-- ============================================================================
-- IMPORTANT: Apply similar policies to other sensitive tables
-- ============================================================================
-- You should apply similar AAL2 enforcement to:
-- - channel_members
-- - server_invites
-- - user_settings
-- - Any other tables containing sensitive user data
--
-- Pattern to follow:
-- 1. Check auth.session_meets_aal_requirement() in USING/WITH CHECK
-- 2. Combine with existing permission checks (AND operator)
-- 3. This ensures users with 2FA MUST complete 2FA before accessing data
-- ============================================================================

-- ============================================================================
-- Testing the policies
-- ============================================================================
-- To test if AAL enforcement is working:
--
-- 1. Enable 2FA for a user
-- 2. Login with password only (should get AAL1 session)
-- 3. Try to query profiles/messages - should be DENIED
-- 4. Complete 2FA verification (upgrades to AAL2)
-- 5. Try to query again - should be ALLOWED
--
-- SQL to check your current AAL:
--   SELECT auth.jwt()->>'aal' as current_aal;
--
-- SQL to check if you need AAL2:
--   SELECT auth.user_requires_aal2();
--
-- SQL to verify session meets requirements:
--   SELECT auth.session_meets_aal_requirement();
-- ============================================================================

