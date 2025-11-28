-- ============================================================================
-- FEDERATION JOB QUEUE SYSTEM
-- 
-- Professional-grade federation delivery using pg-boss (PostgreSQL-native job queue)
-- This replaces the fragile Supabase Realtime approach with guaranteed delivery.
--
-- Architecture:
-- 1. Database triggers fire when federatable content is created/updated
-- 2. Triggers insert jobs into pg-boss job tables
-- 3. Federation-backend workers pick up and process jobs
-- 4. Jobs are retried with exponential backoff on failure
-- 
-- Benefits:
-- - Jobs persist through disconnections, restarts, crashes
-- - Automatic retries with exponential backoff
-- - Dead letter queue for permanent failures  
-- - Monitoring and metrics
-- ============================================================================

-- ============================================
-- STEP 1: Federation Status Tracking
-- Track which content has been federated
-- ============================================

-- Add federation_status to posts table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'posts' 
        AND column_name = 'federation_status'
    ) THEN
        ALTER TABLE public.posts 
        ADD COLUMN federation_status TEXT DEFAULT 'pending'
        CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'));
        
        COMMENT ON COLUMN public.posts.federation_status IS 
        'Federation status: pending (new), queued (job created), processing (being sent), completed (success), failed (permanent failure), skipped (not federatable)';
    END IF;
END $$;

-- Add federation_status to post_interactions table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'post_interactions' 
        AND column_name = 'federation_status'
    ) THEN
        ALTER TABLE public.post_interactions 
        ADD COLUMN federation_status TEXT DEFAULT 'pending'
        CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'));
    END IF;
END $$;

-- Add federation_status to follows table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'follows' 
        AND column_name = 'federation_status'
    ) THEN
        ALTER TABLE public.follows 
        ADD COLUMN federation_status TEXT DEFAULT 'pending'
        CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'));
    END IF;
END $$;

-- Add federation_status to messages table (for federated DMs)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'messages' 
        AND column_name = 'federation_status'
    ) THEN
        ALTER TABLE public.messages 
        ADD COLUMN federation_status TEXT DEFAULT 'pending'
        CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'));
    END IF;
END $$;

-- Add federation_status to reactions table (for message reactions)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'reactions' 
        AND column_name = 'federation_status'
    ) THEN
        ALTER TABLE public.reactions 
        ADD COLUMN federation_status TEXT DEFAULT 'pending'
        CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'));
    END IF;
END $$;

-- Add federation_status to user_blocks table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'user_blocks' 
        AND column_name = 'federation_status'
    ) THEN
        ALTER TABLE public.user_blocks 
        ADD COLUMN federation_status TEXT DEFAULT 'pending'
        CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'));
    END IF;
END $$;

-- Add federation_status to reports table  
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'reports' 
        AND column_name = 'federation_status'
    ) THEN
        ALTER TABLE public.reports 
        ADD COLUMN federation_status TEXT DEFAULT 'pending'
        CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'));
    END IF;
END $$;

-- ============================================
-- STEP 2: Create indexes for efficient queries
-- ============================================

-- Index for finding pending federation items
CREATE INDEX IF NOT EXISTS idx_posts_federation_pending 
ON public.posts (federation_status, created_at) 
WHERE federation_status = 'pending' AND is_local = true;

CREATE INDEX IF NOT EXISTS idx_post_interactions_federation_pending 
ON public.post_interactions (federation_status, created_at) 
WHERE federation_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_follows_federation_pending 
ON public.follows (federation_status, created_at) 
WHERE federation_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_messages_federation_pending 
ON public.messages (federation_status, created_at) 
WHERE federation_status = 'pending' AND conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reactions_federation_pending 
ON public.reactions (federation_status, created_at) 
WHERE federation_status = 'pending';

-- ============================================
-- STEP 3: pg-boss Schema Setup
-- pg-boss will create its own tables, but we need the schema
-- ============================================

-- Create pgboss schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS pgboss;

-- Grant necessary permissions
GRANT USAGE ON SCHEMA pgboss TO authenticated;
GRANT USAGE ON SCHEMA pgboss TO service_role;

-- Note: pg-boss will automatically create these tables when it starts:
-- pgboss.job - Active jobs
-- pgboss.archive - Completed/failed jobs
-- pgboss.schedule - Scheduled jobs
-- pgboss.subscription - Job subscriptions
-- pgboss.version - pg-boss version tracking

