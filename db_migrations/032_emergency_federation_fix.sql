-- Migration 032: EMERGENCY Federation Fix
-- 
-- ISSUE: Migration 031 didn't apply properly
-- RESULT: Posts trigger missing + function missing queue calls
-- 
-- EMERGENCY FIX: Manually create both trigger and function with queue calls

BEGIN;

-- Step 1: Drop and recreate the federation function with queue calls
DROP FUNCTION IF EXISTS public.handle_unified_content_federation() CASCADE;

CREATE OR REPLACE FUNCTION public.handle_unified_content_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;
    remote_participants uuid[];
    activity_id uuid;
    target_domains text[];
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;

    -- Table-aware federation check
    SELECT is_federation_enabled_for_user(
        CASE 
            WHEN TG_TABLE_NAME = 'posts' THEN COALESCE(NEW.author_id, OLD.author_id)
            WHEN TG_TABLE_NAME = 'messages' THEN COALESCE(NEW.user_id, OLD.user_id)
            ELSE NULL
        END
    ) INTO user_federation_enabled;
    
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
            ) RETURNING id INTO activity_id;

            -- 🔥 CRITICAL: Queue for federation delivery
            -- Get follower domains for this user's posts
            SELECT array_agg(DISTINCT p.domain) INTO target_domains
            FROM follows f
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id
            AND f.status = 'accepted'
            AND NOT p.is_local
            AND p.domain IS NOT NULL;

            -- Queue for delivery if there are remote followers
            IF array_length(target_domains, 1) > 0 THEN
                PERFORM queue_activity_for_federation(
                    activity_id,
                    target_domains,
                    5, -- Standard priority for posts
                    true -- Immediate delivery
                );
                
                RAISE NOTICE '📤 Queued post % for federation to % domains', NEW.id, array_length(target_domains, 1);
            ELSE
                RAISE NOTICE 'ℹ️ Post % has no remote followers, skipping federation', NEW.id;
            END IF;
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
                ) RETURNING id INTO activity_id;

                -- 🔥 CRITICAL: Queue DM for federation delivery
                -- Get domains of remote participants
                SELECT array_agg(DISTINCT p.domain) INTO target_domains
                FROM profiles p
                WHERE p.id = ANY(remote_participants)
                AND p.domain IS NOT NULL;

                -- Queue for delivery to remote participants
                IF array_length(target_domains, 1) > 0 THEN
                    PERFORM queue_activity_for_federation(
                        activity_id,
                        target_domains,
                        8, -- High priority for DMs
                        true -- Immediate delivery
                    );
                    
                    RAISE NOTICE '📤 Queued DM % for federation to % domains', NEW.id, array_length(target_domains, 1);
                END IF;
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
    -- Log error but don't block the operation
    RAISE WARNING 'Federation trigger failed for % %: %', TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), SQLERRM;
    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Add function comment
COMMENT ON FUNCTION public.handle_unified_content_federation() IS 
'EMERGENCY FIX: Unified federation trigger with queue_activity_for_federation calls';

-- Step 2: Create the missing posts federation trigger
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;

CREATE TRIGGER trigger_unified_content_federation
    AFTER INSERT OR UPDATE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_unified_content_federation();

-- Add trigger comment
COMMENT ON TRIGGER trigger_unified_content_federation ON posts IS 
'EMERGENCY FIX: Posts federation trigger that creates ap_activities AND federation_delivery_queue entries';
