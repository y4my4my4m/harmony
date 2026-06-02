-- =============================================================================
-- Migration: Ko-fi webhook integration + pending donations
-- =============================================================================
--
-- Adds the schema needed for automated donation tracking via the Ko-fi
-- webhook system (Ko-fi Gold-tier feature):
--
-- 1. Self-healing prerequisite check: creates `instance_funding`,
--    `instance_supporter_tiers`, `instance_supporters`, and
--    `instance_donation_history` if they don't exist. This allows the
--    migration to apply cleanly even on older local instances that never
--    ran 20260309_instance_funding.sql / 20260309_reports_align_and_donations.sql.
--
-- 2. `instance_funding` gains:
--    - `kofi_webhook_token`    - verification_token from Ko-fi dashboard
--    - `kofi_auto_assign_tier` - bool, whether to auto-upsert supporter row
--                                when a donation matches a known user
--
-- 3. New `instance_pending_donations` table for unmatched/manual-review
--    donations (donor didn't include their handle, or no profile matches).
--
-- 4. `instance_donation_history.external_reference` gets a partial UNIQUE
--    index so a webhook retry can't double-count a transaction.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Self-healing: create prerequisite tables if missing
-- ---------------------------------------------------------------------------
-- All `CREATE TABLE IF NOT EXISTS` so this is a no-op on instances that
-- already ran the earlier funding migration.

CREATE TABLE IF NOT EXISTS public.instance_funding (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    enabled boolean DEFAULT false,
    goal_amount numeric(10, 2),
    goal_currency text DEFAULT 'USD',
    current_amount numeric(10, 2) DEFAULT 0,
    funding_period text DEFAULT 'monthly',
    goal_description text,
    funding_links jsonb DEFAULT '[]'::jsonb,
    show_progress_bar boolean DEFAULT true,
    show_in_context_bar boolean DEFAULT false,
    context_bar_style text DEFAULT 'mini-progress',
    thank_you_message text,
    updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.instance_supporter_tiers (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    min_amount numeric(10, 2) NOT NULL,
    badge_icon text,
    badge_color text,
    perks text,
    display_order integer DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.instance_supporters (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    tier_id uuid REFERENCES public.instance_supporter_tiers(id) ON DELETE SET NULL,
    amount numeric(10, 2),
    started_at timestamptz DEFAULT now(),
    expires_at timestamptz,
    is_active boolean DEFAULT true,
    external_id text,
    platform text,
    CONSTRAINT unique_supporter_user UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_supporters_user ON public.instance_supporters (user_id);
CREATE INDEX IF NOT EXISTS idx_supporters_active ON public.instance_supporters (is_active);

CREATE TABLE IF NOT EXISTS public.instance_donation_history (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    supporter_id uuid NOT NULL REFERENCES public.instance_supporters(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount numeric(10, 2) NOT NULL,
    currency text DEFAULT 'USD',
    platform text,
    external_reference text,
    note text,
    donated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_donation_history_user ON public.instance_donation_history (user_id);
CREATE INDEX IF NOT EXISTS idx_donation_history_supporter ON public.instance_donation_history (supporter_id);
CREATE INDEX IF NOT EXISTS idx_donation_history_date ON public.instance_donation_history (donated_at);

-- RLS on the prerequisite tables (idempotent - ENABLE is no-op if already on)
ALTER TABLE public.instance_funding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_supporter_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_supporters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_donation_history ENABLE ROW LEVEL SECURITY;

-- Baseline policies (only applied if the table was freshly created - older
-- instances will already have these via 20260309_*.sql, the DROP makes it safe).
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

DROP POLICY IF EXISTS "donation_history_select_admin" ON public.instance_donation_history;
CREATE POLICY "donation_history_select_admin" ON public.instance_donation_history
    FOR SELECT TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
        OR user_id = auth.uid()
    );

DROP POLICY IF EXISTS "donation_history_modify_admin" ON public.instance_donation_history;
CREATE POLICY "donation_history_modify_admin" ON public.instance_donation_history
    FOR ALL TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_funding TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_supporter_tiers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_supporters TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_donation_history TO authenticated;

-- ---------------------------------------------------------------------------
-- 1. instance_funding: Ko-fi webhook columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.instance_funding
    ADD COLUMN IF NOT EXISTS kofi_webhook_token text,
    ADD COLUMN IF NOT EXISTS kofi_auto_assign_tier boolean DEFAULT true;

COMMENT ON COLUMN public.instance_funding.kofi_webhook_token IS
    'Verification token from Ko-fi (Settings → API → Webhook URL). Required '
    'for the federation backend to accept POSTs at /webhooks/kofi.';
COMMENT ON COLUMN public.instance_funding.kofi_auto_assign_tier IS
    'When true, automatically upserts the matched user into instance_supporters '
    'with the highest tier whose min_amount <= the donation amount.';

-- ---------------------------------------------------------------------------
-- 2. instance_pending_donations
-- ---------------------------------------------------------------------------
-- Stores webhook payloads that we couldn't auto-match to a user (the donor
-- forgot to include @username@domain, or matched a username that doesn't
-- exist). Admins review these in the funding panel and either link to an
-- existing user (which promotes to instance_donation_history) or dismiss.
CREATE TABLE IF NOT EXISTS public.instance_pending_donations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    received_at timestamptz DEFAULT now(),
    platform text NOT NULL,
    external_reference text,
    amount numeric(10, 2) NOT NULL,
    currency text DEFAULT 'USD',
    donor_name text,
    donor_email text,
    donor_message text,
    raw_payload jsonb NOT NULL,
    resolved_at timestamptz,
    resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    resolved_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    -- One row per webhook transaction. Without this, a retry would
    -- insert duplicate pending rows.
    CONSTRAINT instance_pending_donations_external_unique
        UNIQUE (platform, external_reference)
);

CREATE INDEX IF NOT EXISTS idx_pending_donations_unresolved
    ON public.instance_pending_donations (received_at DESC)
    WHERE resolved_at IS NULL;

ALTER TABLE public.instance_pending_donations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pending_donations_admin_all"
    ON public.instance_pending_donations;
CREATE POLICY "pending_donations_admin_all"
    ON public.instance_pending_donations
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND is_admin = true
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.instance_pending_donations
    TO authenticated;

COMMENT ON TABLE public.instance_pending_donations IS
    'Donations received via webhook that could not be auto-matched to a '
    'profile. Admins resolve these manually via the funding admin panel.';

-- ---------------------------------------------------------------------------
-- 3. Dedup index on donation_history.external_reference
-- ---------------------------------------------------------------------------
-- Partial unique index: NULL external_reference (manual donations) are
-- always allowed; non-null values must be unique per platform so a webhook
-- retry can't double-count.
CREATE UNIQUE INDEX IF NOT EXISTS idx_donation_history_external_unique
    ON public.instance_donation_history (platform, external_reference)
    WHERE external_reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Service-role grants for webhook ingestion
-- ---------------------------------------------------------------------------
-- The federation-backend uses the Supabase service_role key for webhook
-- processing. service_role bypasses RLS but still needs explicit table
-- grants - the earlier funding migration only granted to `authenticated`,
-- which caused "permission denied for table instance_funding" errors.
GRANT SELECT ON public.instance_funding TO service_role;
GRANT SELECT ON public.instance_supporter_tiers TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.instance_supporters TO service_role;
GRANT SELECT, INSERT ON public.instance_donation_history TO service_role;
GRANT SELECT ON public.profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.instance_pending_donations
    TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
