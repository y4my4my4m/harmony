-- ============================================================================
-- FIX: Re-add MFA/AAL2 Enforcement to RLS Policies
-- ============================================================================
-- This fixes a security vulnerability where rls_performance_optimization.sql
-- accidentally removed the AAL2 checks from critical table policies.
--
-- The vulnerability allowed users with MFA enabled to access data with only
-- password authentication (AAL1), bypassing the 2FA requirement entirely.
--
-- RUN THIS IN SUPABASE SQL EDITOR IMMEDIATELY!
-- ============================================================================

-- ============================================================================
-- Step 1: Ensure helper functions exist (safe - CREATE OR REPLACE)
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
-- Step 2: MESSAGES TABLE - Critical! This was bypassed
-- ============================================================================

DROP POLICY IF EXISTS "Users can view messages in conversations they participate in" ON public.messages;

CREATE POLICY "Users can view messages in conversations they participate in" 
ON public.messages 
FOR SELECT 
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    (
      (conversation_id IS NOT NULL) 
      AND EXISTS (
        SELECT 1
        FROM public.conversation_participants
        WHERE conversation_participants.conversation_id = messages.conversation_id
          AND conversation_participants.user_id = (SELECT auth.uid())
          AND conversation_participants.left_at IS NULL
      )
    ) 
    OR 
    (
      (channel_id IS NOT NULL) 
      AND EXISTS (
        SELECT 1
        FROM public.channels c
        JOIN public.user_servers us ON c.server_id = us.server_id
        WHERE c.id = messages.channel_id 
          AND us.user_id = (SELECT auth.uid())
      )
    )
  )
);

DROP POLICY IF EXISTS "Users can create messages in conversations they participate in" ON public.messages;

CREATE POLICY "Users can create messages in conversations they participate in" 
ON public.messages 
FOR INSERT 
TO authenticated
WITH CHECK (
  auth.session_meets_aal_requirement()
  AND user_id = (SELECT auth.uid())
  AND (
    (
      (conversation_id IS NOT NULL) 
      AND EXISTS (
        SELECT 1
        FROM public.conversation_participants
        WHERE conversation_participants.conversation_id = messages.conversation_id
          AND conversation_participants.user_id = (SELECT auth.uid())
          AND conversation_participants.left_at IS NULL
      )
    ) 
    OR 
    (
      (channel_id IS NOT NULL) 
      AND EXISTS (
        SELECT 1
        FROM public.channels c
        JOIN public.user_servers us ON c.server_id = us.server_id
        WHERE c.id = messages.channel_id 
          AND us.user_id = (SELECT auth.uid())
      )
    )
  )
);

DROP POLICY IF EXISTS "Message owner or server owner can update" ON public.messages;

CREATE POLICY "Message owner or server owner can update" 
ON public.messages 
FOR UPDATE 
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    (SELECT auth.uid()) = user_id 
    OR 
    (SELECT auth.uid()) = (
      SELECT servers.owner
      FROM public.channels
      JOIN public.servers ON channels.server_id = servers.id
      WHERE channels.id = messages.channel_id
    )
  )
);

DROP POLICY IF EXISTS "messages_delete_policy" ON public.messages;

CREATE POLICY "messages_delete_policy" 
ON public.messages 
FOR DELETE 
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    user_id = (SELECT auth.uid()) 
    OR 
    (
      (channel_id IS NOT NULL) 
      AND EXISTS (
        SELECT 1
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = messages.channel_id 
          AND s.owner = (SELECT auth.uid())
      )
    )
  )
);

-- ============================================================================
-- Step 3: PROFILES TABLE - Prevent unauthorized profile changes
-- ============================================================================

DROP POLICY IF EXISTS "Users can update own profile." ON public.profiles;

CREATE POLICY "Users can update own profile." 
ON public.profiles 
FOR UPDATE 
TO authenticated
USING (
  (SELECT auth.uid()) = id 
  AND auth.session_meets_aal_requirement()
)
WITH CHECK (
  (SELECT auth.uid()) = id 
  AND auth.session_meets_aal_requirement()
);

-- ============================================================================
-- Step 4: CONVERSATIONS TABLE - Protect DM access
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their conversations" ON public.conversations;

CREATE POLICY "Users can view their conversations" 
ON public.conversations 
FOR SELECT 
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND EXISTS (
    SELECT 1 
    FROM public.conversation_participants
    WHERE conversation_participants.conversation_id = conversations.id
      AND conversation_participants.user_id = (SELECT auth.uid())
      AND conversation_participants.left_at IS NULL
  )
);

DROP POLICY IF EXISTS "Users can create conversations" ON public.conversations;

