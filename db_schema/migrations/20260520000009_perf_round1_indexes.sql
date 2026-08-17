-- ---------------------------------------------------------------------------
-- Round-1 performance indexes (BUGS.md PH1).
--
-- 19 indexes that were present in production (`db_schema/latest_dev_backup.sql`)
-- but missing from the init scripts. Each one was verified to have a real
-- code consumer in `src/`, `federation-backend/src/`, or `bot-gateway/src/`
-- before being included - three originally proposed indexes
-- (`idx_messages_encrypted`, `idx_messages_megolm_session`,
-- `idx_reactions_metadata`) were dropped on second review because no
-- query in the codebase uses them as a filter predicate.
--
-- Run this once on each deployed environment. Fresh installs pick the
-- same indexes up automatically via `db_schema/init/14_indexes_perf.sql`.
--
-- ---------------------------------------------------------------------------
-- RUN INSTRUCTIONS
-- ---------------------------------------------------------------------------
--
-- Just paste this entire file into the Supabase SQL editor and click Run.
-- The file is wrapped in a single BEGIN/COMMIT so partial failure rolls
-- back cleanly.
--
-- ---------------------------------------------------------------------------
-- NOTE ON `CONCURRENTLY`
-- ---------------------------------------------------------------------------
--
-- These statements use plain `CREATE INDEX IF NOT EXISTS` - not
-- `CONCURRENTLY`. The trade-off:
--
--   - CREATE INDEX takes an ACCESS EXCLUSIVE lock on each table for the
--     duration of that one table's index build. On hobby-scale tables
--     (≤ ~1M rows) this is sub-second to a few seconds; on a Harmony
--     deployment we've measured well under 10 s total for all 19. The
--     bot gateway / federation worker / frontend will see brief query
--     errors during that window.
--
--   - CONCURRENTLY would avoid the lock but cannot run inside ANY
--     transaction block - including the implicit transaction the
--     Supabase SQL editor uses when you paste multi-statement input -
--     producing `ERROR: 25001`. Running CONCURRENTLY requires either a
--     direct `psql` connection (no `--single-transaction`) or running
--     each statement individually.
--
-- If your `messages` / `posts` tables ever grow large enough that the
-- brief lock matters, run the same statements one at a time via the
-- SQL editor, OR via `psql "$DATABASE_URL" -f` after replacing each
-- `CREATE INDEX IF NOT EXISTS` with `CREATE INDEX CONCURRENTLY IF NOT
-- EXISTS` and removing the `BEGIN`/`COMMIT` wrapper. (Don't do this if
-- you don't need to - the brief lock is cheap.)
--
-- ---------------------------------------------------------------------------

BEGIN;

-- profiles ------------------------------------------------------------------
--
-- NOTE: We intentionally do NOT add `idx_profiles_auth_user_id`. The
-- `auth_user_id uuid UNIQUE` column-level constraint on `profiles`
-- already creates an implicit btree index that `.eq('auth_user_id', ...)`
-- queries use.

CREATE INDEX IF NOT EXISTS idx_profiles_federation_enabled
  ON public.profiles (id) WHERE is_local = true;

CREATE INDEX IF NOT EXISTS idx_profiles_federation_lookup
  ON public.profiles (domain, federation_enabled)
  WHERE federation_enabled = true;

-- posts (timeline hot paths) ------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_posts_author_count
  ON public.posts (author_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_posts_federated_timeline
  ON public.posts (created_at DESC)
  WHERE is_local = false
    AND visibility = 'public'
    AND (is_deleted = false OR is_deleted IS NULL)
    AND deleted_at IS NULL
    AND in_reply_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_posts_local_public_created_at
  ON public.posts (is_local, created_at DESC)
  WHERE visibility = 'public' AND NOT COALESCE(is_deleted, false);

-- Legacy timeline indexes retained from prod for compatibility with any
-- code that references them by name. (Postgres plans by structure, not
-- name, but query patterns matching their partial-index predicates exist
-- in `init/13_functions_rpc_extended.sql`.)
CREATE INDEX IF NOT EXISTS timeline_posts_local_created_idx
  ON public.posts (is_local, created_at DESC)
  WHERE is_deleted = false AND visibility = 'public';

CREATE INDEX IF NOT EXISTS timeline_posts_visibility_created_idx
  ON public.posts (visibility, created_at DESC)
  WHERE is_deleted = false;

-- messages (bot / federation hot paths) -------------------------------------
--
-- NOTE: `idx_messages_encrypted` and `idx_messages_megolm_session` from
-- the prod dump are intentionally NOT ported. A code audit found no
-- `.eq('encrypted', ...)` or `.eq('megolm_session_id', ...)` filter
-- usage; both columns are only set/read via SELECT *. They were
-- dev-backup-only artifacts.

CREATE INDEX IF NOT EXISTS idx_messages_bot_id
  ON public.messages (bot_id) WHERE bot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_bot_channel
  ON public.messages (bot_id, channel_id) WHERE bot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_federation_pending
  ON public.messages (federation_status, created_at)
  WHERE federation_status = 'pending' AND conversation_id IS NOT NULL;

-- reactions -----------------------------------------------------------------
--
-- NOTE: `idx_reactions_metadata` (GIN) is intentionally NOT ported.
-- The only `.contains('metadata', ...)` query in the codebase is on the
-- `messages` table, not `reactions`. The agent's original justification
-- referenced a non-existent file.

CREATE INDEX IF NOT EXISTS idx_reactions_bot_id
  ON public.reactions (bot_id);

CREATE INDEX IF NOT EXISTS idx_reactions_bot_message
  ON public.reactions (bot_id, message_id) WHERE bot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reactions_user_message
  ON public.reactions (user_id, message_id);

-- ap_activities (federation worker) -----------------------------------------

CREATE INDEX IF NOT EXISTS idx_ap_activities_federation_status
  ON public.ap_activities (status, is_local, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_ap_activities_origin_domain
  ON public.ap_activities (origin_domain);

CREATE INDEX IF NOT EXISTS idx_ap_activities_status_type
  ON public.ap_activities (status, ap_type) WHERE status = 'pending';

-- notifications -------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_notifications_expires_at
  ON public.notifications (expires_at);

CREATE INDEX IF NOT EXISTS idx_notifications_type
  ON public.notifications (type);

-- bot_rate_limits -----------------------------------------------------------
-- Replaces the old `idx_bot_rate_limits_reset` (referenced the renamed
-- `reset_at` column; Part 1 of this round dropped that stale index).

CREATE INDEX IF NOT EXISTS idx_bot_rate_limits_resets_at
  ON public.bot_rate_limits (resets_at);

COMMIT;

NOTIFY pgrst, 'reload schema';
