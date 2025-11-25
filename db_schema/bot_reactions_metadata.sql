-- Migration: Add bot support and metadata to reactions table
-- Also add message editing/deletion support

-- 1. Modify reactions table to support bot reactions with metadata

-- Drop existing constraint if it exists
ALTER TABLE public.reactions 
  DROP CONSTRAINT IF EXISTS reactions_user_or_bot_check;

-- Make user_id nullable for bot reactions
ALTER TABLE public.reactions 
  ALTER COLUMN user_id DROP NOT NULL;

-- Add bot_id column if it doesn't exist
ALTER TABLE public.reactions 
  ADD COLUMN IF NOT EXISTS bot_id UUID REFERENCES public.bots(id) ON DELETE CASCADE;

-- Add metadata column if it doesn't exist
ALTER TABLE public.reactions 
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Add check constraint: either user_id OR bot_id must be present, but not both
ALTER TABLE public.reactions 
  ADD CONSTRAINT reactions_user_or_bot_check 
  CHECK (
    (user_id IS NOT NULL AND bot_id IS NULL) OR 
    (user_id IS NULL AND bot_id IS NOT NULL)
  );

-- Add index for bot reactions if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_reactions_bot_id ON public.reactions(bot_id);

-- Add index for metadata queries (GIN index for JSONB) if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_reactions_metadata ON public.reactions USING gin(metadata);

-- 2. Grant permissions for bot API to manage reactions
-- (Service role bypasses RLS, so no RLS policies needed)

COMMENT ON COLUMN public.reactions.bot_id IS 'Bot that added the reaction (mutually exclusive with user_id)';
COMMENT ON COLUMN public.reactions.metadata IS 'Additional metadata for reactions, e.g. Discord user info for bridged reactions';

