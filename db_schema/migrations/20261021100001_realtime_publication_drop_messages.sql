-- messages leaves the supabase_realtime publication.
--
-- Clients since 1.8.6 read message events from Realtime Broadcast only (20261019100001).
-- realtime.subscription held 0 rows on prod and staging on 2026-10-20, so no open client asks
-- for postgres_changes. With the table published, Realtime decoded every messages write from
-- the WAL and polled list_changes, the top statement in pg_stat_statements. The publication
-- itself stays, empty, as Supabase ships it.
--
-- The legacy federation listener (USE_BULLMQ_QUEUE=false) subscribes through this publication
-- and receives nothing after this migration; its other tables were never published.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.messages;
  END IF;
END
$$;

COMMIT;
