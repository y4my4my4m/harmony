BEGIN;

-- =============================================================================
-- Add missing federation columns to threads table
-- These exist in production via earlier migrations but are missing from init
-- =============================================================================

ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS ap_id text;
ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS federation_status text DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_threads_ap_id ON public.threads(ap_id) WHERE ap_id IS NOT NULL;

COMMIT;
