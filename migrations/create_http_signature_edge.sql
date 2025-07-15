-- Updated HTTP signature function using edge function for proper RSA signing
-- This replaces the previous plv8-based approach with a proper cryptographic signature

CREATE OR REPLACE FUNCTION create_http_signature(
    p_target_url TEXT,
    p_body TEXT,
    p_actor_username TEXT,
    p_instance_domain TEXT,
    p_method TEXT DEFAULT 'POST'
)
RETURNS TABLE(
    signature_header TEXT,
    date_header TEXT,
    digest_header TEXT,
    headers_to_sign TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public, pg_temp
AS $$
DECLARE
    v_private_key TEXT;
    v_edge_function_url TEXT;
    v_request_body JSONB;
    v_http_response TEXT;
    v_http_status INTEGER;
    v_response_data JSONB;
BEGIN
    -- Get private key for the actor
    SELECT private_key INTO v_private_key 
    FROM profiles 
    WHERE username = p_actor_username 
      AND is_local = true
    LIMIT 1;
    
    IF v_private_key IS NULL THEN
        RAISE EXCEPTION 'No private key found for actor: %', p_actor_username;
    END IF;
    
    -- Build edge function URL
    v_edge_function_url := 'http://kong:8000/functions/v1/sign-http-request';
    
    -- Build request body for edge function
    v_request_body := jsonb_build_object(
        'target_url', p_target_url,
        'body', p_body,
        'actor_username', p_actor_username,
        'instance_domain', p_instance_domain,
        'method', p_method,
        'private_key', v_private_key
    );
    
    -- Call edge function to sign the request
    BEGIN
        SELECT status, content INTO v_http_status, v_http_response
        FROM http((
            'POST',
            v_edge_function_url,
            ARRAY[
                ('Content-Type', 'application/json'),
                ('User-Agent', 'Harmony-DB/1.0.0')
            ]::http_header[],
            'application/json',
            v_request_body::text
        )::http_request);
        
        IF v_http_status != 200 THEN
            RAISE EXCEPTION 'Edge function signing failed with HTTP %: %', v_http_status, v_http_response;
        END IF;
        
        -- Parse response
        v_response_data := v_http_response::jsonb;
        
        -- Return signature components
        RETURN QUERY SELECT 
            v_response_data->>'signature_header',
            v_response_data->>'date_header',
            v_response_data->>'digest_header',
            ARRAY(SELECT jsonb_array_elements_text(v_response_data->'headers_to_sign'));
            
    EXCEPTION 
        WHEN OTHERS THEN
            RAISE EXCEPTION 'Failed to call signing edge function: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
    END;
END;
$$;
