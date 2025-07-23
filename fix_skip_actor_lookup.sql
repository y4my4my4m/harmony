-- Fix: Remove actor profile requirement from activity processing

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
    
    -- Try to find existing actor profile (but don't fail if not found)
    SELECT id INTO v_actor_profile_id
    FROM profiles 
    WHERE federated_id = NEW.actor_ap_id;
    
    IF v_actor_profile_id IS NOT NULL THEN
      -- Update the activity with the actor_id if we found one
      UPDATE ap_activities 
      SET actor_id = v_actor_profile_id
      WHERE id = NEW.id;
    ELSE
      -- No actor profile found, but that's OK - just log it and continue
      RAISE NOTICE 'No actor profile found for %, processing activity anyway', NEW.actor_ap_id;
    END IF;
    
    -- Handle Create activities with classification
    IF NEW.ap_type = 'Create' THEN
      
      -- Classify the activity
      SELECT * INTO v_classification
      FROM classify_activitypub_activity(NEW.activity_data, v_instance_domain);
      
      IF v_classification.is_direct_message THEN
        -- Route to private message system
        RAISE NOTICE '📨 Processing Create activity as private message (confidence: %)', v_classification.confidence;
        
        -- Only try to process if we have an actor profile
        IF v_actor_profile_id IS NOT NULL THEN
          PERFORM process_incoming_private_message(
            NEW.id,
            NEW.activity_data,
            v_actor_profile_id,
            v_instance_domain
          );
        ELSE
          RAISE NOTICE 'Skipping DM processing - no actor profile for %', NEW.actor_ap_id;
        END IF;
        
        -- Mark as completed either way
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
      
    ELSE
      -- Non-Create activities - mark as completed
      RAISE NOTICE 'Processing % activity - marking as completed', NEW.ap_type;
      UPDATE ap_activities 
      SET status = 'completed', processed_at = NOW()
      WHERE id = NEW.id;
    END IF;
    
  END IF;
  
  RETURN NEW;
END;
$$;