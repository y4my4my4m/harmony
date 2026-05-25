-- =============================================================================
-- Migration: Featured Communities
-- =============================================================================
-- Adds is_featured and featured_order columns to servers table,
-- and an RPC for admins to toggle featured status.
-- =============================================================================

BEGIN;

ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS is_featured boolean DEFAULT false;
ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS featured_order integer DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_servers_featured
    ON public.servers(is_featured, featured_order) WHERE is_featured = true;

-- ---------------------------------------------------------------------------
-- RPC: set_server_featured (instance admin only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_server_featured(
    p_server_id uuid,
    p_is_featured boolean,
    p_order integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_caller_id uuid;
    v_is_admin boolean;
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT is_admin INTO v_is_admin
    FROM public.profiles WHERE id = v_caller_id;

    IF NOT COALESCE(v_is_admin, false) THEN
        RAISE EXCEPTION 'Only instance admins can manage featured communities';
    END IF;

    UPDATE public.servers
    SET is_featured = p_is_featured, featured_order = p_order
    WHERE id = p_server_id;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
