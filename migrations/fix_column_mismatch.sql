-- Fix column name mismatches in unified ActivityPub processing
-- The profiles table uses 'federated_id' not 'ap_id'

-- Update the main processing function to use correct column names
CREATE OR REPLACE FUNCTION handle_activitypub_activity_processing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public, pg_temp
AS $$
DECLARE
    v_actor_profile RECORD;
    v_target_profile RECORD;
    v_activity_object JSONB;
    v_object_id TEXT;
    v_instance_domain TEXT;
    v_result JSONB;
BEGIN
    -- Process activities that are:
    -- 1. In 'processing' status (freshly validated by inbox)
    -- 2. In 'pending' status and ready for retry (next_attempt_at <= now)
    -- Skip if already processed
    IF OLD.status = 'processed' THEN
        RETURN NEW;
    END IF;

    IF NOT (
        (NEW.status = 'processing') OR 
        (NEW.status = 'pending' AND NEW.next_attempt_at IS NOT NULL AND NEW.next_attempt_at <= NOW())
    ) THEN
        RETURN NEW;
    END IF;

    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config 
    WHERE config_key = 'domain' 
    LIMIT 1;

    IF v_instance_domain IS NULL THEN
        v_instance_domain := 'har.mony.lol'; -- fallback
    END IF;

    -- Get actor profile by resolving from actor_ap_id using federated_id column
    SELECT * INTO v_actor_profile
    FROM profiles 
    WHERE federated_id = NEW.actor_ap_id;

    IF NOT FOUND THEN
        -- Try to get or create the remote profile
        RAISE NOTICE 'Actor profile not found for %s, attempting to create...', NEW.actor_ap_id;
        
        -- For now, we'll fail the activity if actor profile doesn't exist
        -- In a production system, you might want to fetch the actor and create the profile
        UPDATE ap_activities 
        SET status = 'failed', 
            error_message = 'Actor profile not found: ' || NEW.actor_ap_id,
            updated_at = NOW()
        WHERE id = NEW.id;
        RETURN NEW;
    END IF;

    -- Extract object from activity data
    v_activity_object := NEW.activity_data->'object';
    v_object_id := CASE 
        WHEN jsonb_typeof(v_activity_object) = 'string' THEN v_activity_object::text
        ELSE v_activity_object->>'id'
    END;

    RAISE NOTICE 'Processing % activity % from %', NEW.ap_type, NEW.ap_id, v_actor_profile.username;

    BEGIN
        -- Process based on activity type
        CASE NEW.ap_type
            WHEN 'Follow' THEN
                PERFORM process_follow_activity(NEW.id, NEW.activity_data, v_actor_profile, v_instance_domain);
                
            WHEN 'Accept' THEN
                PERFORM process_accept_activity(NEW.id, NEW.activity_data, v_actor_profile);
                
            WHEN 'Reject' THEN
                PERFORM process_reject_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Undo' THEN
                PERFORM process_undo_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Create' THEN
                PERFORM process_create_activity(NEW.id, NEW.activity_data, v_actor_profile, v_instance_domain);
            
            WHEN 'Update' THEN
                PERFORM process_update_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Delete' THEN
                PERFORM process_delete_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Like' THEN
                PERFORM process_like_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Announce' THEN
                PERFORM process_announce_activity(NEW.id, NEW.activity_data, v_actor_profile);
                
            ELSE
                RAISE WARNING 'Unhandled activity type: %', NEW.ap_type;
        END CASE;

        -- Mark as processed
        UPDATE ap_activities 
        SET status = 'processed', 
            updated_at = NOW()
        WHERE id = NEW.id;
        
        RAISE NOTICE '✅ Successfully processed % activity: %', NEW.ap_type, NEW.ap_id;

    EXCEPTION WHEN OTHERS THEN
        -- Implement retry logic for processing failures
        DECLARE
            v_new_attempts INTEGER := COALESCE(NEW.attempts, 0) + 1;
            v_max_attempts INTEGER := 5;
            v_next_retry_delay INTERVAL;
        BEGIN
            RAISE WARNING 'Error processing activity %: %', NEW.ap_id, SQLERRM;
            
            IF v_new_attempts >= v_max_attempts THEN
                -- Max attempts reached, mark as failed
                UPDATE ap_activities 
                SET status = 'failed',
                    error_message = SQLERRM,
                    attempts = v_new_attempts,
                    last_attempt_at = NOW(),
                    updated_at = NOW()
                WHERE id = NEW.id;
                
                RAISE NOTICE 'Activity % failed permanently after % attempts', NEW.ap_id, v_new_attempts;
            ELSE
                -- Calculate exponential backoff: 2^attempts minutes
                v_next_retry_delay := (POWER(2, v_new_attempts) || ' minutes')::INTERVAL;
                
                UPDATE ap_activities 
                SET status = 'pending',
                    error_message = SQLERRM,
                    attempts = v_new_attempts,
                    last_attempt_at = NOW(),
                    next_attempt_at = NOW() + v_next_retry_delay,
                    updated_at = NOW()
                WHERE id = NEW.id;
                
                RAISE NOTICE 'Activity % scheduled for retry #% in %', NEW.ap_id, v_new_attempts, v_next_retry_delay;
            END IF;
        END;
    END;

    RETURN NEW;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION handle_activitypub_activity_processing() TO authenticated, service_role;

COMMENT ON FUNCTION handle_activitypub_activity_processing() IS 
'Fixed unified ActivityPub activity processor that uses correct column names (federated_id instead of ap_id for profiles table).';

-- Log the fix
DO $$
BEGIN
    RAISE NOTICE '🔧 FIXED: Updated unified ActivityPub trigger to use federated_id column';
    RAISE NOTICE '✅ Actor profile lookup now uses profiles.federated_id = ap_activities.actor_ap_id';
    RAISE NOTICE '🚀 ActivityPub processing should now work correctly';
END $$;
