-- =============================================================================
-- Migration: Admin Improvements
-- =============================================================================
-- Adds unique constraint on federated_instances.domain,
-- normalizes admin_audit_log columns across environments, and
-- ensures proper indexes and RLS.
--
-- The init schema uses (action, details) while prod uses
-- (action_type, action_details, user_agent). This migration
-- normalizes to (action_type, action_details, user_agent).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Ensure unique constraint on federated_instances.domain
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'federated_instances_domain_key'
    ) THEN
        ALTER TABLE public.federated_instances
            ADD CONSTRAINT federated_instances_domain_key UNIQUE (domain);
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Unique constraint may already exist: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- Normalize admin_audit_log columns
-- If the table has the init-schema columns (action, details), rename them
-- to match the prod schema (action_type, action_details) and add user_agent.
-- If it already has action_type, these are no-ops.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    -- Rename "action" -> "action_type" if needed
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_audit_log' AND column_name = 'action'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_audit_log' AND column_name = 'action_type'
    ) THEN
        ALTER TABLE public.admin_audit_log RENAME COLUMN action TO action_type;
        RAISE NOTICE 'Renamed admin_audit_log.action -> action_type';
    END IF;

    -- Rename "details" -> "action_details" if needed
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_audit_log' AND column_name = 'details'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_audit_log' AND column_name = 'action_details'
    ) THEN
        ALTER TABLE public.admin_audit_log RENAME COLUMN details TO action_details;
        RAISE NOTICE 'Renamed admin_audit_log.details -> action_details';
    END IF;

    -- Add user_agent column if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_audit_log' AND column_name = 'user_agent'
    ) THEN
        ALTER TABLE public.admin_audit_log ADD COLUMN user_agent text;
        RAISE NOTICE 'Added admin_audit_log.user_agent';
    END IF;

    -- If target_id is uuid in init but text in prod, alter to text
    -- (text is a superset; uuid values cast to text transparently)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_audit_log'
          AND column_name = 'target_id' AND data_type = 'uuid'
    ) THEN
        ALTER TABLE public.admin_audit_log ALTER COLUMN target_id TYPE text USING target_id::text;
        RAISE NOTICE 'Changed admin_audit_log.target_id from uuid to text';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Ensure admin_audit_log has proper indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_log_created
    ON public.admin_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_admin
    ON public.admin_audit_log(admin_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_action
    ON public.admin_audit_log(action_type);

-- ---------------------------------------------------------------------------
-- RLS for admin_audit_log (ensure admins can read and write)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "audit_log_select_admin" ON public.admin_audit_log;
CREATE POLICY "audit_log_select_admin" ON public.admin_audit_log
    FOR SELECT TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

DROP POLICY IF EXISTS "audit_log_insert_admin" ON public.admin_audit_log;
CREATE POLICY "audit_log_insert_admin" ON public.admin_audit_log
    FOR INSERT TO authenticated WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

NOTIFY pgrst, 'reload schema';

COMMIT;
