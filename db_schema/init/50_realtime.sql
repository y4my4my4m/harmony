-- =============================================================================
-- Harmony Database Schema - Realtime Publications
-- =============================================================================
-- After the Phase 5 broadcast migration, only messages and reactions still
-- use postgres_changes (CDC).  All other realtime events are delivered via
-- broadcast triggers to user:{id} or server-scoped topics.
--
-- Keeping the publication minimal reduces WAL decoding overhead significantly.
-- =============================================================================

DROP PUBLICATION IF EXISTS supabase_realtime;

CREATE PUBLICATION supabase_realtime FOR TABLE
  messages,
  reactions;

DO $$
BEGIN
    RAISE NOTICE 'Realtime publications configured (messages + reactions only)';
END $$;
