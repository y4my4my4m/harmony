-- =============================================================================
-- Migration: Real system health RPCs (admin-only)
-- =============================================================================
-- Provides real database connection count and database size for admin panel.
-- Uses SECURITY DEFINER to access pg_stat_activity, but checks is_admin
-- inside the function body so only admins get results.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_db_connection_count()
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
        RETURN 0;
    END IF;
    RETURN (SELECT COUNT(*)::integer FROM pg_stat_activity WHERE datname = current_database());
END;
$$;

CREATE OR REPLACE FUNCTION public.get_db_size()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
        RETURN '--';
    END IF;
    RETURN (SELECT pg_size_pretty(pg_database_size(current_database())));
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_db_connection_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_db_size() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
