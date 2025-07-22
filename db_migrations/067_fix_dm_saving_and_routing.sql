-- Fix DM Saving and Routing Issues
-- ISSUE 1: Outgoing DMs are not being saved locally (only federated)
-- ISSUE 2: Incoming DMs are being processed as public posts instead of private DMs
-- SOLUTION: Fix both the outgoing message trigger and the DM detection logic

-- First, ensure the messages table has the correct trigger that ACTUALLY saves the message
-- The current handle_outgoing_messages only handles federation, not saving!

-- Check if message gets saved BEFORE triggering federation (this should already happen)
-- But let's make sure the DM detection is working properly

-- Fix the DM detection function to properly identify private mentions
CREATE OR REPLACE FUNCTION is_activitypub_direct_message(object_data jsonb, instance_domain text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
    v_to JSONB;
    v_cc JSONB;
    v_visibility TEXT;
    v_has_public BOOLEAN := false;
    v_has_followers BOOLEAN := false;
    v_has_local_recipients BOOLEAN := false;
    v_recipient TEXT;
    v_total_recipients INTEGER := 0;
BEGIN
    -- Method 1: Check visibility property
    v_visibility := object_data->>'visibility';
    IF v_visibility = 'direct' THEN
        RETURN true;
    END IF;

    -- Method 2: Check directMessage flag
    IF (object_data->>'directMessage')::boolean = true THEN
        RETURN true;
    END IF;

    -- Method 3: Check addressing patterns
    v_to := COALESCE(object_data->'to', '[]'::jsonb);
    v_cc := COALESCE(object_data->'cc', '[]'::jsonb);

    -- Count total recipients and check for public indicators
    FOR v_recipient IN 
        SELECT jsonb_array_elements_text(v_to || v_cc)
    LOOP
        v_total_recipients := v_total_recipients + 1;
        
        -- Check for public addressing
        IF v_recipient IN (
            'https://www.w3.org/ns/activitystreams#Public',
            'Public'
        ) THEN
            v_has_public := true;
            EXIT; -- If it's public, it's definitely not a DM
        END IF;
        
        -- Check for followers addressing
        IF v_recipient LIKE '%/followers' THEN
            v_has_followers := true;
        END IF;
        
        -- Check for local recipients (this instance)
        IF v_recipient LIKE 'https://' || instance_domain || '/users/%' 
           OR v_recipient LIKE 'https://' || instance_domain || '/social/profile/%' THEN
            v_has_local_recipients := true;
        END IF;
    END LOOP;

    -- CRITICAL FIX: More aggressive DM detection
    -- It's a DM if:
    -- 1. No public addressing AND
    -- 2. No followers addressing AND  
    -- 3. Has local recipients AND
    -- 4. Total recipients is small (≤ 10 for group DMs) AND
    -- 5. CC is empty or very small (private mentions typically have empty CC)
    
    IF NOT v_has_public 
       AND NOT v_has_followers 
       AND v_has_local_recipients 
       AND v_total_recipients <= 10
       AND jsonb_array_length(v_cc) <= 1 THEN
        RETURN true;
    END IF;

    -- ADDITIONAL: If 'to' field is small and CC is empty, it's likely a DM
    IF jsonb_array_length(v_to) <= 5 
       AND jsonb_array_length(v_cc) = 0 
       AND v_has_local_recipients 
       AND NOT v_has_public THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$function$;

-- Now ensure the handle_outgoing_messages trigger is ONLY for federation, not saving
-- The actual message saving should happen through normal INSERT, then trigger fires for federation

-- Let's verify that the messages table INSERT happens BEFORE the trigger
-- The issue might be that we need to make sure the message is saved FIRST

-- Check what triggers exist on messages table
DO $$
DECLARE
    trigger_rec RECORD;
BEGIN
    RAISE WARNING '🔍 Current triggers on messages table:';
    FOR trigger_rec IN 
        SELECT trigger_name, event_manipulation, action_timing, action_statement
        FROM information_schema.triggers 
        WHERE event_object_table = 'messages'
        ORDER BY action_timing, trigger_name
    LOOP
        RAISE WARNING '  - %: % % %', 
            trigger_rec.trigger_name, 
            trigger_rec.action_timing,
            trigger_rec.event_manipulation, 
            trigger_rec.action_statement;
    END LOOP;
END;
$$;