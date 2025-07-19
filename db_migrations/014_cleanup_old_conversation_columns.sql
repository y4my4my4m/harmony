-- Migration 014: Cleanup Old Conversation Columns
-- 
-- CLEANUP: Remove user1/user2 columns after participant system is verified working
-- WARNING: Only run after Migration 013 and thorough testing
-- REQUIRED: Verify all DMs work with participant system before running this

-- =====================================================
-- SAFETY CHECKS
-- =====================================================

-- Verify participant system is working
DO $$
DECLARE
  participant_count INTEGER;
  conversation_count INTEGER;
  orphaned_conversations INTEGER;
BEGIN
  -- Check if conversation_participants table exists and has data
  SELECT COUNT(*) INTO participant_count FROM conversation_participants;
  SELECT COUNT(*) INTO conversation_count FROM conversations;
  
  -- Check for conversations without participants
  SELECT COUNT(*) INTO orphaned_conversations
  FROM conversations c
  WHERE NOT EXISTS (
    SELECT 1 FROM conversation_participants cp 
    WHERE cp.conversation_id = c.id AND cp.left_at IS NULL
  );
  
  IF participant_count = 0 THEN
    RAISE EXCEPTION 'SAFETY CHECK FAILED: No participants found. Run Migration 013 first.';
  END IF;
  
  IF orphaned_conversations > 0 THEN
    RAISE EXCEPTION 'SAFETY CHECK FAILED: % conversations have no participants. Migration 013 may have failed.', orphaned_conversations;
  END IF;
  
  -- Verify we have at least as many participants as expected
  IF participant_count < (conversation_count * 2) THEN
    RAISE WARNING 'WARNING: Participant count (%) seems low for conversation count (%). Expected at least %', 
      participant_count, conversation_count, (conversation_count * 2);
  END IF;
  
  RAISE NOTICE 'SAFETY CHECKS PASSED:';
  RAISE NOTICE '  ✅ % conversations found', conversation_count;
  RAISE NOTICE '  ✅ % participants found', participant_count;
  RAISE NOTICE '  ✅ No orphaned conversations';
  RAISE NOTICE '';
END $$;

-- =====================================================
-- BACKUP DATA (JUST IN CASE)
-- =====================================================

-- Create backup table with old structure (temporary)
CREATE TABLE IF NOT EXISTS conversation_backup_pre_cleanup AS
SELECT 
  id,
  user1,
  user2,
  created_at,
  name,
  type,
  created_by,
  is_active,
  updated_at,
  metadata
FROM conversations
WHERE user1 IS NOT NULL OR user2 IS NOT NULL;

COMMENT ON TABLE conversation_backup_pre_cleanup IS 'Backup of conversations before dropping user1/user2 columns. Can be dropped after verification.';

-- =====================================================
-- UPDATE RLS POLICIES TO USE PARTICIPANT SYSTEM
-- =====================================================

-- First, we need to update all RLS policies that reference user1/user2 columns
-- to use the new conversation_participants table instead

-- =====================================================
-- UPDATE CONVERSATIONS POLICIES
-- =====================================================

-- Drop old conversation policies that reference user1/user2
DROP POLICY IF EXISTS "conversations_insert_policy" ON conversations;
DROP POLICY IF EXISTS "conversations_select_policy" ON conversations;
DROP POLICY IF EXISTS "conversations_update_policy" ON conversations;
DROP POLICY IF EXISTS "Users can view their own conversations" ON conversations;
DROP POLICY IF EXISTS "Users can create conversations" ON conversations;
DROP POLICY IF EXISTS "Users can update their own conversations" ON conversations;

-- Create new policies using participant system
CREATE POLICY "Users can view conversations they participate in"
  ON conversations FOR SELECT
  USING (
    id IN (
      SELECT conversation_id FROM conversation_participants 
      WHERE user_id = auth.uid() AND left_at IS NULL
    )
  );

CREATE POLICY "Users can create conversations"
  ON conversations FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Users can update conversations they participate in"
  ON conversations FOR UPDATE
  USING (
    id IN (
      SELECT conversation_id FROM conversation_participants 
      WHERE user_id = auth.uid() AND left_at IS NULL
    )
  );

-- =====================================================
-- UPDATE MESSAGES POLICIES
-- =====================================================

-- Drop old message policies that reference user1/user2
DROP POLICY IF EXISTS "messages_insert_policy" ON messages;
DROP POLICY IF EXISTS "messages_select_policy" ON messages;
DROP POLICY IF EXISTS "Users can view messages in their conversations" ON messages;
DROP POLICY IF EXISTS "Users can create messages in their conversations" ON messages;

-- Create new policies using participant system
CREATE POLICY "Users can view messages in conversations they participate in"
  ON messages FOR SELECT
  USING (
    conversation_id IN (
      SELECT conversation_id FROM conversation_participants 
      WHERE user_id = auth.uid() AND left_at IS NULL
    )
  );

CREATE POLICY "Users can create messages in conversations they participate in"
  ON messages FOR INSERT
  WITH CHECK (
    conversation_id IN (
      SELECT conversation_id FROM conversation_participants 
      WHERE user_id = auth.uid() AND left_at IS NULL
    )
  );

-- =====================================================
-- UPDATE REACTIONS POLICIES (MESSAGE REACTIONS ONLY)
-- =====================================================

-- Drop old reaction policies that reference user1/user2 via conversations
DROP POLICY IF EXISTS "reactions_select_policy" ON reactions;
DROP POLICY IF EXISTS "reactions_insert_policy" ON reactions;
DROP POLICY IF EXISTS "reactions_update_policy" ON reactions;
DROP POLICY IF EXISTS "reactions_delete_policy" ON reactions;

