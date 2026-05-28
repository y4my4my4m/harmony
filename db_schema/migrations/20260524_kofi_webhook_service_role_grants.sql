-- =============================================================================
-- Migration: Grant funding tables to service_role for webhook ingestion
-- =============================================================================
--
-- The federation-backend uses the Supabase service_role key (which bypasses
-- RLS) when processing donation webhooks. Bypassing RLS is NOT the same as
-- bypassing PostgreSQL table grants — service_role still needs explicit
-- GRANT permissions to SELECT/INSERT/UPDATE the funding tables.
--
-- The earlier funding migration (20260309_*) only granted to `authenticated`.
-- This caused "permission denied for table instance_funding" errors when the
-- Ko-fi webhook handler ran loadFundingConfig() server-side.
--
-- Idempotent: GRANTs are additive and don't error if already present.
-- =============================================================================

BEGIN;

-- Read-only lookups during webhook processing
GRANT SELECT ON public.instance_funding TO service_role;
GRANT SELECT ON public.instance_supporter_tiers TO service_role;

-- Webhook needs to upsert supporters (matched donation) and insert
-- donation history rows.
GRANT SELECT, INSERT, UPDATE ON public.instance_supporters TO service_role;
GRANT SELECT, INSERT ON public.instance_donation_history TO service_role;

-- profiles: webhook needs to look up user by handle when matching donors.
-- Restricted to SELECT only — we never modify profiles from a webhook.
GRANT SELECT ON public.profiles TO service_role;

-- instance_pending_donations was already granted in the previous migration
-- but include it here for completeness (idempotent).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_pending_donations TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
