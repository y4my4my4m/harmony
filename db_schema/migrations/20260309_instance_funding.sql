-- =============================================================================
-- Migration: Instance Funding / Donations
-- =============================================================================
-- Adds tables for instance funding goals, supporter tiers, and supporters.
-- Admin-managed: no payment processing, just external links and manual assignment.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TABLE: instance_funding
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_funding (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    enabled boolean DEFAULT false,
    goal_amount numeric(10,2),
    goal_currency text DEFAULT 'USD',
    current_amount numeric(10,2) DEFAULT 0,
    goal_description text,
    funding_links jsonb DEFAULT '[]'::jsonb,
    show_progress_bar boolean DEFAULT true,
    thank_you_message text,
    updated_at timestamptz DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- TABLE: instance_supporter_tiers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_supporter_tiers (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    min_amount numeric(10,2) NOT NULL,
    badge_icon text,
    badge_color text,
    perks text,
    display_order integer DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- TABLE: instance_supporters
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_supporters (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    tier_id uuid REFERENCES public.instance_supporter_tiers(id) ON DELETE SET NULL,
    amount numeric(10,2),
    started_at timestamptz DEFAULT now(),
    expires_at timestamptz,
    is_active boolean DEFAULT true,
    external_id text,
    platform text,
    CONSTRAINT unique_supporter_user UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_supporters_user ON public.instance_supporters(user_id);
CREATE INDEX IF NOT EXISTS idx_supporters_active ON public.instance_supporters(is_active);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.instance_funding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_supporter_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_supporters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "funding_select_all" ON public.instance_funding;
CREATE POLICY "funding_select_all" ON public.instance_funding
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "funding_modify_admin" ON public.instance_funding;
CREATE POLICY "funding_modify_admin" ON public.instance_funding
    FOR ALL TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

DROP POLICY IF EXISTS "tiers_select_all" ON public.instance_supporter_tiers;
CREATE POLICY "tiers_select_all" ON public.instance_supporter_tiers
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "tiers_modify_admin" ON public.instance_supporter_tiers;
CREATE POLICY "tiers_modify_admin" ON public.instance_supporter_tiers
    FOR ALL TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

DROP POLICY IF EXISTS "supporters_select_all" ON public.instance_supporters;
CREATE POLICY "supporters_select_all" ON public.instance_supporters
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "supporters_modify_admin" ON public.instance_supporters;
CREATE POLICY "supporters_modify_admin" ON public.instance_supporters
    FOR ALL TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

-- ---------------------------------------------------------------------------
-- RPC: get_supporter_badge
-- Returns the supporter badge info for a user (if any)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_supporter_badge(p_user_id uuid)
RETURNS TABLE(
    tier_name text,
    badge_icon text,
    badge_color text,
    is_active boolean
)
LANGUAGE sql STABLE
AS $$
    SELECT
        t.name AS tier_name,
        t.badge_icon,
        t.badge_color,
        s.is_active
    FROM public.instance_supporters s
    LEFT JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
    WHERE s.user_id = p_user_id
      AND s.is_active = true
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
    LIMIT 1;
$$;

-- Table grants for PostgREST access
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_funding TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_supporter_tiers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_supporters TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
