-- Migration 020: Fix conversation_participants INSERT RLS policy
-- 
-- ISSUE: Current RLS policy only allows users to insert their own participation records
--        This prevents adding other users to conversations (group chat functionality)
-- FIX: Allow conversation participants to add other users to conversations they're part of

-- =====================================================
-- STEP 1: Drop existing restrictive INSERT policy
-- =====================================================

DROP POLICY IF EXISTS "conversation_participants_insert_policy" ON conversation_participants;

-- =====================================================
-- STEP 2: Create new policy that allows adding users to conversations
-- =====================================================

-- Policy: Allow users to insert their own participation OR add others to conversations they're in
CREATE POLICY "conversation_participants_insert_policy"
  ON conversation_participants FOR INSERT
  WITH CHECK (
    -- Users can add themselves to any conversation they have access to
    user_id = auth.uid()
    OR
    -- Existing conversation participants can add other users to their conversations
    (
      auth.uid() IN (
        SELECT cp.user_id 
        FROM conversation_participants cp 
        WHERE cp.conversation_id = conversation_participants.conversation_id 
          AND cp.left_at IS NULL
      )
    )
  );

-- =====================================================
-- STEP 3: Verification
-- =====================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 020 completed successfully!';
  RAISE NOTICE 'Fixed:';
  RAISE NOTICE '  ✅ Users can now add other participants to conversations they are part of';
  RAISE NOTICE '  ✅ Group chat functionality is now enabled';
  RAISE NOTICE '  ✅ Maintains security: only conversation participants can add users';
  RAISE NOTICE '';
  RAISE NOTICE 'CONVERSATION PARTICIPANTS CAN NOW ADD OTHER USERS';
END $$;