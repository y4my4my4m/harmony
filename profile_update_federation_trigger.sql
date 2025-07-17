-- Create trigger to federate profile updates for local users
-- This creates an Update activity when public-facing profile fields change

CREATE OR REPLACE FUNCTION handle_profile_update_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    profile_changed BOOLEAN := FALSE;
    activity_id UUID;
    profile_actor_url TEXT;
    instance_domain TEXT;
    update_activity JSONB;
    profile_object JSONB;
BEGIN
    -- Only handle updates for local users
    IF TG_OP != 'UPDATE' OR NOT NEW.is_local THEN
        RETURN NEW;
    END IF;

    -- Check if any federation-relevant fields changed
    IF (OLD.username IS DISTINCT FROM NEW.username OR
        OLD.display_name IS DISTINCT FROM NEW.display_name OR
        OLD.bio IS DISTINCT FROM NEW.bio OR
        OLD.color IS DISTINCT FROM NEW.color OR
        OLD.avatar_url IS DISTINCT FROM NEW.avatar_url OR
        OLD.banner_url IS DISTINCT FROM NEW.banner_url OR
        OLD.public_key IS DISTINCT FROM NEW.public_key OR
        OLD.is_suspended IS DISTINCT FROM NEW.is_suspended OR
        OLD.suspended_at IS DISTINCT FROM NEW.suspended_at OR
        OLD.suspension_reason IS DISTINCT FROM NEW.suspension_reason) THEN
        
        profile_changed := TRUE;
    END IF;

    -- If no relevant changes, skip federation
    IF NOT profile_changed THEN
        RETURN NEW;
    END IF;

    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    IF instance_domain IS NULL THEN
        instance_domain := 'har.mony.lol';  -- Fallback
    END IF;

    -- Build actor URL
    profile_actor_url := 'https://' || instance_domain || '/users/' || NEW.username;

    -- Build the profile object (Person type)
    profile_object := jsonb_build_object(
        '@context', jsonb_build_array(
            'https://www.w3.org/ns/activitystreams',
            'https://w3id.org/security/v1'
        ),
        'id', profile_actor_url,
        'type', 'Person',
        'preferredUsername', NEW.username,
        'name', COALESCE(NEW.display_name, NEW.username),
        'summary', COALESCE(NEW.bio, ''),
        'inbox', 'https://' || instance_domain || '/users/' || NEW.username || '/inbox',
        'outbox', 'https://' || instance_domain || '/users/' || NEW.username || '/outbox',
        'followers', 'https://' || instance_domain || '/users/' || NEW.username || '/followers',
        'following', 'https://' || instance_domain || '/users/' || NEW.username || '/following',
        'featured', 'https://' || instance_domain || '/users/' || NEW.username || '/featured',
        'publicKey', jsonb_build_object(
            'id', profile_actor_url || '#main-key',
            'owner', profile_actor_url,
            'publicKeyPem', NEW.public_key
        )
    );

    -- Add avatar if present
    IF NEW.avatar_url IS NOT NULL THEN
        profile_object := profile_object || jsonb_build_object(
            'icon', jsonb_build_object(
                'type', 'Image',
                'url', NEW.avatar_url
            )
        );
    END IF;

    -- Add banner if present  
    IF NEW.banner_url IS NOT NULL THEN
        profile_object := profile_object || jsonb_build_object(
            'image', jsonb_build_object(
                'type', 'Image', 
                'url', NEW.banner_url
            )
        );
    END IF;

    -- Add suspension info if suspended
    IF NEW.is_suspended THEN
        profile_object := profile_object || jsonb_build_object(
            'suspended', true,
            'suspendedAt', NEW.suspended_at,
            'suspensionReason', NEW.suspension_reason
        );
    END IF;

    -- Build the Update activity
    update_activity := jsonb_build_object(
        '@context', 'https://www.w3.org/ns/activitystreams',
        'id', profile_actor_url || '/activities/update/' || gen_random_uuid(),
        'type', 'Update',
        'actor', profile_actor_url,
        'published', NOW(),
        'object', profile_object,
        'to', jsonb_build_array('https://www.w3.org/ns/activitystreams#Public'),
        'cc', jsonb_build_array('https://' || instance_domain || '/users/' || NEW.username || '/followers')
    );

    -- Create the activity record
    INSERT INTO ap_activities (
        ap_id,
        ap_type,
        actor_ap_id,
        activity_data,
        origin_domain,
        to_addresses,
        cc_addresses,
        is_local,
        status
    ) VALUES (
        update_activity->>'id',
        'Update',
        profile_actor_url,
        update_activity,
        instance_domain,
        ARRAY['https://www.w3.org/ns/activitystreams#Public'],
        ARRAY['https://' || instance_domain || '/users/' || NEW.username || '/followers'],
        true,
        'pending'
    ) RETURNING id INTO activity_id;

    -- Queue the activity for federation delivery directly
    -- Get follower domains to send to
    PERFORM queue_activity_for_federation(
        activity_id,
        ARRAY(
            SELECT DISTINCT domain 
            FROM follows f
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.id
            AND f.status = 'accepted'
            AND NOT p.is_local
            AND p.domain IS NOT NULL
        ),
        3, -- Priority 3 (profile updates are important but not urgent)
        true -- Immediate processing
    );

    RAISE NOTICE '📝 Profile update activity created and queued for %: %', NEW.username, activity_id;

    RETURN NEW;
END;
$$;

-- Create the trigger
DROP TRIGGER IF EXISTS profile_update_federation_trigger ON profiles;

CREATE TRIGGER profile_update_federation_trigger
    AFTER UPDATE ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION handle_profile_update_federation();

COMMENT ON FUNCTION handle_profile_update_federation() IS 
'Federates profile updates for local users. Creates Update activities when public profile fields change. Federation delivery is handled by existing queue system.';

COMMENT ON TRIGGER profile_update_federation_trigger ON profiles IS 
'Triggers federation of profile updates for local users when public-facing fields change.';
