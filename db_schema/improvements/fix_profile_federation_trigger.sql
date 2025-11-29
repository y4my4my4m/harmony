-- ============================================
-- FIX: Profile federation trigger handles missing target_domain
-- 
-- Problem: When updating status, the trigger_queue_profile_federation function
-- calls queue_federation_job, but if pg-boss tables don't exist, the fallback
-- tries to insert into federation_delivery_queue which requires target_domain.
-- Profile updates don't have a single target_domain - they broadcast to followers.
--
-- Solution: Make the profile federation trigger skip when pg-boss isn't ready,
-- since profile updates require the federation-backend to enumerate followers.
-- ============================================

-- First, let's check what triggers exist on profiles
DO $$
DECLARE
    trig_record RECORD;
BEGIN
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

-- Option 1: Update the profile federation trigger to be pg-boss only (no fallback)
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
END;
$$;

COMMENT ON FUNCTION public.trigger_queue_profile_federation() IS 
'Queue profile updates for federation via pg-boss. Requires pg-boss for follower enumeration.';

-- Option 2: Also update queue_federation_job to handle missing target_domain gracefully
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text,
    p_job_data jsonb,
    p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5,
    p_expire_in_seconds integer DEFAULT 3600
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job_id uuid;
    v_target_domain text;
BEGIN
    -- Try to insert into pg-boss queue
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
        p_job_name,
        p_job_data,
        p_priority,
        p_retry_limit,
        make_interval(secs => p_expire_in_seconds),
        now(),
        'created'
    )
    RETURNING id INTO v_job_id;
    
    RETURN v_job_id;
EXCEPTION
    WHEN undefined_table THEN
        -- pg-boss tables don't exist yet
        -- Only use fallback for jobs that have target_domain
        v_target_domain := p_job_data->>'target_domain';
        
        IF v_target_domain IS NOT NULL AND v_target_domain != '' THEN
            -- Has target domain - can use fallback queue
            RAISE LOG 'pg-boss not available, using fallback for job % to %', p_job_name, v_target_domain;
            
            INSERT INTO public.federation_delivery_queue (
                activity_data,
                target_inbox_url,
                target_domain,
                sender_id,
                status,
                priority,
                next_attempt_at
            ) VALUES (
                p_job_data,
                p_job_data->>'target_inbox',
                v_target_domain,
                (p_job_data->>'sender_id')::UUID,
                'pending',
                p_priority,
                NOW()
            )
            RETURNING id INTO v_job_id;
            
            RETURN v_job_id;
        ELSE
            -- No target domain - this job type requires pg-boss (e.g., profile updates)
            RAISE LOG 'pg-boss not available, skipping job % (requires follower enumeration)', p_job_name;
            RETURN NULL;
        END IF;
END;
$$;

COMMENT ON FUNCTION public.queue_federation_job IS 
'Queue a federation job for processing by the federation-backend.
Uses pg-boss for reliable job queuing. Falls back to federation_delivery_queue only for jobs with target_domain.
Jobs without target_domain (like profile updates) require pg-boss for follower enumeration.';

-- Verify the fix
SELECT 'Fix applied. Profile federation now gracefully handles missing pg-boss.' as message;

