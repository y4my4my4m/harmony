-- Migration: Update create_federated_profile function to support banners
-- Description: Adds banner_url parameter to the federated profile creation function

BEGIN;

-- Drop the existing function
DROP FUNCTION IF EXISTS public.create_federated_profile(text, text, text, text, text, text, text, text, text, text, text);

-- Recreate the function with banner_url parameter
CREATE FUNCTION public.create_federated_profile(
    p_username text, 
    p_display_name text DEFAULT NULL::text, 
    p_domain text DEFAULT NULL::text, 
    p_avatar_url text DEFAULT NULL::text, 
    p_banner_url text DEFAULT NULL::text,
    p_bio text DEFAULT NULL::text, 
    p_federated_id text DEFAULT NULL::text, 
    p_inbox_url text DEFAULT NULL::text, 
    p_outbox_url text DEFAULT NULL::text, 
    p_followers_url text DEFAULT NULL::text, 
    p_following_url text DEFAULT NULL::text, 
    p_public_key text DEFAULT NULL::text
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    new_profile_id UUID;
BEGIN
    -- Generate a new UUID for the federated profile
    new_profile_id := gen_random_uuid();
    
    -- Insert the federated profile
    INSERT INTO profiles (
        id,
        username,
        display_name,
        domain,
        avatar_url,
        banner_url,
        bio,
        federated_id,
        inbox_url,
        outbox_url,
        followers_url,
        following_url,
        public_key,
        is_local,
        auth_user_id,
        last_synced_at
    ) VALUES (
        new_profile_id,
        p_username,
        COALESCE(p_display_name, p_username),
        COALESCE(p_domain, 'unknown'),
        p_avatar_url,
        p_banner_url,
        p_bio,
        p_federated_id,
        p_inbox_url,
        p_outbox_url,
        p_followers_url,
        p_following_url,
        p_public_key,
        false, -- is_local = false for federated profiles
        NULL,  -- auth_user_id = NULL for federated profiles
        NOW()
    );
    
    RETURN new_profile_id;
END;
$$;

-- Add comment for the updated function
COMMENT ON FUNCTION public.create_federated_profile(p_username text, p_display_name text, p_domain text, p_avatar_url text, p_banner_url text, p_bio text, p_federated_id text, p_inbox_url text, p_outbox_url text, p_followers_url text, p_following_url text, p_public_key text) IS 'Creates a federated ActivityPub profile without requiring auth.users entry. Supports banner images.';

COMMIT;
