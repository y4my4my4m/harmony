-- harmony:no-transaction
--
-- One live row per Discord message per channel: a live relay and the history import (and a
-- retried request) may race to insert the same Discord message, and the loser must fail with
-- unique_violation instead of leaving a duplicate. Writers insert with
-- ON CONFLICT (channel_id, (metadata->>'discord_message_id')) WHERE <this predicate> DO NOTHING.
-- 20261110900001 soft-deleted the duplicates that existed.
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
                  AND c.relname = 'messages_channel_discord_message_id_unique'
                  AND NOT x.indisvalid) THEN
        DROP INDEX public.messages_channel_discord_message_id_unique;
    END IF;
END
$$;

-- A concurrent build waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS messages_channel_discord_message_id_unique
    ON public.messages (channel_id, (metadata->>'discord_message_id'))
    WHERE channel_id IS NOT NULL AND metadata ? 'discord_message_id' AND is_deleted IS NOT TRUE;

RESET lock_timeout;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.messages_channel_discord_message_id_unique')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'messages_channel_discord_message_id_unique is not valid; run 20261110900002 again';
    END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
