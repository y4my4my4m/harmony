-- Verification Script for DM Fix 073 (Proper Schema Usage)
-- Run this after applying migration 073 to verify everything works

-- =================================================================
-- Test 1: Verify federation_delivery_queue table structure
-- =================================================================

DO $$
DECLARE
    required_columns text[] := ARRAY['activity_data', 'target_domain', 'target_inbox_url', 'actor_username', 'actor_domain'];
    column_name text;
    column_exists boolean;
    missing_columns text[] := '{}';
BEGIN
    RAISE NOTICE '🔍 Checking federation_delivery_queue table structure...';
    
    FOREACH column_name IN ARRAY required_columns
    LOOP
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'federation_delivery_queue' 
            AND column_name = column_name
        ) INTO column_exists;
        
        IF NOT column_exists THEN
            missing_columns := array_append(missing_columns, column_name);
        END IF;
    END LOOP;
    
    IF array_length(missing_columns, 1) > 0 THEN
        RAISE WARNING '❌ Missing required columns: %', array_to_string(missing_columns, ', ');
    ELSE
        RAISE NOTICE '✅ All required federation_delivery_queue columns exist';
    END IF;
END $$;

-- =================================================================
-- Test 2: Check for debug configurations
-- =================================================================

DO $$
DECLARE
    debug_instance_config boolean;
    debug_profiles_count integer;
BEGIN
    RAISE NOTICE '🔍 Checking for debug configurations...';
    
    -- Check instance config for debug values
    SELECT EXISTS (
        SELECT 1 FROM instance_config 
        WHERE config_value::text LIKE '%debug%'
    ) INTO debug_instance_config;
    
    IF debug_instance_config THEN
        RAISE WARNING '⚠️  Found debug values in instance_config:';
        FOR debug_instance_config IN 
            SELECT config_key, config_value 
            FROM instance_config 
            WHERE config_value::text LIKE '%debug%'
        LOOP
            RAISE WARNING '  - %: %', debug_instance_config.config_key, debug_instance_config.config_value;
        END LOOP;
    ELSE
        RAISE NOTICE '✅ No debug values found in instance_config';
    END IF;
    
    -- Check profiles for debug domains
    SELECT COUNT(*) INTO debug_profiles_count
    FROM profiles 
    WHERE domain = 'debug' OR domain = '';
    
    IF debug_profiles_count > 0 THEN
        RAISE WARNING '⚠️  Found % profiles with debug/empty domains', debug_profiles_count;
    ELSE
        RAISE NOTICE '✅ No profiles with debug domains found';
    END IF;
END $$;

-- =================================================================
-- Test 3: Verify notification function exists and works
-- =================================================================

DO $$
DECLARE
    test_user_id uuid;
    test_notification_id uuid;
    function_exists boolean;
BEGIN
    RAISE NOTICE '🔍 Testing notification function...';
    
    -- Check if send_notification_to_user exists
    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'send_notification_to_user'
    ) INTO function_exists;
    
    IF function_exists THEN
        RAISE NOTICE '✅ send_notification_to_user function exists';
        
        -- Test with a real user if available
        SELECT id INTO test_user_id FROM profiles WHERE is_local = true LIMIT 1;
        
        IF test_user_id IS NOT NULL THEN
            SELECT send_notification_to_user(
                'test_dm_fix_073',
                test_user_id,
                '{"test": "DM fix 073 verification"}'::jsonb,
                NULL, NULL, NULL, NULL, 'normal'
            ) INTO test_notification_id;
            
            -- Clean up
            DELETE FROM notifications WHERE id = test_notification_id;
            RAISE NOTICE '✅ Notification function test passed';
        ELSE
            RAISE NOTICE '⚠️  No local users found for testing';
        END IF;
    ELSE
        RAISE WARNING '❌ send_notification_to_user function not found';
    END IF;
END $$;

-- =================================================================
-- Test 4: Check recent federation queue entries
-- =================================================================

DO $$
DECLARE
    recent_entries_count integer;
    debug_entries_count integer;
