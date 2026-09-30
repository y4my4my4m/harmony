-- Partial indexes for the federation_status = 'pending' sweeps (one query per
-- table per 60 s) and a created_at index for the reaction poll
-- (created_at > $1 ORDER BY created_at LIMIT 100, every 2 s).
--
-- federation_status defaults to 'pending' and leaves it once the row is
-- queued, so the pending set stays small. Without a partial index each sweep
-- query is a sequential scan of the whole table.
--
-- idx_reactions_federation_pending and idx_posts_federation_pending match the
-- definitions production already carries; IF NOT EXISTS leaves them untouched
-- there. idx_messages_federation_pending covers DMs only
-- (conversation_id IS NOT NULL); the channel sweeps filter conversation_id IS
-- NULL and need their own.
--
-- Measured on a local supabase/postgres 15.8 build of the baseline with 2.3M
-- messages, 600k reactions, 1M posts, nothing pending, warm cache:
--   new/edited channel-message sweep  90-94 ms parallel seq scan  ->  0.01 ms
--   reaction sweep                    24 ms parallel seq scan     ->  0.01 ms
--   post sweep                        13 ms parallel seq scan     ->  0.01 ms
--   reaction poll                     24 ms parallel seq scan     ->  0.05 ms
-- Build time on that dataset: 0.03-0.21 s per index. Each build holds a SHARE
-- lock that blocks writes to its table for its duration.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS idx_messages_federation_pending_channel
  ON public.messages (created_at)
  WHERE federation_status = 'pending' AND conversation_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_reactions_federation_pending
  ON public.reactions (federation_status, created_at)
  WHERE federation_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_posts_federation_pending
  ON public.posts (federation_status, created_at)
  WHERE federation_status = 'pending' AND is_local = true;

CREATE INDEX IF NOT EXISTS idx_reactions_created_at
  ON public.reactions (created_at);

COMMIT;
