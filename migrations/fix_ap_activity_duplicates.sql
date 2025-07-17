-- Migration to handle ActivityPub activity deduplication
-- This provides idempotent activity insertion at the database level

-- Function to safely insert or update ActivityPub activities
CREATE OR REPLACE FUNCTION public.upsert_ap_activity(
    p_ap_id TEXT,
    p_ap_type TEXT,
    p_actor_ap_id TEXT,
    p_activity_data JSONB,
    p_origin_domain TEXT DEFAULT NULL,
    p_to_addresses TEXT[] DEFAULT '{}',
    p_cc_addresses TEXT[] DEFAULT '{}',
    p_bto_addresses TEXT[] DEFAULT '{}',
    p_bcc_addresses TEXT[] DEFAULT '{}',
    p_is_local BOOLEAN DEFAULT FALSE
) RETURNS TABLE(activity_id UUID, was_updated BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_activity_id UUID;
    v_was_updated BOOLEAN := FALSE;
    v_existing_status TEXT;
BEGIN
    -- Check if activity already exists
    SELECT id, status INTO v_activity_id, v_existing_status
    FROM ap_activities 
    WHERE ap_id = p_ap_id;
    
    IF v_activity_id IS NOT NULL THEN
        -- Activity exists, check its status
        CASE v_existing_status
            WHEN 'completed', 'processed' THEN
                -- Already processed successfully, return idempotent success
                RAISE NOTICE 'Activity % already processed, returning existing ID', p_ap_id;
                v_was_updated := FALSE;
            WHEN 'failed', 'pending' THEN
                -- Failed or pending, update with fresh data for retry
                UPDATE ap_activities 
                SET 
                    activity_data = p_activity_data,
                    status = 'received',
                    to_addresses = p_to_addresses,
                    cc_addresses = p_cc_addresses,
                    bto_addresses = p_bto_addresses,
                    bcc_addresses = p_bcc_addresses,
                    updated_at = NOW(),
                    error_message = NULL,
                    next_attempt_at = NULL,
                    attempts = 0
                WHERE ap_id = p_ap_id;
                
                RAISE NOTICE 'Updated existing activity % for retry', p_ap_id;
                v_was_updated := TRUE;
            WHEN 'processing', 'received' THEN
                -- Currently being processed or just received, update data but keep status
                UPDATE ap_activities 
                SET 
                    activity_data = p_activity_data,
                    to_addresses = p_to_addresses,
                    cc_addresses = p_cc_addresses,
                    bto_addresses = p_bto_addresses,
                    bcc_addresses = p_bcc_addresses,
                    updated_at = NOW()
                WHERE ap_id = p_ap_id;
                
                RAISE NOTICE 'Updated activity data for currently processing activity %', p_ap_id;
                v_was_updated := TRUE;
        END CASE;
    ELSE
        -- Activity doesn't exist, insert new one
        INSERT INTO ap_activities (
            ap_id,
            ap_type,
            actor_ap_id,
            activity_data,
            origin_domain,
            status,
            is_local,
            to_addresses,
            cc_addresses,
            bto_addresses,
            bcc_addresses
        ) VALUES (
            p_ap_id,
            p_ap_type,
            p_actor_ap_id,
            p_activity_data,
            p_origin_domain,
            'received',
            p_is_local,
            p_to_addresses,
            p_cc_addresses,
            p_bto_addresses,
            p_bcc_addresses
        )
        RETURNING id INTO v_activity_id;
        
        RAISE NOTICE 'Inserted new activity %', p_ap_id;
        v_was_updated := FALSE;
    END IF;
    
    RETURN QUERY SELECT v_activity_id, v_was_updated;
END;
$$;

COMMENT ON FUNCTION public.upsert_ap_activity IS 'Safely inserts or updates ActivityPub activities with idempotent behavior. Returns the activity ID and whether it was updated.';

-- Function to handle activity insertion with proper conflict resolution
CREATE OR REPLACE FUNCTION public.insert_ap_activity_safe(
    p_ap_id TEXT,
    p_ap_type TEXT,
    p_actor_ap_id TEXT,
    p_activity_data JSONB,
    p_origin_domain TEXT DEFAULT NULL,
    p_to_addresses TEXT[] DEFAULT '{}',
    p_cc_addresses TEXT[] DEFAULT '{}',
    p_is_local BOOLEAN DEFAULT FALSE
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    result_record RECORD;
BEGIN
    SELECT * INTO result_record 
    FROM upsert_ap_activity(
        p_ap_id,
        p_ap_type,
        p_actor_ap_id,
        p_activity_data,
        p_origin_domain,
        p_to_addresses,
        p_cc_addresses,
        '{}', -- bto_addresses
        '{}', -- bcc_addresses
        p_is_local
    );
    
    RETURN result_record.activity_id;
END;
$$;

COMMENT ON FUNCTION public.insert_ap_activity_safe IS 'Simplified wrapper for upsert_ap_activity that returns just the activity ID.';