BEGIN
    RAISE NOTICE '🔍 Checking recent federation queue entries...';
    
    -- Count recent entries
    SELECT COUNT(*) INTO recent_entries_count
    FROM federation_delivery_queue 
    WHERE created_at > NOW() - INTERVAL '1 hour';
    
    RAISE NOTICE 'Found % recent federation queue entries', recent_entries_count;
    
    -- Check for debug entries
    SELECT COUNT(*) INTO debug_entries_count
    FROM federation_delivery_queue 
    WHERE target_domain = 'debug' OR target_inbox_url = 'debug'
    AND created_at > NOW() - INTERVAL '24 hours';
    
    IF debug_entries_count > 0 THEN
        RAISE WARNING '⚠️  Found % recent entries with debug values', debug_entries_count;
        
        -- Show some debug entries
        FOR debug_entries_count IN 
            SELECT target_domain, target_inbox_url, created_at
            FROM federation_delivery_queue 
            WHERE target_domain = 'debug' OR target_inbox_url = 'debug'
            AND created_at > NOW() - INTERVAL '24 hours'
            ORDER BY created_at DESC
            LIMIT 3
        LOOP
            RAISE WARNING '  - Domain: %, Inbox: %, Created: %', 
                debug_entries_count.target_domain, 
                debug_entries_count.target_inbox_url, 
                debug_entries_count.created_at;
        END LOOP;
    ELSE
        RAISE NOTICE '✅ No recent entries with debug values';
    END IF;
END $$;

-- =================================================================
-- Test 5: Verify handle_outgoing_messages function updated
-- =================================================================

DO $$
DECLARE
    function_body text;
    uses_correct_columns boolean;
    uses_old_columns boolean;
BEGIN
    RAISE NOTICE '🔍 Checking handle_outgoing_messages function...';
    
    -- Get the function definition
    SELECT prosrc INTO function_body 
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' 
    AND p.proname = 'handle_outgoing_messages';
    
    IF function_body IS NOT NULL THEN
        -- Check for correct column usage
        uses_correct_columns := function_body LIKE '%activity_data%' 
                             AND function_body LIKE '%target_domain%'
                             AND function_body LIKE '%target_inbox_url%';
        
        -- Check for old incorrect column usage
        uses_old_columns := function_body LIKE '%activity_uuid%'
                         OR function_body LIKE '%sender_profile_id%'
                         OR function_body LIKE '%recipient_profile_id%';
        
        IF uses_correct_columns AND NOT uses_old_columns THEN
            RAISE NOTICE '✅ handle_outgoing_messages uses correct column names';
        ELSIF uses_old_columns THEN
            RAISE WARNING '❌ handle_outgoing_messages still uses old column names';
        ELSE
            RAISE WARNING '⚠️  handle_outgoing_messages column usage unclear';
        END IF;
    ELSE
        RAISE WARNING '❌ handle_outgoing_messages function not found';
    END IF;
END $$;

-- =================================================================
-- Summary and next steps
-- =================================================================

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '=== DM Fix 073 Verification Summary ===';
    RAISE NOTICE 'If all tests show ✅, the fix is properly applied.';
    RAISE NOTICE '';
    RAISE NOTICE 'Next steps:';
    RAISE NOTICE '1. Try sending a DM to a local user';
    RAISE NOTICE '2. Try sending a DM to a remote user';
    RAISE NOTICE '3. Check the federation_delivery_queue for new entries:';
    RAISE NOTICE '   SELECT target_domain, target_inbox_url, status FROM federation_delivery_queue ORDER BY created_at DESC LIMIT 5;';
    RAISE NOTICE '';
    RAISE NOTICE 'If you still see debug values, check:';
    RAISE NOTICE '- Instance config: SELECT * FROM instance_config WHERE config_key = ''domain'';';
    RAISE NOTICE '- Remote profiles: SELECT username, domain FROM profiles WHERE NOT is_local;';
    RAISE NOTICE '';
END $$;