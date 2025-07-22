-- Migration 077: Revert to 074 Federation Logic + Fix Local Saving
-- ISSUE: 076 broke both local saving AND remote delivery
-- SOLUTION: Use 074's working federation logic, but make trigger safer for local saving

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_outgoing_messages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $function$
DECLARE
    -- Variables for notifications
    mentioned_usernames TEXT[];
    mentioned_user_id UUID;
    username_item TEXT;
    sender_profile profiles%ROWTYPE;
    v_instance_domain TEXT;
    
    -- Variables for federation
    v_recipient_profile RECORD;
    participant_record RECORD;
    v_activity_uuid UUID;
    v_recipient_url TEXT;
    v_activity JSONB;
    v_inbox_url TEXT;
    target_domains TEXT[];
BEGIN
    -- **CRITICAL**: Always return NEW first to ensure message gets saved
    -- Even if everything below fails, the message will be inserted
    
    -- Only process DMs (messages with conversation_id)
    IF NEW.conversation_id IS NULL THEN
        RETURN NEW;
    END IF;
    
    -- Get sender profile (wrapped in exception handling)
    BEGIN
        SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
        IF NOT FOUND THEN
            RAISE WARNING 'Sender profile not found for user_id: %', NEW.user_id;
            RETURN NEW;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error getting sender profile: %', SQLERRM;
        RETURN NEW;
    END;
    
    -- Get instance domain (wrapped in exception handling)
    BEGIN
        SELECT domain INTO v_instance_domain FROM instance_settings LIMIT 1;
        IF v_instance_domain IS NULL THEN
            v_instance_domain := 'localhost';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error getting instance domain: %', SQLERRM;
        v_instance_domain := 'localhost';
    END;
    
    -- Process notifications (wrapped in exception handling)
    BEGIN
        -- Extract mentions from content
        mentioned_usernames := extract_mentions_from_content(NEW.content::text);
        
        -- Send notifications to mentioned users
        IF mentioned_usernames IS NOT NULL AND array_length(mentioned_usernames, 1) > 0 THEN
            FOREACH username_item IN ARRAY mentioned_usernames
            LOOP
                -- Find local user by username
                SELECT id INTO mentioned_user_id 
                FROM profiles 
                WHERE username = username_item 
                AND (domain IS NULL OR domain = v_instance_domain);
                
                IF mentioned_user_id IS NOT NULL THEN
                    -- Send notification using correct function signature
                    PERFORM send_notification_to_user(
                        mentioned_user_id,           -- recipient_user_id  
                        'mention'::notification_type, -- notification_type
                        'You were mentioned in a DM', -- message
                        jsonb_build_object(           -- data
                            'message_id', NEW.id,
                            'sender_username', sender_profile.username,
                            'sender_domain', sender_profile.domain,
                            'conversation_id', NEW.conversation_id
                        ),
                        sender_profile.id,            -- sender_user_id
                        NEW.id,                       -- related_message_id
                        NULL,                         -- related_post_id
                        NEW.conversation_id           -- related_conversation_id
                    );
                END IF;
            END LOOP;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error processing notifications: %', SQLERRM;
        -- Continue with federation even if notifications fail
    END;
    
    -- Process federation (wrapped in exception handling)
    BEGIN
        RAISE WARNING '🔧 handle_outgoing_messages() function called for message %', NEW.id;
        
        -- Get all conversation participants who need federation
        FOR participant_record IN
            SELECT DISTINCT p.id, p.username, p.domain, p.federated_id
            FROM conversation_participants cp
            JOIN profiles p ON cp.user_id = p.id
            WHERE cp.conversation_id = NEW.conversation_id
            AND p.id != NEW.user_id  -- Don't send to sender
            AND p.domain IS NOT NULL -- Only federated users
            AND p.domain != v_instance_domain -- Don't send to local instance
        LOOP
            RAISE WARNING '🎯 Federating DM to: %@%', participant_record.username, participant_record.domain;
            
            v_recipient_profile := participant_record;
            
            -- Determine recipient URL (use federated_id if available, otherwise construct)
            v_recipient_url := COALESCE(v_recipient_profile.federated_id, 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username);
            
            -- Create ActivityPub activity (SAME AS 074 - WORKING VERSION)
            v_activity := jsonb_build_object(
                'type', 'Create',
                'id', 'https://' || v_instance_domain || '/users/' || sender_profile.username || '#dm-' || NEW.id,
                'actor', 'https://' || v_instance_domain || '/users/' || sender_profile.username,
                'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'to', jsonb_build_array(v_recipient_url),
                'cc', jsonb_build_array(),
                'object', jsonb_build_object(
                    'type', 'Note',
                    'id', 'https://' || v_instance_domain || '/messages/' || NEW.id,
                    'attributedTo', 'https://' || v_instance_domain || '/users/' || sender_profile.username,
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'to', jsonb_build_array(v_recipient_url),
                    'cc', jsonb_build_array(),
                    'content', NEW.content,
                    'url', 'https://' || v_instance_domain || '/messages/' || NEW.id,
                    'tag', jsonb_build_array(
                        jsonb_build_object(
                            'type', 'Mention',
                            'href', v_recipient_url,
                            'name', '@' || v_recipient_profile.username || '@' || v_recipient_profile.domain
                        )
                    )
                ),
                '@context', 'https://www.w3.org/ns/activitystreams'
            );
            
            -- Insert into ap_activities table and get UUID
            INSERT INTO ap_activities (
                activity_type,
                activity_data,
                actor_profile_id,
                object_id
            ) VALUES (
                'Create',
                v_activity,
                sender_profile.id,
                NEW.id
            ) RETURNING id INTO v_activity_uuid;
            
            -- Determine inbox URL
            v_inbox_url := CASE 
                WHEN v_recipient_profile.domain = 'mastodon.social' THEN 'https://mastodon.social/inbox'
                WHEN v_recipient_profile.domain = 'misskey.io' THEN 'https://misskey.io/inbox'
                ELSE 'https://' || v_recipient_profile.domain || '/inbox'
            END;
            
            -- Use the queue_activity_for_federation function (PROPER FLOW)
            PERFORM queue_activity_for_federation(
                v_activity_uuid,
                v_recipient_profile.domain,
                v_inbox_url,
                sender_profile.username,
                v_instance_domain
            );
            
            RAISE WARNING '📮 Queuing DM delivery to: %', v_inbox_url;
        END LOOP;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error processing federation: %', SQLERRM;
        -- Don't fail the message insertion even if federation fails
    END;
    
    -- **ALWAYS** return NEW to ensure message gets saved
    RETURN NEW;
END;
$function$;

COMMIT;