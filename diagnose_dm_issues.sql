-- Diagnostic Script for DM Issues
-- Run this to understand what's happening with your DM problems

-- =================================================================
-- DIAGNOSTIC 1: Check if messages are being saved at all
-- =================================================================

DO $$
BEGIN
    RAISE NOTICE '🔍 DIAGNOSTIC: Recent DM messages in database';
END $$;

-- Check recent DM messages (last 1 hour)
SELECT 
    m.id,
    m.conversation_id,
    m.user_id,
    p.username as sender_username,
    p.domain as sender_domain,
    m.created_at,
    LEFT(m.content::text, 100) as content_preview,
    m.metadata
FROM messages m
JOIN profiles p ON m.user_id = p.id
WHERE m.conversation_id IS NOT NULL
  AND m.created_at > NOW() - INTERVAL '1 hour'
ORDER BY m.created_at DESC
LIMIT 10;

-- =================================================================
-- DIAGNOSTIC 2: Check conversation participants
-- =================================================================

DO $$
BEGIN
    RAISE NOTICE '🔍 DIAGNOSTIC: Recent conversation participants';
END $$;

-- Check recent conversations and their participants
SELECT 
    c.id as conversation_id,
    c.type,
    c.name,
    c.created_at,
    cp.user_id,
    p.username,
    p.domain,
    p.is_local,
    cp.role,
    cp.left_at
FROM conversations c
JOIN conversation_participants cp ON c.id = cp.conversation_id
JOIN profiles p ON cp.user_id = p.id
WHERE c.created_at > NOW() - INTERVAL '1 hour'
   OR c.updated_at > NOW() - INTERVAL '1 hour'
ORDER BY c.created_at DESC, cp.joined_at ASC;

-- =================================================================
-- DIAGNOSTIC 3: Check federation activity
-- =================================================================

DO $$
BEGIN
    RAISE NOTICE '🔍 DIAGNOSTIC: Recent federation activity';
END $$;

-- Check recent ap_activities for DMs
SELECT 
    aa.id,
    aa.ap_id,
    aa.ap_type,
    aa.actor_ap_id,
    aa.object_id,
    aa.status,
    aa.created_at,
    aa.is_local
FROM ap_activities aa
WHERE aa.created_at > NOW() - INTERVAL '1 hour'
  AND aa.ap_type = 'Create'
ORDER BY aa.created_at DESC
LIMIT 10;

-- Check recent federation delivery queue
SELECT 
    fdq.id,
    fdq.activity_id,
    fdq.target_domain,
    fdq.target_inbox_url,
    fdq.status,
    fdq.attempts,
    fdq.created_at,
    fdq.next_attempt_at,
    fdq.actor_username
FROM federation_delivery_queue fdq
WHERE fdq.created_at > NOW() - INTERVAL '1 hour'
ORDER BY fdq.created_at DESC
LIMIT 10;

-- =================================================================
-- DIAGNOSTIC 4: Check triggers and functions
-- =================================================================

DO $$
BEGIN
    RAISE NOTICE '🔍 DIAGNOSTIC: Active triggers on messages table';
END $$;

-- Check what triggers are active on the messages table
SELECT 
    trigger_name,
    action_timing,
    event_manipulation,
    action_statement
FROM information_schema.triggers
WHERE event_object_table = 'messages'
  AND trigger_schema = 'public'
ORDER BY trigger_name;

-- =================================================================
-- DIAGNOSTIC 5: Check function existence
-- =================================================================

DO $$
DECLARE
    function_name text;
    critical_functions text[] := ARRAY[
        'handle_outgoing_messages',
        'handle_incoming_messages',
        'convert_ap_to_jsonb',
        'convert_jsonb_to_ap',
        'queue_activity_for_federation',
        'send_notification_to_user',
        'notify_dm_message_sent'
    ];
BEGIN
    RAISE NOTICE '🔍 DIAGNOSTIC: Critical function existence check';
    
    FOREACH function_name IN ARRAY critical_functions
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = 'public' 
            AND p.proname = function_name
        ) THEN
            RAISE NOTICE '✅ Function % exists', function_name;
        ELSE
            RAISE NOTICE '❌ MISSING: Function %', function_name;
        END IF;
    END LOOP;
END $$;

-- =================================================================
-- DIAGNOSTIC 6: Test a simple message lookup
-- =================================================================

DO $$
DECLARE
    recent_message_count integer;
    recent_conversation_count integer;
BEGIN
    -- Count recent DM messages
    SELECT COUNT(*) INTO recent_message_count
    FROM messages 
    WHERE conversation_id IS NOT NULL 
      AND created_at > NOW() - INTERVAL '1 hour';
    
    -- Count recent conversations
    SELECT COUNT(*) INTO recent_conversation_count
    FROM conversations 
    WHERE created_at > NOW() - INTERVAL '1 hour';
    
    RAISE NOTICE '📊 SUMMARY: % recent DM messages, % recent conversations in last hour', 
        recent_message_count, recent_conversation_count;
        
    IF recent_message_count = 0 THEN
        RAISE NOTICE '⚠️  No recent DM messages found - this could indicate messages are not being saved';
    END IF;
    
    IF recent_conversation_count = 0 THEN
        RAISE NOTICE '⚠️  No recent conversations found - this could indicate conversation creation issues';
    END IF;
END $$;

-- =================================================================
-- INSTRUCTIONS FOR USER
-- =================================================================

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '📋 INSTRUCTIONS:';
    RAISE NOTICE '1. Send a test DM to a federated user';
    RAISE NOTICE '2. Run this diagnostic script immediately after';
    RAISE NOTICE '3. Check the output above to see what data was created';
    RAISE NOTICE '4. Look for patterns in the data to identify the issue';
    RAISE NOTICE '';
    RAISE NOTICE '🔍 KEY THINGS TO CHECK:';
    RAISE NOTICE '   - Are messages being saved in the messages table?';
    RAISE NOTICE '   - Are conversation_participants entries being created?';
    RAISE NOTICE '   - Are ap_activities entries being created for federation?';
    RAISE NOTICE '   - Are federation_delivery_queue entries being created?';
    RAISE NOTICE '   - Are all required functions present?';
END $$;