-- =============================================================================
-- Migration: Add GRANTs for instance_announcements and announcement_reads
-- =============================================================================
-- The 20260309_announcements migration created tables and RLS policies but did
-- not grant table access to authenticated. PostgREST requires explicit GRANTs
-- before RLS policies can take effect; otherwise we get 42501 permission denied.
-- =============================================================================

BEGIN;

GRANT SELECT ON public.instance_announcements TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.instance_announcements TO authenticated;

GRANT SELECT, INSERT, UPDATE ON public.announcement_reads TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_unread_announcements(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
