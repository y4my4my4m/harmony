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
-- Add missing FK: threads.parent_message_id → messages.id
-- This existed in production via 20251207_add_threads.sql but was missing
-- from the init file, causing PostgREST joins to fail.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'threads_parent_message_id_fkey'
        AND table_name = 'threads'
    ) THEN
        ALTER TABLE public.threads
            ADD CONSTRAINT threads_parent_message_id_fkey
            FOREIGN KEY (parent_message_id) REFERENCES public.messages(id) ON DELETE CASCADE;
    END IF;
END $$;

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
