-- =============================================================================
-- Klipy GIF ads: per-tier ad removal + instance toggle
-- =============================================================================
-- Harmony's GIF picker now proxies Klipy (Tenor is being shut down). Klipy can
-- serve ads, toggled per API key. The federation backend holds both an
-- ad-enabled and an ad-free key and decides which to use per request. This
-- migration adds the policy inputs that decision reads:
--
--   * instance_supporter_tiers.removes_ads  - admins tick this on a tier to give
--                                             its supporters an ad-free picker.
--   * instance_config.gif_ads_enabled       - instance-wide master switch.
--   * should_show_gif_ads(user)             - the resolved decision, called by
--                                             the backend (service_role) and the
--                                             frontend (to show ad-free status).
--
-- The actual keys never live in the database — they stay in the backend env.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Per-tier ad removal flag
-- ---------------------------------------------------------------------------
ALTER TABLE public.instance_supporter_tiers
    ADD COLUMN IF NOT EXISTS removes_ads boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.instance_supporter_tiers.removes_ads IS
'When true, active supporters on this tier are served the ad-free Klipy key (GIF picker shows no ads).';

-- ---------------------------------------------------------------------------
-- 2. Instance-wide toggle (defaults on; only meaningful if an ad key is set)
-- ---------------------------------------------------------------------------
INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('gif_ads_enabled', 'true'::jsonb, 'Whether the GIF picker (Klipy) may serve ads to non-supporters')
ON CONFLICT (config_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Resolved ad decision
-- ---------------------------------------------------------------------------
-- Returns TRUE when the given user should be shown GIF ads. SECURITY DEFINER so
-- the backend (service_role) and clients can call it without direct table reads.
-- Logic: ads are on unless the instance disabled them, or the user holds an
-- active supporter tier flagged removes_ads.
CREATE OR REPLACE FUNCTION public.should_show_gif_ads(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        -- instance master switch (default true when key absent/garbage)
        COALESCE((SELECT config_value::text = 'true'
                  FROM public.instance_config
                  WHERE config_key = 'gif_ads_enabled'), true)
        -- ...and the user is NOT on an active ad-removing tier
        AND NOT EXISTS (
            SELECT 1
            FROM public.instance_supporters s
            JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
            WHERE s.user_id = p_user_id
              AND s.is_active = true
              AND t.removes_ads = true
              AND (s.expires_at IS NULL OR s.expires_at > now())
        );
$$;

COMMENT ON FUNCTION public.should_show_gif_ads(uuid) IS
'TRUE when the user should see GIF (Klipy) ads. False when the instance disabled ads or the user is on an active ad-removing supporter tier.';

GRANT EXECUTE ON FUNCTION public.should_show_gif_ads(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.should_show_gif_ads(uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
