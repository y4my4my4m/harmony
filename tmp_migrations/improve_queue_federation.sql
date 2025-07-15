-- Improved queue_activity_for_federation function
-- This replaces the existing one with better defaults and DM priority support

CREATE OR REPLACE FUNCTION queue_activity_for_federation(
    p_activity_id uuid, 
    p_target_domains text[],
    p_priority integer DEFAULT 5,
    p_immediate boolean DEFAULT true
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    domain text;
    inbox_url text;
    next_attempt timestamptz;
BEGIN
    -- Set timing for delivery attempt
    next_attempt := CASE 
        WHEN p_immediate THEN now()
        ELSE now() + interval '1 minute'  -- Small delay for non-immediate
    END;
    
    FOREACH domain IN ARRAY p_target_domains LOOP
        -- Get inbox URL for domain (simplified - in production, you'd fetch this)
        inbox_url := 'https://' || domain || '/inbox';
        
        INSERT INTO federation_delivery_queue (
            activity_id,
            target_domain,
            target_inbox_url,
            status,
            priority,
            attempts,
            next_attempt_at
        ) VALUES (
            p_activity_id,
            domain,
            inbox_url,
            'pending',
            p_priority,
            0,  -- Starting with 0 attempts
            next_attempt
        );
    END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION queue_activity_for_federation(uuid, text[], integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION queue_activity_for_federation(uuid, text[], integer, boolean) TO service_role;
