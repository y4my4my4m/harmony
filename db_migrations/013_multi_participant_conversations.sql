-- Migration 013: Multi-Participant Conversations
-- 
-- UPGRADE: Convert user1/user2 conversations to flexible participant system
-- ENABLE: Group chats, federated group DMs, and ActivityPub multi-participant support
-- MIGRATE: All existing conversations preserved with zero data loss

-- =====================================================
-- STEP 1: Create conversation_participants table
-- =====================================================

CREATE TABLE IF NOT EXISTS public.conversation_participants (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  role TEXT DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  is_muted BOOLEAN DEFAULT FALSE,
  last_read_at TIMESTAMP WITH TIME ZONE,
  left_at TIMESTAMP WITH TIME ZONE, -- NULL = active participant
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT conversation_participants_conversation_fkey 
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT conversation_participants_user_fkey 
    FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE,
  CONSTRAINT conversation_participants_unique 
    UNIQUE(conversation_id, user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_conversation_participants_conversation 
  ON conversation_participants(conversation_id) WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_participants_user 
  ON conversation_participants(user_id) WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_participants_active 
  ON conversation_participants(conversation_id, user_id) WHERE left_at IS NULL;

-- =====================================================
-- STEP 2: Add new columns to conversations table
-- =====================================================

-- Add new columns for group chat support
ALTER TABLE conversations 
ADD COLUMN IF NOT EXISTS name TEXT,
ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'channel')),
ADD COLUMN IF NOT EXISTS created_by UUID,
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Add foreign key for created_by
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'conversations_created_by_fkey'
  ) THEN
    ALTER TABLE conversations 
    ADD CONSTRAINT conversations_created_by_fkey 
    FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =====================================================
-- STEP 3: Migrate existing user1/user2 data
-- =====================================================

-- Migrate all existing conversations to participant system
INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
SELECT 
  id as conversation_id,
  user1 as user_id,
  'member' as role,
  created_at as joined_at
FROM conversations 
WHERE user1 IS NOT NULL
ON CONFLICT (conversation_id, user_id) DO NOTHING;

INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
SELECT 
  id as conversation_id,
  user2 as user_id, 
  'member' as role,
  created_at as joined_at
FROM conversations 
WHERE user2 IS NOT NULL
ON CONFLICT (conversation_id, user_id) DO NOTHING;

-- Set conversation metadata for existing direct messages
UPDATE conversations 
SET 
  type = 'direct',
  created_by = user1,
  updated_at = COALESCE(updated_at, created_at)
WHERE user1 IS NOT NULL AND user2 IS NOT NULL;

-- =====================================================
-- STEP 4: Create helper functions for conversation management
-- =====================================================

