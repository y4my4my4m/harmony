-- Check all triggers on posts table
SELECT 
    schemaname,
    tablename, 
    triggername,
    procname as function_name,
    CASE WHEN tgenabled = 'O' THEN 'ENABLED' ELSE 'DISABLED' END as status
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid  
JOIN pg_namespace n ON c.relnamespace = n.oid
JOIN pg_proc p ON t.tgfoid = p.oid
WHERE c.relname = 'posts'
AND n.nspname = 'public'
AND NOT tgisinternal  -- Exclude internal triggers
ORDER BY triggername;

-- Also check what functions are being called
SELECT DISTINCT procname
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid  
JOIN pg_namespace n ON c.relnamespace = n.oid
JOIN pg_proc p ON t.tgfoid = p.oid
WHERE c.relname = 'posts'
AND n.nspname = 'public'
AND NOT tgisinternal;