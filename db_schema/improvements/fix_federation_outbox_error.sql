-- ============================================
-- FIX: Remove reference to non-existent federation_outbox table
-- 
-- Problem: The handle_unified_profile_federation() function tries to insert
-- into public.federation_outbox, but that table doesn't exist - the correct 
-- table is federation_delivery_queue.
--
-- Solution: Replace the function with a safe version that either uses pg-boss
-- or gracefully skips when federation infrastructure isn't ready.
-- ============================================

-- First, let's check what triggers are on the profiles table and which functions they use
DO $$
DECLARE
    trig_record RECORD;
BEGIN
    RAISE NOTICE '=== Triggers on profiles table ===';
    FOR trig_record IN 
        SELECT tgname, tgenabled, pg_get_triggerdef(oid) as definition
        FROM pg_trigger 
        WHERE tgrelid = 'public.profiles'::regclass
        AND NOT tgisinternal
    LOOP
        RAISE NOTICE 'Trigger: % (enabled: %)', trig_record.tgname, trig_record.tgenabled;
        RAISE NOTICE '  Definition: %', trig_record.definition;
    END LOOP;
END $$;

-- Drop any triggers that use the broken function
DROP TRIGGER IF EXISTS unified_profile_federation_trigger ON public.profiles;
DROP TRIGGER IF EXISTS trigger_unified_profile_federation ON public.profiles;
DROP TRIGGER IF EXISTS handle_unified_profile_federation_trigger ON public.profiles;

-- Replace the broken function with a safe version that doesn't use federation_outbox
CREATE OR REPLACE FUNCTION public.handle_unified_profile_federation() 
RETURNS trigger
LANGUAGE plpgsql
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

COMMENT ON FUNCTION public.handle_unified_profile_federation() IS 
'FIXED: Unified trigger for federating local profile updates. Uses pg-boss when available, gracefully skips otherwise. No longer references non-existent federation_outbox table.';

-- Also ensure trigger_queue_profile_federation is safe
CREATE OR REPLACE FUNCTION public.trigger_queue_profile_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
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
            OLD.banner_url IS NOT DISTINCT FROM NEW.banner_url
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
                'banner_url', NEW.banner_url
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

COMMENT ON FUNCTION public.trigger_queue_profile_federation() IS 
'Queue profile updates for federation via pg-boss. Requires pg-boss for follower enumeration. Safe - does not break on missing tables.';

-- Verify the fix by checking what triggers remain
DO $$
DECLARE
    trig_record RECORD;
    func_record RECORD;
BEGIN
    RAISE NOTICE '=== Verification ===';
    
    -- Check for federation_outbox references in functions
    FOR func_record IN 
        SELECT proname 
        FROM pg_proc 
        WHERE prosrc LIKE '%federation_outbox%'
    LOOP
        RAISE WARNING 'Function % still references federation_outbox!', func_record.proname;
    END LOOP;
    
    -- List remaining triggers
    RAISE NOTICE 'Remaining triggers on profiles:';
    FOR trig_record IN 
        SELECT tgname, tgenabled
        FROM pg_trigger 
        WHERE tgrelid = 'public.profiles'::regclass
        AND NOT tgisinternal
    LOOP
        RAISE NOTICE '  - % (enabled: %)', trig_record.tgname, trig_record.tgenabled;
    END LOOP;
END $$;

SELECT 'Fix applied successfully! Profile updates should now work without the federation_outbox error.' as message;

