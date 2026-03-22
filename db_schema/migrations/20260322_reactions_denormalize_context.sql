BEGIN;

-- =============================================================================
-- Step 1a: Denormalize reactions table with channel_id / conversation_id
--
-- The reactions CDC subscription currently has NO filter, meaning every client
-- receives every reaction INSERT/DELETE from the entire table.  Adding the
-- parent message's channel_id or conversation_id to each reaction row lets
-- the frontend filter the subscription server-side, eliminating cross-channel
-- noise and dramatically reducing CDC traffic.
-- =============================================================================

-- 1. Add columns
ALTER TABLE public.reactions
  ADD COLUMN IF NOT EXISTS channel_id uuid,
  ADD COLUMN IF NOT EXISTS conversation_id uuid;

-- 2. Backfill from the parent message
UPDATE reactions r
SET channel_id = m.channel_id,
    conversation_id = m.conversation_id
FROM messages m
WHERE r.message_id = m.id
  AND r.channel_id IS NULL
  AND r.conversation_id IS NULL;

-- 3. Indexes for the new filter columns (used by postgres_changes filter)
CREATE INDEX IF NOT EXISTS idx_reactions_channel_id ON public.reactions(channel_id)
  WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_conversation_id ON public.reactions(conversation_id)
  WHERE conversation_id IS NOT NULL;

-- 4. Trigger: auto-populate on INSERT so new reactions always have the context
CREATE OR REPLACE FUNCTION public.populate_reaction_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.channel_id IS NULL AND NEW.conversation_id IS NULL AND NEW.message_id IS NOT NULL THEN
    SELECT m.channel_id, m.conversation_id
    INTO NEW.channel_id, NEW.conversation_id
    FROM messages m
    WHERE m.id = NEW.message_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_populate_reaction_context ON reactions;
CREATE TRIGGER trg_populate_reaction_context
  BEFORE INSERT ON reactions
  FOR EACH ROW
  EXECUTE FUNCTION populate_reaction_context();

COMMIT;
