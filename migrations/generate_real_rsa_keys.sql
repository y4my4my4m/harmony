-- Real RSA Key Generation for ActivityPub Federation
-- This replaces the hardcoded development keys with proper RSA-2048 key pairs

-- Note: This implementation uses multiple fallback strategies since PostgreSQL 
-- doesn't have built-in RSA key generation. For production, consider:
-- 1. External service for key generation
-- 2. Application-level key generation during user registration
-- 3. Custom PostgreSQL extension with OpenSSL integration

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION generate_rsa_keypair()
RETURNS TABLE(
    private_key TEXT,
    public_key TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_url TEXT := 'http://kong:8000/functions/v1/generate-keys'; -- Update to your edge function endpoint if needed
    v_status INTEGER;
    v_response TEXT;
    v_data JSONB;
BEGIN
    -- Call the edge function to generate real keys
    SELECT status, content INTO v_status, v_response
      FROM http((
        'POST',
        v_url,
        ARRAY[ ('Content-Type','application/json') ]::http_header[],
        'application/json',
        '{}' -- empty POST body
      )::http_request);

    IF v_status != 200 THEN
      RAISE EXCEPTION 'Failed to fetch keys: HTTP %: %', v_status, v_response;
    END IF;

    v_data := v_response::jsonb;

    RETURN QUERY SELECT
      v_data->>'private_key',
      v_data->>'public_key';
END;
$$;

-- Function to generate ActivityPub federation metadata for a user
CREATE OR REPLACE FUNCTION generate_activitypub_metadata(
    p_user_id UUID,
    p_username TEXT,
    p_domain TEXT
)
RETURNS TABLE(
    federated_id TEXT,
    inbox_url TEXT,
    outbox_url TEXT,
    followers_url TEXT,
    following_url TEXT,
    featured_url TEXT,
    public_key TEXT,
    private_key TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
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
    
    -- Return all ActivityPub metadata
    RETURN QUERY SELECT
        v_user_url,                              -- federated_id
        v_user_url || '/inbox',                  -- inbox_url
        v_user_url || '/outbox',                 -- outbox_url
        v_user_url || '/followers',              -- followers_url
        v_user_url || '/following',              -- following_url
        v_user_url || '/featured',               -- featured_url
        v_public_key,                            -- public_key
        v_private_key;                           -- private_key
END;
$$;

-- Function to update existing user with ActivityPub keys (for migration)
CREATE OR REPLACE FUNCTION add_activitypub_keys_to_user(
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
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
    
    -- Generate ActivityPub metadata
    SELECT * INTO v_metadata
    FROM generate_activitypub_metadata(
        p_user_id,
        v_profile.username,
        v_profile.domain
    );
    
    -- Update the profile with ActivityPub data
    UPDATE profiles SET
        federated_id = v_metadata.federated_id,
        inbox_url = v_metadata.inbox_url,
        outbox_url = v_metadata.outbox_url,
        followers_url = v_metadata.followers_url,
        following_url = v_metadata.following_url,
        featured_url = v_metadata.featured_url,
        public_key = v_metadata.public_key,
        private_key = v_metadata.private_key,
        last_synced_at = NOW()
    WHERE id = p_user_id;
    
    RAISE NOTICE 'Generated ActivityPub keys for user: % (ID: %)', v_profile.username, p_user_id;
    
    RETURN TRUE;
END;
$$;

-- Function to regenerate keys for all existing local users
CREATE OR REPLACE FUNCTION regenerate_all_activitypub_keys()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    user_record RECORD;
    updated_count INTEGER := 0;
    error_count INTEGER := 0;
    result_message TEXT;
BEGIN
    -- Loop through all local users
    FOR user_record IN 
        SELECT id, username, domain
        FROM profiles 
        WHERE is_local = true
    LOOP
        BEGIN
            PERFORM add_activitypub_keys_to_user(user_record.id);
            updated_count := updated_count + 1;
        EXCEPTION 
            WHEN OTHERS THEN
                error_count := error_count + 1;
                RAISE WARNING 'Failed to generate keys for user %: %', user_record.username, SQLERRM;
        END;
    END LOOP;
    
    result_message := format('ActivityPub key regeneration complete. Updated: %s users, Errors: %s users', 
                            updated_count, error_count);
    
    RAISE NOTICE '%', result_message;
    RETURN result_message;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION generate_rsa_keypair() TO service_role;
GRANT EXECUTE ON FUNCTION generate_activitypub_metadata(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION add_activitypub_keys_to_user(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION regenerate_all_activitypub_keys() TO service_role;

-- Documentation
COMMENT ON FUNCTION generate_rsa_keypair() IS 'Generates RSA-2048 key pairs for ActivityPub federation. Note: Uses fallback methods - implement proper RSA generation for production.';
COMMENT ON FUNCTION generate_activitypub_metadata(UUID, TEXT, TEXT) IS 'Generates complete ActivityPub federation metadata including RSA keys and standard URLs for a user.';
COMMENT ON FUNCTION add_activitypub_keys_to_user(UUID) IS 'Adds ActivityPub federation support to an existing local user by generating keys and URLs.';
COMMENT ON FUNCTION regenerate_all_activitypub_keys() IS 'Regenerates ActivityPub keys for all existing local users. Use for migration from dev keys to production keys.';

-- Usage Examples:
-- ===============
-- 
-- 1. Generate keys for a single user:
-- SELECT add_activitypub_keys_to_user('bce63d98-6b14-4c7e-b8d5-8776d2c0ee04');
-- 
-- 2. Regenerate keys for all users (migration):
-- SELECT regenerate_all_activitypub_keys();
-- 
-- 3. Generate metadata for new user (use in triggers):
-- SELECT * FROM generate_activitypub_metadata(
--     'new-user-id'::UUID, 
--     'new_username', 
--     'your-domain.com'
-- );

-- IMPORTANT PRODUCTION NOTES:
-- ==========================
-- 
-- 1. SECURITY WARNING: The current RSA key generation is NOT cryptographically secure!
--    For production use, implement one of these solutions:
--    
--    a) External Key Generation Service:
--       - Generate keys in your application code using proper crypto libraries
--       - Store them in the database after generation
--       - Use libraries like: node-forge (Node.js), cryptography (Python), etc.
--    
--    b) PostgreSQL Extension:
--       - Install a custom extension with OpenSSL integration
--       - Use pg_crypto with RSA support if available
--       - Consider extensions like pg_openssl
--    
--    c) Hybrid Approach:
--       - Generate keys during user registration in application layer
--       - Use these functions only for URL generation and metadata
--       - Pass real keys as parameters to the functions
-- 
-- 2. KEY ROTATION:
--    - Implement regular key rotation (every 6-12 months)
--    - Store old keys temporarily for signature verification
--    - Notify federated instances of key changes
-- 
-- 3. KEY STORAGE:
--    - Consider encrypting private keys at rest
--    - Use proper database security and access controls
--    - Implement key escrow for account recovery
-- 
-- 4. PERFORMANCE:
--    - Key generation can be expensive - consider doing it asynchronously
--    - Cache public keys for federation
--    - Use database triggers carefully to avoid blocking user registration
