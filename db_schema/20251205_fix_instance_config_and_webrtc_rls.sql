-- Fix set_instance_config function to properly cast json to jsonb for log_admin_action
CREATE OR REPLACE FUNCTION "public"."set_instance_config"("p_admin_id" "uuid", "p_key" "text", "p_value" "jsonb", "p_description" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    old_value JSONB;
BEGIN
    -- Check if admin has permission
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    
    -- Get old value for logging
    SELECT config_value INTO old_value FROM instance_config WHERE config_key = p_key;
    
    -- Update or insert configuration
    INSERT INTO instance_config (config_key, config_value, description, updated_by, updated_at)
    VALUES (p_key, p_value, p_description, p_admin_id, NOW())
    ON CONFLICT (config_key) DO UPDATE SET
        config_value = p_value,
        description = COALESCE(p_description, instance_config.description),
        updated_by = p_admin_id,
        updated_at = NOW();
    
    -- Log the action (cast json_build_object to jsonb)
    PERFORM log_admin_action(
        p_admin_id,
        'config_change',
        'config',
        p_key,
        json_build_object(
            'old_value', old_value,
            'new_value', p_value,
            'key', p_key
        )::jsonb
    );
    
    RETURN TRUE;
END;
$$;