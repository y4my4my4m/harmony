-- Debug double federation deliveries
-- Check if we have multiple triggers or multiple insert paths

-- 1. Check ALL triggers on posts table (should be only one federation trigger)
SELECT 
    t.tgname as trigger_name,
    p.proname as function_name,
    t.tgenabled as enabled,
    pg_get_triggerdef(t.oid) as trigger_definition
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid  
JOIN pg_proc p ON t.tgfoid = p.oid
WHERE c.relname = 'posts'
AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
AND NOT t.tgisinternal
ORDER BY t.tgname;

-- 2. Check recent federation_delivery_queue entries for duplicates
SELECT 
    activity_id,
    target_domain,
    COUNT(*) as delivery_count,
    array_agg(id) as delivery_ids,
    array_agg(created_at) as created_times
FROM federation_delivery_queue 
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY activity_id, target_domain
HAVING COUNT(*) > 1
ORDER BY MAX(created_at) DESC;

-- 3. Check if activities are being created multiple times
SELECT 
    ap_id,
    ap_type,
    object_id,
    COUNT(*) as activity_count,
    array_agg(id) as activity_ids,
    array_agg(created_at) as created_times
FROM ap_activities 
WHERE is_local = true 
AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY ap_id, ap_type, object_id
HAVING COUNT(*) > 1
ORDER BY MAX(created_at) DESC;

-- 4. Check specific recent post and its federation entries
WITH recent_post AS (
    SELECT id, author_id, created_at 
    FROM posts 
    WHERE is_local = true 
    ORDER BY created_at DESC 
    LIMIT 1
)
SELECT 
    'POST' as type,
    rp.id as post_id,
    rp.created_at,
    NULL as activity_id,
    NULL as delivery_count
FROM recent_post rp
UNION ALL
SELECT 
    'ACTIVITY' as type,
    aa.object_id as post_id,
    aa.created_at,
    aa.id as activity_id,
    NULL as delivery_count
FROM recent_post rp
JOIN ap_activities aa ON aa.object_id = 'https://har.mony.lol/posts/' || rp.id::text
UNION ALL
SELECT 
    'DELIVERY' as type,
    aa.object_id as post_id,
    fdq.created_at,
    fdq.activity_id,
    COUNT(*) OVER (PARTITION BY fdq.activity_id) as delivery_count
FROM recent_post rp
JOIN ap_activities aa ON aa.object_id = 'https://har.mony.lol/posts/' || rp.id::text
JOIN federation_delivery_queue fdq ON fdq.activity_id = aa.id
ORDER BY created_at;