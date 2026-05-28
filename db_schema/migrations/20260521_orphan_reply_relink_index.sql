-- ---------------------------------------------------------------------------
-- Partial index for orphan-reply relinking (federation context fixes).
--
-- `ActivityProcessor.relinkPendingChildren` runs every time we import or
-- look up a post via `/resolve-post` or the inbox `Create` path. It looks
-- for orphaned replies whose `metadata.in_reply_to_ap_url` matches the
-- imported post's ap_id (or alternate URL form), so that as soon as the
-- parent arrives, all children waiting for it become threaded:
--
--     SELECT id FROM posts
--       WHERE in_reply_to IS NULL
--         AND metadata->>'in_reply_to_ap_url' IN (...)
--         AND is_deleted = false;
--
-- Without an index this is a sequential scan over the whole `posts` table
-- on every federated post import. The set of orphaned replies (rows with
-- `in_reply_to IS NULL` AND `metadata->>'in_reply_to_ap_url'` set) is
-- always a small fraction of `posts`, so a partial expression index keeps
-- the index tiny and the lookup O(log n).
--
-- Run this once on each deployed environment. Fresh installs pick the
-- index up automatically via `db_schema/init/14_indexes_perf.sql` (mirror
-- this statement there).
--
-- ---------------------------------------------------------------------------
-- RUN INSTRUCTIONS
-- ---------------------------------------------------------------------------
--
-- Just paste this entire file into the Supabase SQL editor and click Run.
-- Wrapped in a single BEGIN/COMMIT so partial failure rolls back cleanly.
--
-- Uses `CREATE INDEX IF NOT EXISTS` (not `CONCURRENTLY`) for the same
-- reason as `20260520_perf_round1_indexes.sql`: CONCURRENTLY can't run
-- inside the SQL editor's implicit transaction, and the lock window is
-- sub-second on hobby-scale instances. If your `posts` table is large
-- enough that the brief ACCESS EXCLUSIVE lock matters, run via
-- `psql -c "CREATE INDEX CONCURRENTLY ..."` outside this file instead.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE INDEX IF NOT EXISTS idx_posts_pending_in_reply_to_ap_url
  ON public.posts ((metadata->>'in_reply_to_ap_url'))
  WHERE in_reply_to IS NULL
    AND (is_deleted = false OR is_deleted IS NULL)
    AND metadata ? 'in_reply_to_ap_url';

COMMIT;
