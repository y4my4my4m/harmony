-- Check if outgoing DMs are being saved locally
-- Look at recent messages in conversations to see if local saving is working

SELECT 
    'Recent messages in conversations' as info,
    m.id,
    m.conversation_id,
    m.user_id,
    p.username,
    p.is_local,
    m.content,
    m.created_at,
    m.metadata
FROM messages m
JOIN profiles p ON m.user_id = p.id
WHERE m.conversation_id IS NOT NULL
  AND m.created_at > NOW() - INTERVAL '1 hour'
ORDER BY m.created_at DESC
LIMIT 10;

-- Also check conversation participants to make sure the structure is correct
SELECT 
    'Conversation participants' as info,
    cp.conversation_id,
    cp.user_id,
    p.username,
    p.domain,
    p.is_local,
    cp.role,
    cp.joined_at,
    cp.left_at
FROM conversation_participants cp
JOIN profiles p ON cp.user_id = p.id
JOIN conversations c ON cp.conversation_id = c.id
WHERE c.updated_at > NOW() - INTERVAL '1 hour'
ORDER BY c.updated_at DESC, cp.joined_at DESC
LIMIT 10;