BEGIN;

CREATE OR REPLACE FUNCTION public.batch_set_instance_config(
    p_keys text[],
    p_values jsonb[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_admin boolean := false;
    v_caller_profile_id uuid;
    i integer;
BEGIN
    SELECT id INTO v_caller_profile_id
    FROM profiles
    WHERE auth_user_id = auth.uid();

    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Must be authenticated with a valid profile';
    END IF;

    SELECT is_admin INTO v_is_admin
    FROM profiles
    WHERE id = v_caller_profile_id;

    IF NOT COALESCE(v_is_admin, false) THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required';
    END IF;

    IF array_length(p_keys, 1) != array_length(p_values, 1) THEN
        RAISE EXCEPTION 'Keys and values arrays must have the same length';
    END IF;

    FOR i IN 1..array_length(p_keys, 1) LOOP
        INSERT INTO instance_config (config_key, config_value, updated_at)
        VALUES (p_keys[i], p_values[i], now())
        ON CONFLICT (config_key) DO UPDATE
        SET config_value = EXCLUDED.config_value,
            updated_at = now();
    END LOOP;

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.batch_set_instance_config(text[], jsonb[]) TO authenticated;

COMMIT;
