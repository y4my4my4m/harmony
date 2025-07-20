-- Migration 031: Complete Posts Federation Fix
-- 
-- CONTEXT: From HARMONY_DATABASE_ANALYSIS and REFACTOR_TODO:
-- - Migration 003: Created unified triggers (posts federation trigger created)
-- - Migration 017: DISABLED posts federation trigger (temp fix for content issues)
-- - Migration 030: Fixed function field access but forgot to restore posts trigger
-- 
-- ISSUES:
-- 1. Posts table missing federation trigger (disabled in 017, never restored)
-- 2. handle_unified_content_federation() creates ap_activities but never calls queue_activity_for_federation()
-- 
-- RESULT: Posts create ap_activities but federation_delivery_queue stays empty
--         → "Federated Outbox" webhook has nothing to process
--         → Edge function never called
--         → No federation occurs
-- 
-- SOLUTION: Fix function + restore trigger in one migration

BEGIN;

-- Part 1: Fix Federation Function to Include Queue Population
-- (This addresses the missing queue_activity_for_federation calls)

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

    -- Table-aware federation check (fixed in migration 030)
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

            -- 🔥 FIX: Queue for federation delivery (was missing!)
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

                -- 🔥 FIX: Queue DM for federation delivery (was missing!)
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

-- Update function comment
COMMENT ON FUNCTION public.handle_unified_content_federation() IS 
'FIXED: Unified federation trigger that creates ap_activities AND queues for delivery via federation_delivery_queue';

-- Part 2: Restore Missing Posts Federation Trigger
-- (This restores the trigger that was disabled in migration 017)

-- Clean up any existing posts federation triggers
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;
DROP TRIGGER IF EXISTS handle_post_federation_trigger ON posts;
DROP TRIGGER IF EXISTS trg_handle_post_federation ON posts;

-- Create the posts federation trigger (restoring what was removed in migration 017)
CREATE TRIGGER trigger_unified_content_federation
    AFTER INSERT OR UPDATE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_unified_content_federation();

-- Add trigger comment
COMMENT ON TRIGGER trigger_unified_content_federation ON posts IS 
'RESTORED: Posts federation trigger disabled in migration 017, now restored with queue population fix';

-- Verify everything was created correctly
DO $$
BEGIN
    -- Verify function exists
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'handle_unified_content_federation') THEN
        RAISE EXCEPTION 'Federation function was not updated successfully';
    END IF;
    
    -- Verify trigger exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t 
        JOIN pg_class c ON t.tgrelid = c.oid 
        WHERE c.relname = 'posts' AND t.tgname = 'trigger_unified_content_federation'
    ) THEN
        RAISE EXCEPTION 'Posts federation trigger was not created successfully';
    END IF;
    
    RAISE NOTICE '✅ Federation function updated with queue population';
    RAISE NOTICE '✅ Posts federation trigger restored';
END $$;

-- Log completion
INSERT INTO migration_log (version, description, applied_at) 
VALUES (31, 'Complete posts federation fix - function queue population + trigger restoration', NOW())
ON CONFLICT (version) DO UPDATE SET 
    description = EXCLUDED.description,
    applied_at = EXCLUDED.applied_at;

COMMIT;

-- Final status message
DO $$
BEGIN
    RAISE NOTICE '🎯 Posts Federation COMPLETELY FIXED!';
    RAISE NOTICE '';
    RAISE NOTICE 'Historical Context (from your refactor documents):';
    RAISE NOTICE '  Migration 003: Created unified triggers ✅';
    RAISE NOTICE '  Migration 017: Disabled posts trigger (temp fix) ❌';  
    RAISE NOTICE '  Migration 030: Fixed function, forgot trigger ❌';
    RAISE NOTICE '  Migration 031: COMPLETE FIX ✅';
    RAISE NOTICE '';
    RAISE NOTICE 'What was fixed:';
    RAISE NOTICE '  1. Function now calls queue_activity_for_federation() ✅';
    RAISE NOTICE '  2. Posts table trigger restored ✅';
    RAISE NOTICE '';
    RAISE NOTICE 'Federation flow now complete:';
    RAISE NOTICE '  Posts → trigger → ap_activities → queue → webhook → edge function → HTTP';
    RAISE NOTICE '';
    RAISE NOTICE 'Your webhook architecture was perfect - just needed these fixes!';
END $$;