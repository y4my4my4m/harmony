-- harmony:no-transaction
--
-- Keyset index for the attachment mirror's backfill walk (bridge_mirror_backfill, 20261112100001):
-- it reads bridge bot messages in (created_at, id) order from a cursor. Without this index each
-- batch scans the whole messages table.
--
-- No transaction block: CREATE INDEX CONCURRENTLY refuses to run inside one, and the build
-- takes no lock that blocks writes. An interrupted or timed-out build leaves an invalid index;
-- it is dropped before the next build, and the file fails while the index is not valid.

SET lock_timeout = '5s';

DO $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM pg_index x
                 JOIN pg_class c ON c.oid = x.indexrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'idx_messages_bot_created_id'
                  AND NOT x.indisvalid) THEN
        DROP INDEX public.idx_messages_bot_created_id;
    END IF;
END
$$;

-- A concurrent build waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_bot_created_id
    ON public.messages (bot_id, created_at, id)
    WHERE bot_id IS NOT NULL;

RESET lock_timeout;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.idx_messages_bot_created_id')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'idx_messages_bot_created_id is not valid; run 20261112100002 again';
    END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