-- Create new policies using participant system for message reactions
-- NOTE: reactions table is only for message reactions (no target_type column)
CREATE POLICY "Users can view reactions on messages they can see"
  ON reactions FOR SELECT
  USING (
    message_id IN (
      SELECT m.id FROM messages m
      WHERE 
        -- For DM messages: user must be a participant
        (m.conversation_id IN (
          SELECT conversation_id FROM conversation_participants 
          WHERE user_id = auth.uid() AND left_at IS NULL
        ))
        OR
        -- For channel messages: user must be in the server
        (m.channel_id IN (
          SELECT c.id FROM channels c
          INNER JOIN user_servers us ON c.server_id = us.server_id
          WHERE us.user_id = auth.uid() AND us.status = 'member'
        ))
    )
  );

CREATE POLICY "Users can create reactions on messages they can see"
  ON reactions FOR INSERT
  WITH CHECK (
    user_id = auth.uid() 
    AND message_id IN (
      SELECT m.id FROM messages m
      WHERE 
        -- For DM messages: user must be a participant
        (m.conversation_id IN (
          SELECT conversation_id FROM conversation_participants 
          WHERE user_id = auth.uid() AND left_at IS NULL
        ))
        OR
        -- For channel messages: user must be in the server
        (m.channel_id IN (
          SELECT c.id FROM channels c
          INNER JOIN user_servers us ON c.server_id = us.server_id
          WHERE us.user_id = auth.uid() AND us.status = 'member'
        ))
    )
  );

CREATE POLICY "Users can update their own reactions"
  ON reactions FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own reactions"
  ON reactions FOR DELETE
  USING (user_id = auth.uid());

-- =====================================================
-- UPDATE POST_INTERACTIONS POLICIES (POST REACTIONS)
-- =====================================================

-- Also update post_interactions policies to not reference user1/user2
DROP POLICY IF EXISTS "post_interactions_select_policy" ON post_interactions;
DROP POLICY IF EXISTS "post_interactions_insert_policy" ON post_interactions;
DROP POLICY IF EXISTS "post_interactions_update_policy" ON post_interactions;
DROP POLICY IF EXISTS "post_interactions_delete_policy" ON post_interactions;

-- Create new policies for post interactions (including emoji reactions on posts)
CREATE POLICY "Users can view post interactions on posts they can see"
  ON post_interactions FOR SELECT
  USING (
    post_id IN (
      SELECT p.id FROM posts p
      WHERE p.user_id = auth.uid() 
        OR p.visibility = 'public'
        OR (p.visibility = 'followers' AND EXISTS (
          SELECT 1 FROM user_relationships ur 
          WHERE ur.follower_id = auth.uid() 
            AND ur.following_id = p.user_id 
            AND ur.status = 'accepted'
        ))
    )
  );

CREATE POLICY "Users can create post interactions on posts they can see"
  ON post_interactions FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND post_id IN (
      SELECT p.id FROM posts p
      WHERE p.user_id = auth.uid() 
        OR p.visibility = 'public'
        OR (p.visibility = 'followers' AND EXISTS (
          SELECT 1 FROM user_relationships ur 
          WHERE ur.follower_id = auth.uid() 
            AND ur.following_id = p.user_id 
            AND ur.status = 'accepted'
        ))
    )
  );

CREATE POLICY "Users can update their own post interactions"
  ON post_interactions FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own post interactions"
  ON post_interactions FOR DELETE
  USING (user_id = auth.uid());

-- =====================================================
-- REMOVE OLD COLUMNS AND CONSTRAINTS
-- =====================================================

-- Drop indexes on old columns first
DROP INDEX IF EXISTS idx_conversations_participants;
DROP INDEX IF EXISTS idx_conversations_participants_reverse;

-- Remove foreign key constraints on old columns
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_user1_fkey;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_user2_fkey;

-- Now we can safely drop the old columns
ALTER TABLE conversations DROP COLUMN IF EXISTS user1;
ALTER TABLE conversations DROP COLUMN IF EXISTS user2;

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Verify cleanup successful
DO $$
DECLARE
  column_exists BOOLEAN;
BEGIN
  -- Check if old columns still exist
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'conversations' 
    AND column_name IN ('user1', 'user2')
  ) INTO column_exists;
  
  IF column_exists THEN
    RAISE EXCEPTION 'CLEANUP FAILED: Old columns still exist';
  ELSE
    RAISE NOTICE 'CLEANUP SUCCESSFUL:';
    RAISE NOTICE '  ✅ Removed user1/user2 columns';
    RAISE NOTICE '  ✅ Removed old foreign key constraints';  
    RAISE NOTICE '  ✅ Removed old indexes';
    RAISE NOTICE '  ✅ Created backup table for safety';
    RAISE NOTICE '';
    RAISE NOTICE 'CONVERSATION SYSTEM FULLY UPGRADED:';
    RAISE NOTICE '  🎉 Multi-participant conversations active';
    RAISE NOTICE '  🎉 Group chat support enabled';
    RAISE NOTICE '  🎉 Federation-ready participant system';
    RAISE NOTICE '';
    RAISE NOTICE '💡 NEXT STEPS:';
    RAISE NOTICE '  1. Test all DM functionality thoroughly';
    RAISE NOTICE '  2. Test group conversation creation';
    RAISE NOTICE '  3. Drop conversation_backup_pre_cleanup table after verification';
  END IF;
END $$;