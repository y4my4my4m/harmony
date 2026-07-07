-- Purge stale server invites on a schedule.
-- Expired or fully-used invites stay 30 days so "Recent Invites" history can
-- still show them, then get deleted. Requires pg_cron (already used by
-- init/99_cron_jobs.sql); no-ops gracefully when the extension is missing.

CREATE OR REPLACE FUNCTION public.purge_stale_invites()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.invites
  WHERE
    (expires_at IS NOT NULL AND expires_at < now() - interval '30 days')
    OR (max_uses IS NOT NULL AND uses >= max_uses
        AND created_at < now() - interval '30 days');

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.purge_stale_invites() IS
  'Deletes invites expired or fully used for over 30 days. Scheduled daily via pg_cron.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('purge-stale-invites'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule(
      'purge-stale-invites',
      '20 4 * * *',
      'SELECT public.purge_stale_invites()'
    );
  END IF;
END;
$$;
