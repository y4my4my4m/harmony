-- ============================================================================
-- FUNCTION: queue_activity_for_federation
-- 
-- Used by database triggers that need to queue activities for federation.
-- The federation-backend's DeliveryQueue.processQueue() picks up pending items.
-- 
-- NOTE: DM federation is now handled directly by the backend (DatabaseListener)
-- This function is primarily used for:
--   - Follow Accept activities (send_accept_activity_for_follow)
--   - Profile updates
-- ============================================================================

-- First, ensure we have a unique constraint for ON CONFLICT to work
-- This prevents duplicate deliveries to the same domain for the same activity
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'federation_delivery_queue_activity_domain_unique'
    ) THEN
        ALTER TABLE public.federation_delivery_queue
        ADD CONSTRAINT federation_delivery_queue_activity_domain_unique 
        UNIQUE (activity_id, target_domain);
    END IF;
EXCEPTION
    WHEN duplicate_object THEN
        NULL; -- Constraint already exists
END $$;

CREATE OR REPLACE FUNCTION public.queue_activity_for_federation(
    p_activity_id UUID,
    p_target_domains TEXT[],
    p_priority INTEGER DEFAULT 5,
    p_immediate BOOLEAN DEFAULT false
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_domain TEXT;
    v_activity RECORD;
    v_inbox_url TEXT;
    v_target_profile RECORD;
BEGIN
    -- Get the activity data
    SELECT * INTO v_activity
    FROM ap_activities
    WHERE id = p_activity_id;
    
    IF NOT FOUND THEN
        RAISE WARNING 'Activity not found for federation: %', p_activity_id;
        RETURN;
    END IF;
    
    -- Queue delivery for each target domain
    FOREACH v_domain IN ARRAY p_target_domains
    LOOP
        -- Try to find inbox URL for this domain
        -- First check federated_instances for shared inbox
        SELECT shared_inbox_url INTO v_inbox_url
        FROM public.federated_instances
        WHERE domain = v_domain
        AND shared_inbox_url IS NOT NULL
        LIMIT 1;
        
        -- If not found, try to find a user from this domain with an inbox
        IF v_inbox_url IS NULL THEN
            SELECT inbox_url INTO v_inbox_url
            FROM public.profiles
            WHERE domain = v_domain
            AND inbox_url IS NOT NULL
            LIMIT 1;
        END IF;
        
        -- If still no inbox, construct default shared inbox URL
        IF v_inbox_url IS NULL THEN
            v_inbox_url := 'https://' || v_domain || '/inbox';
        END IF;
        
        -- Insert into federation delivery queue
        -- Column names match what the backend's DeliveryQueue expects
        INSERT INTO federation_delivery_queue (
            activity_id,
            target_inbox_url,
            target_domain,
            activity_data,
            sender_id,
            status,
            priority,
            created_at,
            next_attempt_at,
            attempts
        ) VALUES (
            p_activity_id,
            v_inbox_url,
            v_domain,
            v_activity.activity_data,
            v_activity.actor_id,  -- sender_id from ap_activities
            'pending',
            p_priority,
            NOW(),
            CASE WHEN p_immediate THEN NOW() ELSE NOW() + INTERVAL '5 seconds' END,
            0
        )
        ON CONFLICT (activity_id, target_domain) DO UPDATE SET
            status = 'pending',
            next_attempt_at = CASE WHEN p_immediate THEN NOW() ELSE NOW() + INTERVAL '5 seconds' END,
            updated_at = NOW();
            
        RAISE NOTICE '📬 Queued activity % for delivery to %', p_activity_id, v_domain;
    END LOOP;
    
    -- Update the activity status
    UPDATE ap_activities
    SET status = 'queued'
    WHERE id = p_activity_id
    AND status = 'pending';
    
END;
$$;

COMMENT ON FUNCTION public.queue_activity_for_federation(UUID, TEXT[], INTEGER, BOOLEAN) IS 
'Queues an ActivityPub activity for federation delivery to specified domains.
Works with the backend DeliveryQueue.processQueue() which picks up pending items.

NOTE: DM federation is now handled by the backend directly (not through this queue).

Called by:
  - send_accept_activity_for_follow function
  - handle_profile_update_federation trigger

Parameters:
  - p_activity_id: UUID of the activity in ap_activities table
  - p_target_domains: Array of domain names to deliver to
  - p_priority: Delivery priority (1-10, higher = more urgent)
  - p_immediate: If true, queue for immediate delivery (next_attempt_at = NOW())';

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.queue_activity_for_federation(UUID, TEXT[], INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.queue_activity_for_federation(UUID, TEXT[], INTEGER, BOOLEAN) TO service_role;

