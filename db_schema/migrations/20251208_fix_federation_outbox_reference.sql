-- =============================================
-- Fix federation_outbox reference error
-- =============================================
-- This migration ensures all profile federation functions are updated
-- and no longer reference the non-existent federation_outbox table

-- Update trigger_queue_profile_federation to latest version
-- (includes custom_status support and proper error handling)
CREATE OR REPLACE FUNCTION "public"."trigger_queue_profile_federation"() RETURNS "trigger"
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_job_id uuid;
    v_has_pgboss boolean := false;
BEGIN
    -- Only federate local user profile updates
    IF NEW.is_local != true THEN
        RETURN NEW;
    END IF;
    
    -- Check if relevant fields changed (don't federate every tiny update)
    IF TG_OP = 'UPDATE' THEN
        IF (
            OLD.display_name IS NOT DISTINCT FROM NEW.display_name AND
            OLD.bio IS NOT DISTINCT FROM NEW.bio AND
            OLD.avatar_url IS NOT DISTINCT FROM NEW.avatar_url AND
            OLD.banner_url IS NOT DISTINCT FROM NEW.banner_url AND
            OLD.custom_status IS NOT DISTINCT FROM NEW.custom_status
        ) THEN
            -- No federable fields changed, skip
            RETURN NEW;
        END IF;
    END IF;
    
    -- Check if pg-boss tables exist
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'pgboss' 
        AND table_name = 'job'
    ) INTO v_has_pgboss;
    
    IF v_has_pgboss THEN
        -- Use pg-boss for proper job queuing
        INSERT INTO pgboss.job (
            id,
            name,
            data,
            priority,
            retry_limit,
            expire_in,
            created_on,
            state
        ) VALUES (
            gen_random_uuid(),
            'federate-profile',
            jsonb_build_object(
                'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
                'profile_id', NEW.id,
                'username', NEW.username,
                'display_name', NEW.display_name,
                'bio', NEW.bio,
                'avatar_url', NEW.avatar_url,
                'banner_url', NEW.banner_url,
                'custom_status', NEW.custom_status
            ),
            3,
            5,
            interval '1 hour',
            now(),
            'created'
        )
        RETURNING id INTO v_job_id;
        
        RAISE LOG 'Queued profile federation for % (job: %)', NEW.username, v_job_id;
    ELSE
        -- pg-boss not available - profile federation requires it because we need
        -- to enumerate followers. Simply skip and log.
        RAISE LOG 'Profile federation skipped for % - pg-boss not initialized', NEW.username;
    END IF;
    
    RETURN NEW;
EXCEPTION
    WHEN undefined_table THEN
        RAISE LOG 'Profile federation skipped - required tables not available';
        RETURN NEW;
    WHEN OTHERS THEN
        RAISE LOG 'Profile federation error: %', SQLERRM;
        RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."trigger_queue_profile_federation"() IS 'Queue profile updates for federation via pg-boss. Includes custom_status. Requires pg-boss for follower enumeration. Safe - does not break on missing tables. Does not reference federation_outbox.';

-- Also ensure handle_unified_profile_federation is updated (if it exists)
-- This function should not be used anymore, but update it just in case
CREATE OR REPLACE FUNCTION "public"."handle_unified_profile_federation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    user_federation_enabled boolean;
    v_has_pgboss boolean := false;
BEGIN
    -- Only process UPDATE operations
    IF TG_OP != 'UPDATE' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Only process local users
    IF NEW.is_local != true THEN
        RETURN NEW;
    END IF;

    -- Check if federation is enabled for this user
    BEGIN
        SELECT is_federation_enabled_for_user(NEW.id) INTO user_federation_enabled;
    EXCEPTION WHEN OTHERS THEN
        user_federation_enabled := false;
    END;
    
    IF NOT COALESCE(user_federation_enabled, false) THEN
        RETURN NEW;
    END IF;

    -- Check if any federable fields changed
    IF NOT (
        OLD.display_name IS DISTINCT FROM NEW.display_name OR
        OLD.bio IS DISTINCT FROM NEW.bio OR
        OLD.avatar_url IS DISTINCT FROM NEW.avatar_url OR
        OLD.banner_url IS DISTINCT FROM NEW.banner_url
    ) THEN
        -- No federable fields changed, skip
        RETURN NEW;
    END IF;

    -- Check if pg-boss tables exist
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'pgboss' 
        AND table_name = 'job'
    ) INTO v_has_pgboss;
    
    IF v_has_pgboss THEN
        -- Use pg-boss for proper job queuing
        INSERT INTO pgboss.job (
            id,
            name,
            data,
            priority,
            retry_limit,
            expire_in,
            created_on,
            state
        ) VALUES (
            gen_random_uuid(),
            'federate-profile',
            jsonb_build_object(
                'type', 'update',
                'profile_id', NEW.id,
                'username', NEW.username,
                'display_name', NEW.display_name,
                'bio', NEW.bio,
                'avatar_url', NEW.avatar_url,
                'banner_url', NEW.banner_url
            ),
            3,
            5,
            interval '1 hour',
            now(),
            'created'
        );
        
        RAISE LOG 'Queued profile federation for % via pg-boss', NEW.username;
    ELSE
        -- pg-boss not available - profile federation requires it to enumerate followers
        -- Simply log and skip (profile updates without followers is fine)
        RAISE LOG 'Profile federation skipped for % - pg-boss not initialized', NEW.username;
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN undefined_table THEN
        -- If any table doesn't exist, just log and continue
        RAISE LOG 'Profile federation skipped - required tables not available';
        RETURN NEW;
    WHEN OTHERS THEN
        -- Don't let federation errors break profile updates
        RAISE LOG 'Profile federation error for %: %', NEW.username, SQLERRM;
        RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."handle_unified_profile_federation"() IS 'FIXED: Unified trigger for federating local profile updates. Uses pg-boss when available, gracefully skips otherwise. No longer references non-existent federation_outbox table.';

