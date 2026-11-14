-- harmony:no-transaction
--
-- The relayed author of reactions and AutoMod events, for bridge_privacy_erase_core
-- (20261115700001): its batches of `limit` rows read these indexes instead of every reaction and
-- event of the server.
--
-- No transaction block: CREATE INDEX CONCURRENTLY refuses to run inside one, and the build takes no
-- lock that blocks writes. An interrupted build leaves an invalid index; it is dropped before the
-- next build, and the file fails while an index is not valid.

SET lock_timeout = '5s';

DO $$
DECLARE
    v_name text;
BEGIN
    FOREACH v_name IN ARRAY ARRAY['idx_reactions_discord_author', 'idx_automod_events_author_key'] LOOP
        IF EXISTS (SELECT 1
                     FROM pg_index x
                     JOIN pg_class c ON c.oid = x.indexrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = v_name AND NOT x.indisvalid) THEN
            EXECUTE format('DROP INDEX public.%I', v_name);
        END IF;
    END LOOP;
END
$$;

-- A concurrent build waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reactions_discord_author
    ON public.reactions (channel_id, (metadata #>> '{discord_user,id}'))
    WHERE metadata ? 'discord_user';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_automod_events_author_key
    ON public.automod_events (server_id, (details ->> 'author_key'))
    WHERE details ? 'author_key';

RESET lock_timeout;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.idx_reactions_discord_author') AND x.indisvalid)
       OR NOT EXISTS (SELECT 1 FROM pg_index x
                       WHERE x.indexrelid = to_regclass('public.idx_automod_events_author_key') AND x.indisvalid) THEN
        RAISE EXCEPTION 'idx_reactions_discord_author or idx_automod_events_author_key is not valid; run 20261115600001 again';
    END IF;
END
$$;