-- ============================================
-- STEP 4: Queue Job Function
-- Called by triggers to insert federation jobs
-- ============================================

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name TEXT,
    p_job_data JSONB,
    p_priority INTEGER DEFAULT 0,
    p_retry_limit INTEGER DEFAULT 5,
    p_expire_in_seconds INTEGER DEFAULT 3600
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgboss
AS $$
DECLARE
    v_job_id UUID;
BEGIN
    -- Insert job into pg-boss job queue
    -- pg-boss expects jobs in the pgboss.job table with specific columns
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
        -- pg-boss tables don't exist yet, log warning
        RAISE WARNING 'pg-boss tables not initialized yet. Job queued to federation_delivery_queue as fallback.';
        
        -- Fallback to existing federation_delivery_queue table
        -- This ensures we don't lose jobs before pg-boss is set up
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
            p_job_data->>'target_domain',
            (p_job_data->>'sender_id')::UUID,
            'pending',
            p_priority,
            NOW()
        )
        RETURNING id INTO v_job_id;
        
        RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION public.queue_federation_job IS 
'Queue a federation job for processing by the federation-backend.
Uses pg-boss for reliable job queuing with fallback to federation_delivery_queue.';

-- ============================================
-- STEP 5: Trigger Functions for Each Content Type
-- ============================================

-- Post federation trigger
CREATE OR REPLACE FUNCTION public.trigger_queue_post_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Skip if not local or not public/unlisted
    IF NEW.is_local = false OR NEW.visibility NOT IN ('public', 'unlisted') THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;
    
    -- For INSERT: always queue
    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-post',
            jsonb_build_object(
                'type', 'create',
                'post_id', NEW.id,
                'author_id', NEW.author_id,
                'visibility', NEW.visibility,
                'created_at', NEW.created_at
            ),
            5, 5, 3600
        );
        RETURN NEW;
    END IF;
    
    -- For UPDATE: only queue for MEANINGFUL changes, not federation_status changes
    IF TG_OP = 'UPDATE' THEN
        -- Skip if this is just a federation_status update (prevents infinite loop!)
        IF OLD.federation_status IS DISTINCT FROM NEW.federation_status 
           AND OLD.content = NEW.content 
           AND OLD.is_deleted = NEW.is_deleted 
           AND OLD.is_pinned = NEW.is_pinned THEN
            RETURN NEW;  -- Don't re-queue
        END IF;
        
        -- Only queue for actual content/state changes
        IF NEW.is_deleted = true AND OLD.is_deleted = false THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'delete', 'post_id', NEW.id, 'author_id', NEW.author_id),
                10, 5, 3600
            );
        ELSIF NEW.is_pinned IS DISTINCT FROM OLD.is_pinned THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'pin_change', 'post_id', NEW.id, 'author_id', NEW.author_id, 'is_pinned', NEW.is_pinned),
                5, 5, 3600
            );
        ELSIF NEW.content IS DISTINCT FROM OLD.content THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'update', 'post_id', NEW.id, 'author_id', NEW.author_id, 'visibility', NEW.visibility),
                5, 5, 3600
            );
        END IF;
        -- If none of the above, don't change federation_status or queue
    END IF;
    
    RETURN NEW;
END;
$$;

-- Post interaction (reaction/favorite) federation trigger
CREATE OR REPLACE FUNCTION public.trigger_queue_interaction_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Update federation status to queued
        NEW.federation_status := 'queued';
        
        -- Queue the federation job
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'create',
                'interaction_id', NEW.id,
                'interaction_type', NEW.interaction_type,
                'post_id', NEW.post_id,
                'user_id', NEW.user_id,
                'emoji_id', NEW.emoji_id,
                'custom_emoji_content', NEW.custom_emoji_content
            ),
            5,
            3,
            1800 -- expire in 30 mins
        );
    ELSIF TG_OP = 'DELETE' THEN
        -- Queue undo for the reaction
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'delete',
                'interaction_id', OLD.id,
                'interaction_type', OLD.interaction_type,
                'post_id', OLD.post_id,
                'user_id', OLD.user_id
            ),
            5,
            3,
            1800
        );
        RETURN OLD;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Follow federation trigger
