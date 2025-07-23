-- Migration 082: Implement Federated Private Messaging Architecture
-- Professional, enterprise-grade implementation with full ActivityPub compatibility
-- Compatible with Mastodon, Misskey, Pleroma standards

BEGIN;

-- =================================================================
-- 1. Enhanced Message Federation Type Determination
-- =================================================================

CREATE OR REPLACE FUNCTION determine_message_federation_type(
  p_message_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_message_type TEXT;
  v_channel_id UUID;
  v_conversation_id UUID;
  v_remote_participant_count INTEGER := 0;
BEGIN
  -- Get message context
  SELECT channel_id, conversation_id 
  INTO v_channel_id, v_conversation_id
  FROM messages 
  WHERE id = p_message_id;
  
  -- Classification logic
  IF v_channel_id IS NOT NULL THEN
    -- Server chat message → Never federate
    v_message_type := 'chat_local_only';
    
  ELSIF v_conversation_id IS NOT NULL THEN
    -- DM message → Check for remote participants
    SELECT COUNT(DISTINCT cp.user_id)
    INTO v_remote_participant_count
    FROM conversation_participants cp
    JOIN profiles p ON cp.user_id = p.id
    WHERE cp.conversation_id = v_conversation_id
      AND NOT p.is_local
      AND cp.left_at IS NULL;
    
    IF v_remote_participant_count > 0 THEN
      v_message_type := 'dm_federated';
    ELSE
      v_message_type := 'dm_local_only';
    END IF;
    
  ELSE
    -- Orphaned message
    v_message_type := 'unknown';
  END IF;
  
  RETURN v_message_type;
END;
$$;

COMMENT ON FUNCTION determine_message_federation_type(UUID) IS 
'Determines federation type for a message based on context (chat/DM) and participants';

-- =================================================================
-- 2. Get or Create DM Conversation Helper
-- =================================================================

CREATE OR REPLACE FUNCTION get_or_create_dm_conversation(
  p_user1_id UUID,
  p_user2_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_conversation_id UUID;
BEGIN
  -- Try to find existing conversation between these users
  SELECT c.id INTO v_conversation_id
  FROM conversations c
  WHERE c.type = 'direct'
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp1
      WHERE cp1.conversation_id = c.id 
        AND cp1.user_id = p_user1_id 
        AND cp1.left_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp2
      WHERE cp2.conversation_id = c.id 
        AND cp2.user_id = p_user2_id 
        AND cp2.left_at IS NULL
    )
    -- Ensure it's exactly 2 participants (direct conversation)
    AND (
      SELECT COUNT(*) FROM conversation_participants cp3
      WHERE cp3.conversation_id = c.id 
        AND cp3.left_at IS NULL
    ) = 2;
  
  -- If not found, create new conversation
  IF v_conversation_id IS NULL THEN
    INSERT INTO conversations (type, created_by, is_active)
    VALUES ('direct', p_user1_id, TRUE)
    RETURNING id INTO v_conversation_id;
    
    -- Add both participants
    INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
    VALUES 
      (v_conversation_id, p_user1_id, 'member', NOW()),
      (v_conversation_id, p_user2_id, 'member', NOW());
      
    RAISE NOTICE 'Created new DM conversation % between users % and %', 
      v_conversation_id, p_user1_id, p_user2_id;
  END IF;
  
  RETURN v_conversation_id;
END;
$$;

COMMENT ON FUNCTION get_or_create_dm_conversation(UUID, UUID) IS 
'Gets existing or creates new DM conversation between two users using conversation_participants system';

-- =================================================================
-- 3. Professional Incoming Private Message Processor
-- =================================================================

CREATE OR REPLACE FUNCTION process_incoming_private_message(
  p_activity_id UUID,
  p_activity_data JSONB,
  p_actor_profile_id UUID,
  p_instance_domain TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_object JSONB;
  v_content JSONB;
  v_local_recipients TEXT[];
  v_recipient_username TEXT;
  v_local_user profiles%ROWTYPE;
  v_actor_profile profiles%ROWTYPE;
  v_conversation_id UUID;
  v_message_id UUID;
  v_recipient_count INTEGER := 0;
BEGIN
  -- Get actor profile
  SELECT * INTO v_actor_profile FROM profiles WHERE id = p_actor_profile_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Actor profile not found: %', p_actor_profile_id;
  END IF;
  
  RAISE NOTICE '📨 Processing ActivityPub private message from %@%', 
    v_actor_profile.username, v_actor_profile.domain;
  
  -- Extract message object
  v_object := p_activity_data->'object';
  
  -- Extract local recipients from addressing (compatible with all ActivityPub platforms)
  WITH recipient_extraction AS (
    SELECT jsonb_array_elements_text(
      COALESCE(v_object->'to', '[]'::jsonb) || 
      COALESCE(v_object->'cc', '[]'::jsonb)
    ) AS recipient_url
  ),
  -- Also extract from mention tags (Mastodon/Pleroma compatibility)
  mention_extraction AS (
    SELECT jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) AS tag
  ),
  mention_recipients AS (
    SELECT tag->>'href' AS recipient_url
    FROM mention_extraction
    WHERE tag->>'type' = 'Mention'
      AND tag->>'href' IS NOT NULL
  ),
  all_recipients AS (
    SELECT recipient_url FROM recipient_extraction
    UNION
    SELECT recipient_url FROM mention_recipients
  ),
  local_recipients AS (
    SELECT DISTINCT
      CASE 
        WHEN recipient_url LIKE 'https://' || p_instance_domain || '/users/%' THEN
          substring(recipient_url from 'https://' || p_instance_domain || '/users/([^/]+)')
        WHEN recipient_url LIKE 'https://' || p_instance_domain || '/social/profile/%' THEN  
          substring(recipient_url from 'https://' || p_instance_domain || '/social/profile/([^/]+)')
        WHEN recipient_url LIKE 'https://' || p_instance_domain || '/@%' THEN
          substring(recipient_url from 'https://' || p_instance_domain || '/@([^/]+)')
        ELSE NULL
      END AS username
    FROM all_recipients
  )
  SELECT array_agg(username)
  INTO v_local_recipients
  FROM local_recipients 
  WHERE username IS NOT NULL;
  
  -- Validate recipients exist
  IF v_local_recipients IS NULL OR array_length(v_local_recipients, 1) = 0 THEN
    RAISE WARNING 'Private message from %@% has no valid local recipients - skipping',
      v_actor_profile.username, v_actor_profile.domain;
    RETURN;
  END IF;
  
  RAISE NOTICE '📧 Private message mentions % local users: %', 
    array_length(v_local_recipients, 1), v_local_recipients;
  
  -- Convert ActivityPub content to unified format
  v_content := convert_ap_to_jsonb(
    v_object->>'content',
    v_object->'tag'
  );
  
  -- Process each local recipient
  FOREACH v_recipient_username IN ARRAY v_local_recipients LOOP
    -- Get local user profile
    SELECT * INTO v_local_user
    FROM profiles 
    WHERE username = v_recipient_username 
      AND domain = p_instance_domain 
      AND is_local = true;
      
    IF NOT FOUND THEN
      RAISE WARNING 'Local recipient not found: %@%', v_recipient_username, p_instance_domain;
      CONTINUE;
    END IF;
    
    -- Get or create conversation between remote sender and local recipient
    v_conversation_id := get_or_create_dm_conversation(
      v_actor_profile.id,
      v_local_user.id
    );
    
    -- Insert the federated private message
    INSERT INTO messages (
      conversation_id,
      user_id,
      content,
      created_at,
      metadata
    ) VALUES (
      v_conversation_id,
      v_actor_profile.id,
      v_content,
      COALESCE((v_object->>'published')::timestamptz, NOW()),
      jsonb_build_object(
        'federated', true,
        'ap_id', v_object->>'id',
        'ap_type', 'Note',
        'from_domain', v_actor_profile.domain,
        'activity_id', p_activity_id,
        'original_url', COALESCE(v_object->>'url', v_object->>'id'),
        'private_mention', true,
        'activitypub_compatible', true
      )
    ) RETURNING id INTO v_message_id;
    
    v_recipient_count := v_recipient_count + 1;
    
    RAISE NOTICE '✅ Saved federated private message %: %@% → %',
      v_message_id, v_actor_profile.username, v_actor_profile.domain, v_recipient_username;
  END LOOP;
  
  RAISE NOTICE '🎯 Completed private message processing for activity % (% recipients)',
    p_activity_id, v_recipient_count;
END;
$$;

COMMENT ON FUNCTION process_incoming_private_message(UUID, JSONB, UUID, TEXT) IS 
'Processes incoming ActivityPub private messages with full Mastodon/Misskey/Pleroma compatibility';

-- =================================================================
-- 4. Enhanced Message Federation Trigger
-- =================================================================

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

COMMENT ON FUNCTION handle_message_federation() IS 
'Professional message federation trigger with full ActivityPub compatibility and proper incoming/outgoing handling';

-- =================================================================
-- 5. Update Message Triggers
-- =================================================================

-- Drop any existing message triggers
DROP TRIGGER IF EXISTS trg_handle_messages ON messages;
DROP TRIGGER IF EXISTS trg_handle_message_federation ON messages;
DROP TRIGGER IF EXISTS trigger_unified_message_federation ON messages;

-- Create the modern message federation trigger
CREATE TRIGGER trg_handle_message_federation
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION handle_message_federation();

COMMENT ON TRIGGER trg_handle_message_federation ON messages IS 
'Modern unified message federation trigger - handles chat (local-only) and DM (federation-capable) with proper incoming/outgoing logic';

-- =================================================================
-- 6. Enhanced ActivityPub Activity Processing
-- =================================================================

-- Add ActivityPub classification to the existing activity processing
-- This integrates seamlessly with the existing upsert_ap_activity flow

CREATE OR REPLACE FUNCTION classify_activitypub_activity(
  p_activity_data JSONB,
  p_instance_domain TEXT
) RETURNS TABLE (
  is_direct_message BOOLEAN,
  confidence NUMERIC
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_object JSONB;
  v_to JSONB;
  v_cc JSONB;
  v_all_recipients TEXT[];
BEGIN
  v_object := CASE 
    WHEN jsonb_typeof(p_activity_data->'object') = 'string' THEN 
      jsonb_build_object('to', '[]'::jsonb, 'cc', '[]'::jsonb)
    ELSE 
      p_activity_data->'object'
  END;
  
  v_to := COALESCE(v_object->'to', '[]'::jsonb);
  v_cc := COALESCE(v_object->'cc', '[]'::jsonb);
  
  -- Extract all recipients
  SELECT array_agg(value::text)
  INTO v_all_recipients
  FROM jsonb_array_elements_text(v_to || v_cc);
  
  -- Rule 1: Contains 'Public' in 'to' → Public Post
  IF v_to ? 'https://www.w3.org/ns/activitystreams#Public' THEN
    RETURN QUERY SELECT false::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 2: Contains 'Public' in 'cc' → Unlisted Post (still public)
  IF v_cc ? 'https://www.w3.org/ns/activitystreams#Public' THEN
    RETURN QUERY SELECT false::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 3: Contains followers collection URL → Followers-only Post
  IF EXISTS (
    SELECT 1 FROM unnest(v_all_recipients) AS addr
    WHERE addr LIKE '%/followers'
  ) THEN
    RETURN QUERY SELECT false::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 4: Check for local recipients (direct message)
  IF EXISTS (
    SELECT 1 FROM unnest(v_all_recipients) AS addr
    WHERE addr LIKE '%' || p_instance_domain || '%'
  ) THEN
    RETURN QUERY SELECT true::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 5: No local recipients → Not our concern (treat as public)
  RETURN QUERY SELECT false::boolean, 0.1::numeric;
END;
$$;

COMMENT ON FUNCTION classify_activitypub_activity(JSONB, TEXT) IS 
'Classifies ActivityPub activities according to specification - compatible with Mastodon, Misskey, Pleroma';

-- =================================================================
-- Enhanced Activity Processing Trigger
-- =================================================================

-- Create or replace the activity processing function to handle Create activities
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
    
    -- Get instance domain
    v_instance_domain := COALESCE(
      (SELECT setting_value FROM instance_settings WHERE setting_key = 'domain'),
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

-- Create the trigger if it doesn't exist
DROP TRIGGER IF EXISTS trg_process_ap_activity_on_update ON ap_activities;

CREATE TRIGGER trg_process_ap_activity_on_update
  AFTER UPDATE ON ap_activities
  FOR EACH ROW
  EXECUTE FUNCTION process_ap_activity_on_update();

COMMENT ON TRIGGER trg_process_ap_activity_on_update ON ap_activities IS 
'Automatically processes ActivityPub activities and routes Create activities based on ActivityPub classification';

-- =================================================================
-- 7. Verification and Logging
-- =================================================================

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 082 completed successfully';
  RAISE NOTICE '🎯 Federated private messaging architecture implemented';
  RAISE NOTICE '📱 Full ActivityPub compatibility with Mastodon/Misskey/Pleroma';
  RAISE NOTICE '🔧 Professional trigger system with proper incoming/outgoing handling';
  
  -- Verify critical functions exist
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'determine_message_federation_type') THEN
    RAISE EXCEPTION 'Critical function determine_message_federation_type not created';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'process_incoming_private_message') THEN
    RAISE EXCEPTION 'Critical function process_incoming_private_message not created';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_message_federation') THEN
    RAISE EXCEPTION 'Critical function handle_message_federation not created';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_or_create_dm_conversation') THEN
    RAISE EXCEPTION 'Critical function get_or_create_dm_conversation not created';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'classify_activitypub_activity') THEN
    RAISE EXCEPTION 'Critical function classify_activitypub_activity not created';
  END IF;
  
  -- Verify triggers exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'messages' 
    AND t.tgname = 'trg_handle_message_federation'
    AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'Critical trigger trg_handle_message_federation not created';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'ap_activities' 
    AND t.tgname = 'trg_process_ap_activity_on_update'
    AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'Critical trigger trg_process_ap_activity_on_update not created';
  END IF;
  
  RAISE NOTICE '✅ All critical components verified successfully';
END $$;

COMMIT;