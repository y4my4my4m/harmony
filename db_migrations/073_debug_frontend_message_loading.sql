-- Debug Frontend Message Loading
-- Test exactly what the frontend services.messages.loadConversationMessages() would return

-- STEP 1: Test the exact query that CoreMessageService.loadConversationMessages uses
SELECT 
    'Direct database query (what CoreMessageService does)' as info,
    m.id,
    m.conversation_id,
    m.user_id,
    m.content,
    m.created_at,
    m.reply_to,
    m.is_system,
    m.metadata
FROM messages m
WHERE m.conversation_id = '18f369e8-db2c-47c6-967e-149108f52aa0'
  AND (m.is_deleted IS NULL OR m.is_deleted = false)
ORDER BY m.created_at DESC
LIMIT 20;

-- STEP 2: Check if there are any is_deleted flags causing issues
SELECT 
    'Message deletion status check' as info,
    COUNT(*) as total_messages,
    COUNT(*) FILTER (WHERE is_deleted IS NULL) as null_deleted,
    COUNT(*) FILTER (WHERE is_deleted = false) as false_deleted,
    COUNT(*) FILTER (WHERE is_deleted = true) as true_deleted
FROM messages
WHERE conversation_id = '18f369e8-db2c-47c6-967e-149108f52aa0';

-- STEP 3: Check if there are any specific users being filtered
SELECT 
    'Messages by user' as info,
    m.user_id,
    p.username,
    p.is_local,
    COUNT(*) as message_count,
    MAX(m.created_at) as latest_message
FROM messages m
JOIN profiles p ON m.user_id = p.id
WHERE m.conversation_id = '18f369e8-db2c-47c6-967e-149108f52aa0'
GROUP BY m.user_id, p.username, p.is_local
ORDER BY latest_message DESC;

-- STEP 4: Test with different conversation_id formats (in case there's a UUID issue)
SELECT 
    'Conversation ID validation' as info,
    c.id,
    c.type,
    COUNT(m.id) as message_count,
    c.id::text = '18f369e8-db2c-47c6-967e-149108f52aa0' as id_matches_exactly
FROM conversations c
LEFT JOIN messages m ON c.id = m.conversation_id
WHERE c.id::text = '18f369e8-db2c-47c6-967e-149108f52aa0'
GROUP BY c.id, c.type;

-- STEP 5: Check message content format (ensure it's valid JSON)
SELECT 
    'Message content format check' as info,
    m.id,
    jsonb_typeof(m.content) as content_type,
    jsonb_array_length(m.content) as content_parts,
    m.content
FROM messages m
WHERE m.conversation_id = '18f369e8-db2c-47c6-967e-149108f52aa0'
  AND m.created_at > NOW() - INTERVAL '1 day'
ORDER BY m.created_at DESC
LIMIT 5;

-- STEP 6: Check if RLS (Row Level Security) policies might be interfering
-- Note: This shows the actual policy evaluation
DO $$
DECLARE
    message_count INTEGER;
    conversation_id_var UUID := '18f369e8-db2c-47c6-967e-149108f52aa0';
BEGIN
    -- Test as if we're the frontend user
    PERFORM set_config('request.jwt.claims', 
        '{"sub": "67750a0f-7514-43ed-a5ed-89ac873a08f0"}', true);
        
    SELECT COUNT(*) INTO message_count
    FROM messages 
    WHERE conversation_id = conversation_id_var;
    
    RAISE WARNING '🔍 RLS Test: User can see % messages in conversation %', 
        message_count, conversation_id_var;
        
    -- Reset
    PERFORM set_config('request.jwt.claims', null, true);
END;
$$;