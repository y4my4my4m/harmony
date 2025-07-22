-- Debug federation delivery queue and edge function calls

-- 1. Check recent federation delivery queue entries
SELECT 
    fdq.id,
    fdq.activity_id,
    fdq.target_domain,
    fdq.status,
    fdq.attempts,
    fdq.created_at,
    fdq.next_attempt_at,
    fdq.error_message,
    aa.ap_type,
    aa.actor_ap_id
FROM federation_delivery_queue fdq
LEFT JOIN ap_activities aa ON fdq.activity_id = aa.id
WHERE fdq.created_at > NOW() - INTERVAL '1 hour'
ORDER BY fdq.created_at DESC
LIMIT 10;

-- 2. Check if activities are being created without queue entries
SELECT 
    aa.id,
    aa.ap_type,
    aa.actor_ap_id,
    aa.object_id,
    aa.status,
    aa.created_at,
    COUNT(fdq.id) as queue_entries
FROM ap_activities aa
LEFT JOIN federation_delivery_queue fdq ON aa.id = fdq.activity_id
WHERE aa.is_local = true 
AND aa.created_at > NOW() - INTERVAL '1 hour'
GROUP BY aa.id, aa.ap_type, aa.actor_ap_id, aa.object_id, aa.status, aa.created_at
ORDER BY aa.created_at DESC;

-- 3. Check webhook configuration
SELECT config_key, config_value 
FROM instance_config 
WHERE config_key LIKE '%webhook%' OR config_key LIKE '%edge%';

-- 4. Check for stuck/failed deliveries
SELECT 
    target_domain,
    status,
    COUNT(*) as count,
    MAX(next_attempt_at) as latest_attempt,
    string_agg(DISTINCT error_message, '; ') as errors
FROM federation_delivery_queue 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY target_domain, status
ORDER BY target_domain, status;