-- DEBUG: Outgoing Federation Issue  
-- Activities are being sent but remote users don't see them

-- 1. Check recent outgoing activities
SELECT id, ap_type, actor_ap_id, object_id, object_type, status, created_at,
       activity_data->>'@context' as context,
       activity_data->>'type' as activity_type,
       activity_data->>'actor' as actor,
       activity_data->'object'->>'type' as object_type_in_data
FROM ap_activities 
WHERE is_local = true 
AND ap_type = 'Create'
ORDER BY created_at DESC 
LIMIT 3;

-- 2. Check full activity data for latest outgoing Create
SELECT activity_data
FROM ap_activities 
WHERE is_local = true 
AND ap_type = 'Create'
ORDER BY created_at DESC 
LIMIT 1;

-- 3. Check federation delivery queue for recent activities
SELECT fdq.id, fdq.activity_id, fdq.target_domain, fdq.target_inbox_url, 
       fdq.status, fdq.attempts, fdq.created_at, fdq.last_attempt_at,
       fdq.actor_username, fdq.actor_domain
FROM federation_delivery_queue fdq
ORDER BY fdq.created_at DESC
LIMIT 5;

-- 4. Check if delivery was successful
SELECT fdq.target_domain, fdq.status, fdq.attempts, fdq.error_message,
       aa.activity_data->>'type' as activity_type,
       aa.activity_data->'object'->>'content' as content
FROM federation_delivery_queue fdq
JOIN ap_activities aa ON fdq.activity_id = aa.id
WHERE fdq.created_at > NOW() - INTERVAL '1 hour'
ORDER BY fdq.created_at DESC;