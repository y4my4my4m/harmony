-- Migration 015: Fix RLS Infinite Recursion
-- 
-- CRITICAL FIX: The RLS policies in Migration 014 cause infinite recursion
-- ISSUE: conversation_participants policies reference conversation_participants table in their own policies
-- SOLUTION: Use direct user_id checks instead of recursive queries

-- =====================================================
-- FIX CONVERSATION_PARTICIPANTS POLICIES (NO RECURSION)
-- =====================================================

-- Drop the problematic recursive policies
DROP POLICY IF EXISTS "Users can view participations in their conversations" ON conversation_participants;
DROP POLICY IF EXISTS "Users can view their own conversation participations" ON conversation_participants;

-- Create simple, non-recursive policies
CREATE POLICY "Users can view their own participations"
  ON conversation_participants FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can update their own participations"
  ON conversation_participants FOR UPDATE
  USING (user_id = auth.uid());

-- =====================================================
-- FIX CONVERSATIONS POLICIES (USE SIMPLE SUBQUERY)  
-- =====================================================

-- Drop old policies
DROP POLICY IF EXISTS "Users can view conversations they participate in" ON conversations;
DROP POLICY IF EXISTS "Users can create conversations" ON conversations;
DROP POLICY IF EXISTS "Users can update conversations they participate in" ON conversations;

-- Create new, properly structured policies
CREATE POLICY "Users can view conversations they participate in"
  ON conversations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversation_participants 
      WHERE conversation_id = conversations.id 
        AND user_id = auth.uid() 
        AND left_at IS NULL
    )
  );

CREATE POLICY "Users can create conversations"
  ON conversations FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Users can update conversations they participate in"
  ON conversations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM conversation_participants 
      WHERE conversation_id = conversations.id 
        AND user_id = auth.uid() 
        AND left_at IS NULL
    )
  );

-- =====================================================
-- FIX MESSAGES POLICIES (USE SIMPLE SUBQUERY)
-- =====================================================

-- Drop old policies
DROP POLICY IF EXISTS "Users can view messages in conversations they participate in" ON messages;
DROP POLICY IF EXISTS "Users can create messages in conversations they participate in" ON messages;

-- Create new, properly structured policies for messages
CREATE POLICY "Users can view messages in conversations they participate in"
  ON messages FOR SELECT
  USING (
    -- For DM messages: check conversation_participants
    (conversation_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM conversation_participants 
      WHERE conversation_id = messages.conversation_id 
        AND user_id = auth.uid() 
        AND left_at IS NULL
    ))
    OR
    -- For channel messages: check server membership
    (channel_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM channels c
      INNER JOIN user_servers us ON c.server_id = us.server_id
      WHERE c.id = messages.channel_id 
        AND us.user_id = auth.uid()
    ))
  );

CREATE POLICY "Users can create messages in conversations they participate in"
  ON messages FOR INSERT
  WITH CHECK (
    user_id = auth.uid() 
    AND (
      -- For DM messages: check conversation_participants
      (conversation_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM conversation_participants 
        WHERE conversation_id = messages.conversation_id 
          AND user_id = auth.uid() 
          AND left_at IS NULL
      ))
      OR
      -- For channel messages: check server membership
      (channel_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM channels c
        INNER JOIN user_servers us ON c.server_id = us.server_id
        WHERE c.id = messages.channel_id 
          AND us.user_id = auth.uid()
      ))
    )
  );

-- =====================================================
-- VERIFICATION
-- =====================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 015 completed successfully!';
  RAISE NOTICE 'Fixed:';
  RAISE NOTICE '  ✅ Removed infinite recursion from conversation_participants policies';
  RAISE NOTICE '  ✅ Simplified conversation_participants to direct user_id checks';
  RAISE NOTICE '  ✅ Updated conversations policies to use proper EXISTS queries';
  RAISE NOTICE '  ✅ Updated messages policies for both DMs and channels';
  RAISE NOTICE '';
  RAISE NOTICE 'RLS POLICIES ARE NOW SAFE AND NON-RECURSIVE';
END $$;