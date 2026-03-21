BEGIN;

-- Add missing unique constraint on emoji_usage required by record_emoji_usage's ON CONFLICT clause
ALTER TABLE emoji_usage
  DROP CONSTRAINT IF EXISTS emoji_usage_unique_per_context;

ALTER TABLE emoji_usage
  ADD CONSTRAINT emoji_usage_unique_per_context
  UNIQUE (emoji_id, user_id, context_type, context_id);

COMMIT;
