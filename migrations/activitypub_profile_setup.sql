-- ActivityPub Federation Setup for New Profiles
-- This function should be integrated with existing profile creation triggers
-- It generates RSA keys and federation URLs for local users only

-- Function to set up ActivityPub federation for new local users
CREATE OR REPLACE FUNCTION setup_activitypub_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_domain TEXT;
    v_metadata RECORD;
BEGIN
    -- Only set up federation for local users
    -- Remote federated users already have their own federation setup
    IF NEW.is_local = true OR NEW.is_local IS NULL THEN
        
        -- Get the instance domain (cast JSONB to TEXT and remove quotes if present)
        SELECT trim(both '"' from config_value::text) INTO v_domain 
        FROM instance_config 
        WHERE config_key = 'domain' 
        LIMIT 1;
        
        -- Only proceed if we have a domain configured
        IF v_domain IS NOT NULL AND v_domain != '' THEN
            
            -- Generate ActivityPub metadata including RSA keys
            SELECT * INTO v_metadata
            FROM generate_activitypub_metadata(
                NEW.id,
                NEW.username,
                v_domain
            );
            
            -- Update the profile with federation data
            -- Use UPDATE instead of modifying NEW to avoid infinite triggers
            UPDATE profiles SET
                domain = v_domain,
                federated_id = v_metadata.federated_id,
                inbox_url = v_metadata.inbox_url,
                outbox_url = v_metadata.outbox_url,
                followers_url = v_metadata.followers_url,
                following_url = v_metadata.following_url,
                featured_url = v_metadata.featured_url,
                public_key = v_metadata.public_key,
                private_key = v_metadata.private_key,
                last_synced_at = NOW()
            WHERE id = NEW.id;
            
            RAISE NOTICE 'Set up ActivityPub federation for local user: %', NEW.username;
            
        ELSE
            RAISE WARNING 'No domain configured in instance_config, skipping ActivityPub setup for user: %', NEW.username;
        END IF;
        
    ELSE
        -- Remote user - no federation setup needed
        RAISE NOTICE 'Skipping ActivityPub setup for remote user: %@%', NEW.username, NEW.domain;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Alternative function that can be called from existing triggers
-- This allows you to add it to your existing create_notification_preferences function
CREATE OR REPLACE FUNCTION add_activitypub_to_new_local_user(p_user_id UUID, p_username TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_domain TEXT;
    v_metadata RECORD;
    v_is_local BOOLEAN;
BEGIN
    -- Check if user is local
    SELECT is_local INTO v_is_local FROM profiles WHERE id = p_user_id;
    
    IF v_is_local = true OR v_is_local IS NULL THEN
        
        -- Get the instance domain (cast JSONB to TEXT and remove quotes if present)
        SELECT trim(both '"' from config_value::text) INTO v_domain 
        FROM instance_config 
        WHERE config_key = 'domain' 
        LIMIT 1;
        
        IF v_domain IS NOT NULL AND v_domain != '' THEN
            
            -- Generate ActivityPub metadata
            SELECT * INTO v_metadata
            FROM generate_activitypub_metadata(
                p_user_id,
                p_username,
                v_domain
            );
            
            -- Update the profile
            UPDATE profiles SET
                domain = v_domain,
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
            
            RAISE NOTICE 'Added ActivityPub federation to user: %', p_username;
            
        END IF;
    END IF;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION setup_activitypub_federation() TO service_role;
GRANT EXECUTE ON FUNCTION add_activitypub_to_new_local_user(UUID, TEXT) TO service_role;

-- Documentation
COMMENT ON FUNCTION setup_activitypub_federation() IS 
'Trigger function that sets up ActivityPub federation (keys, URLs) for new local users only. Remote users are skipped.';

COMMENT ON FUNCTION add_activitypub_to_new_local_user(UUID, TEXT) IS 
'Helper function to add ActivityPub federation to a user. Can be called from existing trigger functions.';

-- =============================================================================
-- INTEGRATION OPTIONS:
-- =============================================================================
-- 
-- Option 1: Separate Trigger (Clean separation)
-- ---------------------------------------------
-- CREATE TRIGGER setup_activitypub_federation_trigger 
--     AFTER INSERT ON public.profiles 
--     FOR EACH ROW 
--     EXECUTE FUNCTION setup_activitypub_federation();

-- Option 2: Integrate with existing create_notification_preferences function
-- --------------------------------------------------------------------------
-- Modify your existing create_notification_preferences() function to include:
-- 
-- BEGIN
--     -- Existing notification preferences logic
--     IF NEW.is_local = true OR NEW.is_local IS NULL THEN
--         INSERT INTO notification_preferences (user_id) VALUES (NEW.id);
--         
--         -- Add ActivityPub federation setup
--         PERFORM add_activitypub_to_new_local_user(NEW.id, NEW.username);
--     END IF;
--     RETURN NEW;
-- END;
-- 
-- Option 3: Single Combined Function (Most Efficient)
-- ---------------------------------------------------
-- Create a new comprehensive setup function that handles both:
-- 
-- CREATE OR REPLACE FUNCTION setup_new_local_user()
-- RETURNS TRIGGER AS $$
-- BEGIN
--     IF NEW.is_local = true OR NEW.is_local IS NULL THEN
--         -- Create notification preferences
--         INSERT INTO notification_preferences (user_id) VALUES (NEW.id);
--         
--         -- Set up ActivityPub federation
--         PERFORM add_activitypub_to_new_local_user(NEW.id, NEW.username);
--     END IF;
--     RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
-- 
-- Then replace the existing trigger with:
-- DROP TRIGGER create_notification_preferences_trigger ON profiles;
-- CREATE TRIGGER setup_new_local_user_trigger 
--     AFTER INSERT ON profiles 
--     FOR EACH ROW 
--     EXECUTE FUNCTION setup_new_local_user();

-- =============================================================================
-- TESTING:
-- =============================================================================
-- 
-- To test the key generation without affecting your existing triggers:
-- 
-- 1. Test key generation for existing user:
-- SELECT add_activitypub_keys_to_user('bce63d98-6b14-4c7e-b8d5-8776d2c0ee04');
-- 
-- 2. Test metadata generation:
-- SELECT * FROM generate_activitypub_metadata(
--     'bce63d98-6b14-4c7e-b8d5-8776d2c0ee04'::UUID,
--     'poring',
--     'har.mony.lol'
-- );
-- 
-- 3. Test the helper function:
-- SELECT add_activitypub_to_new_local_user(
--     'bce63d98-6b14-4c7e-b8d5-8776d2c0ee04'::UUID,
--     'poring'
-- );
