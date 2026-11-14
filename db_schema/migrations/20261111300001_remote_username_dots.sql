-- Remote usernames with "." and "-": Bluesky accounts bridged by Bridgy Fed
-- (hltv-mirror.eurosky.social@bsky.brid.gy), Threads (john.doe@threads.net), Pleroma and others.
-- profiles_username_check (^[a-zA-Z0-9_]+$) refused them, so a lookup of such an account failed
-- with 23514 at the profile upsert.
--
-- Production carries no profiles_username_check (72 remote rows with "." or "-" on 2026-10-09,
-- 20261009200001_table_layout_convergence.sql); staging and fresh installs do. Dropped where
-- present. Local usernames stay ^[a-z0-9_]{3,24}$ through guard_local_username;
-- profiles_username_length_check (64) stands for every row.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_check;

COMMIT;
