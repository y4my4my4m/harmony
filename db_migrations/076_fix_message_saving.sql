-- Migration 076: Fix Message Saving Issue
-- ISSUE: Migration 074 broke local message saving - trigger failures prevent message INSERT
-- SOLUTION: Make handle_outgoing_messages more robust and don't let federation errors prevent saving

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_outgoing_messages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $function$
DECLARE
    sender_profile profiles%ROWTYPE;
    v_instance_domain TEXT;
    v_recipient_profile RECORD;
    participant_record RECORD;
    v_activity_uuid UUID;
    target_domains TEXT[];
BEGIN
    -- Get sender profile
    SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- =================================================================
    -- SECTION 1: HANDLE NOTIFICATIONS (with error handling)
    -- =================================================================
    BEGIN
        IF NEW.conversation_id IS NOT NULL THEN
            -- Notify conversation participants (LOCAL users only)
            FOR participant_record IN 
                SELECT cp.user_id, p.is_local
                FROM conversation_participants cp
                JOIN profiles p ON p.id = cp.user_id
                WHERE cp.conversation_id = NEW.conversation_id 
                  AND cp.user_id != NEW.user_id
                  AND cp.left_at IS NULL
                  AND p.is_local = true
            LOOP
                -- Try notification, but don't fail if it errors
                BEGIN
                    PERFORM send_notification_to_user(
                        participant_record.user_id,
                        'dm',
                        'New message',
                        jsonb_build_object(
                            'conversation_id', NEW.conversation_id,
                            'message_id', NEW.id,
                            'sender_id', NEW.user_id
                        ),
                        NULL, NULL, NEW.conversation_id, NEW.id
                    );
                EXCEPTION WHEN OTHERS THEN
                    -- Log error but continue
                    RAISE WARNING 'Notification failed for user %: %', participant_record.user_id, SQLERRM;
                END;
            END LOOP;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Notification section failed: %', SQLERRM;
    END;
    
    -- =================================================================
    -- SECTION 2: HANDLE FEDERATION (with error handling)
    -- =================================================================
    BEGIN
        IF NEW.conversation_id IS NOT NULL AND sender_profile.is_local THEN
            -- Get instance domain
            SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
            FROM instance_config WHERE config_key = 'domain' LIMIT 1;
            
            IF v_instance_domain IS NOT NULL AND v_instance_domain != 'debug' AND v_instance_domain != '' THEN
                -- Find remote recipients
                FOR v_recipient_profile IN 
                    SELECT p.id, p.username, p.domain, p.federated_id, p.is_local
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id 
                      AND cp.user_id != NEW.user_id
                      AND cp.left_at IS NULL
                      AND NOT p.is_local
                      AND p.domain IS NOT NULL
                      AND p.domain != 'debug'
                      AND p.domain != ''
                LOOP
                    BEGIN
                        -- Create AP activity
                        INSERT INTO ap_activities (
                            ap_id,
                            ap_type,
                            actor_id,
                            actor_ap_id,
                            object_id,
                            object_type,
                            activity_data,
                            status,
                            to_addresses,
                            is_local,
                            origin_domain
                        ) VALUES (
                            'https://' || v_instance_domain || '/users/' || sender_profile.username || '#dm-' || NEW.id::TEXT,
                            'Create',
                            sender_profile.id,
                            'https://' || v_instance_domain || '/users/' || sender_profile.username,
                            'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT,
                            'Note',
                            jsonb_build_object(
                                '@context', 'https://www.w3.org/ns/activitystreams',
                                'type', 'Create',
                                'actor', 'https://' || v_instance_domain || '/users/' || sender_profile.username,
                                'object', jsonb_build_object(
                                    'type', 'Note',
                                    'id', 'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT,
                                    'content', convert_jsonb_to_ap(NEW.content),
                                    'to', jsonb_build_array(COALESCE(v_recipient_profile.federated_id, 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username))
                                )
                            ),
                            'pending',
                            ARRAY[COALESCE(v_recipient_profile.federated_id, 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username)],
                            true,
                            v_instance_domain
                        ) RETURNING id INTO v_activity_uuid;
                        
                        -- Queue for federation
                        target_domains := ARRAY[v_recipient_profile.domain];
                        PERFORM queue_activity_for_federation(v_activity_uuid, target_domains, 8, true);
                        
                    EXCEPTION WHEN OTHERS THEN
                        RAISE WARNING 'Federation failed for recipient %@%: %', v_recipient_profile.username, v_recipient_profile.domain, SQLERRM;
                    END;
                END LOOP;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Federation section failed: %', SQLERRM;
    END;
    
    -- ALWAYS return NEW to ensure message is saved
    RETURN NEW;
END;
$function$;

COMMIT;