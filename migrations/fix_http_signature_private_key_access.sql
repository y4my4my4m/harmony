-- Migration: Fix HTTP signature function to use secure private key access
-- This fixes the security vulnerability where create_http_signature was accessing
-- private keys directly from the profiles table

-- Replace the create_http_signature function to use the new user_private_keys table
CREATE OR REPLACE FUNCTION public.create_http_signature(
    p_target_url text, 
    p_body text, 
    p_actor_username text, 
    p_instance_domain text, 
    p_method text DEFAULT 'POST'::text
) RETURNS TABLE(
    signature_header text, 
    date_header text, 
    digest_header text, 
    headers_to_sign text[]
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $$
DECLARE
    v_private_key TEXT;
    v_edge_function_url TEXT;
    v_request_body JSONB;
    v_http_response TEXT;
    v_http_status INTEGER;
    v_response_data JSONB;
    v_profile_id UUID;
BEGIN
    -- First get the profile ID for the actor
    SELECT id INTO v_profile_id
    FROM profiles 
    WHERE username = p_actor_username 
      AND is_local = true
    LIMIT 1;
    
    IF v_profile_id IS NULL THEN
        RAISE EXCEPTION 'No local profile found for actor: %', p_actor_username;
    END IF;
    
    -- Get private key from the secure table (only accessible by service role)
    SELECT private_key INTO v_private_key 
    FROM user_private_keys 
    WHERE profile_id = v_profile_id;
    
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

-- Update the function comment to reflect the security fix
COMMENT ON FUNCTION public.create_http_signature(text, text, text, text, text) IS 'Generates HTTP signatures for ActivityPub federation using edge function with proper RSA-SHA256 signing. SECURITY: Uses secure user_private_keys table instead of profiles table.';

-- Fix generate_activitypub_metadata function to store private keys securely
CREATE OR REPLACE FUNCTION public.generate_activitypub_metadata(
    p_user_id uuid, 
    p_username text, 
    p_domain text
) RETURNS TABLE(
    federated_id text, 
    inbox_url text, 
    outbox_url text, 
    followers_url text, 
    following_url text, 
    featured_url text, 
    public_key text, 
    private_key text
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_base_url TEXT;
    v_user_url TEXT;
    v_private_key TEXT;
    v_public_key TEXT;
BEGIN
    -- Build base URLs
    v_base_url := 'https://' || p_domain;
    v_user_url := v_base_url || '/users/' || p_username;
    
    -- Generate RSA key pair
    SELECT rsa.private_key, rsa.public_key 
    INTO v_private_key, v_public_key
    FROM generate_rsa_keypair() AS rsa;
    
    -- Store private key securely in user_private_keys table
    INSERT INTO user_private_keys (profile_id, private_key, created_at)
    VALUES (p_user_id, v_private_key, NOW())
    ON CONFLICT (profile_id) DO UPDATE SET 
        private_key = EXCLUDED.private_key,
        created_at = EXCLUDED.created_at;
    
    -- Return all ActivityPub metadata (private_key returned for compatibility but should not be stored in profiles)
    RETURN QUERY SELECT
        v_user_url,                              -- federated_id
        v_user_url || '/inbox',                  -- inbox_url
        v_user_url || '/outbox',                 -- outbox_url
        v_user_url || '/followers',              -- followers_url
        v_user_url || '/following',              -- following_url
        v_user_url || '/featured',               -- featured_url
        v_public_key,                            -- public_key
        v_private_key;                           -- private_key (for compatibility)
END;
$$;

-- Update the function comment
COMMENT ON FUNCTION public.generate_activitypub_metadata(uuid, text, text) IS 'Generates complete ActivityPub federation metadata including RSA keys and standard URLs for a user. SECURITY: Private keys are now stored in secure user_private_keys table.';

-- Fix add_activitypub_keys_to_user function to use secure storage
CREATE OR REPLACE FUNCTION public.add_activitypub_keys_to_user(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_profile RECORD;
    v_metadata RECORD;
BEGIN
    -- Get user profile
    SELECT username, domain, is_local 
    INTO v_profile
    FROM profiles 
    WHERE id = p_user_id AND is_local = true;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Local user not found: %', p_user_id;
    END IF;
    
    -- Generate ActivityPub metadata (this will store private key securely)
    SELECT * INTO v_metadata
    FROM generate_activitypub_metadata(
        p_user_id,
        v_profile.username,
        v_profile.domain
    );
    
    -- Update the profile with ActivityPub data (NO private_key stored here)
    UPDATE profiles SET
        federated_id = v_metadata.federated_id,
        inbox_url = v_metadata.inbox_url,
        outbox_url = v_metadata.outbox_url,
        followers_url = v_metadata.followers_url,
        following_url = v_metadata.following_url,
        featured_url = v_metadata.featured_url,
        public_key = v_metadata.public_key,
        -- private_key = v_metadata.private_key, -- REMOVED: No longer stored in profiles
        last_synced_at = NOW()
    WHERE id = p_user_id;
    
    RAISE NOTICE 'Generated ActivityPub keys for user: % (ID: %) - Private key stored securely', v_profile.username, p_user_id;
    
    RETURN TRUE;
END;
$$;

-- Update the function comment
COMMENT ON FUNCTION public.add_activitypub_keys_to_user(uuid) IS 'Adds ActivityPub federation support to an existing local user by generating keys and URLs. SECURITY: Private keys are stored in secure user_private_keys table.';
