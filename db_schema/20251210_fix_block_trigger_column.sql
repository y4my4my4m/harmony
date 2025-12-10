-- =============================================================================
-- Migration: Fix user_blocks trigger column name mismatch
-- Date: 2025-12-10
-- Description: The trigger function references 'blocked_id' but the actual 
--              column in user_blocks table is 'blocked_user_id'
-- =============================================================================

-- Drop the old triggers first
DROP TRIGGER IF EXISTS trigger_federate_block ON public.user_blocks;
DROP TRIGGER IF EXISTS trigger_federate_block_delete ON public.user_blocks;

-- Recreate the function with correct column name
CREATE OR REPLACE FUNCTION public.trigger_queue_block_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        
        -- Queue federation job with correct column name (blocked_user_id, NOT blocked_id)
        PERFORM public.queue_federation_job(
            'federate-block',
            jsonb_build_object(
                'type', 'create',
                'block_id', NEW.id,
                'blocker_id', NEW.blocker_id,
                'blocked_user_id', NEW.blocked_user_id
            ),
            3,
            3,
            1800
        );
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.queue_federation_job(
            'federate-block',
            jsonb_build_object(
                'type', 'delete',
                'block_id', OLD.id,
                'blocker_id', OLD.blocker_id,
                'blocked_user_id', OLD.blocked_user_id
            ),
            3,
            3,
            1800
        );
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

-- Recreate the triggers
CREATE TRIGGER trigger_federate_block
    BEFORE INSERT ON public.user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_block_federation();

CREATE TRIGGER trigger_federate_block_delete
    AFTER DELETE ON public.user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_block_federation();

-- Notify completion
DO $$
BEGIN
    RAISE NOTICE 'Fixed user_blocks trigger to use correct column name (blocked_user_id)';
END $$;

