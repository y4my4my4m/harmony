-- Federation Delivery Worker as Database Function
-- More efficient than Edge Function for background processing

CREATE OR REPLACE FUNCTION process_federation_delivery_queue()
RETURNS TABLE(
    processed_count INTEGER,
    successful_count INTEGER,
    failed_count INTEGER,
    details JSONB
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    delivery_record RECORD;
    delivery_count INTEGER := 0;
    success_count INTEGER := 0;
    fail_count INTEGER := 0;
    result_details JSONB := '[]'::JSONB;
    delivery_result JSONB;
    instance_url TEXT := COALESCE(current_setting('app.instance_url', true), 'har.mony.lol');
BEGIN
    -- Log start of processing
    RAISE NOTICE 'Starting federation delivery queue processing...';
    
    -- Process pending deliveries with exponential backoff
    FOR delivery_record IN 
        SELECT * FROM federation_delivery_queue
        WHERE status = 'pending'
        AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        LIMIT 50  -- Process in batches to avoid long-running transactions
    LOOP
        delivery_count := delivery_count + 1;
        
        BEGIN
            -- Attempt HTTP delivery
            delivery_result := net.http_post(
                delivery_record.target_inbox,
                delivery_record.activity_data::TEXT,
                headers => FORMAT(
                    '{"Content-Type": "application/activity+json", "User-Agent": "Harmony/%s", "Host": "%s", "Date": "%s"}',
                    '1.0.0',
                    instance_url,
                    TO_CHAR(NOW() AT TIME ZONE 'UTC', 'Dy, DD Mon YYYY HH24:MI:SS "GMT"')
                )::JSONB
            );
            
            -- Check if delivery was successful (2xx status codes)
            IF (delivery_result->>'status_code')::INTEGER BETWEEN 200 AND 299 THEN
                -- Mark as delivered
                UPDATE federation_delivery_queue 
                SET 
                    status = 'delivered',
                    delivered_at = NOW(),
                    delivery_duration_ms = EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000,
                    last_response = delivery_result
                WHERE id = delivery_record.id;
                
                success_count := success_count + 1;
                
                -- Log successful delivery
                RAISE NOTICE 'Successfully delivered activity % to %', 
                    delivery_record.activity_id, delivery_record.target_inbox;
                    
            ELSE
                -- Handle failed delivery with exponential backoff
                DECLARE
                    new_attempt_count INTEGER := delivery_record.attempt_count + 1;
                    backoff_minutes INTEGER;
                    max_attempts INTEGER := 5;
                BEGIN
                    -- Calculate exponential backoff: 2^attempt_count minutes
                    backoff_minutes := POWER(2, new_attempt_count);
                    
                    IF new_attempt_count >= max_attempts THEN
                        -- Mark as permanently failed
                        UPDATE federation_delivery_queue 
                        SET 
                            status = 'failed',
                            attempt_count = new_attempt_count,
                            last_error = FORMAT('Max attempts reached. Last response: %s', delivery_result),
                            last_response = delivery_result
                        WHERE id = delivery_record.id;
                        
                        fail_count := fail_count + 1;
                        
                        RAISE NOTICE 'Permanently failed delivery of activity % to % after % attempts', 
                            delivery_record.activity_id, delivery_record.target_inbox, max_attempts;
                    ELSE
                        -- Schedule retry with exponential backoff
                        UPDATE federation_delivery_queue 
                        SET 
                            attempt_count = new_attempt_count,
                            next_attempt_at = NOW() + (backoff_minutes || ' minutes')::INTERVAL,
                            last_error = FORMAT('Attempt %s failed. Response: %s', new_attempt_count, delivery_result),
                            last_response = delivery_result
                        WHERE id = delivery_record.id;
                        
                        RAISE NOTICE 'Scheduled retry for activity % to % in % minutes (attempt %)', 
                            delivery_record.activity_id, delivery_record.target_inbox, backoff_minutes, new_attempt_count;
                    END IF;
                END;
            END IF;
            
            -- Add to result details
            result_details := result_details || JSONB_BUILD_OBJECT(
                'delivery_id', delivery_record.id,
                'activity_id', delivery_record.activity_id,
                'target_inbox', delivery_record.target_inbox,
                'status', CASE 
                    WHEN (delivery_result->>'status_code')::INTEGER BETWEEN 200 AND 299 THEN 'delivered'
                    WHEN delivery_record.attempt_count + 1 >= 5 THEN 'failed'
                    ELSE 'retrying'
                END,
                'response_status', delivery_result->>'status_code'
            );
            
        EXCEPTION WHEN OTHERS THEN
            -- Handle any other errors (network issues, etc.)
            DECLARE
                new_attempt_count INTEGER := delivery_record.attempt_count + 1;
                backoff_minutes INTEGER;
                max_attempts INTEGER := 5;
            BEGIN
                backoff_minutes := POWER(2, new_attempt_count);
                
                IF new_attempt_count >= max_attempts THEN
                    UPDATE federation_delivery_queue 
                    SET 
                        status = 'failed',
                        attempt_count = new_attempt_count,
                        last_error = FORMAT('Exception after %s attempts: %s', max_attempts, SQLERRM)
                    WHERE id = delivery_record.id;
                    
                    fail_count := fail_count + 1;
                ELSE
                    UPDATE federation_delivery_queue 
                    SET 
                        attempt_count = new_attempt_count,
                        next_attempt_at = NOW() + (backoff_minutes || ' minutes')::INTERVAL,
                        last_error = FORMAT('Attempt %s exception: %s', new_attempt_count, SQLERRM)
                    WHERE id = delivery_record.id;
                END IF;
                
                RAISE NOTICE 'Exception processing delivery %: %', delivery_record.id, SQLERRM;
            END;
        END;
    END LOOP;
    
    -- Return summary
    RAISE NOTICE 'Completed processing: % total, % successful, % failed', 
        delivery_count, success_count, fail_count;
    
    RETURN QUERY SELECT 
        delivery_count,
        success_count,
        fail_count,
        result_details;
END;
$$;

-- Grant execute permission to service role
GRANT EXECUTE ON FUNCTION process_federation_delivery_queue() TO service_role;

-- Create a simpler cleanup function
CREATE OR REPLACE FUNCTION cleanup_federation_delivery_queue()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete delivered records older than 7 days
    DELETE FROM federation_delivery_queue 
    WHERE status = 'delivered' 
    AND delivered_at < NOW() - INTERVAL '7 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RAISE NOTICE 'Cleaned up % old delivery records', deleted_count;
    
    RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_federation_delivery_queue() TO service_role;

-- Create federation stats collection function
CREATE OR REPLACE FUNCTION collect_federation_stats()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO federation_delivery_stats (
        period_start,
        period_end,
        total_deliveries,
        successful_deliveries,
        failed_deliveries,
        avg_delivery_time_ms
    )
    SELECT 
        DATE_TRUNC('hour', NOW() - INTERVAL '6 hours') as period_start,
        DATE_TRUNC('hour', NOW()) as period_end,
        COUNT(*) as total_deliveries,
        COUNT(*) FILTER (WHERE status = 'delivered') as successful_deliveries,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_deliveries,
        AVG(delivery_duration_ms) as avg_delivery_time_ms
    FROM federation_delivery_queue
    WHERE created_at >= NOW() - INTERVAL '6 hours'
    AND created_at < NOW()
    AND status IN ('delivered', 'failed');
    
    RAISE NOTICE 'Federation stats collected for last 6 hours';
END;
$$;

GRANT EXECUTE ON FUNCTION collect_federation_stats() TO service_role;
