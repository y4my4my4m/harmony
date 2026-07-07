-- ===========================================================================
-- Performance indexes (BUGS.md PH1, addendum 2026-05-20)
-- ===========================================================================
--
-- This file ports indexes that exist in production (per
-- db_schema/latest_dev_backup.sql) but were missing from init/. They were
-- verified against actual query usage in src/, federation-backend/src/,
-- and bot-gateway/src/ before being added - see the investigation in
-- BUGS.md addendum. Indexes that only appear in the prod dump but have no
-- code consumers (mostly legacy pgboss runtime tables and abandoned
-- features) are NOT ported here.
--
-- Each index is wrapped in `IF NOT EXISTS` so this file is idempotent and
-- safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- profiles (federation lookup hot paths)
-- ---------------------------------------------------------------------------

-- NOTE: We do NOT add `idx_profiles_auth_user_id` here. The
-- `auth_user_id uuid UNIQUE` column-level constraint on `profiles`
-- (db_schema/init/02_tables_core.sql:59) already creates an implicit
-- btree index that `.eq('auth_user_id', ...)` queries use. Adding a
-- second non-unique index on the same column would just double WAL
-- writes per profile mutation with no planner benefit. The
-- `idx_profiles_auth_user_id` and `idx_profiles_auth_user_id_unique`
-- present in `latest_dev_backup.sql` are prod-drift artifacts, not
-- something to mirror.

-- "all local profiles" queries during federation outbound delivery.
CREATE INDEX IF NOT EXISTS idx_profiles_federation_enabled
  ON public.profiles (id) WHERE is_local = true;

-- Federation discovery / actor refresh: filter by domain among
-- federation-enabled remote profiles.
CREATE INDEX IF NOT EXISTS idx_profiles_federation_lookup
  ON public.profiles (domain, federation_enabled)
  WHERE federation_enabled = true;

-- ---------------------------------------------------------------------------
-- posts (timeline hot paths)
-- ---------------------------------------------------------------------------

-- Author post counts excluding tombstones.
CREATE INDEX IF NOT EXISTS idx_posts_author_count
  ON public.posts (author_id) WHERE deleted_at IS NULL;

-- Federated timeline: public, non-local, top-level, not deleted, newest first.
-- This is the bread-and-butter timeline query for federated views.
CREATE INDEX IF NOT EXISTS idx_posts_federated_timeline
  ON public.posts (created_at DESC)
  WHERE is_local = false
    AND visibility = 'public'
    AND (is_deleted = false OR is_deleted IS NULL)
    AND deleted_at IS NULL
    AND in_reply_to IS NULL;

-- Local-vs-federated split for "local-only" and "all" timelines.
CREATE INDEX IF NOT EXISTS idx_posts_local_public_created_at
  ON public.posts (is_local, created_at DESC)
  WHERE visibility = 'public' AND NOT COALESCE(is_deleted, false);

-- Legacy timeline indexes used by some RPC paths. Names retained from the
-- prod dump for compatibility with any code that references them by name.
CREATE INDEX IF NOT EXISTS timeline_posts_local_created_idx
  ON public.posts (is_local, created_at DESC)
  WHERE is_deleted = false AND visibility = 'public';

CREATE INDEX IF NOT EXISTS timeline_posts_visibility_created_idx
  ON public.posts (visibility, created_at DESC)
  WHERE is_deleted = false;

-- Orphan-reply relink lookup (federation context fixes, 2026-05-21):
-- ActivityProcessor.relinkPendingChildren queries for orphaned replies
-- whose parent's ap_id we just imported. The set of orphaned replies is
-- always a small fraction of `posts`, so a partial expression index keeps
-- the index tiny and the lookup O(log n). See
-- migrations/20260521_orphan_reply_relink_index.sql for the rollout note.
CREATE INDEX IF NOT EXISTS idx_posts_pending_in_reply_to_ap_url
  ON public.posts ((metadata->>'in_reply_to_ap_url'))
  WHERE in_reply_to IS NULL
    AND (is_deleted = false OR is_deleted IS NULL)
    AND metadata ? 'in_reply_to_ap_url';

-- ---------------------------------------------------------------------------
-- messages (bot/channel/federation hot paths)
-- ---------------------------------------------------------------------------

