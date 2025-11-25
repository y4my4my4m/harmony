-- =====================================================
-- ADD BOT MESSAGE SUPPORT
-- =====================================================
-- This script adds support for bot messages by:
-- 1. Making user_id nullable (messages can be from users OR bots)
-- 2. Adding bot_id column (references bots table)
-- 3. Adding constraint: must have either user_id OR bot_id, not both
-- 4. Adding indexes for bot messages
-- 5. Updating reactions table to support bot reactions
-- =====================================================

-- =====================================================
-- MESSAGES TABLE
-- =====================================================

-- Step 1: Make user_id nullable
ALTER TABLE public.messages 
  ALTER COLUMN user_id DROP NOT NULL;

-- Step 2: Add bot_id column
ALTER TABLE public.messages 
  ADD COLUMN bot_id UUID REFERENCES public.bots(id) ON DELETE CASCADE;

-- Step 3: Add constraint - must have exactly one of user_id or bot_id
ALTER TABLE public.messages 
  ADD CONSTRAINT messages_user_or_bot_check 
  CHECK (
    (user_id IS NOT NULL AND bot_id IS NULL) OR
    (user_id IS NULL AND bot_id IS NOT NULL)
  );

-- Step 4: Add indexes for bot messages
CREATE INDEX idx_messages_bot_id ON public.messages(bot_id) 
  WHERE bot_id IS NOT NULL;

CREATE INDEX idx_messages_bot_channel ON public.messages(bot_id, channel_id) 
  WHERE bot_id IS NOT NULL;

-- Step 5: Add foreign key with proper name
ALTER TABLE public.messages
  ADD CONSTRAINT messages_bot_id_fkey 
  FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;

-- Step 6: Add comment
COMMENT ON COLUMN public.messages.bot_id IS 
  'Bot that sent this message (mutually exclusive with user_id)';

-- =====================================================
-- REACTIONS TABLE
-- =====================================================

-- Step 7: Make reactions user_id nullable (reactions can be from users OR bots)
ALTER TABLE public.reactions 
  ALTER COLUMN user_id DROP NOT NULL;

-- Step 8: Add bot_id column to reactions
ALTER TABLE public.reactions 
  ADD COLUMN bot_id UUID REFERENCES public.bots(id) ON DELETE CASCADE;

-- Step 9: Add constraint - must have exactly one of user_id or bot_id
ALTER TABLE public.reactions 
  ADD CONSTRAINT reactions_user_or_bot_check 
  CHECK (
    (user_id IS NOT NULL AND bot_id IS NULL) OR
    (user_id IS NULL AND bot_id IS NOT NULL)
  );

-- Step 10: Add indexes for bot reactions
CREATE INDEX idx_reactions_bot_id ON public.reactions(bot_id) 
  WHERE bot_id IS NOT NULL;

CREATE INDEX idx_reactions_bot_message ON public.reactions(bot_id, message_id) 
  WHERE bot_id IS NOT NULL;

-- Step 11: Add comment
COMMENT ON COLUMN public.reactions.bot_id IS 
  'Bot that created this reaction (mutually exclusive with user_id)';

-- =====================================================
-- PERMISSIONS
-- =====================================================

-- Grant access to service_role for bot operations
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reactions TO service_role;

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Verify messages table structure
SELECT 
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'messages'
  AND column_name IN ('user_id', 'bot_id')
ORDER BY column_name;

-- Verify reactions table structure
SELECT 
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'reactions'
  AND column_name IN ('user_id', 'bot_id')
ORDER BY column_name;