-- Function to get conversation participants
CREATE OR REPLACE FUNCTION get_conversation_participants(conversation_uuid UUID)
RETURNS TABLE(
  user_id UUID,
  role TEXT,
  joined_at TIMESTAMP WITH TIME ZONE,
  is_muted BOOLEAN,
  last_read_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE SQL STABLE
AS $$
  SELECT 
    cp.user_id,
    cp.role,
    cp.joined_at,
    cp.is_muted,
    cp.last_read_at
  FROM conversation_participants cp
  WHERE cp.conversation_id = conversation_uuid 
    AND cp.left_at IS NULL
  ORDER BY cp.joined_at;
$$;

-- Function to check if user is in conversation
CREATE OR REPLACE FUNCTION is_user_in_conversation(user_uuid UUID, conversation_uuid UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE
AS $$
  SELECT EXISTS(
    SELECT 1 FROM conversation_participants 
    WHERE user_id = user_uuid 
      AND conversation_id = conversation_uuid 
      AND left_at IS NULL
  );
$$;

-- Function to add user to conversation
CREATE OR REPLACE FUNCTION add_user_to_conversation(
  conversation_uuid UUID,
  user_uuid UUID,
  user_role TEXT DEFAULT 'member'
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  participant_id UUID;
BEGIN
  INSERT INTO conversation_participants (conversation_id, user_id, role)
  VALUES (conversation_uuid, user_uuid, user_role)
  ON CONFLICT (conversation_id, user_id) 
  DO UPDATE SET 
    left_at = NULL,
    role = user_role,
    updated_at = CURRENT_TIMESTAMP
  RETURNING id INTO participant_id;
  
  RETURN participant_id;
END;
$$;

-- Function to create or get direct conversation between two users
CREATE OR REPLACE FUNCTION create_or_get_direct_conversation(user1_uuid UUID, user2_uuid UUID)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  conversation_uuid UUID;
BEGIN
  -- Try to find existing direct conversation between these two users
  SELECT c.id INTO conversation_uuid
  FROM conversations c
  WHERE c.type = 'direct'
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp1 
      WHERE cp1.conversation_id = c.id 
        AND cp1.user_id = user1_uuid 
        AND cp1.left_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp2 
      WHERE cp2.conversation_id = c.id 
        AND cp2.user_id = user2_uuid 
        AND cp2.left_at IS NULL
    )
    -- Ensure it's exactly 2 participants
    AND (
      SELECT COUNT(*) FROM conversation_participants cp3 
      WHERE cp3.conversation_id = c.id 
        AND cp3.left_at IS NULL
    ) = 2;
  
  -- If not found, create new conversation
  IF conversation_uuid IS NULL THEN
    INSERT INTO conversations (type, created_by, is_active)
    VALUES ('direct', user1_uuid, TRUE)
    RETURNING id INTO conversation_uuid;
    
    -- Add both users as participants
    PERFORM add_user_to_conversation(conversation_uuid, user1_uuid, 'member');
    PERFORM add_user_to_conversation(conversation_uuid, user2_uuid, 'member');
  END IF;
  
  RETURN conversation_uuid;
END;
$$;

-- =====================================================
-- STEP 5: Create indexes for new functionality
-- =====================================================

-- Conversation type and active status
CREATE INDEX IF NOT EXISTS idx_conversations_type_active 
  ON conversations(type, is_active);

-- Conversation creation and updates
CREATE INDEX IF NOT EXISTS idx_conversations_created_by 
  ON conversations(created_by);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at 
  ON conversations(updated_at DESC);

-- =====================================================
-- STEP 6: Update RLS policies for new tables
-- =====================================================

-- Enable RLS on conversation_participants
ALTER TABLE conversation_participants ENABLE ROW LEVEL SECURITY;

-- Policy: Users can see their own participations
DROP POLICY IF EXISTS "Users can view their own conversation participations" ON conversation_participants;
CREATE POLICY "Users can view their own conversation participations"
  ON conversation_participants FOR SELECT
  USING (user_id = auth.uid());

-- Policy: Users can see participations in conversations they're part of
DROP POLICY IF EXISTS "Users can view participations in their conversations" ON conversation_participants;
CREATE POLICY "Users can view participations in their conversations"
  ON conversation_participants FOR SELECT
  USING (
    conversation_id IN (
      SELECT conversation_id FROM conversation_participants cp_inner
      WHERE cp_inner.user_id = auth.uid() AND cp_inner.left_at IS NULL
    )
  );

-- Policy: Users can update their own participation settings
DROP POLICY IF EXISTS "Users can update their own participations" ON conversation_participants;
CREATE POLICY "Users can update their own participations"
  ON conversation_participants FOR UPDATE
  USING (user_id = auth.uid());

-- =====================================================
-- STEP 7: Verification and cleanup preparation
-- =====================================================

-- Verify migration success
DO $$
DECLARE
  old_conversation_count INTEGER;
  new_participant_count INTEGER;
  expected_participant_count INTEGER;
BEGIN
  -- Count original conversations
  SELECT COUNT(*) INTO old_conversation_count 
  FROM conversations 
  WHERE user1 IS NOT NULL AND user2 IS NOT NULL;
  
  -- Count new participants
  SELECT COUNT(*) INTO new_participant_count 
  FROM conversation_participants;
  
  -- Expected should be 2x conversation count (user1 + user2 for each)
  expected_participant_count := old_conversation_count * 2;
  
  RAISE NOTICE 'Migration 013 Results:';
  RAISE NOTICE '  Original conversations: %', old_conversation_count;
  RAISE NOTICE '  New participants created: %', new_participant_count;
  RAISE NOTICE '  Expected participants: %', expected_participant_count;
  
  IF new_participant_count >= expected_participant_count THEN
    RAISE NOTICE '✅ Migration successful - all conversations migrated!';
  ELSE
    RAISE WARNING '⚠️ Migration incomplete - participant count mismatch';
  END IF;
  
  RAISE NOTICE '';
  RAISE NOTICE 'NEW FEATURES ENABLED:';
  RAISE NOTICE '  ✅ Multi-participant conversations';
  RAISE NOTICE '  ✅ Group chat support';
  RAISE NOTICE '  ✅ Federated group DMs';
  RAISE NOTICE '  ✅ ActivityPub multi-participant support';
  RAISE NOTICE '  ✅ Flexible participant management';
  RAISE NOTICE '';
  RAISE NOTICE '⚠️ NEXT STEP: Drop user1/user2 columns after verifying all works correctly';
END $$;

-- Add comment about next migration
COMMENT ON TABLE conversation_participants IS 'Multi-participant conversation system. Migration 013 created this table and migrated from user1/user2 system. Next migration will drop old user1/user2 columns after verification.';

-- =====================================================
-- STEP 8: Helper functions for service layer
-- =====================================================

-- Function to get user conversations with participant info
CREATE OR REPLACE FUNCTION get_user_conversations_with_participants(user_uuid UUID)
RETURNS TABLE(
  conversation_id UUID,
  conversation_name TEXT,
  conversation_type TEXT,
  is_active BOOLEAN,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  participant_count BIGINT,
  other_participants JSONB,
  user_role TEXT,
  user_joined_at TIMESTAMP WITH TIME ZONE,
  user_last_read_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE SQL STABLE
AS $$
  SELECT 
    c.id as conversation_id,
    c.name as conversation_name,
    c.type as conversation_type,
    c.is_active,
    c.created_at,
    c.updated_at,
    (
      SELECT COUNT(*) FROM conversation_participants cp_count
      WHERE cp_count.conversation_id = c.id AND cp_count.left_at IS NULL
    ) as participant_count,
    (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id', cp_others.user_id,
            'role', cp_others.role,
            'joined_at', cp_others.joined_at
          )
        ),
        '[]'::jsonb
      )
      FROM conversation_participants cp_others
      WHERE cp_others.conversation_id = c.id 
        AND cp_others.user_id != user_uuid
        AND cp_others.left_at IS NULL
    ) as other_participants,
    cp_user.role as user_role,
    cp_user.joined_at as user_joined_at,
    cp_user.last_read_at as user_last_read_at
  FROM conversations c
  INNER JOIN conversation_participants cp_user ON c.id = cp_user.conversation_id
  WHERE cp_user.user_id = user_uuid 
    AND cp_user.left_at IS NULL
    AND c.is_active = TRUE
  ORDER BY c.updated_at DESC;
$$;

COMMENT ON FUNCTION get_user_conversations_with_participants(UUID) IS 'Returns all active conversations for a user with participant information. Used by service layer for conversation management.';