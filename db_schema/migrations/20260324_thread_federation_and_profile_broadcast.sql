BEGIN;

-- =============================================================================
-- Add missing federation columns to threads table
-- These exist in production via earlier migrations but are missing from init
-- =============================================================================

ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS ap_id text;
ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS federation_status text DEFAULT 'pending';

-- Unique index required for upsert on ap_id in ThreadActivityHandler
CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_ap_id ON public.threads(ap_id) WHERE ap_id IS NOT NULL;

-- =============================================================================
-- Fix thread federation trigger: AFTER → BEFORE
-- The trigger function modifies NEW.federation_status, which only works in
-- BEFORE triggers. The PERFORM queue_federation_job() side effect worked in
-- AFTER, but the status was never actually written to the row.
-- =============================================================================

DROP TRIGGER IF EXISTS trigger_federate_thread ON public.threads;
CREATE TRIGGER trigger_federate_thread
    BEFORE INSERT OR UPDATE ON public.threads
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_thread_federation();

COMMIT;
