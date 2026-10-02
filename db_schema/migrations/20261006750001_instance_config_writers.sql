-- Instance config writers.
--
-- Production carries set_instance_config(p_admin_id uuid, p_key, p_value, p_description) in
-- place of the client's (p_key, p_value, p_user_id, p_description). It trusts p_admin_id
-- and has the default PUBLIC EXECUTE, so anon writes any key by naming an admin's profile
-- id, and every single-key write from the admin panel fails there with PGRST202. Nothing
-- calls that overload (the client, both live schemas, REACHABILITY.tsv); it is dropped.
--
-- set_instance_config(text, jsonb, uuid, text) and batch_set_instance_config(text[], jsonb[])
-- act as the caller's profile, require an instance admin (42501 otherwise), record
-- updated_by and log each key as config_change {key, old_value, new_value}, the shape
-- ActivityLog.vue renders. p_user_id is ignored. EXECUTE: authenticated and service_role.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Instance config writers
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regprocedure('public.set_instance_config(uuid, text, jsonb, text)') IS NOT NULL THEN
        RAISE NOTICE 'dropping set_instance_config(uuid, text, jsonb, text): trusts p_admin_id, no caller';
        DROP FUNCTION public.set_instance_config(uuid, text, jsonb, text);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_instance_config(
    p_key text,
    p_value jsonb,
    p_user_id uuid DEFAULT NULL,
    p_description text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_old jsonb;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(btrim(p_key), '') IS NULL THEN
        RAISE EXCEPTION 'p_key is required' USING ERRCODE = '22023';
    END IF;

    SELECT ic.config_value INTO v_old FROM public.instance_config ic WHERE ic.config_key = p_key;

    INSERT INTO public.instance_config (config_key, config_value, description, updated_at, updated_by)
    VALUES (p_key, p_value, p_description, now(), v_me)
    ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value,
           description = COALESCE(EXCLUDED.description, instance_config.description),
           updated_at = now(),
           updated_by = EXCLUDED.updated_by;

    PERFORM public.log_admin_action(v_me, 'config_change', 'config', p_key,
        jsonb_build_object('key', p_key, 'old_value', v_old, 'new_value', p_value));
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.batch_set_instance_config(p_keys text[], p_values jsonb[])
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_old jsonb;
    i integer;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    IF cardinality(p_keys) IS DISTINCT FROM cardinality(p_values) THEN
        RAISE EXCEPTION 'Keys and values arrays must have the same length' USING ERRCODE = '22023';
    END IF;

    FOR i IN 1 .. COALESCE(cardinality(p_keys), 0) LOOP
        IF NULLIF(btrim(p_keys[i]), '') IS NULL THEN
            RAISE EXCEPTION 'p_keys[%] is empty', i USING ERRCODE = '22023';
        END IF;

        SELECT ic.config_value INTO v_old FROM public.instance_config ic WHERE ic.config_key = p_keys[i];

        INSERT INTO public.instance_config (config_key, config_value, updated_at, updated_by)
        VALUES (p_keys[i], p_values[i], now(), v_me)
        ON CONFLICT (config_key) DO UPDATE
           SET config_value = EXCLUDED.config_value,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by;

        IF v_old IS DISTINCT FROM p_values[i] THEN
            PERFORM public.log_admin_action(v_me, 'config_change', 'config', p_keys[i],
                jsonb_build_object('key', p_keys[i], 'old_value', v_old, 'new_value', p_values[i]));
        END IF;
    END LOOP;

    RETURN true;
END;
$$;

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.set_instance_config(text, jsonb, uuid, text)'::regprocedure,
                              'public.batch_set_instance_config(text[], jsonb[])'::regprocedure] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
        FOREACH grantee IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
        END LOOP;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
