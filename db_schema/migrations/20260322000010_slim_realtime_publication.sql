BEGIN;

-- ============================================================================
-- Step 4: Slim the realtime publication to only tables that still use CDC.
--
-- After the broadcast migration, the only remaining postgres_changes
-- subscriptions are:
--   1. messages - per-channel/per-conversation filtered CDC
--   2. reactions - per-channel/per-conversation filtered CDC (Step 1a)
--
-- All other tables now use broadcast triggers and are removed from the
-- publication to eliminate WAL decoding overhead for those tables.
-- ============================================================================

DROP PUBLICATION IF EXISTS supabase_realtime;

CREATE PUBLICATION supabase_realtime FOR TABLE
  messages,
  reactions;

DO $$
BEGIN
  RAISE NOTICE 'Realtime publication slimmed to messages + reactions only';
END $$;

COMMIT;
