-- Diagnostic: Check Current Trigger State for Messages
-- This will show us exactly what's wrong with outgoing DM federation

-- 1. Show all triggers on messages table
SELECT 
    '=== MESSAGES TABLE TRIGGERS ===' as section,
    NULL as trigger_name,
    NULL as event_timing,
    NULL as event_manipulation,
    NULL as when_condition
UNION ALL
SELECT 
    'Current' as section,
    trigger_name,
    action_timing as event_timing,
    event_manipulation,
    CASE WHEN pg_get_triggerdef(oid) LIKE '%WHEN%' 
         THEN 'HAS WHEN CLAUSE' 
         ELSE 'NO WHEN CLAUSE' 
    END as when_condition
FROM information_schema.triggers t
JOIN pg_trigger pt ON pt.tgname = t.trigger_name
WHERE event_object_table = 'messages'
ORDER BY trigger_name;

-- 2. Show full trigger definitions
SELECT 
    '=== TRIGGER DEFINITIONS ===' as info,
    trigger_name,
    pg_get_triggerdef(oid) as full_definition
FROM information_schema.triggers t
JOIN pg_trigger pt ON pt.tgname = t.trigger_name  
WHERE event_object_table = 'messages';

-- 3. Check if required functions exist
SELECT 
    '=== FUNCTION CHECK ===' as info,
    function_name,
    CASE WHEN EXISTS(SELECT 1 FROM pg_proc WHERE proname = function_name) 
         THEN '✅ EXISTS' 
         ELSE '❌ MISSING' 
    END as status
FROM (VALUES 
    ('handle_outgoing_messages'),
    ('handle_message_federation'),
    ('handle_messages'),
    ('queue_activity_for_federation'),
    ('determine_message_federation_type')
) AS functions(function_name);

-- 4. Test a specific trigger pattern we expect
SELECT 
    '=== EXPECTED TRIGGER CHECK ===' as info,
    CASE WHEN EXISTS(
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        WHERE c.relname = 'messages' 
        AND t.tgname = 'trg_handle_outgoing_messages'
        AND pg_get_triggerdef(t.oid) LIKE '%WHEN%'
        AND pg_get_triggerdef(t.oid) LIKE '%federated%'
    ) THEN '✅ CORRECT TRIGGER EXISTS'
    ELSE '❌ MISSING CORRECT TRIGGER'
    END as status;