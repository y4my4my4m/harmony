-- Fix Message Editing Issues
-- 1. Change updated_at from time to timestamptz
-- 2. Add trigger to automatically update updated_at on message edits
-- 3. Add default value for updated_at

-- =====================================================
-- ISSUE #1: Fix updated_at column type
-- =====================================================

-- Drop the old column and recreate with proper type
ALTER TABLE messages 
  DROP COLUMN IF EXISTS updated_at;

-- Add updated_at with proper type and default
ALTER TABLE messages 
  ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill updated_at for existing messages (set to created_at)
UPDATE messages 
SET updated_at = created_at 
WHERE updated_at IS NULL;

-- Make updated_at NOT NULL now that we've backfilled
ALTER TABLE messages 
  ALTER COLUMN updated_at SET NOT NULL;

COMMENT ON COLUMN messages.updated_at IS 'Timestamp when the message was last updated/edited';

-- =====================================================
-- ISSUE #2: Create trigger to auto-update updated_at
-- =====================================================

-- Enable moddatetime extension if not already enabled
CREATE EXTENSION IF NOT EXISTS moddatetime SCHEMA extensions;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS messages_updated_at_trigger ON messages;
DROP TRIGGER IF EXISTS handle_updated_at ON messages;

-- Create the trigger using moddatetime
-- This automatically sets updated_at to NOW() on any UPDATE
CREATE TRIGGER handle_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW
  EXECUTE FUNCTION moddatetime(updated_at);

COMMENT ON TRIGGER handle_updated_at ON messages IS 'Automatically updates the updated_at timestamp when a message is modified';

-- =====================================================
-- Verification queries
-- =====================================================

-- Verify the column type is correct
SELECT 
  column_name, 
  data_type, 
  is_nullable,
  column_default
FROM information_schema.columns 
WHERE table_name = 'messages' 
  AND column_name = 'updated_at';

-- Test that the trigger is installed
SELECT 
  trigger_name,
  event_manipulation,
  event_object_table,
  action_statement
FROM information_schema.triggers
WHERE trigger_name = 'handle_updated_at' 
  AND event_object_table = 'messages';


