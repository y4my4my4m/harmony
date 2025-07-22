-- Debug Migration: Check instance_config table for malformed domain data

DO $$
DECLARE
    domain_value TEXT;
    config_record RECORD;
BEGIN
    RAISE WARNING '🔍 Checking instance_config table for domain issues...';
    
    -- Check all config entries
    FOR config_record IN SELECT config_key, config_value, pg_typeof(config_value) FROM instance_config
    LOOP
        RAISE WARNING '🔍 Config - Key: %, Value: %, Type: %', 
            config_record.config_key, 
            config_record.config_value, 
            config_record.pg_typeof;
    END LOOP;
    
    -- Check the specific domain extraction
    BEGIN
        SELECT trim(both '"' from config_value::text) INTO domain_value 
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;
        
        RAISE WARNING '🔍 Extracted domain value: %', domain_value;
        
        -- Check if domain contains @
        IF domain_value LIKE '%@%' THEN
            RAISE WARNING '❌ PROBLEM: Domain contains @ character: %', domain_value;
        END IF;
        
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '❌ ERROR extracting domain - SQLSTATE: %, Message: %', SQLSTATE, SQLERRM;
    END;
END;
$$;