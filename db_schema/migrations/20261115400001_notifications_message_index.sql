-- harmony:no-transaction
--
-- Notifications by the message they name: an erase of a relayed author's messages
-- (bridge_privacy_erase_core, 20261115500001) deletes the notifications that quote them, and
-- notifications.data carries message_id with no index on it.
--
-- No transaction block: CREATE INDEX CONCURRENTLY refuses to run inside one, and the build takes no
-- lock that blocks writes. An interrupted build leaves an invalid index; it is dropped before the
-- next build, and the file fails while the index is not valid.

SET lock_timeout = '5s';

DO $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM pg_index x
                 JOIN pg_class c ON c.oid = x.indexrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'idx_notifications_message_id'
                  AND NOT x.indisvalid) THEN
        DROP INDEX public.idx_notifications_message_id;
    END IF;
END
$$;

-- A concurrent build waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_message_id
    ON public.notifications ((data ->> 'message_id'))
    WHERE data ? 'message_id';

RESET lock_timeout;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.idx_notifications_message_id')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'idx_notifications_message_id is not valid; run 20261115400001 again';
    END IF;
END
$$;
