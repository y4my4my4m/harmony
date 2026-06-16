-- =============================================================================
-- Harmony Database Schema - Realtime Publications
-- =============================================================================
-- After the Phase 5 broadcast migration, only message delivery still uses
-- postgres_changes (CDC).  All other realtime events - including reactions -
-- are delivered via broadcast triggers to user:{id}, server-scoped, or
-- per-context message topics (channel-messages-{id} / dm-conversation-{id}).
--
-- Keeping the publication minimal reduces WAL decoding overhead significantly.
-- =============================================================================

DROP PUBLICATION IF EXISTS supabase_realtime;

CREATE PUBLICATION supabase_realtime FOR TABLE
  messages;

DO $$
BEGIN
    RAISE NOTICE 'Realtime publications configured (messages only)';
END $$;
