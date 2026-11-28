-- Autovacuum of posts, messages and profiles at 5% of the table instead of 20%.
--
-- An index-only scan reads the heap for every page the visibility map does not mark all-visible,
-- and only VACUUM sets those bits. The not-deleted posts count of refresh_admin_instance_stats
-- (20261124600003), its active-server probes on messages and its profile counts are index-only
-- scans.
--
-- Production, 2026-11-24:
--   posts     91,843 live, 16,382 dead (17%), last autovacuum 6 days earlier, 8,984 of 13,644
--             heap pages all-visible. The default trigger, 50 + 0.2 * reltuples = 18,419 dead
--             tuples, had not fired. The index-only count of not-deleted posts fetched heap
--             pages: 6.6 s on a cold cache, 1.28 s in another run, 120 ms warm.
--   messages  34,915 live, 4,455 dead (13%); default trigger 7,033.
--   profiles  16,102 live, 1,494 dead (9%), 82,901 updates, 2,522 of 3,890 heap pages all-visible;
--             default trigger 3,270. The index-only count of all and local profiles fetched
--             8,347 heap rows: 289 ms.
-- At 0.05 the dead-tuple trigger is 50 + 0.05 * reltuples (posts 4,642, messages 1,796, profiles 855) and the
-- insert trigger 1000 + 0.05 * reltuples, so append-mostly growth also sets visibility bits.
--
-- ALTER TABLE ... SET (storage parameters) takes SHARE UPDATE EXCLUSIVE: reads and writes go on,
-- VACUUM, ANALYZE and other schema changes on the table wait. A running autovacuum yields to it.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.posts SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_insert_scale_factor = 0.05
);

ALTER TABLE public.messages SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_insert_scale_factor = 0.05
);

ALTER TABLE public.profiles SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_insert_scale_factor = 0.05
);

COMMIT;
