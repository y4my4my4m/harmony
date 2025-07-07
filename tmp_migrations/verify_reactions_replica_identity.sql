-- Verify if REPLICA IDENTITY FULL was properly set on reactions table

-- Check current replica identity setting
SELECT 
    c.relname as table_name,
    CASE c.relreplident
        WHEN 'd' THEN 'DEFAULT'
        WHEN 'n' THEN 'NOTHING'
        WHEN 'f' THEN 'FULL'
        WHEN 'i' THEN 'INDEX'
    END as replica_identity
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public' AND c.relname = 'reactions';

-- Check if reactions table is in realtime publication
SELECT 
    'reactions table in realtime publication' as check_name,
    EXISTS(
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'reactions'
    ) as result;

-- Force apply REPLICA IDENTITY FULL again (in case it didn't work the first time)
ALTER TABLE reactions REPLICA IDENTITY FULL;

-- Restart realtime by notifying all clients to reconnect
SELECT pg_notify('pgrst', 'reload schema');

-- Test: Create and delete a reaction to see what data is in WAL
-- (This would need to be monitored in real-time subscription)
SELECT 'REPLICA IDENTITY verification complete. Test by creating/deleting a reaction and checking console logs.' as status;
