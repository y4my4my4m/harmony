-- =============================================================================
-- Harmony Database Schema - Realtime Publications
-- =============================================================================
-- Only publish tables that clients still subscribe to via postgres_changes.
-- Tables migrated to broadcast (notifications, unread_counts) are excluded
-- to reduce WAL/CDC overhead.
-- =============================================================================

DROP PUBLICATION IF EXISTS supabase_realtime;

CREATE PUBLICATION supabase_realtime FOR TABLE
  -- Core messaging (active channel/DM/thread subscriptions)
  messages,
  reactions,
  -- Server structure (sidebar + channel list)
  channels,
  channel_categories,
  servers,
  user_servers,
  server_roles,
  -- DM conversations (per-conversation subscriptions)
  conversations,
  conversation_participants,
  -- User data
  profiles,
  user_view_contexts,
  -- Voice
  voice_channel_participants,
  -- Encryption key sharing
  megolm_session_shares,
  megolm_key_backups,
  -- ActivityPub (social feed subscriptions)
  posts,
  post_interactions,
  follows,
  -- Threads
  threads,
  -- Server emojis
  emojis,
  -- Federation membership events
  server_membership_events;

DO $$
BEGIN
    RAISE NOTICE 'Realtime publications configured successfully';
END $$;
