-- Grant necessary permissions for bot gateway (service role)
-- The bot gateway uses service_role and needs to bypass RLS

-- Grant access to channels table
GRANT SELECT ON public.channels TO service_role;
GRANT SELECT ON public.servers TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.messages TO service_role;
GRANT SELECT ON public.profiles TO service_role;
GRANT SELECT, UPDATE ON public.bots TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.bot_server_permissions TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.bot_audit_log TO service_role;
GRANT SELECT ON public.user_servers TO service_role;

-- Ensure service_role can execute RPC functions
GRANT EXECUTE ON FUNCTION public.check_bot_permission TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_bot_token TO service_role;

-- Verify grants
SELECT 
    table_name, 
    privilege_type 
FROM information_schema.table_privileges 
WHERE grantee = 'service_role' 
AND table_schema = 'public'
AND table_name IN ('channels', 'servers', 'messages', 'bots', 'bot_server_permissions')
ORDER BY table_name, privilege_type;

