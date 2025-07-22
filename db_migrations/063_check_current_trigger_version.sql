-- Check what version of handle_outgoing_messages function is currently active

-- Show the current function definition
SELECT 
    'Current handle_outgoing_messages function' as info,
    pg_get_functiondef(oid) as definition
FROM pg_proc 
WHERE proname = 'handle_outgoing_messages';

-- Show all triggers on the messages table
SELECT 
    'Triggers on messages table' as info,
    trigger_name,
    event_manipulation,
    action_timing,
    action_statement
FROM information_schema.triggers 
WHERE event_object_table = 'messages';

-- Show the current function source (shorter version)
SELECT 
    'Function source snippet' as info,
    substring(pg_get_functiondef(oid) from 1 for 500) || '...' as definition_start
FROM pg_proc 
WHERE proname = 'handle_outgoing_messages';