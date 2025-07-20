-- DEBUG STEP 2: Find the exact federation issue
-- The trigger exists and ap_activities are created, but queue_activity_for_federation isn't being called

-- 1. List ALL functions that contain "unified_content_federation"
SELECT proname, prosrc LIKE '%queue_activity_for_federation%' as has_queue_calls
FROM pg_proc 
WHERE proname LIKE '%unified_content_federation%';

-- 2. Check the EXACT function name being used by the trigger
SELECT t.tgname as trigger_name, p.proname as function_name
FROM pg_trigger t
JOIN pg_proc p ON t.tgfoid = p.oid
JOIN pg_class c ON t.tgrelid = c.oid
WHERE c.relname = 'posts' AND t.tgname = 'trigger_unified_content_federation';

-- 3. Get the ACTUAL function source to see what's wrong
SELECT proname, 
       CASE WHEN prosrc LIKE '%queue_activity_for_federation%' THEN '✅ HAS_QUEUE' ELSE '❌ NO_QUEUE' END,
       LENGTH(prosrc) as source_length
FROM pg_proc 
WHERE oid = (
    SELECT tgfoid FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'posts' AND t.tgname = 'trigger_unified_content_federation'
);

-- 4. Check if queue_activity_for_federation function exists
SELECT proname, proargtypes 
FROM pg_proc 
WHERE proname = 'queue_activity_for_federation';

-- 5. Check the latest ap_activity to see if it has the right structure
SELECT id, ap_type, actor_id, object_id, object_type, status, created_at
FROM ap_activities 
WHERE created_at > NOW() - INTERVAL '5 minutes'
ORDER BY created_at DESC 
LIMIT 1;

-- 6. Test the queue function manually with the latest activity
-- (Run this after checking the above queries)
-- SELECT queue_activity_for_federation(
--     (SELECT id FROM ap_activities ORDER BY created_at DESC LIMIT 1),
--     ARRAY['mastodon.social'],
--     5,
--     true
-- );

-- 7. Check if there are ANY entries in federation_delivery_queue recently
SELECT COUNT(*), MAX(created_at) as latest_entry
FROM federation_delivery_queue 
WHERE created_at > NOW() - INTERVAL '1 hour';