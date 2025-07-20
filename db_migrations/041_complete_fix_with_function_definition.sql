-- Migration 041: Complete fix with function definition
-- Create the function first, then apply all fixes

BEGIN;

-- ============================================================================
-- STEP 1: Create the handle_unified_content_federation function if it doesn't exist
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_unified_content_federation() 
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;
    remote_participants uuid[];
    target_user_id uuid;
    activity_id uuid;
    target_domains text[];
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;

    -- FIXED: Determine user_id based on which table triggered this function
    IF TG_TABLE_NAME = 'posts' THEN
        target_user_id := COALESCE(NEW.author_id, OLD.author_id);
    ELSIF TG_TABLE_NAME = 'messages' THEN  
        target_user_id := COALESCE(NEW.user_id, OLD.user_id);
        
        -- ✅ ADD DEBUG LOGGING FOR MESSAGES
        RAISE WARNING '🔧 Message federation trigger fired: message_id=%, user_id=%, conversation_id=%', 
            NEW.id, NEW.user_id, NEW.conversation_id;
    ELSE
        -- Unknown table, skip federation
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check federation for the identified user
    SELECT is_federation_enabled_for_user(target_user_id) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RAISE WARNING '🔧 User % has federation disabled, skipping', target_user_id;
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_TABLE_NAME = 'posts' THEN
        -- Handle post federation (existing logic)
        IF TG_OP = 'INSERT' THEN
            -- Create ActivityPub activity for the post
            INSERT INTO ap_activities (
                ap_id, 
                ap_type,
                actor_id,
                actor_ap_id,
                object_id,
                object_type,
                activity_data,
                status,
                is_local
            ) VALUES (
                full_instance_url || '/activities/' || gen_random_uuid(),
                'Create',
                NEW.author_id,
                (SELECT federated_id FROM profiles WHERE id = NEW.author_id),
                NEW.id::text,
                'Note',
                create_activitypub_note_activity(NEW.id),
                'pending',
                true
            ) RETURNING id INTO activity_id;

            -- Get follower domains and queue for federation
            SELECT array_agg(DISTINCT p.domain) INTO target_domains
            FROM follows f
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id
              AND f.status = 'accepted'
              AND NOT p.is_local
              AND p.domain IS NOT NULL;

            IF target_domains IS NOT NULL AND array_length(target_domains, 1) > 0 THEN
                PERFORM queue_activity_for_federation(activity_id, target_domains, 5, true);
                RAISE WARNING '🔧 Queued post % for federation to % domains', NEW.id, array_length(target_domains, 1);
            END IF;
        END IF;

    ELSIF TG_TABLE_NAME = 'messages' THEN
        -- Handle DM federation (only if there are remote participants)
        IF TG_OP = 'INSERT' THEN
            RAISE WARNING '🔧 Processing message federation for message %', NEW.id;

            -- Get remote participants from conversation
            SELECT array_agg(cp.user_id) 
            INTO remote_participants
            FROM conversation_participants cp
            JOIN profiles p ON cp.user_id = p.id
            WHERE cp.conversation_id = NEW.conversation_id
              AND NOT p.is_local;

            RAISE WARNING '🔧 Found % remote participants: %', 
                COALESCE(array_length(remote_participants, 1), 0), remote_participants;

            -- Only federate if there are remote participants
            IF remote_participants IS NOT NULL AND array_length(remote_participants, 1) > 0 THEN
                
                RAISE WARNING '🔧 Creating ap_activity for DM federation';
                
                INSERT INTO ap_activities (
                    ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                    activity_data, status, is_local, to_addresses
                ) VALUES (
                    full_instance_url || '/activities/' || gen_random_uuid(),
                    'Create',
                    NEW.user_id,
                    (SELECT federated_id FROM profiles WHERE id = NEW.user_id),
                    NEW.id::text,
                    'Note',
                    jsonb_build_object(
                        'type', 'Create',
                        'actor', (SELECT federated_id FROM profiles WHERE id = NEW.user_id),
                        'object', jsonb_build_object(
                            'type', 'Note',
                            'id', full_instance_url || '/messages/' || NEW.id,
                            'attributedTo', (SELECT federated_id FROM profiles WHERE id = NEW.user_id),
                            'content', convert_jsonb_to_ap(NEW.content),
                            'to', array_to_json(ARRAY(
                                SELECT p.federated_id 
                                FROM profiles p 
                                WHERE p.id = ANY(remote_participants)
                            ))::jsonb
                        )
                    ),
                    'pending',
                    true
                ) RETURNING id INTO activity_id;

                RAISE WARNING '🔧 Created ap_activity with ID: %', activity_id;

                -- Get domains of remote participants
                SELECT array_agg(DISTINCT p.domain) INTO target_domains
                FROM profiles p
                WHERE p.id = ANY(remote_participants)
                AND p.domain IS NOT NULL;

                RAISE WARNING '🔧 Target domains for federation: %', target_domains;

                -- Queue for delivery to remote participants
                IF target_domains IS NOT NULL AND array_length(target_domains, 1) > 0 THEN
                    PERFORM queue_activity_for_federation(activity_id, target_domains, 8, true);
                    RAISE WARNING '🔧 Queued DM for federation delivery to % domains', array_length(target_domains, 1);
                ELSE
                    RAISE WARNING '🔧 No target domains found for federation';
                END IF;
            ELSE
                RAISE WARNING '🔧 No remote participants, skipping DM federation';
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
EXCEPTION 
    WHEN OTHERS THEN
        -- Log error but don't block the operation (graceful degradation)
        RAISE WARNING '❌ Federation trigger failed for % %: %', TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), SQLERRM;
        RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ============================================================================
