-- Update Federation Delivery Worker to use HTTP Signatures
-- This file shows how to modify the existing delivery worker to use the new create_http_signature function

-- First, ensure the delivery worker has access to activity metadata
ALTER TABLE federation_delivery_queue 
ADD COLUMN IF NOT EXISTS actor_username TEXT,
ADD COLUMN IF NOT EXISTS actor_domain TEXT;

-- Drop the old function to avoid signature conflicts
DROP FUNCTION IF EXISTS queue_activity_for_federation(uuid, text[]);

-- Update the queue function to include actor info
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
    activity_record RECORD;
    actor_username TEXT;
    actor_domain TEXT;
BEGIN
    -- Get activity metadata
    SELECT 
        aa.actor_ap_id,
        aa.origin_domain
    INTO activity_record
    FROM ap_activities aa
    WHERE aa.id = p_activity_id;
    
    -- Extract username from actor AP ID
    actor_username := regexp_replace(activity_record.actor_ap_id, '^https?://[^/]+/users/([^/#]+).*$', '\1');
    actor_domain := activity_record.origin_domain;
    
    -- Set timing for delivery attempt
    next_attempt := CASE 
        WHEN p_immediate THEN now()
        ELSE now() + interval '1 minute'
    END;
    
    FOREACH domain IN ARRAY p_target_domains LOOP
        inbox_url := 'https://' || domain || '/inbox';
        
        INSERT INTO federation_delivery_queue (
            activity_id,
            target_domain,
            target_inbox_url,
            actor_username,
            actor_domain,
            status,
            priority,
            attempts,
            next_attempt_at
        ) VALUES (
            p_activity_id,
            domain,
            inbox_url,
            actor_username,
            actor_domain,
            'pending',
            p_priority,
            0,
            next_attempt
        );
    END LOOP;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION queue_activity_for_federation(uuid, text[], integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION queue_activity_for_federation(uuid, text[], integer, boolean) TO service_role;

-- Comments
COMMENT ON FUNCTION queue_activity_for_federation IS 'Enhanced queue function that includes actor metadata for HTTP signature generation during delivery';
