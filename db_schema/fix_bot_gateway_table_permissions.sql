-- =====================================================
-- Fix Bot Gateway Database Permissions
-- Grant service_role access to bot tables
-- =====================================================

-- The bot gateway needs to read from these tables to check permissions
-- Error: "permission denied for table bot_server_permissions"

-- Grant SELECT on bot-related tables to service_role
GRANT SELECT ON public.bots TO service_role;
GRANT SELECT ON public.bot_tokens TO service_role;
GRANT SELECT ON public.bot_server_permissions TO service_role;
GRANT SELECT ON public.bot_audit_log TO service_role;

-- Grant INSERT for audit logging
GRANT INSERT ON public.bot_audit_log TO service_role;

-- Grant INSERT/UPDATE/DELETE on messages for bots
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reactions TO service_role;

-- Grant SELECT on emojis for bot emoji creation
GRANT SELECT, INSERT ON public.emojis TO service_role;

-- Grant SELECT on channels and servers for permission checks
GRANT SELECT ON public.channels TO service_role;
GRANT SELECT ON public.servers TO service_role;
GRANT SELECT ON public.user_servers TO service_role;

-- Also grant to authenticated role (in case bot gateway uses that)
GRANT SELECT ON public.bots TO authenticated;
GRANT SELECT ON public.bot_tokens TO authenticated;
GRANT SELECT ON public.bot_server_permissions TO authenticated;
GRANT SELECT ON public.bot_audit_log TO authenticated;

-- Grant INSERT for audit logging
GRANT INSERT ON public.bot_audit_log TO authenticated;

-- Verify the grants
SELECT 
    table_name,
    grantee,
    privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
AND table_name IN ('bot_server_permissions', 'bots', 'bot_tokens')
AND grantee IN ('service_role', 'authenticated')
ORDER BY table_name, grantee, privilege_type;

-- Also make sure the RPC function is executable
GRANT EXECUTE ON FUNCTION public.check_bot_permission TO service_role;
GRANT EXECUTE ON FUNCTION public.check_bot_permission TO authenticated;

SELECT 'Grants applied successfully!' as status;

