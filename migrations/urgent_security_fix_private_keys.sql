-- URGENT SECURITY FIX: Move private keys to secure table
-- This migration addresses the critical security vulnerability where private keys 
-- were exposed through the profiles table

-- Step 1: Create secure private keys table (server-side only access)
CREATE TABLE IF NOT EXISTS public.user_private_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    private_key TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure one private key per user
    UNIQUE(user_id)
);

-- Step 2: Migrate existing private keys from profiles to secure table
INSERT INTO public.user_private_keys (user_id, private_key)
SELECT id, private_key 
FROM public.profiles 
WHERE private_key IS NOT NULL;

-- Step 3: Remove private_key column from profiles table
ALTER TABLE public.profiles DROP COLUMN IF EXISTS private_key;

-- Step 4: Set up RLS - CRITICAL: No read access for regular users
ALTER TABLE public.user_private_keys ENABLE ROW LEVEL SECURITY;

-- Only service role can access private keys (for server-side operations)
CREATE POLICY "Service role only access" ON public.user_private_keys
    FOR ALL USING (auth.role() = 'service_role');

-- Step 5: Create server-side function to get private key (RPC only)
CREATE OR REPLACE FUNCTION get_user_private_key(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER -- Runs with elevated privileges
SET search_path = public
AS $$
DECLARE
    v_private_key TEXT;
BEGIN
    -- This function can only be called server-side
    -- Additional security: check if caller has proper permissions
    SELECT private_key INTO v_private_key
    FROM user_private_keys
    WHERE user_id = p_user_id;
    
    RETURN v_private_key;
END;
$$;

-- Grant execute only to service role
REVOKE ALL ON FUNCTION get_user_private_key(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_user_private_key(UUID) TO service_role;

-- Step 6: Update the generate_activitypub_metadata function to use secure table
CREATE OR REPLACE FUNCTION public.generate_activitypub_metadata(p_user_id uuid, p_username text, p_domain text) 
RETURNS TABLE(federated_id text, inbox_url text, outbox_url text, followers_url text, following_url text, featured_url text, public_key text, private_key text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_public_key TEXT;
    v_private_key TEXT;
BEGIN
    -- Get keys from secure table
    SELECT upk.private_key INTO v_private_key
    FROM user_private_keys upk
    WHERE upk.user_id = p_user_id;
    
    -- Get public key from profiles (this is safe to expose)
    SELECT p.public_key INTO v_public_key
    FROM profiles p
    WHERE p.id = p_user_id;
    
    -- If no keys exist, generate them
    IF v_private_key IS NULL THEN
        SELECT rsa.private_key, rsa.public_key 
        INTO v_private_key, v_public_key
        FROM generate_rsa_keypair() AS rsa;
        
        -- Store private key securely
        INSERT INTO user_private_keys (user_id, private_key)
        VALUES (p_user_id, v_private_key)
        ON CONFLICT (user_id) DO UPDATE SET private_key = EXCLUDED.private_key;
        
        -- Update public key in profiles
        UPDATE profiles SET public_key = v_public_key WHERE id = p_user_id;
    END IF;

    RETURN QUERY SELECT
        'https://' || p_domain || '/users/' || p_username,  -- federated_id
        'https://' || p_domain || '/users/' || p_username || '/inbox',  -- inbox_url
        'https://' || p_domain || '/users/' || p_username || '/outbox', -- outbox_url
        'https://' || p_domain || '/users/' || p_username || '/followers', -- followers_url
        'https://' || p_domain || '/users/' || p_username || '/following', -- following_url
        'https://' || p_domain || '/users/' || p_username || '/featured',  -- featured_url
        v_public_key,                        -- public_key (safe to expose)
        v_private_key;                       -- private_key (server-side only)
END;
$$;
