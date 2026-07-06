-- =============================================================================
-- Migration: Supporter badge rolling 30-day expiry (monthly instances)
-- =============================================================================
--
-- Fixes badge lifetime for instances running funding_period = 'monthly'.
--
-- Two defects, both stemming from tying badge lifetime to the calendar month:
--
--   1. instance_supporters.expires_at was never populated, so a monthly-cycle
--      badge never actually reset - it lived forever (until an unrelated
--      recompute happened to strip it).
--
--   2. Tier/eligibility was summed over the CURRENT CALENDAR MONTH
--      (date_trunc('month', now())). So a donation on the 30th only "counted"
--      for ~1 day, and any recompute early in the next month saw $0 and
--      stripped the badge - even though the donation was days old. That also
--      stripped users with legitimately overlapping donations.
--
-- Desired behaviour:
--   * funding_period = 'monthly': a donation grants supporter status for a
--     full 30 days from when it was paid. Overlapping donations aggregate for
--     tier purposes and EXTEND the window to (latest donation + 30 days) -
--     they never shorten it.
--   * funding_period = 'all': lifetime, no expiry (unchanged).
--
-- The public funding COUNTER (get_funding_current_total) intentionally stays a
-- hard calendar-month reset - it is a separate function and is NOT touched
-- here. Only the per-user supporter/badge lifetime changes.
--
-- Badge display (get_supporter_badge / get_supporter_badges) already gates on
-- `expires_at IS NULL OR expires_at > NOW()`, so populating expires_at is the
-- entire reset mechanism - no scheduled job required.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- get_user_cycle_donation_total(user_id)
-- ---------------------------------------------------------------------------
-- Monthly branch now sums a ROLLING 30-day window ending now (was calendar
-- month), so a late-month donation counts in full and overlapping donations
-- aggregate. 'all' branch unchanged (lifetime).
CREATE OR REPLACE FUNCTION public.get_user_cycle_donation_total(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_period text;
    v_total numeric;
BEGIN
    SELECT COALESCE(funding_period, 'monthly') INTO v_period
    FROM public.instance_funding LIMIT 1;

    IF v_period = 'all' THEN
        SELECT COALESCE(SUM(amount), 0) INTO v_total
        FROM public.instance_donation_history
        WHERE user_id = p_user_id;
    ELSE
        SELECT COALESCE(SUM(amount), 0) INTO v_total
        FROM public.instance_donation_history
        WHERE user_id = p_user_id
          AND donated_at >= now() - interval '30 days';
    END IF;

    RETURN v_total;
END;
$$;

-- ---------------------------------------------------------------------------
-- recompute_supporter_tier(user_id)
-- ---------------------------------------------------------------------------
-- Now also sets expires_at so monthly badges reset. For 'monthly', the badge
-- expires 30 days after the user's MOST RECENT donation, so overlapping
-- donations extend (never shorten) the window. For 'all', expires_at is NULL.
CREATE OR REPLACE FUNCTION public.recompute_supporter_tier(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_period text;
    v_total numeric;
    v_tier_id uuid;
    v_currency text;
    v_expires timestamptz;
BEGIN
    -- No supporter row yet -> nothing to recompute (manual or webhook
    -- callers create the row before invoking this).
    IF NOT EXISTS (SELECT 1 FROM public.instance_supporters WHERE user_id = p_user_id) THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(funding_period, 'monthly'), COALESCE(goal_currency, 'USD')
      INTO v_period, v_currency
    FROM public.instance_funding LIMIT 1;

    v_total := public.get_user_cycle_donation_total(p_user_id);
    v_tier_id := public.compute_supporter_tier_for_amount(v_total, v_currency);

    IF v_period = 'all' THEN
        v_expires := NULL;
    ELSE
        -- Latest donation + 30 days. If the user has no donation history the
        -- window is NULL, which the badge query treats as "no expiry"; that is
        -- only reachable for manually-granted supporters (no donation rows),
        -- which are intentionally left permanent.
        SELECT MAX(donated_at) + interval '30 days'
          INTO v_expires
        FROM public.instance_donation_history
        WHERE user_id = p_user_id;
    END IF;

    UPDATE public.instance_supporters
    SET tier_id = v_tier_id,
        amount = v_total,
        expires_at = v_expires
    WHERE user_id = p_user_id;

    RETURN v_tier_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Backfill: resync donation-earned supporters onto the new window/expiry.
-- ---------------------------------------------------------------------------
-- Only touch supporters who actually have donation history, so manually
-- granted badges (platform='manual', no donation rows) are not stripped.
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    FOR v_user_id IN
        SELECT DISTINCT s.user_id
        FROM public.instance_supporters s
        JOIN public.instance_donation_history dh ON dh.user_id = s.user_id
        WHERE s.is_active = true
    LOOP
        PERFORM public.recompute_supporter_tier(v_user_id);
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
