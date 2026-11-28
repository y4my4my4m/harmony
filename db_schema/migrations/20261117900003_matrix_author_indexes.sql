-- harmony:no-transaction
--
-- The Matrix author of relayed rows, for bridge_privacy_erase_core (20261117900002); the Discord
-- counterparts are 20261112600002, 20261115600001 and 20261115800001.
--   messages_matrix_author_idx       relayed messages by MXID: one author's erase.
--   messages_matrix_relayed_channel  a server's relayed messages: "Remove all bridged messages".
--   idx_reactions_matrix_author      relayed reactions by channel and MXID.
-- Partial, so rows without a Matrix author cost nothing.
--
-- No transaction block: CREATE INDEX CONCURRENTLY refuses to run inside one, and the build takes no
-- lock that blocks writes. An interrupted build leaves an invalid index; it is dropped before the
-- next build, and the file fails while an index is not valid.

SET lock_timeout = '5s';

DO $$
DECLARE
    v_name text;
BEGIN
    FOREACH v_name IN ARRAY ARRAY['messages_matrix_author_idx', 'messages_matrix_relayed_channel', 'idx_reactions_matrix_author'] LOOP
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

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_matrix_author_idx
    ON public.messages ((metadata #>> '{matrix_user,id}'))
    WHERE metadata ? 'matrix_user';

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_matrix_relayed_channel
    ON public.messages (channel_id)
    WHERE metadata ? 'matrix_user';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reactions_matrix_author
    ON public.reactions (channel_id, (metadata #>> '{matrix_user,id}'))
    WHERE metadata ? 'matrix_user';

RESET lock_timeout;

DO $$
DECLARE
    v_name text;
BEGIN
    FOREACH v_name IN ARRAY ARRAY['messages_matrix_author_idx', 'messages_matrix_relayed_channel', 'idx_reactions_matrix_author'] LOOP
        IF NOT EXISTS (SELECT 1
                         FROM pg_index x
                        WHERE x.indexrelid = to_regclass('public.' || v_name)
                          AND x.indisvalid) THEN
            RAISE EXCEPTION '% is not valid; run 20261117900003 again', v_name;
        END IF;
    END LOOP;
END
$$;
