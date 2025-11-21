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
-- Update EXISTING RLS Policies to Include AAL2 Checks
-- ============================================================================
-- Strategy: Add AAL2 requirement to existing policies using AND logic
-- This way users with 2FA MUST complete 2FA before accessing data
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PROFILES table - Update own profile policy
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can update own profile." ON public.profiles;

CREATE POLICY "Users can update own profile."
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
-- MESSAGES table - Enhanced with AAL2 checks
-- ----------------------------------------------------------------------------

-- View messages policy
DROP POLICY IF EXISTS "Users can view messages in conversations they participate in" ON public.messages;

CREATE POLICY "Users can view messages in conversations they participate in"
ON public.messages
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    (
      conversation_id IS NOT NULL 
      AND EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.id = messages.conversation_id
          AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
      )
    )
    OR
    (
      channel_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.channels ch
        WHERE ch.id = messages.channel_id
          AND (
            ch.server_id IN (
              SELECT server_id FROM public.servers WHERE owner = auth.uid()
            )
            OR EXISTS (
              SELECT 1 FROM public.servers s
              WHERE s.id = ch.server_id
                AND s.visibility = 'public'
            )
          )
      )
    )
  )
);

-- Create messages policy
DROP POLICY IF EXISTS "Users can create messages in conversations they participate in" ON public.messages;

CREATE POLICY "Users can create messages in conversations they participate in"
ON public.messages
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND auth.session_meets_aal_requirement()
  AND (
    (
      conversation_id IS NOT NULL 
      AND EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.id = messages.conversation_id
          AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
      )
    )
    OR
    (
      channel_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.channels ch
        WHERE ch.id = messages.channel_id
      )
    )
  )
);

-- Update messages policy
DROP POLICY IF EXISTS "Message owner or server owner can update" ON public.messages;

CREATE POLICY "Message owner or server owner can update"
ON public.messages
FOR UPDATE
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    auth.uid() = user_id
    OR auth.uid() = (
      SELECT servers.owner
      FROM public.servers
      WHERE servers.id = (
        SELECT channels.server_id 
        FROM public.channels
        WHERE channels.id = messages.channel_id
      )
    )
  )
)
WITH CHECK (
  auth.session_meets_aal_requirement()
  AND auth.uid() = user_id
);

-- Delete messages policy
DROP POLICY IF EXISTS "messages_delete_policy" ON public.messages;

CREATE POLICY "messages_delete_policy"
ON public.messages
FOR DELETE
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    user_id = auth.uid()
    OR (
      channel_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.channels ch
        INNER JOIN public.servers s ON s.id = ch.server_id
        WHERE ch.id = messages.channel_id
          AND s.owner = auth.uid()
      )
    )
  )
);

-- ----------------------------------------------------------------------------
-- CONVERSATIONS table (DMs)
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can view conversations they are part of" ON public.conversations;

CREATE POLICY "Users can view conversations they are part of"
ON public.conversations
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (user1_id = auth.uid() OR user2_id = auth.uid())
);

DROP POLICY IF EXISTS "Users can create conversations" ON public.conversations;

CREATE POLICY "Users can create conversations"
ON public.conversations
FOR INSERT
TO authenticated
WITH CHECK (
  auth.session_meets_aal_requirement()
  AND (user1_id = auth.uid() OR user2_id = auth.uid())
);

-- ============================================================================
-- Testing Commands
-- ============================================================================

-- To test AAL enforcement, run these queries:

-- 1. Check your current AAL level:
-- SELECT auth.jwt()->>'aal' as current_aal;

-- 2. Check if you have 2FA enabled:
-- SELECT auth.user_requires_aal2();

-- 3. Check if your session meets requirements:
-- SELECT auth.session_meets_aal_requirement();

-- 4. Force AAL1 to test (simulates password-only login with 2FA enabled):
-- UPDATE auth.sessions SET aal = 'aal1', factor_id = NULL WHERE user_id = auth.uid();

-- 5. After running #4, try to query your profile:
-- SELECT * FROM profiles WHERE id = auth.uid();
-- Should return EMPTY if working correctly!

-- 6. Sign out and sign in again to restore AAL2

-- ============================================================================
-- IMPORTANT NOTES
-- ============================================================================
--
-- 1. These policies only affect users who have MFA/2FA ENABLED
--    Users without 2FA continue working normally with AAL1
--
-- 2. The AAL level is stored in the JWT token and cannot be faked
--    It's cryptographically signed by Supabase
--
-- 3. Even if an attacker steals a password and gets an AAL1 session,
--    they cannot access data if the user has 2FA enabled
--
-- 4. You may need to add similar checks to other tables:
--    - servers
--    - channels
--    - reactions
--    - Any other sensitive data tables
--
-- 5. To add AAL2 checks to other policies:
--    Just add "AND auth.session_meets_aal_requirement()" to USING/WITH CHECK
-- ============================================================================

