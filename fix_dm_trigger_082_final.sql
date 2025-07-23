-- Final Fix: Replace both functions with correct table references and notification calls

CREATE OR REPLACE FUNCTION handle_message_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_federation_type TEXT;
  v_is_federated_incoming BOOLEAN;
  v_sender_profile profiles%ROWTYPE;
BEGIN
  -- Determine federation type
  v_federation_type := determine_message_federation_type(NEW.id);
  
  -- Check if this is an incoming federated message
  v_is_federated_incoming := (NEW.metadata->>'federated' = 'true');
  
  -- Get sender profile
  SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;
  
  RAISE NOTICE '🔧 Message federation: type=%, incoming=%, message=%', 
    v_federation_type, v_is_federated_incoming, NEW.id;
  
  -- Process based on federation type and direction
  CASE v_federation_type
    WHEN 'chat_local_only' THEN
      -- Local chat: notifications only, no federation
      PERFORM send_notification(
        'message',
        (SELECT ARRAY_AGG(sm.user_id) 
         FROM server_members sm 
         JOIN channels c ON sm.server_id = c.server_id
         WHERE c.id = NEW.channel_id AND sm.user_id != NEW.user_id),
        jsonb_build_object(
          'message_id', NEW.id,
          'channel_id', NEW.channel_id,
          'sender', jsonb_build_object(
            'id', v_sender_profile.id,
            'username', v_sender_profile.username,
            'display_name', v_sender_profile.display_name
          )
        ),
        (SELECT c.server_id FROM channels c WHERE c.id = NEW.channel_id),
        NEW.channel_id,
        NULL,
        NEW.user_id,
        'normal'
      );
      
    WHEN 'dm_local_only' THEN
      -- Local DM: notifications only, no federation
      PERFORM send_notification(
        'dm',
        (SELECT ARRAY_AGG(cp.user_id) 
         FROM conversation_participants cp 
         WHERE cp.conversation_id = NEW.conversation_id 
           AND cp.user_id != NEW.user_id 
           AND cp.left_at IS NULL),
        jsonb_build_object(
          'message_id', NEW.id,
          'conversation_id', NEW.conversation_id,
          'sender', jsonb_build_object(
            'id', v_sender_profile.id,
            'username', v_sender_profile.username,
            'display_name', v_sender_profile.display_name
          )
        ),
        NULL,
        NULL,
        NEW.conversation_id,
        NEW.user_id,
        'normal'
      );
      
    WHEN 'dm_federated' THEN
      IF v_is_federated_incoming THEN
        -- Incoming federated DM: notifications only
        PERFORM send_notification(
          'dm',
          (SELECT ARRAY_AGG(cp.user_id) 
           FROM conversation_participants cp 
           WHERE cp.conversation_id = NEW.conversation_id 
             AND cp.user_id != NEW.user_id 
             AND cp.left_at IS NULL),
          jsonb_build_object(
            'message_id', NEW.id,
            'conversation_id', NEW.conversation_id,
            'sender', jsonb_build_object(
              'id', v_sender_profile.id,
              'username', v_sender_profile.username,
              'display_name', v_sender_profile.display_name,
              'domain', v_sender_profile.domain
            ),
            'federated', true
          ),
          NULL,
          NULL,
          NEW.conversation_id,
          NEW.user_id,
          'normal'
        );
      ELSE
        -- Outgoing federated DM: notifications + federation
        -- Notifications for local users
        PERFORM send_notification(
          'dm',
          (SELECT ARRAY_AGG(cp.user_id) 
           FROM conversation_participants cp 
           JOIN profiles p ON cp.user_id = p.id
           WHERE cp.conversation_id = NEW.conversation_id 
             AND cp.user_id != NEW.user_id 
             AND cp.left_at IS NULL
             AND p.is_local),
          jsonb_build_object(
            'message_id', NEW.id,
            'conversation_id', NEW.conversation_id,
            'sender', jsonb_build_object(
              'id', v_sender_profile.id,
              'username', v_sender_profile.username,
              'display_name', v_sender_profile.display_name
            )
          ),
          NULL,
          NULL,
          NEW.conversation_id,
          NEW.user_id,
          'normal'
        );
        
        -- Federation handled by existing handle_outgoing_messages function
        -- (This preserves your existing federation infrastructure)
      END IF;
      
    ELSE
      -- Unknown type: log and skip
      RAISE WARNING 'Unknown message federation type: % for message %', v_federation_type, NEW.id;
  END CASE;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Graceful degradation: log error but don't block message saving
    RAISE WARNING 'Message federation processing failed for %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

-- Fix the ActivityPub processing function with correct table name
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
    
    -- Get instance domain from CORRECT table with CORRECT column names
    v_instance_domain := COALESCE(
      trim(both '"' from (SELECT config_value FROM instance_config WHERE config_key = 'domain')),
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
        
        -- Let existing ActivityPub processing handle this
        -- The activity will be processed by existing triggers/functions
      END IF;
      
    END IF;
    
  END IF;
  
  RETURN NEW;
END;
$$;