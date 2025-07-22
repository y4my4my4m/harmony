-- Verification Script for DM Federation Fix 074
-- Run this AFTER applying migration 074 to verify the fix is working

-- =================================================================
-- Test 1: Check that the federation flow is working
-- =================================================================

DO $$
DECLARE
    function_exists boolean;
    handle_outgoing_messages_source text;
BEGIN
    RAISE NOTICE '🔍 Testing DM Federation Fix 074...';
    
    -- Check if handle_outgoing_messages function was updated correctly
    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'handle_outgoing_messages'
    ) INTO function_exists;
    
    IF function_exists THEN
        -- Get function source to verify it's using the new flow
        SELECT prosrc INTO handle_outgoing_messages_source
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'handle_outgoing_messages';
        
        -- Check for key indicators of the fix
        IF handle_outgoing_messages_source LIKE '%queue_activity_for_federation%' AND
           handle_outgoing_messages_source LIKE '%ap_activities%' AND
           handle_outgoing_messages_source LIKE '%send_notification_to_user%' THEN
            RAISE NOTICE '✅ handle_outgoing_messages function updated correctly';
            RAISE NOTICE '✅ Function uses proper federation flow with ap_activities';
            RAISE NOTICE '✅ Function uses correct notification function';
        ELSE
            RAISE WARNING '❌ handle_outgoing_messages function may not be updated correctly';
            IF handle_outgoing_messages_source NOT LIKE '%queue_activity_for_federation%' THEN
                RAISE WARNING '❌ Missing queue_activity_for_federation call';
            END IF;
            IF handle_outgoing_messages_source NOT LIKE '%ap_activities%' THEN
                RAISE WARNING '❌ Not using ap_activities table properly';
            END IF;
            IF handle_outgoing_messages_source NOT LIKE '%send_notification_to_user%' THEN
                RAISE WARNING '❌ Not using correct notification function';
            END IF;
        END IF;
    ELSE
        RAISE WARNING '❌ handle_outgoing_messages function not found';
    END IF;
END $$;

-- =================================================================
-- Test 2: Verify supporting functions exist
-- =================================================================

DO $$
DECLARE
    function_name text;
    required_functions text[] := ARRAY[
        'queue_activity_for_federation',
        'send_notification_to_user',
        'convert_jsonb_to_ap',
        'extract_activitypub_attachments',
        'extract_all_activitypub_tags'
    ];
BEGIN
    RAISE NOTICE '🔍 Checking required supporting functions...';
    
    FOREACH function_name IN ARRAY required_functions
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = 'public' 
            AND p.proname = function_name
        ) THEN
            RAISE NOTICE '✅ Function % exists', function_name;
        ELSE
            RAISE WARNING '❌ Missing function: %', function_name;
        END IF;
    END LOOP;
END $$;

-- =================================================================
-- Test 3: Check table schemas are correct
-- =================================================================

DO $$
DECLARE
    column_name text;
    ap_activities_columns text[] := ARRAY['id', 'ap_id', 'ap_type', 'actor_id', 'actor_ap_id', 'activity_data', 'status'];
    federation_queue_columns text[] := ARRAY['id', 'activity_id', 'activity_data', 'target_domain', 'target_inbox_url', 'status'];
    table_exists boolean;
BEGIN
    RAISE NOTICE '🔍 Checking table schemas...';
    
    -- Check ap_activities table
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'ap_activities' AND table_schema = 'public'
    ) INTO table_exists;
    
    IF table_exists THEN
        RAISE NOTICE '✅ ap_activities table exists';
        
        FOREACH column_name IN ARRAY ap_activities_columns
        LOOP
            IF EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'ap_activities' 
                AND column_name = column_name
                AND table_schema = 'public'
            ) THEN
                RAISE NOTICE '✅ ap_activities.% exists', column_name;
            ELSE
                RAISE WARNING '❌ Missing column: ap_activities.%', column_name;
            END IF;
        END LOOP;
    ELSE
        RAISE WARNING '❌ ap_activities table not found';
    END IF;
    
    -- Check federation_delivery_queue table
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'federation_delivery_queue' AND table_schema = 'public'
    ) INTO table_exists;
    
    IF table_exists THEN
        RAISE NOTICE '✅ federation_delivery_queue table exists';
        
        FOREACH column_name IN ARRAY federation_queue_columns
        LOOP
            IF EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'federation_delivery_queue' 
                AND column_name = column_name
                AND table_schema = 'public'
            ) THEN
                RAISE NOTICE '✅ federation_delivery_queue.% exists', column_name;
            ELSE
                RAISE WARNING '❌ Missing column: federation_delivery_queue.%', column_name;
            END IF;
        END LOOP;
    ELSE
        RAISE WARNING '❌ federation_delivery_queue table not found';
    END IF;
END $$;

-- =================================================================
-- Test 4: Show recent federation activity (if any)
-- =================================================================

DO $$
DECLARE
    recent_activities integer;
    recent_queue_items integer;
BEGIN
    RAISE NOTICE '🔍 Checking recent federation activity...';
    
    -- Count recent ap_activities
    SELECT COUNT(*) INTO recent_activities
    FROM ap_activities
    WHERE created_at > NOW() - INTERVAL '1 hour'
    AND is_local = true;
    
    -- Count recent federation queue items
    SELECT COUNT(*) INTO recent_queue_items
    FROM federation_delivery_queue
    WHERE created_at > NOW() - INTERVAL '1 hour';
    
    RAISE NOTICE '📊 Recent ap_activities (last hour): %', recent_activities;
    RAISE NOTICE '📊 Recent federation_delivery_queue items (last hour): %', recent_queue_items;
    
    IF recent_activities > 0 AND recent_queue_items > 0 THEN
        RAISE NOTICE '✅ Federation system appears to be active';
    ELSIF recent_activities = 0 AND recent_queue_items = 0 THEN
        RAISE NOTICE '⚠️  No recent federation activity (this is normal if no DMs/posts were sent)';
    ELSE
        RAISE WARNING '⚠️  Mismatch: % activities but % queue items (may indicate an issue)', recent_activities, recent_queue_items;
    END IF;
END $$;

-- =================================================================
-- Test 5: Manual federation test (informational)
-- =================================================================

DO $$
BEGIN
    RAISE NOTICE '🧪 TO TEST DM FEDERATION MANUALLY:';
    RAISE NOTICE '1. Send a DM to a federated user (e.g., tester004@misskey.io)';
    RAISE NOTICE '2. Check the edge function logs for successful delivery';
    RAISE NOTICE '3. Verify the remote user receives the DM';
    RAISE NOTICE '';
    RAISE NOTICE '📊 To monitor federation after sending a DM, run:';
    RAISE NOTICE 'SELECT id, ap_type, actor_ap_id, status FROM ap_activities WHERE created_at > NOW() - INTERVAL ''5 minutes'' ORDER BY created_at DESC LIMIT 5;';
    RAISE NOTICE 'SELECT id, activity_id, target_domain, status FROM federation_delivery_queue WHERE created_at > NOW() - INTERVAL ''5 minutes'' ORDER BY created_at DESC LIMIT 5;';
END $$;