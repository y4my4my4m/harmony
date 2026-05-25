-- =============================================================================
-- Migration: Funding total from donations + monthly period
-- =============================================================================
-- 1. Add funding_period to instance_funding ('all' | 'monthly')
-- 2. Add RPC get_funding_current_total to compute sum from donation history
--    (SECURITY DEFINER so any authenticated user can see the aggregate)
-- 3. When monthly: sum only donations in current calendar month
-- =============================================================================

BEGIN;

-- Add funding period
ALTER TABLE public.instance_funding ADD COLUMN IF NOT EXISTS funding_period text DEFAULT 'monthly';

COMMENT ON COLUMN public.instance_funding.funding_period IS 'all = sum all donations; monthly = sum current calendar month only';

-- RPC: get_funding_current_total
-- Returns the sum of donations for display (no per-user data exposed)
CREATE OR REPLACE FUNCTION public.get_funding_current_total(p_period text DEFAULT 'monthly')
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT COALESCE(SUM(dh.amount), 0)::numeric
  FROM public.instance_donation_history dh
  WHERE
    (p_period = 'all')
    OR (p_period = 'monthly' AND dh.donated_at >= date_trunc('month', now())::timestamptz);
$$;

COMMENT ON FUNCTION public.get_funding_current_total(text)
  IS 'Returns funding total from donation history. p_period: all | monthly (default monthly = current month only)';

GRANT EXECUTE ON FUNCTION public.get_funding_current_total(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
