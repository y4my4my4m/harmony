-- harmony:no-transaction
--
-- Rewrites content_tsvector of rows indexed before 20261031800001 as search_document() and
-- builds idx_message_search_fold_trgm, the trigram index behind the typo fallback.
--
-- No transaction block: each batch of 2,000 rows commits by itself, and CREATE INDEX
-- CONCURRENTLY refuses to run inside one. psql -f runs it as written; a BEGIN ... ROLLBACK
-- rehearsal of pending migrations must leave this file out.
--
-- Rows already holding search_document(content_text) are skipped, so a rerun writes only what
-- an interrupted run left. An interrupted or timed-out index build leaves an invalid index;
-- it is dropped before the next build, and the file fails while the index is not valid.
-- search_messages runs no typo fallback until it is. Writes to messages proceed throughout: a
-- batch locks its 2,000 index rows until it commits, and the concurrent build takes no lock
-- that blocks writes.
--
-- Rehearsal, supabase/postgres:15.8.1.060, 1,000,000 rows with the english-only vector and
-- every index of the table, 20 message inserts a second alongside: 244 s for both steps;
-- inserts p50 4.2 ms, p99 142 ms, max 355 ms, none failed. Table 639 -> 1018 MB before
-- vacuum (one dead tuple per rewritten row); content_tsvector GIN 25 -> 79 MB, trigram GIN
-- 111 MB.

SET lock_timeout = '5s';

DO $$
DECLARE
    v_last uuid := '00000000-0000-0000-0000-000000000000';
    v_next uuid;
    v_batch bigint;
    v_rows bigint := 0;
BEGIN
    LOOP
        SELECT b.id INTO v_next
          FROM (SELECT id FROM public.message_search_index WHERE id > v_last ORDER BY id LIMIT 2000) b
         ORDER BY b.id DESC
         LIMIT 1;
        EXIT WHEN v_next IS NULL;

        UPDATE public.message_search_index
           SET content_tsvector = public.search_document(coalesce(content_text, ''))
         WHERE id > v_last AND id <= v_next
           AND content_tsvector IS DISTINCT FROM public.search_document(coalesce(content_text, ''));
        GET DIAGNOSTICS v_batch = ROW_COUNT;
        v_rows := v_rows + v_batch;
        COMMIT;
        v_last := v_next;
    END LOOP;
    RAISE NOTICE 'message_search_index: % rows rewritten', v_rows;
END
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM pg_index x
                 JOIN pg_class c ON c.oid = x.indexrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'idx_message_search_fold_trgm'
                  AND NOT x.indisvalid) THEN
        DROP INDEX public.idx_message_search_fold_trgm;
    END IF;
END
$$;

-- A concurrent build waits, at three points, for transactions open before it; lock_timeout
-- bounds each wait, so a session idle in a transaction fails the build instead of holding the
-- deploy. postgres 16, a repeatable-read transaction left open: lock_timeout 2s ended the build
-- after 2.1 s and left the index invalid.
SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_search_fold_trgm
    ON public.message_search_index USING gin (public.search_fold(content_text) extensions.gin_trgm_ops);

RESET lock_timeout;

-- IF NOT EXISTS passes over an invalid index of that name.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.idx_message_search_fold_trgm')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'idx_message_search_fold_trgm is not valid; run 20261031800002 again';
    END IF;
END
$$;
