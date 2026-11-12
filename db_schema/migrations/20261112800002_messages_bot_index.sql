-- harmony:no-transaction
--
-- Drops idx_messages_bot_id (bot_id) WHERE bot_id IS NOT NULL. It is a prefix of two indexes
-- under the same predicate: idx_messages_bot_channel (bot_id, channel_id) and
-- idx_messages_bot_created_id (bot_id, created_at, id) of 20261112200002. A bot message
-- maintains two bot indexes, as it did before that file.
--
-- No transaction block: DROP INDEX CONCURRENTLY refuses to run inside one, and it takes no lock
-- that blocks reads or writes of messages. An interrupted drop leaves the index invalid; the
-- next run drops it.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.idx_messages_bot_created_id')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'idx_messages_bot_created_id is not valid; run 20261112200002 first';
    END IF;
END
$$;

-- A concurrent drop waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

DROP INDEX CONCURRENTLY IF EXISTS public.idx_messages_bot_id;

RESET lock_timeout;
