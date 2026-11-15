-- harmony:no-transaction
--
-- One bot index on messages: idx_messages_bot_channel (bot_id, channel_id) WHERE bot_id IS NOT NULL.
--
-- Dropped:
--   idx_messages_bot_id (bot_id)
--       A prefix of idx_messages_bot_channel under the same predicate.
--   idx_messages_bot_created_id (bot_id, created_at, id)
--       Present where 20261112200002 built it. bridge_mirror_backfill orders by (created_at, id)
--       across every bridge bot; an index led by bot_id does not give that order.
--
-- Measured on supabase/postgres 15.8.1.060, 3.9M messages, a full backfill walk in batches of 500,
-- with idx_messages_bot_created_id and without:
--   390k bridge messages   42.0 s   44.2 s
--   100k                    9.6 s    9.7 s
--    20k                    0.09 s   0.13 s
-- At 410k bot messages the index is 35 MB; idx_messages_bot_channel is 3 MB.
--
-- No transaction block: CREATE and DROP INDEX CONCURRENTLY refuse to run inside one, and take no
-- lock that blocks reads or writes of messages. An interrupted build leaves an invalid index; it
-- is dropped before the next build, and the file fails while the index is not valid. An
-- interrupted drop leaves the index invalid; the next run drops it.

SET lock_timeout = '5s';

DO $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM pg_index x
                WHERE x.indexrelid = to_regclass('public.idx_messages_bot_channel')
                  AND NOT x.indisvalid) THEN
        DROP INDEX public.idx_messages_bot_channel;
    END IF;
END
$$;

-- A concurrent build or drop waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_bot_channel
    ON public.messages (bot_id, channel_id)
    WHERE bot_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.idx_messages_bot_channel')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'idx_messages_bot_channel is not valid; run 20261112800002 again';
    END IF;
END
$$;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_messages_bot_id;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_messages_bot_created_id;

RESET lock_timeout;
