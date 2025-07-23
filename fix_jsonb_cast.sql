-- Fix JSONB casting issue for domain lookup

CREATE OR REPLACE FUNCTION process_ap_activity_on_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_classification RECORD;
  v_instance_domain TEXT;
BEGIN
  -- Only process when status changes to 'processing'
  IF OLD.status != 'processing' AND NEW.status = 'processing' THEN
    
    -- Get instance domain from correct table with proper JSONB casting
    v_instance_domain := COALESCE(
      trim(both '"' from (SELECT config_value::text FROM instance_config WHERE config_key = 'domain')),
      'har.mony.lol'
    );
    
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
          NEW.actor_id,
          v_instance_domain
        );
        
        -- Mark as completed
        UPDATE ap_activities 
        SET status = 'completed', processed_at = NOW()
        WHERE id = NEW.id;
        
      ELSE
        -- Route to existing public post system
        RAISE NOTICE '📢 Processing Create activity as public post (confidence: %)', v_classification.confidence;
      END IF;
      
    END IF;
    
  END IF;
  
  RETURN NEW;
END;
$$;