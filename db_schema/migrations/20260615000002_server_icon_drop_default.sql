-- ---------------------------------------------------------------------------
-- Stop storing the built-in default server icon as a magic sentinel string.
--
-- Why:
-- `public.servers.icon` defaulted to the literal string '/default_server.webp'.
-- That sentinel is indistinguishable from a real stored icon, so it leaked into
-- ActivityPub/federation: remote instances received '/default_server.webp' (or
-- an absolutized 'https://peer/default_server.webp') as if it were a real
-- upload, and the remote browser tried to load a non-existent asset -> HTTP 400.
--
-- The fix is to remove the sentinel at the source:
--   1. Drop the column default so new servers start with NULL ("no icon").
--   2. Backfill existing rows that still hold the sentinel to NULL.
--
-- The frontend already renders the bundled default asset for a NULL/empty icon
-- (see `getServerIconUrl` in src/utils/serverUtils.ts), so display is
-- unaffected. Federation now naturally omits the icon for serverless-icon
-- servers (getFullServerIconUrl(null) -> null), with no sentinel to detect.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.servers ALTER COLUMN icon DROP DEFAULT;

UPDATE public.servers
SET icon = NULL
WHERE icon = '/default_server.webp';

COMMIT;

NOTIFY pgrst, 'reload schema';
