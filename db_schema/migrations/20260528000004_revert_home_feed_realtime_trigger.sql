-- Revert the in-transaction home-feed broadcast trigger (20260528_home_feed_realtime.sql).
-- Replaced by an out-of-transaction BullMQ-driven broadcast in postHandler.ts -
-- runs on a Node worker, has retries via BullMQ, doesn't block post INSERT commit.
BEGIN;
DROP TRIGGER IF EXISTS trg_broadcast_home_feed_entry ON public.timeline_entries;
DROP FUNCTION IF EXISTS public.broadcast_home_feed_entry();
COMMIT;
NOTIFY pgrst, 'reload schema';
