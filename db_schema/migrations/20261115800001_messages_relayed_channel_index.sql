-- harmony:no-transaction
--
-- A server's relayed messages, for bridge_privacy_erase_core (20261115900001) when it erases every
-- relayed author of a server ("Remove all bridged messages"): each batch reads this index instead
-- of every message of the server.
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
                  AND c.relname = 'messages_discord_relayed_channel'
                  AND NOT x.indisvalid) THEN
        DROP INDEX public.messages_discord_relayed_channel;
    END IF;
END
$$;

-- A concurrent build waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_discord_relayed_channel
    ON public.messages (channel_id)
    WHERE metadata ? 'discord_user';

RESET lock_timeout;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.messages_discord_relayed_channel')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'messages_discord_relayed_channel is not valid; run 20261115800001 again';
    END IF;
END
$$;
