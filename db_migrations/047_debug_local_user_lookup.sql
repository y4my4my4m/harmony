BEGIN;

-- Debug function to investigate local user lookup issue
-- This will help understand why "Local user not found: y4my4m@har.mony.lol" is happening

CREATE OR REPLACE FUNCTION debug_local_user_lookup(
    p_username TEXT DEFAULT 'y4my4m',
    p_domain TEXT DEFAULT 'har.mony.lol'
) RETURNS TABLE (
    debug_info TEXT,
    found_users JSONB
) LANGUAGE plpgsql AS $$
DECLARE
    instance_domain TEXT;
    user_count INTEGER;
    matching_users JSONB;
BEGIN
    -- Get the configured instance domain
    SELECT trim(both '"' from config_value::text) INTO instance_domain 
    FROM instance_config 
    WHERE config_key = 'domain' 
    LIMIT 1;
    
    RETURN QUERY SELECT 
        'Instance domain from config'::TEXT,
        to_jsonb(instance_domain);
    
    RETURN QUERY SELECT 
        'Parameter domain'::TEXT,
        to_jsonb(p_domain);
    
    RETURN QUERY SELECT 
        'Domain match?'::TEXT,
        to_jsonb(instance_domain = p_domain);
    
    -- Check all users with this username
    SELECT count(*), jsonb_agg(jsonb_build_object(
        'id', id,
        'username', username,
        'domain', domain,
        'is_local', is_local,
        'federated_id', federated_id
    )) INTO user_count, matching_users
    FROM profiles 
    WHERE username = p_username;
    
    RETURN QUERY SELECT 
        format('Total users with username "%s"', p_username)::TEXT,
        to_jsonb(user_count);
    
    RETURN QUERY SELECT 
        'All matching users'::TEXT,
        COALESCE(matching_users, '[]'::jsonb);
    
    -- Check the specific lookup that's failing
    SELECT count(*), jsonb_agg(jsonb_build_object(
        'id', id,
        'username', username,
        'domain', domain,
        'is_local', is_local,
        'federated_id', federated_id
    )) INTO user_count, matching_users
    FROM profiles 
    WHERE username = p_username 
      AND domain = instance_domain 
      AND is_local = true;
    
    RETURN QUERY SELECT 
        format('Users matching exact lookup (username=%s, domain=%s, is_local=true)', p_username, instance_domain)::TEXT,
        to_jsonb(user_count);
    
    RETURN QUERY SELECT 
        'Exact lookup results'::TEXT,
        COALESCE(matching_users, '[]'::jsonb);
    
    -- Check if there's a user with NULL domain
    SELECT count(*), jsonb_agg(jsonb_build_object(
        'id', id,
        'username', username,
        'domain', domain,
        'is_local', is_local,
        'federated_id', federated_id
    )) INTO user_count, matching_users
    FROM profiles 
    WHERE username = p_username 
      AND domain IS NULL
      AND is_local = true;
    
    RETURN QUERY SELECT 
        format('Users with username=%s, domain=NULL, is_local=true', p_username)::TEXT,
        to_jsonb(user_count);
    
    RETURN QUERY SELECT 
        'NULL domain results'::TEXT,
        COALESCE(matching_users, '[]'::jsonb);
        
    -- Check alternative lookup patterns
    SELECT count(*), jsonb_agg(jsonb_build_object(
        'id', id,
        'username', username,
        'domain', domain,
        'is_local', is_local,
        'federated_id', federated_id
    )) INTO user_count, matching_users
    FROM profiles 
    WHERE username = p_username 
      AND is_local = true;
    
    RETURN QUERY SELECT 
        format('All local users with username=%s (any domain)', p_username)::TEXT,
        to_jsonb(user_count);
    
    RETURN QUERY SELECT 
        'All local users results'::TEXT,
        COALESCE(matching_users, '[]'::jsonb);
        
END $$;

-- Test the debug function
SELECT * FROM debug_local_user_lookup();

COMMIT;