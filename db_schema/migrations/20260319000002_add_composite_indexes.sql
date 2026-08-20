BEGIN;

-- =============================================================================
-- Composite indexes for message pagination performance
-- =============================================================================

-- Channel message pagination: the most common query pattern.
-- CoreMessageService filters: channel_id, thread_id IS NULL, is_deleted, ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_messages_channel_created_main
  ON messages (channel_id, created_at DESC)
  WHERE thread_id IS NULL AND (is_deleted IS NULL OR is_deleted = false);

-- DM message pagination: conversation_id ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL
    AND thread_id IS NULL
    AND (is_deleted IS NULL OR is_deleted = false);

-- Thread message pagination within a channel.
CREATE INDEX IF NOT EXISTS idx_messages_thread_created
  ON messages (thread_id, created_at ASC)
  WHERE thread_id IS NOT NULL;

-- =============================================================================
-- Indexes for RLS block-check functions (is_blocked_by / has_blocked)
-- =============================================================================

-- These composite indexes cover the most common access patterns in RLS policies
-- that call is_blocked_by() and has_blocked() per row.
-- Note: can't use NOW() in partial index predicates (not IMMUTABLE),
-- so we index all rows and let the query filter expired blocks at runtime.
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker_blocked
  ON user_blocks (blocker_id, blocked_user_id);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked_blocker
  ON user_blocks (blocked_user_id, blocker_id);

-- =============================================================================
-- Indexes for RLS membership checks (messages_select_channel_member)
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_user_servers_user_server
  ON user_servers (user_id, server_id);

CREATE INDEX IF NOT EXISTS idx_conversation_participants_conv_user
  ON conversation_participants (conversation_id, user_id);

-- =============================================================================
-- Timeline entry indexes for feed queries
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_timeline_entries_user_type_position
  ON timeline_entries (user_id, timeline_type, position DESC);

COMMIT;

NOTIFY pgrst, 'reload schema';
