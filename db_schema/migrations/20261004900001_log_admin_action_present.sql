-- public.log_admin_action exists on every instance.
--
-- Staging carries no log_admin_action; admin moderation there raises 42883. Production and
-- a fresh install carry the baseline definition. It is created where missing and an
-- existing one is left untouched; grants match 20261004200001.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $do$
BEGIN
    IF to_regprocedure('public.log_admin_action(uuid, text, text, text, jsonb, inet, text)') IS NULL THEN
        CREATE FUNCTION public.log_admin_action(
            p_admin_id uuid,
            p_action_type text,
            p_target_type text DEFAULT NULL::text,
            p_target_id text DEFAULT NULL::text,
            p_action_details jsonb DEFAULT NULL::jsonb,
            p_ip_address inet DEFAULT NULL::inet,
            p_user_agent text DEFAULT NULL::text
        )
        RETURNS uuid
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
        DECLARE
            v_log_id uuid;
        BEGIN
            INSERT INTO admin_audit_log (admin_id, action_type, target_type, target_id, action_details, ip_address, user_agent)
            VALUES (p_admin_id, p_action_type, p_target_type, p_target_id, p_action_details, p_ip_address, p_user_agent)
            RETURNING id INTO v_log_id;

            RETURN v_log_id;
        END;
        $$;
    END IF;
END;
$do$;

REVOKE ALL ON FUNCTION public.log_admin_action(uuid, text, text, text, jsonb, inet, text)
    FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
    grantee text;
BEGIN
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.log_admin_action(uuid, text, text, text, jsonb, inet, text) TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
