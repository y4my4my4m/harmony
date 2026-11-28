-- harmony:no-transaction
--
-- idx_emojis_unique_federated_domain_name, UNIQUE (domain, name) WHERE domain IS NOT NULL on
-- emojis, is dropped where an instance holds it. No migration defines it: production carries it
-- from before the baseline (schema dumps of 2026-08 to 2026-11-10), fresh installs and staging
-- never had it. One instance may hold several rows of one name and domain, and the copy sync
-- (federation-backend services/CopyMirrorService.ts, 20261114200001) writes them:
--   - two servers hosted on one instance, each with an emoji of one name, on their copies here;
--   - an emoji the host removes and adds again under the same name, while the copy keeps the
--     dropped row;
--   - a rename to a name a cached row of another image holds.
-- With the index the insert or rename raises 23505 and the emoji never reaches the copy. An
-- inbound reaction whose image URL is new for a cached shortcode fails the same way and is
-- dropped. Nothing reads it as a conflict target. idx_emojis_domain_name, a plain index of the
-- same columns on the same instances, stays.
--
-- No transaction block: DROP INDEX CONCURRENTLY refuses to run inside one, and it takes no lock
-- that blocks reads or writes of emojis. The file fails while the index remains.

DO $$
BEGIN
    IF to_regclass('public.idx_emojis_unique_federated_domain_name') IS NOT NULL THEN
        RAISE NOTICE 'idx_emojis_unique_federated_domain_name: dropped';
    ELSE
        RAISE NOTICE 'idx_emojis_unique_federated_domain_name: absent, nothing to drop';
    END IF;
END
$$;

-- A concurrent drop waits for transactions open on emojis; lock_timeout bounds each wait.
SET lock_timeout = '10min';

DROP INDEX CONCURRENTLY IF EXISTS public.idx_emojis_unique_federated_domain_name;

RESET lock_timeout;

DO $$
BEGIN
    IF to_regclass('public.idx_emojis_unique_federated_domain_name') IS NOT NULL THEN
        RAISE EXCEPTION 'idx_emojis_unique_federated_domain_name remains; run 20261123400004 again';
    END IF;
END
$$;
