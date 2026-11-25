-- harmony:no-transaction
--
-- idx_profiles_lower_username_domain: profiles by lower(username), lower(domain), the keys
-- public_profile_page (20261111400001) matches an account on. The remote branch matches both, the
-- local branch the leading column; idx_profiles_username_domain holds the columns as stored, so
-- neither branch could use it and each call read every profile.
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
                  AND c.relname = 'idx_profiles_lower_username_domain'
                  AND NOT x.indisvalid) THEN
        DROP INDEX public.idx_profiles_lower_username_domain;
    END IF;
END
$$;

-- A concurrent build waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_lower_username_domain
    ON public.profiles (lower(username), lower(domain));

RESET lock_timeout;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.idx_profiles_lower_username_domain')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'idx_profiles_lower_username_domain is not valid; run 20261123400001 again';
    END IF;
END
$$;
