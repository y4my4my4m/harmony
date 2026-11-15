-- harmony:no-transaction
--
-- Relayed Discord messages by author id: the lookup of bridge_privacy_erase_core (20261112600001).
-- Partial, so rows without a relayed author cost nothing.
--
-- No transaction block: CREATE INDEX CONCURRENTLY refuses to run inside one. An interrupted build
-- leaves an invalid index; it is dropped before the next build, and the file fails while the
-- index is not valid.

SET lock_timeout = '5s';

DO $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM pg_index x
                 JOIN pg_class c ON c.oid = x.indexrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'messages_discord_author_idx'
                  AND NOT x.indisvalid) THEN
        DROP INDEX public.messages_discord_author_idx;
    END IF;
END
$$;

SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_discord_author_idx
    ON public.messages ((metadata #>> '{discord_user,id}'))
    WHERE metadata ? 'discord_user';

RESET lock_timeout;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.messages_discord_author_idx')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'messages_discord_author_idx is not valid; run 20261112600002 again';
    END IF;
END
$$;
