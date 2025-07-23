-- Migration 083: Ensure Conversation Participants Table Exists
-- Required for the federated private messaging architecture

BEGIN;

-- =================================================================
-- Create conversation_participants table if it doesn't exist
-- =================================================================

CREATE TABLE IF NOT EXISTS conversation_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member' CHECK (role IN ('member', 'admin', 'moderator')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Constraints
  UNIQUE (conversation_id, user_id),
  CHECK (left_at IS NULL OR left_at >= joined_at)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_conversation_participants_conversation_id 
  ON conversation_participants(conversation_id);

CREATE INDEX IF NOT EXISTS idx_conversation_participants_user_id 
  ON conversation_participants(user_id);

CREATE INDEX IF NOT EXISTS idx_conversation_participants_active 
  ON conversation_participants(conversation_id, user_id) 
  WHERE left_at IS NULL;

-- =================================================================
-- Row Level Security
-- =================================================================

ALTER TABLE conversation_participants ENABLE ROW LEVEL SECURITY;

-- Users can see participants in conversations they're part of
CREATE POLICY IF NOT EXISTS "Users can view conversation participants" 
  ON conversation_participants FOR SELECT 
  USING (
    EXISTS (
      SELECT 1 FROM conversation_participants cp 
      WHERE cp.conversation_id = conversation_participants.conversation_id 
        AND cp.user_id = auth.uid()::uuid 
        AND cp.left_at IS NULL
    )
  );

-- Users can join conversations (handled by functions)
CREATE POLICY IF NOT EXISTS "Users can join conversations" 
  ON conversation_participants FOR INSERT 
  WITH CHECK (user_id = auth.uid()::uuid);

-- Users can leave conversations
CREATE POLICY IF NOT EXISTS "Users can leave conversations" 
  ON conversation_participants FOR UPDATE 
  USING (user_id = auth.uid()::uuid);

-- =================================================================
-- Migration: Convert existing conversations if needed
-- =================================================================

DO $$
DECLARE
  conv_record RECORD;
  participant_count INTEGER;
BEGIN
  -- Check if we have old-style conversations (user1/user2 columns)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'conversations' 
    AND column_name IN ('user1', 'user2')
  ) THEN
    
    RAISE NOTICE 'Converting existing conversations to participant system...';
    
    -- Convert existing conversations
    FOR conv_record IN 
      SELECT id, user1, user2 
      FROM conversations 
      WHERE user1 IS NOT NULL AND user2 IS NOT NULL
    LOOP
      -- Check if participants already exist
      SELECT COUNT(*) INTO participant_count
      FROM conversation_participants
      WHERE conversation_id = conv_record.id;
      
      -- Only add participants if none exist
      IF participant_count = 0 THEN
        INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
        VALUES 
          (conv_record.id, conv_record.user1, 'member', NOW()),
          (conv_record.id, conv_record.user2, 'member', NOW())
        ON CONFLICT (conversation_id, user_id) DO NOTHING;
        
        RAISE NOTICE 'Converted conversation % with users % and %', 
          conv_record.id, conv_record.user1, conv_record.user2;
      END IF;
    END LOOP;
    
    RAISE NOTICE 'Conversation migration completed';
  END IF;
END $$;

-- =================================================================
-- Helper function to ensure conversation type is set
-- =================================================================

-- Ensure conversations have proper type
UPDATE conversations 
SET type = 'direct' 
WHERE type IS NULL 
  AND EXISTS (
    SELECT 1 FROM conversation_participants cp 
    WHERE cp.conversation_id = conversations.id 
    GROUP BY cp.conversation_id 
    HAVING COUNT(*) = 2
  );

UPDATE conversations 
SET type = 'group' 
WHERE type IS NULL 
  AND EXISTS (
    SELECT 1 FROM conversation_participants cp 
    WHERE cp.conversation_id = conversations.id 
    GROUP BY cp.conversation_id 
    HAVING COUNT(*) > 2
  );

-- =================================================================
-- Verification
-- =================================================================

DO $$
BEGIN
  -- Verify table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'conversation_participants'
  ) THEN
    RAISE EXCEPTION 'conversation_participants table was not created';
  END IF;
  
  -- Verify indexes exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE tablename = 'conversation_participants' 
    AND indexname = 'idx_conversation_participants_conversation_id'
  ) THEN
    RAISE EXCEPTION 'Required index idx_conversation_participants_conversation_id not found';
  END IF;
  
  RAISE NOTICE '✅ Migration 083 completed successfully';
  RAISE NOTICE '📋 conversation_participants table ready for federated messaging';
END $$;

COMMIT;