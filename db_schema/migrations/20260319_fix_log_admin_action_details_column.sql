-- =============================================================================
-- Migration: Fix log_admin_action to use action_details column
-- =============================================================================
-- admin_audit_log uses action_details (per init and 20260309_admin_improvements).
-- log_admin_action was still inserting into "details", causing:
--   column "details" of relation "admin_audit_log" does not exist
-- (e.g. when calling moderate_user RPC).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.log_admin_action(
    p_admin_id uuid,
    p_action_type text,
    p_target_type text,
    p_target_id text,
    p_details jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_log_id uuid;
BEGIN
    INSERT INTO admin_audit_log (admin_id, action_type, target_type, target_id, action_details)
    VALUES (p_admin_id, p_action_type, p_target_type, p_target_id, p_details)
    RETURNING id INTO v_log_id;

    RETURN v_log_id;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
