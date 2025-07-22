-- DEBUG: Check Federation Function Status
-- We need to see what functions exist and which ones have the right logic

-- 1. List ALL federation-related functions
SELECT proname, 
       CASE WHEN prosrc LIKE '%queue_activity_for_federation%' THEN '✅ HAS_QUEUE' ELSE '❌ NO_QUEUE' END as queue_status,
       CASE WHEN prosrc LIKE '%handle_post_federation%' THEN '📝 POST_HANDLER' ELSE '🔄 OTHER' END as function_type
FROM pg_proc 
WHERE proname LIKE '%federation%' OR proname LIKE '%post%' 
ORDER BY proname;

-- 2. Check what triggers exist on posts table
SELECT t.tgname as trigger_name, p.proname as function_name
FROM pg_trigger t
JOIN pg_proc p ON t.tgfoid = p.oid
JOIN pg_class c ON t.tgrelid = c.oid
WHERE c.relname = 'posts'
ORDER BY t.tgname;

-- 3. Check if handle_post_federation function exists (from all_db_functions.sql)
SELECT proname, 
       LENGTH(prosrc) as source_length,
       CASE WHEN prosrc LIKE '%queue_activity_for_federation%' THEN '✅ HAS_QUEUE_CALLS' ELSE '❌ MISSING_QUEUE_CALLS' END as queue_status
FROM pg_proc 
WHERE proname = 'handle_post_federation';

-- 4. Check what the current posts trigger is actually calling
SELECT p.proname as current_function,
       CASE WHEN p.prosrc LIKE '%queue_activity_for_federation%' THEN '✅ HAS_QUEUE' ELSE '❌ NO_QUEUE' END as has_queue,
       LENGTH(p.prosrc) as function_size
FROM pg_trigger t
JOIN pg_proc p ON t.tgfoid = p.oid
JOIN pg_class c ON t.tgrelid = c.oid
WHERE c.relname = 'posts' AND t.tgname = 'trigger_unified_content_federation';

-- 5. Check recent ap_activities to see what's being created
SELECT ap_type, object_type, status, created_at, actor_id
FROM ap_activities 
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC
LIMIT 5;