-- STEP 2: Create the notification processing function if it doesn't exist
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    msg_user_id uuid;
    msg_channel_id uuid;
    msg_conversation_id uuid;
    sender_profile profiles%ROWTYPE;
    channel_info channels%ROWTYPE;
    conversation_info conversations%ROWTYPE;
    participant_record RECORD;
    mentioned_usernames TEXT[];
    mentioned_user_id UUID;
    username_item TEXT;
    notification_data JSONB;
    content_preview TEXT;
BEGIN
    -- Early exit for non-notification operations
    IF TG_OP = 'UPDATE' THEN
        RETURN NEW;
    END IF;

    -- Handle different table operations
    IF TG_TABLE_NAME = 'messages' THEN
        msg_user_id := NEW.user_id;
        msg_channel_id := NEW.channel_id;
        msg_conversation_id := NEW.conversation_id;
        
        RAISE WARNING '🔔 Processing notifications for message: msg_id=%, user_id=%, channel_id=%, conversation_id=%', 
            NEW.id, msg_user_id, msg_channel_id, msg_conversation_id;
        
    ELSE
        -- Only handle messages for now
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Get sender profile
    SELECT * INTO sender_profile FROM profiles WHERE id = msg_user_id;
    
    -- Extract content preview for notifications
    IF jsonb_typeof(NEW.content) = 'array' THEN
        SELECT LEFT(string_agg(
            CASE 
                WHEN item->>'type' = 'mention' THEN item->>'mention'
                ELSE COALESCE(item->>'text', item::text)
            END, ''
        ), 100) INTO content_preview
        FROM jsonb_array_elements(NEW.content) AS item;
    ELSE
        content_preview := LEFT(NEW.content::text, 100);
    END IF;

    -- Handle DM notifications (using participant system)
    IF msg_conversation_id IS NOT NULL THEN
        SELECT * INTO conversation_info FROM conversations WHERE id = msg_conversation_id;
        
        -- Build structured data for DM notification
        notification_data := jsonb_build_object(
            'sender', jsonb_build_object(
                'user_id', sender_profile.id,
                'username', sender_profile.username,
                'avatar_url', sender_profile.avatar_url
            ),
            'conversation', jsonb_build_object(
                'id', msg_conversation_id
            ),
            'message', jsonb_build_object(
                'id', NEW.id,
                'content_preview', content_preview,
                'created_at', NEW.created_at
            )
        );
        
        RAISE WARNING '🔔 Creating DM notifications for conversation %', msg_conversation_id;
        
        -- Notify all conversation participants except sender (using participant system)
        FOR participant_record IN 
            SELECT cp.user_id, p.is_local
            FROM conversation_participants cp
            JOIN profiles p ON p.id = cp.user_id
            WHERE cp.conversation_id = msg_conversation_id 
              AND cp.user_id != msg_user_id
              AND cp.left_at IS NULL
        LOOP
            -- Only notify LOCAL users
            IF participant_record.is_local THEN
                RAISE WARNING '🔔 Creating DM notification for user %', participant_record.user_id;
                
                -- ✅ FIX: Use the fixed create_notification_structured function
                PERFORM create_notification_structured(
                    participant_record.user_id, 
                    'dm', 
                    notification_data,
                    NULL, -- p_channel_id 
                    msg_conversation_id -- p_conversation_id
                );
            END IF;
        END LOOP;
    
    -- Handle server channel notifications
    ELSIF msg_channel_id IS NOT NULL THEN
        SELECT * INTO channel_info FROM channels WHERE id = msg_channel_id;
        
        -- Build notification data for channel messages
        notification_data := jsonb_build_object(
            'sender', jsonb_build_object(
                'user_id', sender_profile.id,
                'username', sender_profile.username,
                'avatar_url', sender_profile.avatar_url
            ),
            'location', jsonb_build_object(
                'channel_id', msg_channel_id,
                'channel_name', channel_info.name
            ),
            'message', jsonb_build_object(
                'id', NEW.id,
                'content_preview', content_preview,
                'created_at', NEW.created_at
            )
        );
        
        -- Handle mention notifications (LOCAL users only)
        mentioned_usernames := extract_mentions(NEW.content);
        FOREACH username_item IN ARRAY mentioned_usernames
        LOOP
            mentioned_user_id := get_user_id_from_username(username_item);
            IF mentioned_user_id IS NOT NULL AND mentioned_user_id != msg_user_id THEN
                -- Check if user is local
                IF EXISTS(SELECT 1 FROM profiles WHERE id = mentioned_user_id AND is_local = true) THEN
                    RAISE WARNING '🔔 Creating mention notification for user %', mentioned_user_id;
                    
                    PERFORM create_notification_structured(
                        mentioned_user_id, 
                        'mention', 
                        notification_data,
                        msg_channel_id, -- p_channel_id
                        NULL -- p_conversation_id
                    );
                END IF;
            END IF;
        END LOOP;
    END IF;
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        -- Log error but don't block the operation
        RAISE WARNING '❌ Notification processing failed for % %: %', TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), SQLERRM;
        RETURN NEW;
