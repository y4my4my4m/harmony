-- Fix automatic actor profile creation for incoming ActivityPub activities

-- Function to fetch and create missing actor profiles
CREATE OR REPLACE FUNCTION fetch_and_create_actor_profile(
  p_actor_url TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_profile_id UUID;
  v_actor_json JSONB;
  v_username TEXT;
  v_domain TEXT;
BEGIN
  -- First check if profile already exists
  SELECT id INTO v_profile_id 
  FROM profiles 
  WHERE federated_id = p_actor_url;
  
  IF v_profile_id IS NOT NULL THEN
    RETURN v_profile_id;
  END IF;
  
  -- Profile doesn't exist, we need to create it
  -- For now, create a minimal profile with just the URL info
  -- In production, you'd want to HTTP fetch the actor document
  
  -- Parse domain and username from URL
  -- Examples: https://misskey.io/users/aa9hh3eoz0kz0apv
  -- Examples: https://mastodon.social/@username
  
  BEGIN
    v_domain := substring(p_actor_url from 'https://([^/]+)');
    
    -- Try to extract username from common patterns
    IF p_actor_url ~ '/users/[^/]+$' THEN
      v_username := substring(p_actor_url from '/users/([^/]+)$');
    ELSIF p_actor_url ~ '/@[^/]+$' THEN
      v_username := substring(p_actor_url from '/@([^/]+)$');
    ELSE
      -- Fallback: use last part of path
      v_username := substring(p_actor_url from '/([^/]+)$');
    END IF;
    
    -- Ensure we have valid values
    IF v_domain IS NULL OR v_username IS NULL THEN
      RAISE WARNING 'Could not parse domain/username from actor URL: %', p_actor_url;
      v_domain := 'unknown';
      v_username := 'unknown_' || substring(md5(p_actor_url) from 1 for 8);
    END IF;
    
    RAISE NOTICE 'Creating minimal profile for actor: %@%', v_username, v_domain;
    
    -- Create the federated profile with minimal info
    SELECT create_federated_profile(
      p_username := v_username,
      p_display_name := v_username, -- Use username as display name initially
      p_domain := v_domain,
      p_avatar_url := NULL,
      p_banner_url := NULL,
      p_bio := NULL,
      p_federated_id := p_actor_url,
      p_inbox_url := NULL,
      p_outbox_url := NULL,
      p_followers_url := NULL,
      p_following_url := NULL,
      p_public_key := NULL
    ) INTO v_profile_id;
    
    RAISE NOTICE 'Created federated profile % for actor %', v_profile_id, p_actor_url;
    
    RETURN v_profile_id;
    
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'Failed to create federated profile for %: %', p_actor_url, SQLERRM;
      RETURN NULL;
  END;
END;
$$;

-- Update the activity processing to auto-create missing actors
CREATE OR REPLACE FUNCTION process_ap_activity_on_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_classification RECORD;
  v_instance_domain TEXT;
  v_actor_profile_id UUID;
BEGIN
  -- Only process when status changes to 'processing'
  IF OLD.status != 'processing' AND NEW.status = 'processing' THEN
    
    -- Get instance domain from correct table with proper JSONB casting
    v_instance_domain := COALESCE(
      trim(both '"' from (SELECT config_value::text FROM instance_config WHERE config_key = 'domain')),
      'har.mony.lol'
    );
    
    -- Get or create the actor profile
    v_actor_profile_id := fetch_and_create_actor_profile(NEW.actor_ap_id);
    
    IF v_actor_profile_id IS NULL THEN
      -- Failed to create actor profile, mark activity as failed
      UPDATE ap_activities 
      SET status = 'failed', 
          error_message = 'Failed to create actor profile for: ' || NEW.actor_ap_id,
          updated_at = NOW()
      WHERE id = NEW.id;
      RETURN NEW;
    END IF;
    
    -- Update the activity with the actor_id
    UPDATE ap_activities 
    SET actor_id = v_actor_profile_id
    WHERE id = NEW.id;
    
    -- Handle Create activities with classification
    IF NEW.ap_type = 'Create' THEN
      
      -- Classify the activity
      SELECT * INTO v_classification
      FROM classify_activitypub_activity(NEW.activity_data, v_instance_domain);
      
      IF v_classification.is_direct_message THEN
        -- Route to private message system
        RAISE NOTICE '📨 Processing Create activity as private message (confidence: %)', v_classification.confidence;
        
        PERFORM process_incoming_private_message(
          NEW.id,
          NEW.activity_data,
          v_actor_profile_id,
          v_instance_domain
        );
        
        -- Mark as completed
        UPDATE ap_activities 
        SET status = 'completed', processed_at = NOW()
        WHERE id = NEW.id;
        
      ELSE
        -- Route to existing public post system
        RAISE NOTICE '📢 Processing Create activity as public post (confidence: %)', v_classification.confidence;
        
        -- Mark as completed (let existing system handle it)
        UPDATE ap_activities 
        SET status = 'completed', processed_at = NOW()
        WHERE id = NEW.id;
      END IF;
      
    END IF;
    
  END IF;
  
  RETURN NEW;
END;
$$;