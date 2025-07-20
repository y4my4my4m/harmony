-- Migration 033: FORCE Replace Federation Function
-- 
-- ISSUE: handle_unified_content_federation exists but is the OLD broken version
-- RESULT: No Create activities, no queue calls, no federation
-- 
-- ROOT CAUSE: Migration gaps in refactor process (from HARMONY_DATABASE_ANALYSIS.md)
-- SOLUTION: Force replace with working function that has queue calls

BEGIN;

-- Step 1: Force drop the old broken function (CASCADE removes trigger dependencies)
DROP FUNCTION IF EXISTS public.handle_unified_content_federation() CASCADE;

-- Step 2: Recreate the function with PROPER queue calls (from your refactor plan)
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
    RAISE NOTICE 'Federation trigger fired for % on % (operation: %)', TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), TG_OP;

    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    IF current_instance_domain IS NULL THEN
        RAISE WARNING 'No instance domain configured, skipping federation';
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    full_instance_url := 'https://' || current_instance_domain;

    -- Table-aware federation check (from Migration 030 fix)
    SELECT is_federation_enabled_for_user(
        CASE 
            WHEN TG_TABLE_NAME = 'posts' THEN COALESCE(NEW.author_id, OLD.author_id)
            WHEN TG_TABLE_NAME = 'messages' THEN COALESCE(NEW.user_id, OLD.user_id)
            ELSE NULL
        END
    ) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RAISE NOTICE 'Federation disabled for user, skipping';
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- POSTS FEDERATION (the main issue)
    IF TG_TABLE_NAME = 'posts' THEN
        IF TG_OP = 'INSERT' THEN
            RAISE NOTICE 'Processing post federation for post %', NEW.id;

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

            RAISE NOTICE 'Created ap_activity % for post %', activity_id, NEW.id;

            -- 🔥 CRITICAL: Get follower domains and queue for federation
            SELECT array_agg(DISTINCT p.domain) INTO target_domains
            FROM follows f
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id
            AND f.status = 'accepted'
            AND NOT p.is_local
            AND p.domain IS NOT NULL;

            IF target_domains IS NOT NULL AND array_length(target_domains, 1) > 0 THEN
                -- Call the queue function
                PERFORM queue_activity_for_federation(
                    activity_id,
                    target_domains,
                    5, -- Standard priority for posts
                    true -- Immediate delivery
                );
                
                RAISE NOTICE '📤 QUEUED post % for federation to domains: %', NEW.id, target_domains;
            ELSE
                RAISE NOTICE 'ℹ️ Post % has no remote followers, skipping federation queue', NEW.id;
            END IF;
        END IF;

    -- MESSAGES FEDERATION (for DMs)
    ELSIF TG_TABLE_NAME = 'messages' THEN
        IF TG_OP = 'INSERT' THEN
            RAISE NOTICE 'Processing message federation for message %', NEW.id;

            -- Get remote participants from conversation
            SELECT array_agg(cp.user_id) 
            INTO remote_participants
            FROM conversation_participants cp
            JOIN profiles p ON cp.user_id = p.id
            WHERE cp.conversation_id = NEW.conversation_id
              AND NOT p.is_local;

            -- Only federate if there are remote participants
            IF remote_participants IS NOT NULL AND array_length(remote_participants, 1) > 0 THEN
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

                RAISE NOTICE 'Created ap_activity % for DM %', activity_id, NEW.id;

                -- Get domains of remote participants
                SELECT array_agg(DISTINCT p.domain) INTO target_domains
                FROM profiles p
                WHERE p.id = ANY(remote_participants)
                AND p.domain IS NOT NULL;

                -- Queue for delivery to remote participants
                IF target_domains IS NOT NULL AND array_length(target_domains, 1) > 0 THEN
                    PERFORM queue_activity_for_federation(
                        activity_id,
                        target_domains,
                        8, -- High priority for DMs
                        true -- Immediate delivery
                    );
                    
                    RAISE NOTICE '📤 QUEUED DM % for federation to domains: %', NEW.id, target_domains;
                END IF;
            ELSE
                RAISE NOTICE 'ℹ️ Message % has no remote participants, skipping federation', NEW.id;
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Federation trigger failed for % %: %', TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), SQLERRM;
    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Step 3: Recreate the posts trigger (CASCADE dropped it)
CREATE TRIGGER trigger_unified_content_federation
    AFTER INSERT OR UPDATE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_unified_content_federation();

-- Step 4: Recreate the messages trigger if it was there
CREATE TRIGGER IF NOT EXISTS trigger_unified_content_federation
    AFTER INSERT OR UPDATE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION handle_unified_content_federation();

-- Step 5: Add comments
COMMENT ON FUNCTION public.handle_unified_content_federation() IS 
'FORCE FIXED: Complete federation function with queue_activity_for_federation calls and detailed logging';

COMMENT ON TRIGGER trigger_unified_content_federation ON posts IS 
'FORCE FIXED: Posts federation trigger with proper queue population';

-- Step 6: Verify the fix worked
DO $$
BEGIN
    -- Check function has queue calls
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'handle_unified_content_federation' 
        AND prosrc LIKE '%queue_activity_for_federation%'
    ) THEN
        RAISE EXCEPTION 'FORCE FIX FAILED: Function still missing queue calls';
    END IF;
    
    -- Check posts trigger exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t 
        JOIN pg_class c ON t.tgrelid = c.oid 
        WHERE c.relname = 'posts' AND t.tgname = 'trigger_unified_content_federation'
    ) THEN
        RAISE EXCEPTION 'FORCE FIX FAILED: Posts trigger missing after recreate';
    END IF;
    
    RAISE NOTICE '🔥 FORCE FIX SUCCESSFUL!';
    RAISE NOTICE '✅ Function now has queue_activity_for_federation calls';
    RAISE NOTICE '✅ Posts trigger recreated and working';
    RAISE NOTICE '✅ Detailed logging added for debugging';
    RAISE NOTICE '🎯 Federation should work now with visible logs!';
END $$;

-- Log completion
INSERT INTO migration_log (version, description, applied_at) 
VALUES (33, 'FORCE replaced broken federation function with working version + queue calls', NOW())
ON CONFLICT (version) DO UPDATE SET 
    description = EXCLUDED.description,
    applied_at = EXCLUDED.applied_at;

COMMIT;