CREATE POLICY "Users can create conversations" 
ON public.conversations 
FOR INSERT 
TO authenticated
WITH CHECK (
  auth.session_meets_aal_requirement()
);

-- ============================================================================
-- Step 5: CONVERSATION_PARTICIPANTS TABLE - Protect DM membership
-- ============================================================================

-- Helper function to check conversation membership WITHOUT triggering RLS
-- SECURITY DEFINER bypasses RLS, preventing infinite recursion
CREATE OR REPLACE FUNCTION public.user_is_conversation_member(p_conversation_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.conversation_participants
    WHERE conversation_id = p_conversation_id
      AND user_id = p_user_id
      AND left_at IS NULL
  );
$$;

DROP POLICY IF EXISTS "Users can view participants in their conversations" ON public.conversation_participants;

CREATE POLICY "Users can view participants in their conversations" 
ON public.conversation_participants 
FOR SELECT 
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    -- User can always see their own participation record
    user_id = (SELECT auth.uid())
    OR
    -- User can see other participants if they're in the same conversation
    -- Uses SECURITY DEFINER function to avoid RLS recursion
    public.user_is_conversation_member(conversation_id, (SELECT auth.uid()))
  )
);

DROP POLICY IF EXISTS "Users can join conversations they're invited to" ON public.conversation_participants;

CREATE POLICY "Users can join conversations they're invited to" 
ON public.conversation_participants 
FOR INSERT 
TO authenticated
WITH CHECK (
  auth.session_meets_aal_requirement()
);

DROP POLICY IF EXISTS "conversation_participants_update_policy" ON public.conversation_participants;

CREATE POLICY "conversation_participants_update_policy" 
ON public.conversation_participants 
FOR UPDATE 
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND user_id = (SELECT auth.uid())
);

DROP POLICY IF EXISTS "conversation_participants_delete_policy" ON public.conversation_participants;

CREATE POLICY "conversation_participants_delete_policy" 
ON public.conversation_participants 
FOR DELETE 
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND user_id = (SELECT auth.uid())
);

-- ============================================================================
-- Step 6: SERVERS TABLE - Protect server ownership operations
-- ============================================================================

DROP POLICY IF EXISTS "Server owners can update their servers" ON public.servers;

CREATE POLICY "Server owners can update their servers" 
ON public.servers 
FOR UPDATE 
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND owner = (SELECT auth.uid())
)
WITH CHECK (
  auth.session_meets_aal_requirement()
  AND owner = (SELECT auth.uid())
);

DROP POLICY IF EXISTS "Server owners can delete their servers" ON public.servers;

CREATE POLICY "Server owners can delete their servers" 
ON public.servers 
FOR DELETE 
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND owner = (SELECT auth.uid())
);

-- ============================================================================
-- Step 7: USER_SERVERS TABLE - Protect server membership
-- ============================================================================

DROP POLICY IF EXISTS "Users can leave servers" ON public.user_servers;

CREATE POLICY "Users can leave servers" 
ON public.user_servers 
FOR DELETE 
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    user_id = (SELECT auth.uid())
    OR 
    EXISTS (
      SELECT 1 FROM public.servers 
      WHERE servers.id = user_servers.server_id 
        AND servers.owner = (SELECT auth.uid())
    )
  )
);

-- ============================================================================
-- VERIFICATION QUERIES - Run these after applying to verify
-- ============================================================================

-- Test 1: Check if function exists and works
-- SELECT auth.session_meets_aal_requirement();

-- Test 2: Check your current AAL level
-- SELECT auth.jwt()->>'aal' as current_aal;

-- Test 3: Check if you require AAL2
-- SELECT auth.user_requires_aal2();

-- Test 4: List all policies on messages table to verify AAL check is present
-- SELECT policyname, qual FROM pg_policies WHERE tablename = 'messages';

-- ============================================================================
-- SECURITY SUMMARY
-- ============================================================================
-- 
-- With these policies in place:
-- 
-- 1. Users WITHOUT MFA: Continue working normally (AAL1 is sufficient)
-- 
-- 2. Users WITH MFA enabled but only AAL1 session (the bypass scenario):
--    ❌ Cannot read messages
--    ❌ Cannot send messages  
--    ❌ Cannot update/delete messages
--    ❌ Cannot update profile
--    ❌ Cannot view conversations
--    ❌ Cannot modify server membership
--    ❌ Cannot modify servers they own
-- 
-- 3. Users WITH MFA who completed verification (AAL2):
--    ✅ Full access as expected
--
-- The AAL level is cryptographically signed in the JWT and CANNOT be faked.
-- Even with Chrome DevTools, an attacker cannot bypass these backend checks.
-- ============================================================================

