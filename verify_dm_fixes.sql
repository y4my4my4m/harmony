-- Verification Script for DM Fixes (Migration 072)
-- Run this after applying the migration to verify everything works

-- =================================================================
-- Test 1: Verify send_notification_to_user function works
-- =================================================================

DO $$
DECLARE
    test_user_id uuid;
    test_notification_id uuid;
    function_exists boolean;
BEGIN
    -- Check if the function exists with correct signature
    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'send_notification_to_user'
        AND p.pronargs = 8  -- 8 parameters
    ) INTO function_exists;
    
    IF function_exists THEN
        RAISE NOTICE '✅ send_notification_to_user function exists with correct signature';
        
        -- Test with a real user if available
        SELECT id INTO test_user_id FROM profiles WHERE is_local = true LIMIT 1;
        
        IF test_user_id IS NOT NULL THEN
            SELECT send_notification_to_user(
                'test_verification',
                test_user_id,
                '{"test": "DM fix verification"}'::jsonb,
                NULL, NULL, NULL, NULL, 'normal'
            ) INTO test_notification_id;
            
            -- Clean up
            DELETE FROM notifications WHERE id = test_notification_id;
            RAISE NOTICE '✅ Notification function test passed for user %', test_user_id;
        ELSE
            RAISE NOTICE '⚠️  No local users found for testing, but function exists';
        END IF;
    ELSE
        RAISE WARNING '❌ send_notification_to_user function not found or has wrong signature';
    END IF;
END $$;

-- =================================================================
-- Test 2: Verify handle_outgoing_messages function updated
-- =================================================================

DO $$
DECLARE
    function_body text;
    uses_old_function boolean;
    uses_new_function boolean;
BEGIN
    -- Get the function definition
    SELECT prosrc INTO function_body 
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' 
    AND p.proname = 'handle_outgoing_messages';
    
    IF function_body IS NOT NULL THEN
        -- Check for old problematic function calls
        uses_old_function := function_body LIKE '%create_notification_structured%';
        uses_new_function := function_body LIKE '%send_notification_to_user%';
        
        IF uses_new_function AND NOT uses_old_function THEN
            RAISE NOTICE '✅ handle_outgoing_messages updated to use send_notification_to_user';
        ELSIF uses_old_function THEN
            RAISE WARNING '❌ handle_outgoing_messages still uses create_notification_structured';
        ELSE
            RAISE WARNING '⚠️  handle_outgoing_messages notification method unclear';
        END IF;
    ELSE
        RAISE WARNING '❌ handle_outgoing_messages function not found';
    END IF;
END $$;

-- =================================================================
-- Test 3: Verify ActivityPub DM function enhanced
-- =================================================================

DO $$
DECLARE
    function_body text;
    has_enhanced_detection boolean;
BEGIN
    -- Get the function definition
    SELECT prosrc INTO function_body 
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' 
    AND p.proname = 'is_activitypub_direct_message';
    
    IF function_body IS NOT NULL THEN
        -- Check for enhanced DM detection logic
        has_enhanced_detection := function_body LIKE '%directMessage%';
        
        IF has_enhanced_detection THEN
            RAISE NOTICE '✅ is_activitypub_direct_message enhanced with directMessage flag support';
        ELSE
            RAISE WARNING '⚠️  is_activitypub_direct_message may not have latest enhancements';
        END IF;
    ELSE
        RAISE WARNING '❌ is_activitypub_direct_message function not found';
    END IF;
END $$;

-- =================================================================
-- Test 4: Check federation delivery queue structure
-- =================================================================

DO $$
DECLARE
    table_exists boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'federation_delivery_queue'
    ) INTO table_exists;
    
    IF table_exists THEN
        RAISE NOTICE '✅ federation_delivery_queue table exists for DM federation';
    ELSE
        RAISE WARNING '❌ federation_delivery_queue table not found - federation may not work';
    END IF;
END $$;

-- =================================================================
-- Test 5: Sample DM detection test
-- =================================================================

DO $$
DECLARE
    test_dm_object jsonb;
    is_dm boolean;
BEGIN
    -- Test a typical DM object
    test_dm_object := '{
        "type": "Note",
        "to": ["https://example.com/users/testuser"],
        "cc": [],
        "directMessage": true,
        "content": "Test direct message"
    }'::jsonb;
    
    SELECT is_activitypub_direct_message(test_dm_object, 'example.com') INTO is_dm;
    
    IF is_dm THEN
        RAISE NOTICE '✅ DM detection test passed';
    ELSE
        RAISE WARNING '❌ DM detection test failed - may not recognize DMs properly';
    END IF;
END $$;

-- =================================================================
-- Summary
-- =================================================================

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '=== DM Fix Verification Summary ===';
    RAISE NOTICE 'If all tests show ✅, your DM fixes are properly applied.';
    RAISE NOTICE 'If any show ❌, you may need to re-apply the migration.';
    RAISE NOTICE '';
    RAISE NOTICE 'Next steps:';
    RAISE NOTICE '1. Try sending a DM to a local user';
    RAISE NOTICE '2. Try sending a DM to a remote user';
    RAISE NOTICE '3. Check browser console for federation logs';
    RAISE NOTICE '';
END $$;