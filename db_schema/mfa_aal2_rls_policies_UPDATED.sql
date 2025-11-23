-- ============================================================================
-- MFA/2FA Row Level Security (RLS) Policies with AAL2 Enforcement - UPDATED
-- ============================================================================
-- This file adds AAL2 enforcement to match the CURRENT schema structure.
-- Compatible with conversation_participants and current policy structure.
--
-- SAFETY:
-- - Uses CREATE OR REPLACE for functions (idempotent)
-- - Uses DROP POLICY IF EXISTS (no errors if doesn't exist)
-- - Can be run multiple times safely
-- - Only affects users with 2FA enabled
-- ============================================================================

-- ============================================================================
-- Helper Functions (Create or Update)
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
-- PROFILES table - Critical: Prevent unauthorized profile updates
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
-- MESSAGES table - Critical: Protect message access
-- ============================================================================

-- View messages - Uses conversation_participants (current schema)
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

-- Create messages
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

-- Update messages
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

-- Delete messages
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
-- CONVERSATIONS table - Uses conversation_participants (current schema)
-- ============================================================================

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

DROP POLICY IF EXISTS "Users can create conversations" ON public.conversations;

CREATE POLICY "Users can create conversations"
ON public.conversations
FOR INSERT
TO authenticated
WITH CHECK (
  auth.session_meets_aal_requirement()
);

-- ============================================================================
-- CONVERSATION_PARTICIPANTS table - Control who can join/leave DMs
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own conversation participations" ON public.conversation_participants;

CREATE POLICY "Users can view their own conversation participations"
ON public.conversation_participants
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND user_id = auth.uid()
);

DROP POLICY IF EXISTS "Users can create conversation participations" ON public.conversation_participants;

CREATE POLICY "Users can create conversation participations"
ON public.conversation_participants
FOR INSERT
TO authenticated
WITH CHECK (
  auth.session_meets_aal_requirement()
  AND user_id = auth.uid()
);

-- ============================================================================
-- SERVERS table - Server ownership and visibility
-- ============================================================================

DROP POLICY IF EXISTS "Users can view public servers or their own" ON public.servers;

CREATE POLICY "Users can view public servers or their own"
ON public.servers
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND (
    visibility = 'public'
    OR owner = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_servers
      WHERE server_id = servers.id
        AND user_id = auth.uid()
    )
  )
);

DROP POLICY IF EXISTS "Server owners can update their servers" ON public.servers;

CREATE POLICY "Server owners can update their servers"
ON public.servers
FOR UPDATE
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND owner = auth.uid()
)
WITH CHECK (
  auth.session_meets_aal_requirement()
  AND owner = auth.uid()
);

-- ============================================================================
-- CHANNELS table - Channel access
-- ============================================================================

DROP POLICY IF EXISTS "Users can view channels in servers they have access to" ON public.channels;

CREATE POLICY "Users can view channels in servers they have access to"
ON public.channels
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND EXISTS (
    SELECT 1 FROM public.servers s
    WHERE s.id = channels.server_id
      AND (
        s.visibility = 'public'
        OR s.owner = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.user_servers us
          WHERE us.server_id = s.id
            AND us.user_id = auth.uid()
        )
      )
  )
);

-- ============================================================================
-- REACTIONS table - Message reactions
-- ============================================================================

DROP POLICY IF EXISTS "Users can create reactions on messages they can see" ON public.reactions;

CREATE POLICY "Users can create reactions on messages they can see"
ON public.reactions
FOR INSERT
TO authenticated
WITH CHECK (
  auth.session_meets_aal_requirement()
  AND user_id = auth.uid()
  AND message_id IN (
    SELECT m.id FROM public.messages m
    WHERE (
      -- Can see DM messages
      (
        m.conversation_id IN (
          SELECT conversation_id FROM public.conversation_participants
          WHERE user_id = auth.uid()
            AND left_at IS NULL
        )
      )
      OR
      -- Can see channel messages
      (
        m.channel_id IN (
          SELECT c.id FROM public.channels c
          JOIN public.user_servers us ON c.server_id = us.server_id
          WHERE us.user_id = auth.uid()
        )
      )
    )
  )
);

DROP POLICY IF EXISTS "Users can delete their own reactions" ON public.reactions;

CREATE POLICY "Users can delete their own reactions"
ON public.reactions
FOR DELETE
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND user_id = auth.uid()
);

-- ============================================================================
-- NOTIFICATIONS table - User notifications
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own notifications" ON public.notifications;

CREATE POLICY "Users can view their own notifications"
ON public.notifications
FOR SELECT
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND user_id = auth.uid()
);

DROP POLICY IF EXISTS "Users can update their own notifications" ON public.notifications;

CREATE POLICY "Users can update their own notifications"
ON public.notifications
FOR UPDATE
TO authenticated
USING (
  auth.session_meets_aal_requirement()
  AND user_id = auth.uid()
)
WITH CHECK (
  auth.session_meets_aal_requirement()
  AND user_id = auth.uid()
);

-- ============================================================================
-- Testing Commands
-- ============================================================================

-- 1. Check your current AAL level:
-- SELECT auth.jwt()->>'aal' as current_aal;

-- 2. Check if you have 2FA enabled:
-- SELECT auth.user_requires_aal2();

-- 3. Check if your session meets requirements:
-- SELECT auth.session_meets_aal_requirement();

-- 4. Test with AAL1 (simulates stolen password):
-- UPDATE auth.sessions SET aal = 'aal1', factor_id = NULL WHERE user_id = auth.uid();

-- 5. Try to access your data (should fail if you have 2FA):
-- SELECT * FROM profiles WHERE id = auth.uid();
-- SELECT * FROM messages WHERE user_id = auth.uid() LIMIT 5;

-- 6. Restore AAL2 by logging out and back in with 2FA

-- ============================================================================
-- IMPORTANT NOTES
-- ============================================================================
--
-- 1. Only affects users with 2FA enabled
--    Users without 2FA continue working normally with AAL1
--
-- 2. The AAL level is cryptographically signed in the JWT token
--    Cannot be faked by the client
--
-- 3. This provides defense in depth:
--    - Frontend: Blocks UI (UX)
--    - Backend: Blocks API (these policies)
--    - Database: Blocks data access (RLS enforcement)
--
-- 4. Safe to run multiple times - uses DROP IF EXISTS
--
-- 5. Compatible with current conversation_participants schema
--
-- 6. Covers critical tables:
--    ✅ profiles, messages, conversations, conversation_participants
--    ✅ servers, channels, reactions, notifications
--
-- 7. Tables NOT covered (add AAL checks if needed):
--    - user_servers (server memberships)
--    - follows (federation follows)
--    - federated_instances (public data)
--    - Other federation tables
--
-- ============================================================================

