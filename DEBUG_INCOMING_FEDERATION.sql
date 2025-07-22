-- Debug incoming federation - why aren't we seeing incoming activities?

-- 1. Check if incoming activities are being stored at all
SELECT 
    id,
    ap_type,
    actor_ap_id,
    object_id,
    object_type,
    status,
    created_at,
    (activity_data->>'id') as activity_id_from_data
FROM ap_activities 
WHERE is_local = false 
AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC
LIMIT 10;

-- 2. Check if any Create activities from Misskey have object data
SELECT 
    id,
    ap_type,
    actor_ap_id,
    object_id,
    object_type,
    status,
    activity_data->'object'->>'type' as object_type_in_data,
    activity_data->'object'->>'content' as content_preview,
    array_length(activity_data->'object'->'tag', 1) as tag_count,
    created_at
FROM ap_activities 
WHERE is_local = false 
AND ap_type = 'Create'
AND actor_ap_id LIKE '%misskey.io%'
ORDER BY created_at DESC
LIMIT 5;

-- 3. Check if notifications are being created for mentions
SELECT 
    n.id,
    n.type,
    n.user_id,
    n.data,
    n.created_at,
    p.username as mentioned_user
FROM notifications n
LEFT JOIN profiles p ON n.user_id = p.id
WHERE n.created_at > NOW() - INTERVAL '1 hour'
AND n.type = 'mention'
ORDER BY n.created_at DESC;

-- 4. Check if any posts are being created from incoming activities
SELECT 
    p.id,
    p.content,
    p.author_id,
    p.is_local,
    p.created_at,
    pr.username,
    pr.domain,
    pr.federated_id
FROM posts p
LEFT JOIN profiles pr ON p.author_id = pr.id
WHERE p.is_local = false 
AND p.created_at > NOW() - INTERVAL '1 hour'
ORDER BY p.created_at DESC;

-- 5. Check the full activity data for latest Misskey Create activity
SELECT 
    id,
    ap_type,
    actor_ap_id,
    jsonb_pretty(activity_data) as full_activity
FROM ap_activities 
WHERE is_local = false 
AND ap_type = 'Create'
AND actor_ap_id LIKE '%misskey.io%'
ORDER BY created_at DESC 
LIMIT 1;

-- 6. Check if there are any triggers processing incoming activities
SELECT 
    t.tgname as trigger_name,
    p.proname as function_name,
    c.relname as table_name,
    t.tgenabled as enabled
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid  
JOIN pg_proc p ON t.tgfoid = p.oid
WHERE c.relname = 'ap_activities'
AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
AND NOT t.tgisinternal
ORDER BY t.tgname;