-- Migration 030: Fix Federation Trigger Field Reference
-- 
-- ISSUE: handle_unified_content_federation() assumes it can access both author_id and user_id
-- CAUSE: Function designed for both posts/messages but only messages trigger is active
-- SOLUTION: Make the function table-aware and use correct fields for each table
--
-- ERROR FIXED: "record \"new\" has no field \"author_id\""

BEGIN;

-- Fix the unified content federation function to be table-aware
CREATE OR REPLACE FUNCTION public.handle_unified_content_federation() 
RETURNS TRIGGER AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;
    remote_participants uuid[];
    target_user_id uuid;
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
    ELSE
        -- Unknown table, skip federation
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check federation for the identified user
    SELECT is_federation_enabled_for_user(target_user_id) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_TABLE_NAME = 'posts' THEN
        -- Handle post federation
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
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'messages' THEN
        -- Handle DM federation (only if there are remote participants)
        IF TG_OP = 'INSERT' THEN
            -- Get remote participants from conversation
            SELECT array_agg(cp.user_id) 
            INTO remote_participants
            FROM conversation_participants cp
            JOIN profiles p ON cp.user_id = p.id
            WHERE cp.conversation_id = NEW.conversation_id
              AND NOT p.is_local;

            -- Only federate if there are remote participants
            IF array_length(remote_participants, 1) > 0 THEN
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
                );
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
EXCEPTION 
    WHEN OTHERS THEN
        -- Log error but don't block the operation (graceful degradation)
        RAISE WARNING 'Federation trigger failed for % %: %', TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), SQLERRM;
        RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Update function comment to reflect the fix
COMMENT ON FUNCTION public.handle_unified_content_federation() IS 'FIXED: Table-aware federation trigger that correctly handles field references for both posts (author_id) and messages (user_id) tables.';

COMMIT;