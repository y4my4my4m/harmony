-- DEBUG: Incoming Federation Issue
-- Misskey sent a mention but nothing appears in frontend

-- 1. Check if ANY incoming activities are being stored
SELECT COUNT(*) as total_activities, 
       COUNT(CASE WHEN is_local = false THEN 1 END) as remote_activities,
       MAX(created_at) as latest_activity
FROM ap_activities;

-- 2. Look for recent incoming activities (not local)
SELECT id, ap_type, actor_ap_id, object_id, object_type, status, created_at
FROM ap_activities 
WHERE is_local = false 
ORDER BY created_at DESC 
LIMIT 5;

-- 3. Check if the Misskey mention created any records
SELECT id, ap_type, actor_ap_id, object_id, activity_data->>'content' as content, created_at
FROM ap_activities 
WHERE actor_ap_id LIKE '%misskey.io%' 
OR activity_data::text LIKE '%misskey.io%'
ORDER BY created_at DESC;

-- 4. Check if any posts were created from incoming activities
SELECT p.id, p.content, p.author_id, p.is_local, p.created_at,
       pr.username, pr.domain
FROM posts p
LEFT JOIN profiles pr ON p.author_id = pr.id
WHERE p.is_local = false OR pr.domain IS NOT NULL
ORDER BY p.created_at DESC
LIMIT 5;

-- 5. Check if any notifications were created for mentions
SELECT n.id, n.type, n.message, n.user_id, n.created_at,
       n.metadata
FROM notifications n
WHERE n.created_at > NOW() - INTERVAL '1 hour'
ORDER BY n.created_at DESC
LIMIT 5;