END;
$function$;

-- ============================================================================
-- STEP 3: Ensure triggers are created properly
-- ============================================================================

-- Drop and recreate the federation trigger
DROP TRIGGER IF EXISTS trigger_unified_message_federation ON messages;
CREATE TRIGGER trigger_unified_message_federation 
    AFTER INSERT OR UPDATE ON public.messages 
    FOR EACH ROW 
    EXECUTE FUNCTION public.handle_unified_content_federation();

-- Drop and recreate the notification trigger
DROP TRIGGER IF EXISTS trigger_unified_notification_messages ON messages;
CREATE TRIGGER trigger_unified_notification_messages 
    AFTER INSERT ON public.messages 
    FOR EACH ROW 
    EXECUTE FUNCTION public.handle_unified_notification_processing();

-- ============================================================================
-- STEP 4: Fix the notification function to not reference server_id
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_notification_structured(
    p_user_id uuid,
    p_type character varying,
    p_data jsonb DEFAULT '{}'::jsonb,
    p_channel_id uuid DEFAULT NULL::uuid,
    p_conversation_id uuid DEFAULT NULL::uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_notification_id UUID;
    v_existing_count INTEGER;
    v_time_threshold TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Set appropriate time threshold based on notification type
    v_time_threshold := CASE p_type
        WHEN 'mention' THEN NOW() - INTERVAL '5 minutes'
        WHEN 'reply' THEN NOW() - INTERVAL '5 minutes'
        WHEN 'dm' THEN NOW() - INTERVAL '2 minutes'
        WHEN 'follow' THEN NOW() - INTERVAL '10 minutes'
        ELSE NOW() - INTERVAL '1 minute'
    END;

    -- Check for spam/duplicate notifications
    SELECT COUNT(*) INTO v_existing_count
    FROM notifications n
    WHERE n.user_id = p_user_id
      AND n.type = p_type
      AND n.created_at > v_time_threshold
      AND (
          -- For mentions/replies, check if same source mentioned/replied to same target
          (p_type IN ('mention', 'reply') AND 
           n.data->>'sender'->>'user_id' = p_data->'sender'->>'user_id') OR
          -- For DMs, check if same conversation
          (p_type = 'dm' AND 
           n.data->'conversation'->>'id' = p_data->'conversation'->>'id') OR
          -- For follows, check if same follower
          (p_type = 'follow' AND 
           n.data->'follower'->>'user_id' = p_data->'follower'->>'user_id')
      );

    -- Don't create notification if too many recent similar notifications
    IF v_existing_count >= 3 THEN
        RAISE WARNING 'Suppressing duplicate notification: type=%, user=%, recent_count=%', 
            p_type, p_user_id, v_existing_count;
        RETURN NULL;
    END IF;

    -- ✅ FIX: Insert notification without server_id column
    INSERT INTO notifications (
        user_id,
        type,
        data
    ) VALUES (
        p_user_id,
        p_type,
        p_data
    ) RETURNING id INTO v_notification_id;

    RAISE WARNING '✅ Created notification: id=%, type=%, user=%', 
        v_notification_id, p_type, p_user_id;

    RETURN v_notification_id;
END;
$function$;

COMMIT;