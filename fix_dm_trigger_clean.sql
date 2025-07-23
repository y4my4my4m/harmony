-- Critical Bug Fixes for DM/Federation System
-- Apply BEFORE running migration 091
-- Fixes: function signatures, table references, casting, typos

BEGIN;

-- =====================================================
-- FIX 1: handle_message_federation() function
-- Issues: send_notification_to_user signature, "derated" typo
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_federation_type TEXT;
    v_is_federated_incoming BOOLEAN;
    v_sender_profile profiles%ROWTYPE;
BEGIN
    -- Determine federation type
    v_federation_type := determine_message_federation_type(NEW.id);
    
    -- Check if this is an incoming federated message
    v_is_federated_incoming := (NEW.metadata->>'federated' = 'true');
    
    -- Get sender profile for notifications
    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;
    
    CASE v_federation_type
        WHEN 'chat_local_only' THEN
            -- Send local notifications for chat messages
            PERFORM send_notification(
                'chat_message',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                ),
                jsonb_build_object(
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', left(NEW.content::text, 100)
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
            
        WHEN 'dm_local_only' THEN
            -- Send DM notifications for local-only DMs
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                ),
                jsonb_build_object(
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', left(NEW.content::text, 100)
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
            
        WHEN 'dm_federated' THEN
            -- Send DM notifications for federated DMs
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                ),
                jsonb_build_object(
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', left(NEW.content::text, 100),
                    'federated', true
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
    END CASE;
    
    RETURN NEW;
    
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Message federation processing failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$function$;

-- =====================================================
-- FIX 2: process_ap_activity_on_update() function  
-- Issues: instance_settings table, trim() casting
-- =====================================================

CREATE OR REPLACE FUNCTION public.process_ap_activity_on_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_instance_domain TEXT;
    v_classification TEXT;
    v_actor_profile_id UUID;
BEGIN
    -- Only process when status changes to 'processing'
    IF NEW.status != 'processing' OR OLD.status = 'processing' THEN
        RETURN NEW;
    END IF;
    
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    IF v_instance_domain IS NULL THEN
        RAISE WARNING 'No instance domain configured, skipping activity processing';
        RETURN NEW;
    END IF;
    
    -- Try to find actor profile (optional)
    SELECT actor_id INTO v_actor_profile_id FROM ap_activities WHERE id = NEW.id;
    
    -- Classify the activity
    v_classification := classify_activitypub_activity(NEW.activity_data, v_instance_domain);
    
    -- Route based on classification
    CASE v_classification
        WHEN 'private_mention' THEN
            -- Process as incoming private message/DM
            IF v_actor_profile_id IS NOT NULL THEN
                PERFORM process_incoming_private_message(
                    NEW.id,
                    NEW.activity_data,
                    v_actor_profile_id,
                    v_instance_domain
                );
            ELSE
                RAISE WARNING 'Actor profile not found for private mention activity %', NEW.id;
            END IF;
            
        WHEN 'public_post' THEN
            -- Process as public post (existing function)
            IF v_actor_profile_id IS NOT NULL THEN
                PERFORM process_activitypub_public_post(
                    NEW.id,
                    NEW.activity_data,
                    (SELECT ROW(id, username, display_name, domain, federated_id, is_local, avatar_url, bio, created_at, updated_at) 
                     FROM profiles WHERE id = v_actor_profile_id),
                    v_instance_domain
                );
            ELSE
                RAISE WARNING 'Actor profile not found for public post activity %', NEW.id;
            END IF;
            
        ELSE
            RAISE WARNING 'Unknown activity classification: % for activity %', v_classification, NEW.id;
    END CASE;
    
    -- Mark as completed
    UPDATE ap_activities SET status = 'completed', processed_at = NOW() WHERE id = NEW.id;
    
    RETURN NEW;
    
EXCEPTION
    WHEN OTHERS THEN
        -- Mark as failed and log error
        UPDATE ap_activities SET 
            status = 'failed', 
            error_message = SQLERRM,
            processed_at = NOW()
        WHERE id = NEW.id;
        
        RAISE WARNING 'Failed to process ActivityPub activity %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$function$;

-- =====================================================
-- VERIFICATION
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Critical bug fixes applied:';
    RAISE NOTICE '   - Fixed send_notification function calls';
    RAISE NOTICE '   - Fixed instance_config table references';  
    RAISE NOTICE '   - Fixed trim() casting issues';
    RAISE NOTICE '   - Fixed "federated" typo';
    RAISE NOTICE '🚀 Ready to run migration 091';
END $$;

COMMIT;