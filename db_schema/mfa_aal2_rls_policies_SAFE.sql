-- ============================================================================
-- MFA/2FA Critical RLS Policies - MINIMAL SAFE VERSION
-- ============================================================================
-- This file ONLY updates the most critical policies to add AAL2 enforcement.
-- It matches your EXACT current schema structure.
--
-- WHAT THIS COVERS:
-- ✅ profiles (UPDATE only)
-- ✅ messages (SELECT, INSERT, UPDATE, DELETE)
-- ✅ conversations (SELECT, INSERT)
--
-- WHAT THIS SKIPS (to avoid errors):
-- ⚠️ servers, channels, reactions - will update these later
--
-- SAFE TO RUN: Uses DROP IF EXISTS and CREATE OR REPLACE
-- ============================================================================

-- ============================================================================
-- Step 1: Helper Functions (Safe - CREATE OR REPLACE)
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
-- Step 2: PROFILES - Critical user data protection
-- ============================================================================

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

-- ============================================================================
-- Step 3: MESSAGES - Critical communication data
-- ============================================================================

-- SELECT: View messages
DROP POLICY IF EXISTS "Users can view messages in conversations they participate in" ON public.messages;

CREATE POLICY "Users can view messages in conversations they participate in"
ON public.messages
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    -- DM messages: check via conversation_participants
    (
      conversation_id IS NOT NULL 
      AND EXISTS (
        SELECT 1 FROM public.conversation_participants
        WHERE conversation_participants.conversation_id = messages.conversation_id
          AND conversation_participants.user_id = auth.uid()
          AND conversation_participants.left_at IS NULL
      )
    )
    OR
    -- Channel messages: check via user_servers
    (
      channel_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.channels c
        JOIN public.user_servers us ON c.server_id = us.server_id
        WHERE c.id = messages.channel_id
          AND us.user_id = auth.uid()
      )
    )
  )
);

-- INSERT: Create messages
DROP POLICY IF EXISTS "Users can create messages in conversations they participate in" ON public.messages;

CREATE POLICY "Users can create messages in conversations they participate in"
ON public.messages
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND auth.session_meets_aal_requirement()
  AND (
    -- DM messages
    (
      conversation_id IS NOT NULL 
      AND EXISTS (
        SELECT 1 FROM public.conversation_participants
        WHERE conversation_participants.conversation_id = messages.conversation_id
          AND conversation_participants.user_id = auth.uid()
          AND conversation_participants.left_at IS NULL
      )
    )
    OR
    -- Channel messages
    (
      channel_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.channels c
        JOIN public.user_servers us ON c.server_id = us.server_id
        WHERE c.id = messages.channel_id
          AND us.user_id = auth.uid()
      )
    )
  )
);

-- UPDATE: Edit messages
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

-- DELETE: Remove messages
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

-- ============================================================================
-- Step 4: CONVERSATIONS - DM protection
-- ============================================================================

-- SELECT: View conversations
DROP POLICY IF EXISTS "Users can view conversations they participate in" ON public.conversations;

CREATE POLICY "Users can view conversations they participate in"
ON public.conversations
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND EXISTS (
    SELECT 1 FROM public.conversation_participants
    WHERE conversation_participants.conversation_id = conversations.id
      AND conversation_participants.user_id = auth.uid()
      AND conversation_participants.left_at IS NULL
  )
);

-- INSERT: Create conversations
DROP POLICY IF EXISTS "Users can create conversations" ON public.conversations;

CREATE POLICY "Users can create conversations"
ON public.conversations
FOR INSERT
TO authenticated
WITH CHECK (
  auth.session_meets_aal_requirement()
);

-- ============================================================================
-- Testing & Verification
-- ============================================================================

-- Test 1: Check functions exist
-- SELECT auth.user_requires_aal2();
-- SELECT auth.session_meets_aal_requirement();

-- Test 2: Check your current AAL
-- SELECT auth.jwt()->>'aal' as current_aal;

-- Test 3: Simulate stolen password (AAL1 with 2FA)
-- UPDATE auth.sessions SET aal = 'aal1', factor_id = NULL WHERE user_id = auth.uid();

-- Test 4: Try to access data (should fail if you have 2FA)
-- SELECT * FROM profiles WHERE id = auth.uid();
-- SELECT * FROM messages WHERE user_id = auth.uid() LIMIT 1;
-- SELECT * FROM conversations LIMIT 1;

-- Test 5: Restore AAL2
-- Log out and back in with 2FA

-- ============================================================================
-- NEXT STEPS (Optional - after this works)
-- ============================================================================
--
-- This file covers the CRITICAL data:
-- ✅ profiles, messages, conversations
--
-- Still need AAL2 checks on:
-- ⚠️ servers, channels (if server security is important)
-- ⚠️ reactions, notifications (less critical)
-- ⚠️ user_servers, conversation_participants (membership)
--
-- Add those manually once you confirm this works!
-- ============================================================================

-- ============================================================================
-- Summary of Changes
-- ============================================================================
-- 
-- This migration adds AAL2 enforcement to:
-- 
-- 1. profiles.UPDATE - Can't modify profile without 2FA (if enabled)
-- 2. messages.SELECT - Can't read messages without 2FA
-- 3. messages.INSERT - Can't send messages without 2FA
-- 4. messages.UPDATE - Can't edit messages without 2FA
-- 5. messages.DELETE - Can't delete messages without 2FA
-- 6. conversations.SELECT - Can't view DMs without 2FA
-- 7. conversations.INSERT - Can't create DMs without 2FA
--
-- Result: Users with 2FA MUST complete 2FA to access these critical features.
-- Users WITHOUT 2FA are not affected (continue with AAL1).
-- ============================================================================

