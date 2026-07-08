-- Leaving a server must drop role assignments (Discord parity): role colors /
-- hoisted roles no longer apply to ex-members' old messages. The ban RPC already
-- deletes user_roles explicitly; this trigger makes every membership-removal
-- path (leave, kick, cascade) uniform and idempotent.

CREATE OR REPLACE FUNCTION public.cleanup_roles_on_member_leave()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.user_roles
    WHERE user_id = OLD.user_id AND server_id = OLD.server_id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_roles_on_member_leave ON public.user_servers;
CREATE TRIGGER trg_cleanup_roles_on_member_leave
    AFTER DELETE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.cleanup_roles_on_member_leave();

-- One-time backfill: remove role assignments that already outlived membership
DELETE FROM public.user_roles ur
WHERE NOT EXISTS (
    SELECT 1 FROM public.user_servers us
    WHERE us.user_id = ur.user_id AND us.server_id = ur.server_id
);