-- Bot-authored message lookups. The init script had no index on
-- `messages.bot_id`, so every `.eq('bot_id', botId)` in BotRestAPI hit a
-- sequential scan once messages table grew.
CREATE INDEX IF NOT EXISTS idx_messages_bot_id
  ON public.messages (bot_id) WHERE bot_id IS NOT NULL;

-- Composite for "this bot's messages in this channel" lookups.
CREATE INDEX IF NOT EXISTS idx_messages_bot_channel
  ON public.messages (bot_id, channel_id) WHERE bot_id IS NOT NULL;

-- NOTE: We previously ported `idx_messages_encrypted` and
-- `idx_messages_megolm_session` from the prod dump on the assumption
-- that they had code consumers. A second-pass code audit found NO
-- `.eq('encrypted', ...)` or `.eq('megolm_session_id', ...)` filter
-- usage anywhere in `src/`, `federation-backend/src/`, or
-- `bot-gateway/src/` - the `encrypted` column is only ever set/read via
-- `SELECT *`, never as a WHERE-filter predicate. Both indexes were
-- dev-backup-only artifacts and are intentionally NOT ported here.

-- Federation worker scans for pending DM federation.
CREATE INDEX IF NOT EXISTS idx_messages_federation_pending
  ON public.messages (federation_status, created_at)
  WHERE federation_status = 'pending' AND conversation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- reactions (bot + user lookup hot paths)
-- ---------------------------------------------------------------------------

-- Mirror of messages.bot_id situation: bots react to messages and we
-- look up reactions by bot.
CREATE INDEX IF NOT EXISTS idx_reactions_bot_id
  ON public.reactions (bot_id);

-- Composite partial for bot reactions on a specific message.
CREATE INDEX IF NOT EXISTS idx_reactions_bot_message
  ON public.reactions (bot_id, message_id) WHERE bot_id IS NOT NULL;

-- Has-current-user-reacted lookup (CoreMessageService.ts:636).
CREATE INDEX IF NOT EXISTS idx_reactions_user_message
  ON public.reactions (user_id, message_id);

-- NOTE: `idx_reactions_metadata` (GIN on jsonb) is intentionally NOT
-- ported. The second-pass audit found the only `.contains('metadata', ...)`
-- predicate in the codebase is on the `messages` table, not `reactions`
-- (federation-backend/src/activitypub/ActivityProcessor.ts:3042).
-- The agent's original justification referenced a `reactionHandler.ts:1263`
-- that does not exist in the current tree.

-- ---------------------------------------------------------------------------
-- ap_activities (federation worker hot paths)
-- ---------------------------------------------------------------------------

-- Worker pulls pending/processing activities ordered by time.
CREATE INDEX IF NOT EXISTS idx_ap_activities_federation_status
  ON public.ap_activities (status, is_local, created_at)
  WHERE status IN ('pending', 'processing');

-- Origin-domain filter for per-instance auditing / rate limiting joins.
CREATE INDEX IF NOT EXISTS idx_ap_activities_origin_domain
  ON public.ap_activities (origin_domain);

-- Status+type composite for the worker's "next of kind" scan.
CREATE INDEX IF NOT EXISTS idx_ap_activities_status_type
  ON public.ap_activities (status, ap_type) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- notifications (filter + cleanup)
-- ---------------------------------------------------------------------------

-- Cleanup job that drops expired toast/transient notifications.
CREATE INDEX IF NOT EXISTS idx_notifications_expires_at
  ON public.notifications (expires_at);

-- Type filtering (useNotification.ts:326,332,338,344 build per-type
-- badges and tabs). The existing `idx_notifications_unread` is partial
-- on (user_id, is_read) and doesn't help with type filtering.
CREATE INDEX IF NOT EXISTS idx_notifications_type
  ON public.notifications (type);

-- ---------------------------------------------------------------------------
-- messages (slowmode last-message lookup)
-- ---------------------------------------------------------------------------

-- enforce_channel_slowmode() checks the author's most recent message per
-- channel on every insert into a slowmode channel.
CREATE INDEX IF NOT EXISTS idx_messages_channel_user_created
  ON public.messages (channel_id, user_id, created_at DESC)
  WHERE channel_id IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE 'Performance indexes (PH1) installed';
END $$;
