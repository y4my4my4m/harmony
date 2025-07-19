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
-- REMOVE OLD COLUMNS
-- =====================================================

-- Drop indexes on old columns first
DROP INDEX IF EXISTS idx_conversations_participants;
DROP INDEX IF EXISTS idx_conversations_participants_reverse;

-- Remove foreign key constraints on old columns
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_user1_fkey;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_user2_fkey;

-- Drop the old columns
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