-- =============================================
-- Add create_federated_profile function and fix orphaned keys
-- This function is called by process_activitypub_emoji_reaction but was missing
-- Also adds protection to prevent overwriting local users with remote data
-- =============================================

-- First, fix the orphaned public key for user ar53n
-- This will clear the public_key so it regenerates correctly with a matching private key
SELECT clear_orphaned_public_keys();

-- Create the missing create_federated_profile function
-- This is used to create profiles for remote ActivityPub actors
CREATE OR REPLACE FUNCTION public.create_federated_profile(
    p_username text,
    p_display_name text DEFAULT NULL,
    p_domain text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL,
    p_banner_url text DEFAULT NULL,
    p_federated_id text DEFAULT NULL,
    p_bio text DEFAULT NULL,
    p_inbox_url text DEFAULT NULL,
    p_outbox_url text DEFAULT NULL,
    p_followers_url text DEFAULT NULL,
    p_following_url text DEFAULT NULL,
    p_public_key text DEFAULT NULL,
    p_shared_inbox_url text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_profile_id uuid;
    v_instance_domain text;
BEGIN
    -- Get our instance domain to prevent creating "remote" profiles for local domain
    SELECT COALESCE(
        (SELECT trim(both '"' from config_value::text) FROM instance_config WHERE config_key = 'domain'),
        'har.mony.lol'
    ) INTO v_instance_domain;
    
    -- SECURITY: Refuse to create/update profiles for our own domain
    -- This prevents a malicious remote instance from overwriting local users
    IF p_domain = v_instance_domain THEN
        RAISE WARNING 'Refusing to create federated profile for local domain: %@%', p_username, p_domain;
        
        -- Try to return existing local user's ID instead
        SELECT id INTO v_profile_id
        FROM profiles
        WHERE username = p_username AND domain = p_domain AND is_local = true;
        
        RETURN v_profile_id;
    END IF;
    
    -- Insert or update the federated profile
    INSERT INTO profiles (
        username, 
        display_name, 
        domain, 
        avatar_url, 
        banner_url,
        federated_id, 
        bio, 
        inbox_url, 
        outbox_url, 
        followers_url,
        following_url, 
        public_key, 
        shared_inbox_url,
        is_local,
        last_synced_at
    ) VALUES (
        p_username, 
        COALESCE(p_display_name, p_username), 
        p_domain,
        p_avatar_url, 
        p_banner_url, 
        p_federated_id, 
        p_bio,
        p_inbox_url, 
        p_outbox_url, 
        p_followers_url,
        p_following_url, 
        p_public_key, 
        p_shared_inbox_url,
        false,  -- ALWAYS false for federated profiles
        NOW()
    )
    ON CONFLICT (username, domain) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
        avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
        banner_url = COALESCE(EXCLUDED.banner_url, profiles.banner_url),
        federated_id = COALESCE(EXCLUDED.federated_id, profiles.federated_id),
        bio = COALESCE(EXCLUDED.bio, profiles.bio),
        inbox_url = COALESCE(EXCLUDED.inbox_url, profiles.inbox_url),
        outbox_url = COALESCE(EXCLUDED.outbox_url, profiles.outbox_url),
        followers_url = COALESCE(EXCLUDED.followers_url, profiles.followers_url),
        following_url = COALESCE(EXCLUDED.following_url, profiles.following_url),
        public_key = COALESCE(EXCLUDED.public_key, profiles.public_key),
        shared_inbox_url = COALESCE(EXCLUDED.shared_inbox_url, profiles.shared_inbox_url),
        last_synced_at = NOW(),
        updated_at = NOW()
    WHERE profiles.is_local = false  -- CRITICAL: Never update local users!
    RETURNING id INTO v_profile_id;
    
    -- If no profile was returned (because it's a local user that we refused to update),
    -- try to get the existing profile ID
    IF v_profile_id IS NULL THEN
        SELECT id INTO v_profile_id
        FROM profiles
        WHERE username = p_username AND domain = p_domain;
    END IF;
    
    RETURN v_profile_id;
END;
$$;

COMMENT ON FUNCTION public.create_federated_profile IS 
'Creates or updates a federated (remote) user profile. 
SECURITY: Refuses to create/update profiles for the local instance domain.
SECURITY: ON CONFLICT only updates profiles where is_local = false.
Used by process_activitypub_emoji_reaction and other ActivityPub handlers.';

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION public.create_federated_profile TO service_role;

-- Also create a helper function to safely upsert remote profiles
-- This provides an additional layer of protection
CREATE OR REPLACE FUNCTION public.safe_upsert_remote_profile(
    p_username text,
    p_domain text,
    p_federated_id text DEFAULT NULL,
    p_display_name text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL,
    p_banner_url text DEFAULT NULL,
    p_bio text DEFAULT NULL,
    p_public_key text DEFAULT NULL,
    p_inbox_url text DEFAULT NULL,
    p_outbox_url text DEFAULT NULL,
    p_followers_url text DEFAULT NULL,
    p_following_url text DEFAULT NULL,
    p_shared_inbox_url text DEFAULT NULL
) RETURNS TABLE(profile_id uuid, was_created boolean, was_updated boolean, is_local_user boolean)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_profile_id uuid;
    v_was_created boolean := false;
    v_was_updated boolean := false;
    v_is_local_user boolean := false;
    v_instance_domain text;
BEGIN
    -- Get our instance domain
    SELECT COALESCE(
        (SELECT trim(both '"' from config_value::text) FROM instance_config WHERE config_key = 'domain'),
        'har.mony.lol'
    ) INTO v_instance_domain;
    
    -- Check if this is our local domain
    IF p_domain = v_instance_domain THEN
        -- Return existing local user without modification
        SELECT id, true INTO v_profile_id, v_is_local_user
        FROM profiles
        WHERE username = p_username AND domain = p_domain AND is_local = true;
        
        RETURN QUERY SELECT v_profile_id, false, false, true;
        RETURN;
    END IF;
    
    -- Check if profile exists
    SELECT id, is_local INTO v_profile_id, v_is_local_user
    FROM profiles
    WHERE username = p_username AND domain = p_domain;
    
    IF v_profile_id IS NULL THEN
        -- Create new remote profile
        INSERT INTO profiles (
            username, domain, federated_id, display_name, avatar_url, banner_url,
            bio, public_key, inbox_url, outbox_url, followers_url, following_url,
            shared_inbox_url, is_local, last_synced_at
        ) VALUES (
            p_username, p_domain, p_federated_id, COALESCE(p_display_name, p_username),
            p_avatar_url, p_banner_url, p_bio, p_public_key, p_inbox_url, p_outbox_url,
            p_followers_url, p_following_url, p_shared_inbox_url, false, NOW()
        )
        RETURNING id INTO v_profile_id;
        
        v_was_created := true;
    ELSIF NOT v_is_local_user THEN
        -- Update existing remote profile
        UPDATE profiles SET
            federated_id = COALESCE(p_federated_id, federated_id),
            display_name = COALESCE(p_display_name, display_name),
            avatar_url = COALESCE(p_avatar_url, avatar_url),
            banner_url = COALESCE(p_banner_url, banner_url),
            bio = COALESCE(p_bio, bio),
            public_key = COALESCE(p_public_key, public_key),
            inbox_url = COALESCE(p_inbox_url, inbox_url),
            outbox_url = COALESCE(p_outbox_url, outbox_url),
            followers_url = COALESCE(p_followers_url, followers_url),
            following_url = COALESCE(p_following_url, following_url),
            shared_inbox_url = COALESCE(p_shared_inbox_url, shared_inbox_url),
            last_synced_at = NOW(),
            updated_at = NOW()
        WHERE id = v_profile_id;
        
        v_was_updated := true;
    END IF;
    -- If it's a local user, we don't update anything
    
    RETURN QUERY SELECT v_profile_id, v_was_created, v_was_updated, v_is_local_user;
END;
$$;

COMMENT ON FUNCTION public.safe_upsert_remote_profile IS 
'Safely upserts a remote profile with protection against overwriting local users.
Returns profile_id, was_created, was_updated, and is_local_user flags.
Use this instead of direct upsert for maximum safety.';

GRANT EXECUTE ON FUNCTION public.safe_upsert_remote_profile TO service_role;


