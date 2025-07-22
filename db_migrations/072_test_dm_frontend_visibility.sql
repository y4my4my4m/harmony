-- Test DM Frontend Visibility
-- Check if the fixed conversation should be visible in the frontend

-- STEP 1: Verify the conversation is properly structured for frontend
SELECT 
    'Frontend-ready conversation check' as info,
    c.id as conversation_id,
    c.type,
    c.created_at,
    c.updated_at,
    COUNT(cp.user_id) as participant_count,
    COUNT(m.id) as message_count,
    MAX(m.created_at) as last_message_at
FROM conversations c
LEFT JOIN conversation_participants cp ON c.id = cp.conversation_id AND cp.left_at IS NULL
LEFT JOIN messages m ON c.id = m.conversation_id
WHERE c.id = '18f369e8-db2c-47c6-967e-149108f52aa0'
GROUP BY c.id, c.type, c.created_at, c.updated_at;

-- STEP 2: Check what the frontend query would return for your user
-- This simulates the fetchUserConversations query
WITH user_conversations AS (
    SELECT DISTINCT 
        c.id,
        c.type,
        c.name,
        c.created_at,
        c.updated_at,
        -- Get the "other" user for direct conversations
        CASE 
            WHEN c.type = 'direct' THEN (
                SELECT p2.username 
                FROM conversation_participants cp2 
                JOIN profiles p2 ON cp2.user_id = p2.id
                WHERE cp2.conversation_id = c.id 
                  AND cp2.user_id != '67750a0f-7514-43ed-a5ed-89ac873a08f0'  -- Your user ID
                  AND cp2.left_at IS NULL
                LIMIT 1
            )
            ELSE c.name
        END as other_username,
        -- Get last message info
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_activity,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
    FROM conversations c
    JOIN conversation_participants cp ON c.id = cp.conversation_id
    WHERE cp.user_id = '67750a0f-7514-43ed-a5ed-89ac873a08f0'  -- Your user ID
      AND cp.left_at IS NULL
)
SELECT 
    'Your conversations (frontend query)' as info,
    *
FROM user_conversations
ORDER BY last_activity DESC NULLS LAST;

-- STEP 3: Check the specific conversation participants details
SELECT 
    'Conversation participants details' as info,
    cp.conversation_id,
    cp.user_id,
    p.username,
    p.display_name,
    p.is_local,
    p.domain,
    p.federated_id,
    cp.role,
    cp.joined_at,
    cp.left_at
FROM conversation_participants cp
JOIN profiles p ON cp.user_id = p.id
WHERE cp.conversation_id = '18f369e8-db2c-47c6-967e-149108f52aa0'
ORDER BY cp.joined_at;

-- STEP 4: Test the conversation creation function directly
-- This tests if create_or_get_direct_conversation works for your users
SELECT 
    'Test create_or_get_direct_conversation' as info,
    create_or_get_direct_conversation(
        '67750a0f-7514-43ed-a5ed-89ac873a08f0',  -- Your user ID
        'e33e2b83-922a-40cc-9629-b83ca1922011'   -- tester004's user ID
    ) as returned_conversation_id;
    
-- Should return: 18f369e8-db2c-47c6-967e-149108f52aa0

-- STEP 5: Force refresh the conversation updated_at timestamp
-- This might trigger frontend real-time updates
UPDATE conversations 
SET updated_at = NOW() 
WHERE id = '18f369e8-db2c-47c6-967e-149108f52aa0';

-- STEP 6: Check if there are any issues with the conversation record itself
SELECT 
    'Conversation health check' as info,
    c.*,
    (SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.left_at IS NULL) as active_participants,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as total_messages
FROM conversations c
WHERE c.id = '18f369e8-db2c-47c6-967e-149108f52aa0';