CREATE OR REPLACE FUNCTION public.trigger_queue_follow_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_follower_is_local BOOLEAN;
BEGIN
    -- Check if follower is local
    SELECT is_local INTO v_follower_is_local
    FROM public.profiles
    WHERE id = NEW.follower_id;
    
    -- Only federate if follower is local (outgoing follow)
    IF v_follower_is_local = true THEN
        IF TG_OP = 'INSERT' THEN
            NEW.federation_status := 'queued';
            
            PERFORM public.queue_federation_job(
                'federate-follow',
                jsonb_build_object(
                    'type', 'create',
                    'follow_id', NEW.id,
                    'follower_id', NEW.follower_id,
                    'following_id', NEW.following_id,
                    'status', NEW.status
                ),
                5,
                5,
                3600
            );
        ELSIF TG_OP = 'DELETE' THEN
            PERFORM public.queue_federation_job(
                'federate-follow',
                jsonb_build_object(
                    'type', 'delete',
                    'follow_id', OLD.id,
                    'follower_id', OLD.follower_id,
                    'following_id', OLD.following_id
                ),
                5,
                5,
                3600
            );
            RETURN OLD;
        END IF;
    ELSE
        NEW.federation_status := 'skipped';
    END IF;
    
    RETURN NEW;
END;
$$;

-- DM message federation trigger
CREATE OR REPLACE FUNCTION public.trigger_queue_dm_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Only process DM messages (conversation_id is set)
    IF NEW.conversation_id IS NOT NULL AND NOT (NEW.metadata ? 'federated') THEN
        NEW.federation_status := 'queued';
        
        PERFORM public.queue_federation_job(
            'federate-dm',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'conversation_id', NEW.conversation_id,
                'user_id', NEW.user_id,
                'created_at', NEW.created_at
            ),
            5,
            5,
            3600
        );
    ELSE
        NEW.federation_status := 'skipped';
    END IF;
    
    RETURN NEW;
END;
$$;

-- Message reaction federation trigger
CREATE OR REPLACE FUNCTION public.trigger_queue_message_reaction_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        
        PERFORM public.queue_federation_job(
            'federate-message-reaction',
            jsonb_build_object(
                'type', 'create',
                'reaction_id', NEW.id,
                'message_id', NEW.message_id,
                'user_id', NEW.user_id,
                'emoji', NEW.emoji
            ),
            5,
            3,
            1800
        );
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.queue_federation_job(
            'federate-message-reaction',
            jsonb_build_object(
                'type', 'delete',
                'reaction_id', OLD.id,
                'message_id', OLD.message_id,
                'user_id', OLD.user_id,
                'emoji', OLD.emoji
            ),
            5,
            3,
            1800
        );
        RETURN OLD;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Block federation trigger
CREATE OR REPLACE FUNCTION public.trigger_queue_block_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        
        PERFORM public.queue_federation_job(
            'federate-block',
            jsonb_build_object(
                'type', 'create',
                'block_id', NEW.id,
                'blocker_id', NEW.blocker_id,
                'blocked_id', NEW.blocked_id
            ),
            3,
            3,
            1800
        );
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.queue_federation_job(
            'federate-block',
            jsonb_build_object(
                'type', 'delete',
                'block_id', OLD.id,
                'blocker_id', OLD.blocker_id,
                'blocked_id', OLD.blocked_id
            ),
            3,
            3,
            1800
        );
        RETURN OLD;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Report federation trigger
CREATE OR REPLACE FUNCTION public.trigger_queue_report_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    NEW.federation_status := 'queued';
    
    PERFORM public.queue_federation_job(
        'federate-report',
        jsonb_build_object(
            'type', 'create',
            'report_id', NEW.id,
            'reporter_id', NEW.reporter_id,
            'reported_user_id', NEW.reported_user_id,
            'reported_post_id', NEW.reported_post_id,
            'reason', NEW.reason
        ),
        10, -- High priority for reports
        5,
        7200 -- 2 hour expiry
    );
    
    RETURN NEW;
END;
$$;

-- Profile update federation trigger (for local users)
CREATE OR REPLACE FUNCTION public.trigger_queue_profile_federation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Only federate local user profile updates
    IF NEW.is_local = true THEN
        PERFORM public.queue_federation_job(
            'federate-profile',
            jsonb_build_object(
                'type', 'update',
                'profile_id', NEW.id,
                'username', NEW.username,
                'display_name', NEW.display_name,
                'bio', NEW.bio,
                'avatar_url', NEW.avatar_url,
                'header_url', NEW.header_url
            ),
            3, -- Lower priority than posts
            5,
            3600
        );
    END IF;
    
    RETURN NEW;
END;
$$;

