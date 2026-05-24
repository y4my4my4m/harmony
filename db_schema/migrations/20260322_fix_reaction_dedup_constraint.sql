BEGIN;

-- Fix reaction deduplication for federated reactions.
--
-- The existing UNIQUE constraint (message_id, user_id, emoji_id) does NOT
-- prevent duplicate reactions when emoji_id IS NULL (native/unicode emoji)
-- because PostgreSQL treats NULLs as distinct for uniqueness purposes.
--
-- This migration adds a functional unique index that uses COALESCE to convert
-- NULLs to sentinel values, preventing the same user from reacting with the
-- same emoji twice on the same message - even when emoji_id is NULL.

-- First, clean up any existing duplicates (keep the oldest row per group)
DELETE FROM reactions
WHERE id NOT IN (
  SELECT DISTINCT ON (
    message_id,
    COALESCE(emoji_id, '00000000-0000-0000-0000-000000000000'::uuid),
    user_id,
    COALESCE(custom_emoji_content, '')
  ) id
  FROM reactions
  ORDER BY
    message_id,
    COALESCE(emoji_id, '00000000-0000-0000-0000-000000000000'::uuid),
    user_id,
    COALESCE(custom_emoji_content, ''),
    created_at ASC
);

-- Also clean up rows where both emoji_id (as a UUID) and emoji_id=NULL exist
-- for the same user+message+emoji content - keep the one with emoji_id set
DELETE FROM reactions r1
WHERE r1.emoji_id IS NULL
  AND r1.custom_emoji_content IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM reactions r2
    WHERE r2.message_id = r1.message_id
      AND r2.user_id = r1.user_id
      AND r2.custom_emoji_content = r1.custom_emoji_content
      AND r2.emoji_id IS NOT NULL
      AND r2.id != r1.id
  );

-- Create the new functional unique index
CREATE UNIQUE INDEX IF NOT EXISTS reactions_message_user_emoji_unique
ON reactions (
  message_id,
  user_id,
  COALESCE(emoji_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(custom_emoji_content, '')
);

COMMIT;
