-- Debug message rendering issues
-- Check if messages are in the database and in the correct format

-- 1. Check recent messages in the database
SELECT 
    m.id,
    m.user_id,
    m.channel_id,
    m.conversation_id,
    m.content,
    jsonb_typeof(m.content) as content_type,
    array_length(m.content, 1) as content_array_length,
    m.created_at,
    p.username
FROM messages m
LEFT JOIN profiles p ON m.user_id = p.id
WHERE m.created_at > NOW() - INTERVAL '1 hour'
ORDER BY m.created_at DESC
LIMIT 10;

-- 2. Check if any messages have invalid content format
SELECT 
    m.id,
    m.content,
    CASE 
        WHEN jsonb_typeof(m.content) = 'array' THEN 'ARRAY (correct)'
        WHEN jsonb_typeof(m.content) = 'string' THEN 'STRING (needs conversion)'
        WHEN jsonb_typeof(m.content) = 'object' THEN 'OBJECT (wrong format)'
        ELSE 'OTHER (invalid)'
    END as content_format_status,
    m.created_at
FROM messages m
WHERE m.created_at > NOW() - INTERVAL '24 hours'
AND jsonb_typeof(m.content) != 'array'
ORDER BY m.created_at DESC
LIMIT 5;

-- 3. Check user profiles for recent message senders
SELECT DISTINCT
    p.id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.is_local,
    p.domain
FROM messages m
JOIN profiles p ON m.user_id = p.id
WHERE m.created_at > NOW() - INTERVAL '1 hour'
ORDER BY p.username;

-- 4. Check specific conversation messages (for DM testing)
-- Replace with actual conversation ID if available
SELECT 
    m.id,
    m.user_id,
    m.conversation_id,
    m.content,
    jsonb_pretty(m.content) as formatted_content,
    m.created_at,
    p.username
FROM messages m
LEFT JOIN profiles p ON m.user_id = p.id
WHERE m.conversation_id IS NOT NULL
ORDER BY m.created_at DESC
LIMIT 5;

-- 5. Check specific channel messages (for chat testing)  
-- Replace with actual channel ID if available
SELECT 
    m.id,
    m.user_id,
    m.channel_id,
    m.content,
    jsonb_pretty(m.content) as formatted_content,
    m.created_at,
    p.username
FROM messages m
LEFT JOIN profiles p ON m.user_id = p.id
WHERE m.channel_id IS NOT NULL
ORDER BY m.created_at DESC
LIMIT 5;

-- 6. Check if content validation trigger is interfering
SELECT 
    t.tgname as trigger_name,
    p.proname as function_name,
    t.tgenabled as enabled
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid  
JOIN pg_proc p ON t.tgfoid = p.oid
WHERE c.relname = 'messages'
AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
AND NOT t.tgisinternal
ORDER BY t.tgname;