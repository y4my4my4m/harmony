-- GIF / Klipy instance toggles (branding) + robust should_show_gif_ads boolean read
BEGIN;

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES (
    'gif_klipy_branding_enabled',
    'true'::jsonb,
    'Show KLIPY search placeholder and optional GIF watermark attribution'
)
ON CONFLICT (config_key) DO NOTHING;

-- Read jsonb booleans reliably (true, "true", or missing → default on for ads).
CREATE OR REPLACE FUNCTION public.should_show_gif_ads(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        COALESCE((
            SELECT CASE
                WHEN jsonb_typeof(config_value) = 'boolean' THEN config_value::boolean
                WHEN config_value::text IN ('true', '"true"') THEN true
                WHEN config_value::text IN ('false', '"false"') THEN false
                ELSE true
            END
            FROM public.instance_config
            WHERE config_key = 'gif_ads_enabled'
        ), true)
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

COMMIT;

NOTIFY pgrst, 'reload schema';
