-- Migration 042: Fix Inbox Processing Chain
-- Issue: Activities get stuck in 'received' status and never get processed

BEGIN;

-- Function to manually process stuck activities
CREATE OR REPLACE FUNCTION public.process_stuck_activities()
RETURNS TABLE(processed_count integer, failed_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    stuck_activity RECORD;
    processed_count INTEGER := 0;
    failed_count INTEGER := 0;
BEGIN
    -- Process activities stuck in 'received' status for more than 5 minutes
    FOR stuck_activity IN 
        SELECT id, ap_id, ap_type, status
        FROM ap_activities 
        WHERE status = 'received'
          AND is_local = false
          AND created_at < NOW() - INTERVAL '5 minutes'
        ORDER BY created_at
    LOOP
        BEGIN
            -- Try to update to processing status (this should trigger the processing)
            UPDATE ap_activities 
            SET status = 'processing', updated_at = NOW()
            WHERE id = stuck_activity.id;
            
            processed_count := processed_count + 1;
            RAISE NOTICE 'Triggered processing for stuck activity: %', stuck_activity.ap_id;
            
        EXCEPTION WHEN OTHERS THEN
            failed_count := failed_count + 1;
            RAISE WARNING 'Failed to process stuck activity %: %', stuck_activity.ap_id, SQLERRM;
        END;
    END LOOP;
    
    RETURN QUERY SELECT processed_count, failed_count;
END;
$function$;

-- Function to check inbox processing health
CREATE OR REPLACE FUNCTION public.check_inbox_health()
RETURNS TABLE(
    recent_activities integer,
    stuck_in_received integer,
    processing integer,
    processed integer,
    failed integer
)
LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*)::integer as recent_activities,
        COUNT(CASE WHEN status = 'received' THEN 1 END)::integer as stuck_in_received,
        COUNT(CASE WHEN status = 'processing' THEN 1 END)::integer as processing,
        COUNT(CASE WHEN status = 'processed' THEN 1 END)::integer as processed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END)::integer as failed
    FROM ap_activities 
    WHERE is_local = false
      AND created_at > NOW() - INTERVAL '1 hour';
END;
$function$;

-- Verify the processing trigger exists and is enabled
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        WHERE c.relname = 'ap_activities' 
        AND t.tgname = 'unified_activitypub_processing_trigger'
        AND t.tgenabled = 'O'  -- enabled
    ) THEN
        RAISE EXCEPTION 'Missing or disabled processing trigger on ap_activities table!';
    END IF;
    
    RAISE NOTICE '✅ Processing trigger verified on ap_activities table';
END $$;

COMMIT;