-- ============================================
-- STEP 6: Create Triggers (Disabled by Default)
-- Enable these after pg-boss is set up
-- ============================================

-- Drop existing triggers if they exist (for clean re-creation)
DROP TRIGGER IF EXISTS trigger_federate_post ON public.posts;
DROP TRIGGER IF EXISTS trigger_federate_post_interaction ON public.post_interactions;
DROP TRIGGER IF EXISTS trigger_federate_post_interaction_delete ON public.post_interactions;
DROP TRIGGER IF EXISTS trigger_federate_follow ON public.follows;
DROP TRIGGER IF EXISTS trigger_federate_follow_delete ON public.follows;
DROP TRIGGER IF EXISTS trigger_federate_dm ON public.messages;
DROP TRIGGER IF EXISTS trigger_federate_message_reaction ON public.reactions;
DROP TRIGGER IF EXISTS trigger_federate_message_reaction_delete ON public.reactions;
DROP TRIGGER IF EXISTS trigger_federate_block ON public.user_blocks;
DROP TRIGGER IF EXISTS trigger_federate_block_delete ON public.user_blocks;
DROP TRIGGER IF EXISTS trigger_federate_report ON public.reports;
DROP TRIGGER IF EXISTS trigger_federate_profile ON public.profiles;

-- Create triggers (DISABLED - enable after pg-boss setup)
-- To enable: ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;

CREATE TRIGGER trigger_federate_post
    BEFORE INSERT OR UPDATE ON public.posts
    FOR EACH ROW
    WHEN (NEW.is_local = true)
    EXECUTE FUNCTION public.trigger_queue_post_federation();
-- Disable by default
ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;

CREATE TRIGGER trigger_federate_post_interaction
    BEFORE INSERT ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_interaction_federation();
ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;

-- DELETE trigger needs AFTER not BEFORE
CREATE TRIGGER trigger_federate_post_interaction_delete
    AFTER DELETE ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_interaction_federation();
ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;

CREATE TRIGGER trigger_federate_follow
    BEFORE INSERT ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_follow_federation();
ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;

CREATE TRIGGER trigger_federate_follow_delete
    AFTER DELETE ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_follow_federation();
ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;

CREATE TRIGGER trigger_federate_dm
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.conversation_id IS NOT NULL)
    EXECUTE FUNCTION public.trigger_queue_dm_federation();
ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;

CREATE TRIGGER trigger_federate_message_reaction
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_message_reaction_federation();
ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;

CREATE TRIGGER trigger_federate_message_reaction_delete
    AFTER DELETE ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_message_reaction_federation();
ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;

CREATE TRIGGER trigger_federate_block
    BEFORE INSERT ON public.user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_block_federation();
ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;

CREATE TRIGGER trigger_federate_block_delete
    AFTER DELETE ON public.user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_block_federation();
ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;

CREATE TRIGGER trigger_federate_report
    BEFORE INSERT ON public.reports
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_report_federation();
ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;

CREATE TRIGGER trigger_federate_profile
    AFTER UPDATE ON public.profiles
    FOR EACH ROW
    WHEN (NEW.is_local = true)
    EXECUTE FUNCTION public.trigger_queue_profile_federation();
ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;

-- ============================================
-- STEP 7: Helper Functions for Migration
-- ============================================

-- Function to enable all federation triggers (call after pg-boss setup)
CREATE OR REPLACE FUNCTION public.enable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    
    RAISE NOTICE '✅ All federation triggers enabled';
END;
$$;

-- Function to disable all federation triggers (for maintenance)
CREATE OR REPLACE FUNCTION public.disable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    
    RAISE NOTICE '⚠️ All federation triggers disabled';
END;
$$;

-- ============================================
-- USAGE INSTRUCTIONS
-- ============================================
-- 
-- 1. Run this SQL migration to add federation_status columns and create triggers
-- 2. Install pg-boss in federation-backend: npm install pg-boss
-- 3. Start federation-backend with pg-boss (it will create pgboss.* tables)
-- 4. Enable triggers by running: SELECT public.enable_federation_triggers();
-- 5. The old DatabaseListener Supabase Realtime code can then be removed
--
-- To disable triggers for maintenance: SELECT public.disable_federation_triggers();
-- ============================================

COMMENT ON FUNCTION public.enable_federation_triggers IS 'Enable all federation job queue triggers. Call this after pg-boss is set up.';
COMMENT ON FUNCTION public.disable_federation_triggers IS 'Disable all federation job queue triggers. Use for maintenance.';

