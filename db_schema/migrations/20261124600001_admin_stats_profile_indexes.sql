-- harmony:no-transaction
--
-- Indexes for the profile counts of refresh_admin_instance_stats (20261124600003). Neither existed
-- on a fresh install or on production, so each count read the whole heap (45 MB, 16k rows, on
-- production 2026-11-24):
--   idx_profiles_created_at  profiles by created_at: accounts created in the last 24 hours.
--   idx_profiles_suspended   suspended profiles only: their count is an index-only scan of a
--                            few entries.
--
-- No transaction block: CREATE INDEX CONCURRENTLY refuses to run inside one, and the build takes no
-- lock that blocks writes. An interrupted build leaves an invalid index; it is dropped before the
-- next build, and the file fails while an index is not valid.

SET lock_timeout = '5s';

DO $$
DECLARE
    v_name text;
BEGIN
    FOREACH v_name IN ARRAY ARRAY['idx_profiles_created_at', 'idx_profiles_suspended'] LOOP
        IF EXISTS (SELECT 1
                     FROM pg_index x
                     JOIN pg_class c ON c.oid = x.indexrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public'
                      AND c.relname = v_name
                      AND NOT x.indisvalid) THEN
            EXECUTE format('DROP INDEX public.%I', v_name);
        END IF;
    END LOOP;
END
$$;

-- A concurrent build waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_created_at
    ON public.profiles (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_suspended
    ON public.profiles (id) WHERE is_suspended;

RESET lock_timeout;

DO $$
DECLARE
    v_name text;
BEGIN
    FOREACH v_name IN ARRAY ARRAY['idx_profiles_created_at', 'idx_profiles_suspended'] LOOP
        IF NOT EXISTS (SELECT 1
                         FROM pg_index x
                        WHERE x.indexrelid = to_regclass('public.' || v_name)
                          AND x.indisvalid) THEN
            RAISE EXCEPTION '% is not valid; run 20261124600001 again', v_name;
        END IF;
    END LOOP;
END
$$;
