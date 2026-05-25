BEGIN;

-- =============================================================================
-- Scalability: Reduce realtime publication to only necessary tables
-- 
-- PROBLEM: ~25 tables published to realtime including high-volume ones
-- (timeline_entries, ap_activities) that don't need client subscriptions.
-- Each published table adds overhead to the replication slot.
--
-- FIX: Only publish tables that clients actually subscribe to.
-- =============================================================================

-- Drop and recreate publication with only the tables clients need
DROP PUBLICATION IF EXISTS supabase_realtime;

CREATE PUBLICATION supabase_realtime FOR TABLE
  -- Core messaging
  messages,
  reactions,
  -- Server structure (for sidebar updates)
  channels,
  channel_categories,
  servers,
  user_servers,
  server_roles,
  -- DM conversations
  conversations,
  conversation_participants,
  -- Notifications and unread state
  notifications,
  unread_counts,
  -- User data
  profiles,
  user_view_contexts,
  -- Voice
  voice_channel_participants,
  -- Encryption key sharing
  megolm_session_shares,
  megolm_key_backups,
  -- Posts (ActivityPub realtime updates)
  posts,
  post_interactions,
  follows,
  -- Threads
  threads,
  -- Server emojis
  emojis,
  -- Federation membership events
  server_membership_events;

COMMIT;

NOTIFY pgrst, 'reload schema';
