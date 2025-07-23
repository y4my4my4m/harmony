-- Quick Fix: Replace handle_message_federation function to use correct notification functions

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