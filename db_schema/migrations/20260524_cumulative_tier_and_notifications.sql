-- =============================================================================
-- Migration: Cumulative-in-cycle supporter tiers + admin notifications
-- =============================================================================
--
-- Two corrections to the donation/supporter system:
--
-- 1. Cumulative tier resolution
--    Previously, a webhook donation set the supporter's tier based on that
--    single donation amount. This created two bugs:
--      a) A $1 donation showed a supporter badge with NO tier (since none
--         of the tiers had min_amount <= 1), and the fallback star "⭐"
--         rendered as a generic supporter — misleading.
--      b) Multiple smaller donations in the same cycle that, summed, would
--         exceed a tier's min_amount, weren't recognized.
--
--    New behavior: when recording a donation, recompute the supporter's
--    tier from the SUM of their donations in the current cycle (per
--    instance_funding.funding_period). If the sum is below the lowest
--    tier, the supporter row keeps tier_id=NULL and `get_supporter_badge`
--    now correctly returns no badge (NULL row).
--
-- 2. Admin notifications on new pending donations
--    Mirror the existing reports-notification pattern: when a webhook
--    payload couldn't be auto-matched to a user (donor forgot to include
--    @username@domain), send a system notification of type
--    'admin_pending_donation' to all instance admins + moderators so they
--    can act on it from the admin panel.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1a. compute_supporter_tier_for_amount(amount, currency)
-- ---------------------------------------------------------------------------
-- Pure helper: given a total amount, return the highest tier whose
-- min_amount <= amount. NULL if none qualify. Currency parameter reserved
-- for future per-currency tiers; ignored for now.
CREATE OR REPLACE FUNCTION public.compute_supporter_tier_for_amount(
    p_amount numeric,
    p_currency text DEFAULT 'USD'
)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT id
    FROM public.instance_supporter_tiers
    WHERE min_amount <= p_amount
    ORDER BY min_amount DESC
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 1b. get_user_cycle_donation_total(user_id)
-- ---------------------------------------------------------------------------
-- Sums a user's donations in the current funding cycle, respecting the
-- instance_funding.funding_period setting ('monthly' = current calendar
-- month; 'all' = lifetime). SECURITY DEFINER so RLS doesn't block the
-- supporter rows the webhook needs to read.
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
          AND donated_at >= date_trunc('month', now())::timestamptz;
    END IF;

    RETURN v_total;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1c. recompute_supporter_tier(user_id)
-- ---------------------------------------------------------------------------
-- After any donation insert/update/delete touching a user, call this to
-- snap their supporter row to the correct tier based on the current
-- cycle's cumulative total. If the total is below the lowest tier, sets
-- tier_id = NULL (badge resolution then returns nothing).
--
-- Returns the tier_id (or NULL) for callers that want to log/observe it.
-- Idempotent and safe to call multiple times.
CREATE OR REPLACE FUNCTION public.recompute_supporter_tier(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total numeric;
    v_tier_id uuid;
    v_currency text;
BEGIN
    -- No supporter row yet → nothing to recompute (manual or webhook
    -- callers create the row before invoking this).
    IF NOT EXISTS (SELECT 1 FROM public.instance_supporters WHERE user_id = p_user_id) THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(goal_currency, 'USD') INTO v_currency FROM public.instance_funding LIMIT 1;
    v_total := public.get_user_cycle_donation_total(p_user_id);
    v_tier_id := public.compute_supporter_tier_for_amount(v_total, v_currency);

    UPDATE public.instance_supporters
    SET tier_id = v_tier_id,
        amount = v_total
    WHERE user_id = p_user_id;

    RETURN v_tier_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1d. Tighten get_supporter_badge to require tier_id
-- ---------------------------------------------------------------------------
-- Previously this LEFT JOINed and returned a row even when tier_id was NULL,
-- which caused the frontend to render a default star "⭐" badge for users
-- whose donations didn't qualify for any tier.
CREATE OR REPLACE FUNCTION public.get_supporter_badge(p_user_id uuid)
RETURNS TABLE(
    tier_name text,
    badge_icon text,
    badge_color text,
    is_active boolean
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        t.name AS tier_name,
        t.badge_icon,
        t.badge_color,
        s.is_active
    FROM public.instance_supporters s
    JOIN public.instance_supporter_tiers t ON t.id = s.tier_id  -- INNER JOIN: no tier → no badge
    WHERE s.user_id = p_user_id
      AND s.is_active = true
      AND s.tier_id IS NOT NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 1e. Backfill: reconcile existing supporters with their actual cycle totals
-- ---------------------------------------------------------------------------
-- Without this, the bug visible in your screenshot (small donation showing
-- a default star) would persist until the next donation triggered a
-- recompute. Run for everyone with an active supporter row.
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    FOR v_user_id IN
        SELECT user_id FROM public.instance_supporters WHERE is_active = true
    LOOP
        PERFORM public.recompute_supporter_tier(v_user_id);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 1f. Grants
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.compute_supporter_tier_for_amount(numeric, text)
    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_cycle_donation_total(uuid)
    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recompute_supporter_tier(uuid)
    TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. notify_admins_on_pending_donation()
-- ---------------------------------------------------------------------------
-- Trigger: after a row is inserted into instance_pending_donations, send
-- a 'admin_pending_donation' notification to every active admin and
-- moderator profile via the existing send_notification() helper.
--
-- We don't notify on UPDATE (resolve/dismiss) since those are caused by
-- admin actions in the panel.
CREATE OR REPLACE FUNCTION public.notify_admins_on_pending_donation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_recipient_ids uuid[];
    v_data jsonb;
BEGIN
    -- Collect all admins and moderators. Same predicate the moderation
    -- system uses elsewhere (is_admin OR is_moderator).
    SELECT array_agg(id) INTO v_recipient_ids
    FROM public.profiles
    WHERE (is_admin = true OR is_moderator = true)
      AND is_suspended = false;

    IF v_recipient_ids IS NULL OR array_length(v_recipient_ids, 1) IS NULL THEN
        RETURN NEW;
    END IF;

    v_data := jsonb_build_object(
        'pending_donation_id', NEW.id,
        'platform', NEW.platform,
        'amount', NEW.amount,
        'currency', NEW.currency,
        'donor_name', NEW.donor_name,
        'donor_message', NEW.donor_message,
        'received_at', NEW.received_at
    );

    PERFORM public.send_notification(
        'admin_pending_donation'::varchar,
        v_recipient_ids,
        v_data,
        NULL,    -- server_id
        NULL,    -- channel_id
        NULL,    -- conversation_id
        NULL,    -- from_user_id (donor isn't a profile)
        'normal'::varchar
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_admins_on_pending_donation
    ON public.instance_pending_donations;
CREATE TRIGGER trg_notify_admins_on_pending_donation
    AFTER INSERT ON public.instance_pending_donations
    FOR EACH ROW
    EXECUTE FUNCTION public.notify_admins_on_pending_donation();

NOTIFY pgrst, 'reload schema';

COMMIT;
